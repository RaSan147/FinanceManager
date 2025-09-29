"""Goal data models, persistence helpers, progress calculations, simple allocation logic,
and background AI enrichment for financial goals.
"""

from bson import ObjectId
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List, Union, Literal
from pydantic import BaseModel, Field, field_validator
from models.user import User
from utils.timezone_utils import now_utc, ensure_utc, parse_date_only, parse_datetime_any
from utils.finance_calculator import calculate_lifetime_transaction_summary
from utils.currency import currency_service
from pymongo import ReturnDocument
import asyncio
import threading
import traceback

# Lazy imports inside AI methods to avoid circular dependencies where possible


# --- Pydantic Data Models for Goal ---

# TargetDate validator mixin (no fields)
class TargetDateUtcMixin:
    # Pre-parse strings into aware datetimes
    @field_validator('target_date', mode='before')
    def _parse_target_date(cls, v):  # type: ignore[override]
        if v is None:
            return v
        if isinstance(v, str):
            raw = v.strip()
            # Heuristic: date-only if length <= 10 (YYYY-MM-DD or similar)
            try:
                if len(raw) <= 10:
                    return parse_date_only(raw)
                return parse_datetime_any(raw)
            except Exception as e:  # pragma: no cover - defensive
                raise ValueError(f"Invalid target_date format: {raw}") from e
        return v

    @field_validator('target_date', mode='after')
    def _ensure_target_date_utc(cls, v):  # type: ignore[override]
        return ensure_utc(v) if v is not None else None

class GoalBase(TargetDateUtcMixin, BaseModel):
    """Base Goal schema shared by create/store/read variants.

    Fields:
    - user_id: Owner user identifier (Mongo _id as string).
    - type: 'savings' or 'purchase'.
    - target_amount: Amount to reach in goal currency.
    - currency: ISO currency code for amounts stored on the goal.
    - description: Short human description of the goal.
    - target_date: UTC datetime when the goal should be achieved.
    - current_amount: Amount already accrued toward the target (in goal currency).
    - is_completed: Flag indicating whether the goal is complete.
    - created_at: UTC timestamp when the goal was created.
    - last_updated: UTC timestamp for last modification.
    """

    user_id: str
    type: Literal['savings', 'purchase']  # was str; narrow to known values
    target_amount: float
    currency: str  # currency code for target/current amounts
    description: str
    target_date: datetime
    current_amount: float = 0.0
    is_completed: bool = False
    created_at: datetime = Field(default_factory=now_utc)
    last_updated: datetime = Field(default_factory=now_utc)

class GoalCreate(GoalBase):
    """Payload schema for creating a new Goal. Inherits default values from GoalBase."""
    pass

class GoalUpdate(TargetDateUtcMixin, BaseModel):
    """Patch-style update schema. Only non-null fields are applied on update.

    Fields:
    - target_amount
    - description
    - target_date (UTC)
    - current_amount
    - is_completed
    - completed_date (UTC)
    """
    target_amount: Optional[float] = None
    description: Optional[str] = None
    target_date: Optional[datetime] = None
    current_amount: Optional[float] = None
    is_completed: Optional[bool] = None
    completed_date: Optional[datetime] = None

class GoalInDB(GoalBase):
    """Goal persisted in the database.

    Notes:
    - id is aliased from MongoDB "_id" and is normalized to string.
    - ai_priority/ai_metadata/ai_plan are optional AI-enrichment fields.
    - completed_date is stored for completed goals.
    """
    id: str = Field(..., alias="_id")
    # AI metrics below are stored on a 0–100 scale (percent-like)
    ai_priority: Optional[float] = None
    ai_plan: Optional[str] = None
    ai_plan_paste_url: Optional[str] = None  # Remote offloaded plan
    ai_plan_offloaded: Optional[bool] = None
    ai_plan_archived_at: Optional[datetime] = None
    ai_urgency: Optional[float] = None
    ai_impact: Optional[float] = None
    ai_health_impact: Optional[float] = None
    ai_confidence: Optional[float] = None
    ai_suggestions: Optional[List[str]] = None
    ai_summary: Optional[str] = None

    completed_date: Optional[datetime] = None

    # Convert incoming Mongo ObjectId (or string) to a string early so core validation passes
    @field_validator('id', mode='before')
    def validate_id(cls, v):
        """Normalize MongoDB ObjectId to string and validate format."""
        if isinstance(v, ObjectId):
            return str(v)
        if not ObjectId.is_valid(v):
            raise ValueError("Invalid ObjectId")
        return str(v)




class Goal:
    """Storage and domain utilities for Goal records.

    Includes CRUD operations, listings, progress computation, a simple allocation strategy,
    and background AI enrichment helpers.
    """

    @staticmethod
    def create(goal_data: GoalCreate, db) -> GoalInDB:
        """Insert a new goal.

        Args:
            goal_data: Validated goal payload.
            db: Database handle with goals collection.

        Returns:
            GoalInDB: The stored goal document.
        """
        goal_dict = goal_data.model_dump()
        result = db.goals.insert_one(goal_dict)
        return GoalInDB(**{**goal_dict, "_id": str(result.inserted_id)})

    @staticmethod
    def get_by_id(goal_id: str, user_id: str, db) -> Optional[GoalInDB]:
        """Fetch a goal by id scoped to a user.

        Args:
            goal_id: String representation of ObjectId.
            user_id: Owner user id.
            db: Database handle.

        Returns:
            GoalInDB or None if not found.

        Raises:
            bson.errors.InvalidId: If goal_id is not a valid ObjectId.
        """
        goal = db.goals.find_one({"_id": ObjectId(goal_id), "user_id": user_id})
        return GoalInDB(**goal) if goal else None

    @staticmethod
    def update(goal_id: str, user_id: str, update_data: GoalUpdate, db) -> Optional[GoalInDB]:
        """Apply a partial update to a goal and return the updated document.

        Only non-null fields in update_data are applied. Also updates last_updated.

        Args:
            goal_id: String ObjectId for the goal.
            user_id: Owner user id.
            update_data: Patch payload.
            db: Database handle.

        Returns:
            GoalInDB or None if no update occurred or goal not found.

        Raises:
            bson.errors.InvalidId: If goal_id is not a valid ObjectId.
        """
        update_dict = {k: v for k, v in update_data.model_dump().items() if v is not None}
        if not update_dict:
            return None

        update_dict["last_updated"] = now_utc()
        result = db.goals.find_one_and_update(
            {"_id": ObjectId(goal_id), "user_id": user_id},
            {"$set": update_dict},
            return_document=ReturnDocument.AFTER
        )
        return GoalInDB(**result) if result else None

    @staticmethod
    def delete(goal_id: str, user_id: str, db) -> bool:
        """Delete a goal by id for a user.

        Returns:
            True if a document was deleted, else False.

        Raises:
            bson.errors.InvalidId: If goal_id is not a valid ObjectId.
        """
        result = db.goals.delete_one({"_id": ObjectId(goal_id), "user_id": user_id})
        return result.deleted_count > 0

    @staticmethod
    def get_user_goals(user_id: str, db, skip: int = 0, limit: int = 10, batch_size: int = -1, sort_mode: str | None = None, projection: Dict[str, int] | None = None) -> List[GoalInDB]:
        """List goals for a user with pagination and deterministic sorting.

        Default order: newest first (created_at desc).

        Supports lightweight sort modes via a special key placed in the cursor's
        comment (for easier future explain / profiling) and simple mapping to
        Mongo sort tuples.

        Accepted sort values (case-insensitive):
            - created_desc (default)
            - created_asc
            - target_date (soonest first)
            - target_date_desc
            - priority (ai_priority desc then created_at desc)

        Args:
            user_id: Owner id
            db: Mongo database handle
            skip: Pagination offset
            limit: Page size
            batch_size: Optional Mongo cursor batch_size to use when fetching (<=0 means no batch_size call)

        Returns:
            List[GoalInDB]
        """
        # Normalize sort mode and map to mongo sort tuples
        # Priority: explicit param `sort_mode`, then per-user `sort_modes.goals` via User.get_sorting, then default
        if sort_mode is None:
            try:
                user_obj = User.get_by_id(user_id, db)
                sort_mode = user_obj.get_sort_mode('goals') if user_obj else None
            except Exception:
                sort_mode = None
        if not sort_mode:
            sort_mode = 'created_desc'
        sort_map: dict[str, list[tuple[str, int]]] = {
            'created_desc': [('created_at', -1)],
            'created_asc': [('created_at', 1)],
            'target_date': [('target_date', 1), ('created_at', -1)],
            'target_date_desc': [('target_date', -1), ('created_at', -1)],
            'priority': [('ai_priority', -1), ('target_date', 1), ('created_at', -1)],
        }
        mongo_sort = sort_map.get((sort_mode or 'created_desc').lower(), sort_map['created_desc'])

        # Ensure completed goals sort last by prepending is_completed ascending
        mongo_sort = [('is_completed', 1)] + mongo_sort

        # Default projection excludes large `ai_plan` field unless caller provided a projection
        if projection is None:
            projection = {'ai_plan': 0}
        cursor = db.goals.find({"user_id": user_id}, projection).sort(mongo_sort).skip(skip).limit(limit)
        if isinstance(batch_size, int) and batch_size > 0:
            try:
                cursor = cursor.batch_size(int(batch_size))
            except Exception:
                pass
        return [GoalInDB(**g) for g in cursor]

    @staticmethod
    def get_active_goals(user_id: str, db, skip: int = 0, N: int = -1, batch_size: int = -1, sort_mode: str | None = None, projection: Dict[str, int] | None = None) -> List[GoalInDB]:
        """List non-completed goals with deterministic ordering.

        Defaults to ai_priority desc, target_date asc, created_at desc.
        """
        sort_map: dict[str, list[tuple[str, int]]] = {
            'created_desc': [('created_at', -1)],
            'created_asc': [('created_at', 1)],
            'target_date': [('target_date', 1), ('created_at', -1)],
            'target_date_desc': [('target_date', -1), ('created_at', -1)],
            'priority': [('ai_priority', -1), ('target_date', 1), ('created_at', -1)],
        }
    # Resolve sort_mode: prefer explicit param, then per-user `sort_modes.goals` via User.get_sorting, then default
        if not sort_mode:
            try:
                user_obj = User.get_by_id(user_id, db)
                sort_mode = user_obj.get_sort_mode('goals') if user_obj else None
            except Exception:
                sort_mode = None
        if not sort_mode:
            sort_mode = 'priority'
        mongo_sort = sort_map.get((sort_mode or 'priority').lower(), sort_map['priority'])

        # Default projection excludes large `ai_plan` field unless caller provided a projection
        if projection is None:
            projection = {'ai_plan': 0}
        cursor = db.goals.find({"user_id": user_id, "is_completed": False}, projection).sort(mongo_sort)
        if isinstance(batch_size, int) and batch_size > 0:
            try:
                cursor = cursor.batch_size(int(batch_size))
            except Exception:
                pass
        if skip > 0:
            cursor = cursor.skip(skip)
        if N > 0:
            cursor = cursor.limit(N)
        return [GoalInDB(**g) for g in cursor]

    @staticmethod
    def calculate_goal_progress(goal: GoalInDB, monthly_summary: Dict[str, Any], override_current_amount: float | None = None, base_currency_code: str = 'USD') -> Dict[str, Any]:
        """Compute progress and projections for a goal.

        Behavior:
        - Uses goal.currency for target/current amounts.
        - If override_current_amount is provided, it is interpreted in base_currency_code
          and converted to the goal currency.
        - For savings goals, includes required monthly contribution and current monthly
          savings (converted from base currency).

        Args:
            goal: GoalInDB instance.
            monthly_summary: Dict with monthly aggregates (expects 'savings' in base currency).
            override_current_amount: Optional override for current amount (in base currency).
            base_currency_code: User base currency for conversions.

        Returns:
            Dict including current_amount, target_amount, progress_percent, remaining_days,
            remaining_months, and for savings goals also required_monthly, current_monthly, currency.
        """
        target_date = ensure_utc(goal.target_date)
        now = now_utc()
        delta_sec = (target_date - now).total_seconds()
        remaining_days = int(delta_sec // 86400)  # keep sign (negative when past due)
        remaining_months = delta_sec / (30 * 86400)

        # Normalize currencies
        goal_currency = goal.currency
        from utils.currency import currency_service

        # Determine current amount in goal currency
        if override_current_amount is not None:
            current_amt_goal = currency_service.convert_amount(float(override_current_amount), base_currency_code, goal_currency)
        else:
            current_amt_goal = float(goal.current_amount or 0.0)

        progress_data = {
            "current_amount": current_amt_goal,
            "target_amount": goal.target_amount,
            "progress_percent": round(((current_amt_goal) / goal.target_amount) * 100, 2) if goal.target_amount else 0,
            "remaining_days": remaining_days,
            "remaining_months": remaining_months
        }

        if goal.type == "savings":
            progress_data["required_monthly"] = (
                (goal.target_amount - progress_data["current_amount"]) / max(remaining_months, 1)
            )
            monthly_savings_base = float(monthly_summary.get("savings", 0) or 0)
            # Convert monthly savings (base currency) into goal currency
            progress_data["current_monthly"] = currency_service.convert_amount(monthly_savings_base, base_currency_code, goal_currency)
            progress_data["currency"] = goal_currency

        return progress_data

    @staticmethod
    def compute_allocations(user_id: str, db, *, sort_by: str = 'algorithmic', cache_id: str | None = None, goals_list: List[GoalInDB] | None = None) -> Dict[str, float]:
        """Allocate lifetime current balance across active goals (FIFO-style).

        Algorithm:
        - Pool = max(lifetime current_balance, 0) in user's base currency.
        - Sort active goals by sort_by; default 'algorithmic' blends:
            ai_priority, ai_urgency, ai_impact, ai_health_impact, ai_confidence,
            target coverage vs pool, and time to target.
            - If sort_by is 'created_at', fallback to simple created_at ordering.
        - For each goal (target in goal currency):
            - Convert target to base currency.
            - allocated = min(pool, target_in_base)
            - pool -= allocated
        - Return allocations keyed by goal_id with amounts in base currency.

        Args:
            user_id: Owner user id.
            db: Database handle.
            sort_by: Field to sort goals by; defaults to created_at.

        Returns:
            Mapping of goal_id (str) to allocated amount (float) in base currency.

        Raises:
            bson.errors.InvalidId: If user_id is not a valid ObjectId.
        """
        # Get lifetime current balance as savings pool
        lifetime = calculate_lifetime_transaction_summary(user_id, db, cache_id=cache_id)
        pool = max(float(lifetime.get('current_balance', 0) or 0), 0.0)
        # Determine user's base currency for conversions
        user_doc = db.users.find_one({'_id': ObjectId(user_id)})
        base_ccy = (user_doc or {}).get('default_currency', 'USD').upper()

        # Fetch active goals (exclude large ai_plan field for performance) unless provided by caller
        if goals_list is None:
            goals_cursor = db.goals.find({"user_id": user_id, "is_completed": False}, {"ai_plan": 0})
            # Sort in Python to avoid index requirements
            goals_list = [GoalInDB(**g) for g in goals_cursor]

        if sort_by == 'algorithmic':
            def _algorithmic_sort_key(goalindb: GoalInDB):
                # Time metrics
                target_dt = ensure_utc(goalindb.target_date) if goalindb.target_date else now_utc()
                _now = now_utc()
                days_left = max(int((target_dt - _now).total_seconds() // 86400), -3650)

                # Monetary normalization
                target_in_base = currency_service.convert_amount(
                    float(goalindb.target_amount or 0.0),
                    (goalindb.currency or base_ccy).upper(),
                    base_ccy,
                )

                # Normalize AI signals to 0..1 from stored 0..100
                def _pct01(val: Optional[float], default: float = 0.0) -> float:
                    try:
                        if val is None:
                            return max(0.0, min(1.0, default))
                        return max(0.0, min(1.0, float(val) / 100.0))
                    except Exception:
                        return max(0.0, min(1.0, default))

                priority_n = _pct01(goalindb.ai_priority, 0.5)
                urgency_n = _pct01(goalindb.ai_urgency, 0.0)
                impact_n = _pct01(goalindb.ai_impact, 0.0)
                health_n = _pct01(goalindb.ai_health_impact, 0.0)
                confidence = _pct01(goalindb.ai_confidence, 0.5)

                # If AI urgency missing, infer a soft urgency from time left (sooner => higher)
                if goalindb.ai_urgency is None:
                    # 0 when > 24 months away, 100 when due now or overdue
                    inferred_urgency_pct = max(0.0, min(100.0, 100.0 * (1.0 - (days_left / (24 * 30)))))
                    urgency_n = inferred_urgency_pct / 100.0

                # Time-pressure penalty (dimensionless, scaled to pool)
                # - time_pressure: 1.0 when due/overdue, scales down with more days (<=30 days -> near 1)
                # - resource_ratio: how large the target is vs available pool (capped to avoid overpower)
                penalty_weight = 0.15  # keep conservative to avoid overwhelming AI score
                time_pressure = 1.0 if days_left <= 0 else min(1.0, 30.0 / max(days_left, 1))
                resource_ratio = 0.0
                if pool > 0:
                    resource_ratio = min(1.0, target_in_base / pool)
                penalty_amount = penalty_weight * time_pressure * resource_ratio * pool

                # Fraction of goal we could cover from pool right now (bounded)
                coverage = 0.0
                if target_in_base > 0:
                    coverage = max(0.0, min(1.0, pool / target_in_base))

                # Aggregate AI-driven score; emphasize priority and urgency, keep impact & confidence
                ai_base = (
                    0.45 * priority_n +
                    0.40 * urgency_n +
                    0.10 * impact_n +
                    0.05 * health_n
                )
                ai_score = ai_base * confidence

                # Overall value combines AI score and coverage bonus, minus a bounded time-pressure penalty
                value = (ai_score * pool) + (0.2 * coverage * pool) - penalty_amount

                # Sort primarily by value desc, then by priority, then earliest due date, then earliest created
                return (
                    value,
                    priority_n,
                    -days_left,
                    (goalindb.created_at or _now),
                )

            goals_list.sort(key=_algorithmic_sort_key, reverse=True)
        else:
            goals_list.sort(key=lambda g: getattr(g, sort_by) or getattr(g, 'created_at') or now_utc())

        allocations: Dict[str, float] = {}
        for g in goals_list:
            gid = str(g.id)
            target = float(g.target_amount or 0)
            g_ccy = (g.currency or base_ccy).upper()
            target_in_base = currency_service.convert_amount(target, g_ccy, base_ccy)
            if pool <= 0 or target <= 0:
                allocations[gid] = 0.0
                continue
            amt = min(pool, target_in_base)
            allocations[gid] = round(amt, 2)
            pool = round(pool - amt, 2)

        return allocations

    # -------- AI Enhancement Methods (reintroduced & adapted) --------
    @staticmethod
    async def _ai_enhance_goal(goal_id: Union[str, ObjectId], goal_data: Union[GoalInDB, Dict[str, Any]], db, ai_engine):
        """Async AI enrichment for a goal.

        Updates:
    - ai_priority: integer (0-100, higher = more important to pursue soon)
    - ai_urgency: integer (0-100, higher = more urgent)
    - ai_impact: integer (0-100, scaled from impact heuristics)
        - ai_suggestions: list of suggested actions.
        - ai_summary: string (1-2 concise sentences summarizing the goal's importance)
        - ai_plan: step-by-step plan text.

        Args:
            goal_id: Goal id (str or ObjectId).
            goal_data: Goal object or dict.
            db: Database handle.
            ai_engine: AI engine/provider used by helper functions.
        """
        from models.user import User  # local import to minimize circular refs
        from utils.ai_helper import run_goal_priority_analysis, get_goal_plan
        try:
            # Normalize goal dict
            if isinstance(goal_data, GoalInDB):
                goal_dict = goal_data.model_dump(by_alias=True)
            else:
                goal_dict = goal_data.copy()

            user_id_str = goal_dict['user_id']
            user = db.users.find_one({'_id': ObjectId(user_id_str)})
            if not user:
                raise ValueError(f"User with ID {user_id_str} not found")

            user_obj = User(user, db)

            ai_analysis = await run_goal_priority_analysis(user_obj, ai_engine, goal_dict)


            # Generate a concrete step-by-step plan using the dedicated helper
            try:
                plan_text: str = await get_goal_plan(
                    goal_dict,
                    user_obj
                )
            except Exception:
                traceback.print_exc()
                plan_text = ai_analysis.get('summary') or 'Plan unavailable.'

            # Compute days_left for fallback urgency/priority
            target_dt = ensure_utc(goal_dict.get('target_date')) if goal_dict.get('target_date') else now_utc()
            now = now_utc()
            days_left = max(int((target_dt - now).total_seconds() // 86400), -3650)

            priority_pct = ai_analysis.get('priority_score', 0)
            urgency_pct = ai_analysis.get('urgency', 0)
            impact_pct = ai_analysis.get('financial_impact', 0)
            health_pct = ai_analysis.get('health_impact', 0)
            confidence_pct = ai_analysis.get('confidence', 50)

            db.goals.update_one(
                {'_id': ObjectId(goal_id)},
                {'$set': {
                    'ai_priority': priority_pct,
                    'ai_urgency': urgency_pct,
                    'ai_impact': impact_pct,
                    'ai_health_impact': health_pct,
                    'ai_confidence': confidence_pct,
                    'ai_suggestions': ai_analysis.get('suggested_actions'),
                    # Keep the short summary in metadata for context
                    'ai_summary': ai_analysis.get('summary'),
                    'ai_plan': plan_text,
                    'last_updated': now_utc()
                }}
            )
        except Exception as e:
            # Simple stderr logging; can integrate logger
            print(f"AI enhancement failed for goal {goal_id}: {e}\n{traceback.format_exc()}")

    @staticmethod
    def enhance_goal_background(goal: GoalInDB, db, ai_engine):
        """Run AI enrichment in a detached daemon thread for non-blocking UX."""
        def runner():
            asyncio.run(Goal._ai_enhance_goal(goal.id, goal, db, ai_engine))
        threading.Thread(target=runner, daemon=True).start()

    @staticmethod
    def get_prioritized(user_id: str, db) -> List[dict]:
        """Return goals sorted by ai_priority descending (excluding large ai_plan body)."""
        cursor = db.goals.find({'user_id': user_id}, {'ai_plan': 0})
        goals_list = [GoalInDB(**g) for g in cursor]

        # sort by ai_priority desc then created_at desc, but always place completed goals at the end
        def _priority_key(g: GoalInDB):
            p = getattr(g, 'ai_priority', None)
            try:
                p_val = float(p) if p is not None else 0.0
            except Exception:
                p_val = 0.0
            created = getattr(g, 'created_at', now_utc()) or now_utc()
            # We want primary key: is_completed (False first), then priority desc, then created_at desc
            return (1 if getattr(g, 'is_completed', False) else 0, -p_val, -created.timestamp())

        goals_list.sort(key=_priority_key)
        return [GoalInDB(**g.model_dump(by_alias=True)).model_dump(by_alias=True) if isinstance(g, GoalInDB) else GoalInDB(**g).model_dump(by_alias=True) for g in goals_list]

    @staticmethod
    def mark_as_completed(user_id: str, goal_id: ObjectId, db):
        """Mark a goal as completed, storing completed_date and updating last_updated."""
        db.goals.update_one(
            {'_id': goal_id, 'user_id': user_id},
            {'$set': {'is_completed': True, 'completed_date': now_utc(), 'last_updated': now_utc()}}
        )

    # ---------- AI PLAN OFFLOADING (Pastebin) ----------
    @staticmethod
    async def offload_old_ai_plans(user_id: str, db, pastebin_client=None, days:int=30):
        """Offload ai_plan HTML older than N days to Pastebin.

        Process:
        - Find goals for user having ai_plan, not offloaded, last_updated older than cutoff.
        - Create paste per plan; store url; remove ai_plan content (to reduce DB bloat).
        - Mark ai_plan_offloaded True and record ai_plan_archived_at.
        Returns count of migrated goals.
        """
        if not pastebin_client:
            return 0
        cutoff = now_utc() - timedelta(days=days)
        cursor = db.goals.find({
            'user_id': user_id,
            'ai_plan': {'$exists': True, '$ne': None},
            '$or': [
                {'ai_plan_offloaded': {'$exists': False}},
                {'ai_plan_offloaded': False}
            ],
            'last_updated': {'$lt': cutoff}
        })
        migrated = 0
        for g in cursor:
            try:
                paste_url = await pastebin_client.create_paste(
                    title=f"GoalPlan {g.get('description','goal')} {g['_id']}",
                    content=g.get('ai_plan') or '',
                    private=True
                ) if pastebin_client else None
            except Exception:
                paste_url = None
            update_doc = {
                'ai_plan_offloaded': bool(paste_url),
                'ai_plan_archived_at': now_utc(),
                'last_updated': now_utc()
            }
            if paste_url:
                update_doc['ai_plan_paste_url'] = paste_url
            # Remove local content if successfully offloaded
            unset = {'ai_plan': ''} if paste_url else {}
            db.goals.update_one({'_id': g['_id']}, {'$set': update_doc, '$unset': unset})
            migrated += 1
        return migrated

    @staticmethod
    async def delete_remote_ai_plan_if_any(goal_doc: dict, pastebin_client=None):
        if not pastebin_client:
            return False
        url = goal_doc.get('ai_plan_paste_url')
        if not url:
            return False
        key = pastebin_client.extract_paste_key(url)
        if not key:
            return False
        try:
            return await pastebin_client.delete_paste(key)
        except Exception:
            return False

    @staticmethod
    def compact_dict(goal: GoalInDB|dict, include_ai_analysis=False) -> dict:
        """Return a compact representation of the goal."""
        if isinstance(goal, GoalInDB):
            goal = goal.model_dump(by_alias=True)

        compact = {
            'description': goal.get('description', ''),
            'target_amount': goal.get('target_amount', 0),
            'target_date': goal.get('target_date', ''),
            'currency': goal.get('currency', ''),
            'days_left': max(int(((ensure_utc(goal.get('target_date')) if goal.get('target_date') else now_utc()) - now_utc()).total_seconds() // 86400), -3650),
        }

        if include_ai_analysis:
            compact.update({
                'ai_priority': goal.get('ai_priority'),
                'ai_urgency': goal.get('ai_urgency'),
                'ai_impact': goal.get('ai_impact'),
                'ai_health_impact': goal.get('ai_health_impact'),
                'ai_confidence': goal.get('ai_confidence'),
                'ai_summary': goal.get('ai_summary'),
                'ai_suggestions': goal.get('ai_suggestions'),
            })

        return compact



from typing import Dict, Optional

class Allocator:
    @staticmethod
    def _safe_pct_field(goal, *names, default=0.0):
        """
        Read several possible AI fields and normalize to 0..1 floats.
        Accepts both 0..100 ints and 0..1 floats (defensive).
        """
        for n in names:
            val = getattr(goal, n, None) if hasattr(goal, n) else goal.get(n) if isinstance(goal, dict) else None
            if val is None:
                continue
            try:
                v = float(val)
                # If already 0..1 (likely produced by something else), leave it
                if 0.0 <= v <= 1.0:
                    return v
                # If 0..100 scale, convert
                if 0.0 <= v <= 100.0:
                    return max(0.0, min(1.0, v / 100.0))
            except Exception:
                continue
        return max(0.0, min(1.0, float(default)))

    @staticmethod
    def compute_allocations(user_id: str, db, *, sort_by: str = 'algorithmic', cache_id: str | None = None, goals_list: List[GoalInDB] | None = None) -> Dict[str, float]:
        """Improved allocation algorithm: two-pass (secure urgent needs, then proportional by value).
        Returns mapping goal_id -> allocation (base currency amount, rounded to 2 decimals).
        """
        # --- Gather pool and base currency ---
        lifetime = calculate_lifetime_transaction_summary(user_id, db, cache_id=cache_id) or {}
        pool = max(float(lifetime.get('current_balance', 0) or 0), 0.0)
        if pool == 0:
            return {}

        user_doc = db.users.find_one({'_id': ObjectId(user_id)})
        base_ccy = (user_doc or {}).get('default_currency', 'USD').upper()

        # Optional: monthly savings estimate (fallbacks)
        monthly_savings_est = None
        # prefer explicit field if available
        if lifetime.get('monthly_net_savings') is not None:
            try:
                monthly_savings_est = float(lifetime.get('monthly_net_savings') or 0.0)
            except Exception:
                monthly_savings_est = None
        # fallback to an approximate (pool/12) if unknown
        if monthly_savings_est is None or monthly_savings_est <= 0:
            monthly_savings_est = max(0.0, pool / 12.0)

        # Fetch goals (exclude heavy ai_plan) unless provided by caller
        if goals_list is None:
            goals_cursor = db.goals.find({"user_id": user_id, "is_completed": False}, {"ai_plan": 0})
            goals_list = [GoalInDB(**g) for g in goals_cursor]

        # early exit
        if not goals_list:
            return {}

        # parameters / knobs
        safety_reserve_pct = 0.05  # keep a small reserve of pool (5%)
        min_alloc_absolute = 1.00  # don't allocate amounts < $1 (avoid dust)
        time_penalty_weight = 0.12  # bounded time penalty weight
        coverage_bonus_weight = 0.18
        affordability_weight = 0.40  # how much affordability modifies priority
        ai_weights = {
            "priority": 0.40,
            "urgency": 0.30,
            "impact": 0.18,
            "health": 0.12
        }

        # Precompute some pool-derived values
        initial_pool = pool
        reserve = round(pool * safety_reserve_pct, 2)
        working_pool = max(0.0, pool - reserve)

        # build sort key / value computation
        def goal_score(g: GoalInDB):
            now = now_utc()
            # time metrics
            if g.target_date:
                try:
                    target_dt = ensure_utc(g.target_date)
                except Exception:
                    target_dt = now
            else:
                target_dt = now

            # days / months left (cap months to 0..240)
            delta_days = (target_dt - now).total_seconds() / 86400.0
            months_left = max(0.0, delta_days / 30.0)
            months_left_capped = min(240.0, months_left)  # 20 years cap

            # target in base currency
            try:
                target_amt = float(g.target_amount or 0.0)
            except Exception:
                target_amt = 0.0
            g_ccy = (g.currency or base_ccy).upper()
            target_in_base = currency_service.convert_amount(target_amt, g_ccy, base_ccy)

            # required monthly to hit target on time
            required_monthly = target_in_base / max(1.0, months_left_capped)

            # AI fields normalized 0..1
            priority_n = Allocator._safe_pct_field(g, 'ai_priority', 'priority_score', default=0.5)
            urgency_n = Allocator._safe_pct_field(g, 'ai_urgency', 'urgency', default=None)
            impact_n = Allocator._safe_pct_field(g, 'ai_impact', 'financial_impact', default=0.0)
            health_n = Allocator._safe_pct_field(g, 'ai_health_impact', 'health_impact', default=0.0)
            confidence = Allocator._safe_pct_field(g, 'ai_confidence', 'confidence', default=0.6)

            # If AI urgency not provided, infer from time left (0 when >24 months, 1 when due or overdue)
            if urgency_n is None or urgency_n == 0.0:
                urgency_inferred = 0.0
                if months_left_capped <= 24.0:
                    urgency_inferred = max(0.0, min(1.0, 1.0 - (months_left_capped / 24.0)))
                urgency_n = max(urgency_n or 0.0, urgency_inferred)

            # Affordability: how realistic is hitting target given user's monthly savings
            affordability = 0.0
            if required_monthly > 0:
                affordability = max(0.0, min(1.0, monthly_savings_est / required_monthly))
            else:
                affordability = 1.0

            # coverage: fraction of target we could cover from current working_pool
            coverage = 0.0
            if target_in_base > 0:
                coverage = max(0.0, min(1.0, working_pool / target_in_base))

            # time_pressure (1 if due or overdue, else decays with months; stronger when <= 3 months)
            if months_left <= 0:
                time_pressure = 1.0
            elif months_left <= 3:
                time_pressure = max(0.6, 1.0 - (months_left / 3.0) * 0.4)
            else:
                time_pressure = max(0.0, min(1.0, 3.0 / months_left))

            # AI base score (weighted)
            ai_base = (
                ai_weights['priority'] * priority_n +
                ai_weights['urgency'] * urgency_n +
                ai_weights['impact'] * impact_n +
                ai_weights['health'] * health_n
            )
            ai_score = ai_base * confidence  # confidence downscales score if uncertain

            # Compose final value:
            # start with ai_score scaled by pool + an affordability multiplier + coverage bonus - time penalty
            value = (
                ai_score * (0.6 + affordability_weight * affordability) * working_pool
                + coverage_bonus_weight * coverage * working_pool
                - (time_penalty_weight * time_pressure * min(1.0, target_in_base / max(1.0, working_pool)) * working_pool)
            )

            # Secondary sort keys to break ties
            created_at = getattr(g, 'created_at', now) or now
            return (
                float(value or 0.0),
                float(priority_n),
                float(urgency_n),
                -months_left,          # sooner (less months) comes first
                created_at
            )

        # Sort goals by algorithmic value by default
        if sort_by == 'algorithmic':
            goals_list.sort(key=goal_score, reverse=True)
        else:
            goals_list.sort(key=lambda g: getattr(g, sort_by) or getattr(g, 'created_at') or now_utc())

        # --- First pass: ensure urgent goals get at least the 'next-month' required funding if affordable ---
        allocations: Dict[str, float] = {}
        remaining_pool = working_pool

        # Helper to compute current target_in_base and required_monthly per goal
        def target_and_required(g):
            try:
                t = float(g.target_amount or 0.0)
            except Exception:
                t = 0.0
            ccy = (g.currency or base_ccy).upper()
            t_base = currency_service.convert_amount(t, ccy, base_ccy)
            now = now_utc()
            if getattr(g, 'target_date', None):
                try:
                    months_left = max(0.0, (ensure_utc(g.target_date) - now).total_seconds() / 86400.0 / 30.0)
                except Exception:
                    months_left = 0.0
            else:
                months_left = 0.0
            months_left = min(240.0, months_left)
            req_monthly = t_base / max(1.0, months_left) if months_left > 0 else t_base
            return t_base, req_monthly, months_left

        # Pass 1: for goals with high urgency (urgency_n >= 0.75), try to allocate a single-month required amount (capped)
        for g in goals_list:
            gid = str(g.id)
            t_base, req_monthly, months_left = target_and_required(g)
            urgency_n = Allocator._safe_pct_field(g, 'ai_urgency', 'urgency', default=None)
            if urgency_n is None:
                # infer if missing
                if months_left <= 24.0:
                    urgency_n = max(0.0, min(1.0, 1.0 - (months_left / 24.0)))
                else:
                    urgency_n = 0.0

            # high-urgency threshold
            if urgency_n >= 0.75 and remaining_pool > 0 and req_monthly > 0:
                # allocate min(req_monthly, remaining_pool, t_base) but leave min reserve
                alloc = min(remaining_pool, req_monthly, t_base)
                # avoid dust allocations
                if alloc < min_alloc_absolute:
                    alloc = 0.0
                else:
                    alloc = round(alloc, 2)
                    allocations[gid] = allocations.get(gid, 0.0) + alloc
                    remaining_pool = round(remaining_pool - alloc, 2)

        # Pass 2: allocate remaining_pool proportionally by computed 'value' (greedy but normalized)
        # compute numeric values
        values = []
        for g in goals_list:
            gid = str(g.id)
            v_tuple = goal_score(g)
            v = max(0.0, float(v_tuple[0]))
            # reduce value for goals already fully funded by first-pass allocations
            t_base, _, _ = target_and_required(g)
            already = allocations.get(gid, 0.0)
            remaining_to_goal = max(0.0, t_base - already)
            if remaining_to_goal <= 0:
                v = 0.0
            values.append((g, gid, v, remaining_to_goal, t_base))

        total_value = sum(v for (_, _, v, _, _) in values) or 0.0

        # If total_value is zero (no positive value), fallback to FIFO/earliest created
        if total_value <= 0.0:
            for g, gid, _, remaining_to_goal, t_base in values:
                if remaining_pool <= 0:
                    break
                if remaining_to_goal <= 0:
                    continue
                alloc = min(remaining_pool, remaining_to_goal)
                if alloc < min_alloc_absolute:
                    continue
                alloc = round(alloc, 2)
                allocations[gid] = allocations.get(gid, 0.0) + alloc
                remaining_pool = round(remaining_pool - alloc, 2)
        else:
            # distribute proportionally to v / total_value, but also cap to remaining_to_goal
            for g, gid, v, remaining_to_goal, t_base in sorted(values, key=lambda x: x[2], reverse=True):
                if remaining_pool <= 0:
                    break
                if v <= 0 or remaining_to_goal <= 0:
                    continue
                share = v / total_value
                desired = remaining_pool * share
                alloc = min(desired, remaining_to_goal, remaining_pool)
                # avoid tiny allocations
                if alloc < min_alloc_absolute:
                    continue
                alloc = round(alloc, 2)
                allocations[gid] = allocations.get(gid, 0.0) + alloc
                remaining_pool = round(remaining_pool - alloc, 2)
                total_value -= v  # conservative: remove this goal's value so next shares adjust

        # Final step: if rounding left some cents and a small positive remaining_pool, add it to highest priority goal that still needs it
        if remaining_pool >= 0.01:
            # find candidate with remaining need
            candidates = [(gid, (t := currency_service.convert_amount(float(g.target_amount or 0.0),
                                                                         (g.currency or base_ccy).upper(), base_ccy) - allocations.get(str(g.id), 0.0)))
                          for g in goals_list for gid in [str(g.id)]]
            # pick candidate with positive remaining need and highest ai priority
            candidate = None
            for g in goals_list:
                gid = str(g.id)
                need = (currency_service.convert_amount(float(g.target_amount or 0.0),
                                                        (g.currency or base_ccy).upper(), base_ccy)
                        - allocations.get(gid, 0.0))
                if need > 0.01:
                    candidate = (gid, need)
                    break
            if candidate:
                gid, need = candidate
                add = min(round(remaining_pool, 2), need)
                if add >= 0.01:
                    allocations[gid] = allocations.get(gid, 0.0) + add
                    remaining_pool = round(remaining_pool - add, 2)

        # ensure all allocations are rounded to 2 decimals and no negatives
        for k in list(allocations.keys()):
            allocations[k] = round(max(0.0, allocations[k]), 2)

        # ensure we never allocate more than initial pool (safety clamp)
        total_alloc = round(sum(allocations.values()), 2)
        if total_alloc > initial_pool:
            # scale down proportionally
            scale = initial_pool / total_alloc
            for k in allocations:
                allocations[k] = round(allocations[k] * scale, 2)

        return allocations
