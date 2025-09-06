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
    def get_user_goals(user_id: str, db, skip: int = 0, limit: int = 10) -> List[GoalInDB]:
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

        Returns:
            List[GoalInDB]
        """
        sort_mode = getattr(db, '_goal_sort_mode', 'created_desc')  # ephemeral attr optionally set by caller
        sort_mode = (sort_mode or 'created_desc').lower()
        sort_map: dict[str, list[tuple[str, int]]] = {
            'created_desc': [('created_at', -1)],
            'created_asc': [('created_at', 1)],
            'target_date': [('target_date', 1), ('created_at', -1)],
            'target_date_desc': [('target_date', -1), ('created_at', -1)],
            'priority': [('ai_priority', -1), ('created_at', -1)],
        }
        mongo_sort = sort_map.get(sort_mode, sort_map['created_desc'])
        cursor = db.goals.find({"user_id": user_id}, {  # projection excludes large plan body
            'ai_plan': 0
        }).sort(mongo_sort).skip(skip).limit(limit)
        return [GoalInDB(**g) for g in cursor]

    @staticmethod
    def get_active_goals(user_id: str, db) -> List[GoalInDB]:
        """List non-completed goals with deterministic ordering.

        Uses ai_priority desc then target_date asc then created_at desc so that
        newly added goals without AI data naturally fall toward the end but
        still appear before very old, far future goals if priorities tie.
        """
        cursor = (db.goals
                  .find({"user_id": user_id, "is_completed": False}, {'ai_plan': 0})
                  .sort([
                      ('ai_priority', -1),
                      ('target_date', 1),
                      ('created_at', -1)
                  ]))
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
    def compute_allocations(user_id: str, db, *, sort_by: str = 'algorithmic') -> Dict[str, float]:
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
        lifetime = calculate_lifetime_transaction_summary(user_id, db)
        pool = max(float(lifetime.get('current_balance', 0) or 0), 0.0)
        # Determine user's base currency for conversions
        user_doc = db.users.find_one({'_id': ObjectId(user_id)})
        base_ccy = (user_doc or {}).get('default_currency', 'USD').upper()

        from utils.currency import currency_service

        # Fetch active goals (exclude large ai_plan field for performance)
        goals_cursor = db.goals.find({"user_id": user_id, "is_completed": False}, {"ai_plan": 0})
        # Sort in Python to avoid index requirements
        goals_list = list(GoalInDB(**g) for g in goals_cursor)
        if sort_by == 'algorithmic':
            def _algorithmic_sort_key(goalindb: GoalInDB):
                # Time metrics
                target_dt = ensure_utc(goalindb.target_date) if goalindb.target_date else now_utc()
                now = now_utc()
                days_left = max(int((target_dt - now).total_seconds() // 86400), -3650)

                # Monetary normalization
                target_in_base = currency_service.convert_amount(float(goalindb.target_amount or 0.0), (goalindb.currency or base_ccy).upper(), base_ccy)

                # AI signals (with sensible defaults)
                priority_n = float(goalindb.ai_priority or 50) / 100.0
                urgency_n = float(goalindb.ai_urgency or 0.0)
                impact_n = min(float(goalindb.ai_impact or 0.0), 10.0) / 10.0
                health_n = float(goalindb.ai_health_impact or 0.0)
                confidence = float(goalindb.ai_confidence or 0.5)

                # If AI urgency missing, infer a soft urgency from time left (sooner => higher)
                if goalindb.ai_urgency is None:
                    # 0 when > 24 months away, 1 when due now or overdue
                    urgency_n = max(0.0, min(1.0, 1.0 - (days_left / (24 * 30))))

                # Required per-day burn in base currency (avoid div by 0)
                daily_required_amount = target_in_base / (days_left + 1) if days_left > 0 else target_in_base

                # Fraction of goal we could cover from pool right now (bounded)
                coverage = 0.0
                if target_in_base > 0:
                    coverage = max(0.0, min(1.0, pool / target_in_base))

                # Aggregate AI-driven score; confidence scales the AI parts
                ai_score = confidence * (
                    0.5 * priority_n +
                    0.3 * urgency_n +
                    0.15 * impact_n +
                    0.05 * health_n
                )

                # Overall value combines "available resources to deploy" vs. "required pace"
                # and a small boost for goals that are fully coverable now.
                value = (ai_score * pool) + (0.2 * coverage * pool) - daily_required_amount

                # Sort primarily by value desc, then by ai_priority desc, then earliest due date, then earliest created
                return (
                    value,
                    priority_n,
                    -days_left,  # sooner deadlines first
                    (goalindb.created_at or now)
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
        - ai_urgency: float (0.0-1.0, representing days_remaining / total_days until target).
        - ai_impact: float (goal_amount ÷ monthly_income, capped at 10)
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
                plan_text: str = get_goal_plan(
                    goal_dict,
                    user_obj
                )
            except Exception:
                plan_text = ai_analysis.get('summary') or 'Plan unavailable.'

            db.goals.update_one(
                {'_id': ObjectId(goal_id)},
                {'$set': {
                    'ai_priority': ai_analysis.get('priority_score', 0),
                    'ai_urgency': ai_analysis.get('urgency'),
                    'ai_impact': ai_analysis.get('financial_impact'),
                    'ai_health_impact': ai_analysis.get('health_impact'),
                    'ai_confidence': ai_analysis.get('confidence'),
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
        cursor = db.goals.find({'user_id': user_id}, {'ai_plan': 0}).sort('ai_priority', -1)
        return [GoalInDB(**g).model_dump(by_alias=True) for g in cursor]

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
    def compact_dict(goal: GoalInDB|dict) -> dict:
        """Return a compact representation of the goal."""
        if isinstance(goal, GoalInDB):
            goal = goal.model_dump(by_alias=True)

        return {
            'description': goal.get('description', ''),
            'target_amount': goal.get('target_amount', 0),
            'target_date': goal.get('target_date', ''),
            'currency': goal.get('currency', ''),
        }