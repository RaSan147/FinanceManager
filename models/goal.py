from bson import ObjectId
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List, Union
from pydantic import BaseModel, Field, field_validator
from utils.timezone_utils import now_utc, ensure_utc
from utils.finance_calculator import calculate_lifetime_transaction_summary
import asyncio
import threading
import traceback

# Lazy imports inside AI methods to avoid circular dependencies where possible


# --- Pydantic Data Models for Goal ---

class GoalBase(BaseModel):
    user_id: str
    type: str  # 'savings' or 'purchase'
    target_amount: float
    currency: str  # currency code for target/current amounts
    description: str
    target_date: datetime
    current_amount: float = 0.0
    is_completed: bool = False
    created_at: datetime = Field(default_factory=now_utc)
    last_updated: datetime = Field(default_factory=now_utc)

class GoalCreate(GoalBase):
    pass

class GoalUpdate(BaseModel):
    target_amount: Optional[float] = None
    description: Optional[str] = None
    target_date: Optional[datetime] = None
    current_amount: Optional[float] = None
    is_completed: Optional[bool] = None
    completed_date: Optional[datetime] = None

class GoalInDB(GoalBase):
    id: str = Field(..., alias="_id")
    ai_priority: Optional[float] = None
    ai_metadata: Optional[Dict[str, Any]] = None
    ai_plan: Optional[str] = None
    completed_date: Optional[datetime] = None

    # Convert incoming Mongo ObjectId (or string) to a string early so core validation passes
    @field_validator('id', mode='before')
    def validate_id(cls, v):
        if isinstance(v, ObjectId):
            return str(v)
        if not ObjectId.is_valid(v):
            raise ValueError("Invalid ObjectId")
        return str(v)

class Goal:
    @staticmethod
    def create(goal_data: GoalCreate, db) -> GoalInDB:
        goal_dict = goal_data.model_dump()
        result = db.goals.insert_one(goal_dict)
        return GoalInDB(**{**goal_dict, "_id": str(result.inserted_id)})

    @staticmethod
    def get_by_id(goal_id: str, user_id: str, db) -> Optional[GoalInDB]:
        goal = db.goals.find_one({"_id": ObjectId(goal_id), "user_id": user_id})
        return GoalInDB(**goal) if goal else None

    @staticmethod
    def update(goal_id: str, user_id: str, update_data: GoalUpdate, db) -> Optional[GoalInDB]:
        update_dict = {k: v for k, v in update_data.model_dump().items() if v is not None}
        if not update_dict:
            return None
        
        update_dict["last_updated"] = now_utc()
        result = db.goals.find_one_and_update(
            {"_id": ObjectId(goal_id), "user_id": user_id},
            {"$set": update_dict},
            return_document=True
        )
        return GoalInDB(**result) if result else None

    @staticmethod
    def delete(goal_id: str, user_id: str, db) -> bool:
        result = db.goals.delete_one({"_id": ObjectId(goal_id), "user_id": user_id})
        return result.deleted_count > 0

    @staticmethod
    def get_user_goals(user_id: str, db, skip: int = 0, limit: int = 10) -> List[GoalInDB]:
        goals = db.goals.find({"user_id": user_id}).skip(skip).limit(limit)
        return [GoalInDB(**goal) for goal in goals]

    @staticmethod
    def get_active_goals(user_id: str, db) -> List[GoalInDB]:
        goals = db.goals.find({"user_id": user_id, "is_completed": False})
        return [GoalInDB(**goal) for goal in goals]

    @staticmethod
    def calculate_goal_progress(goal: GoalInDB, monthly_summary: Dict[str, Any], override_current_amount: float | None = None, base_currency_code: str = 'USD') -> Dict[str, Any]:
        target_date = ensure_utc(goal.target_date)
        now = now_utc()
        remaining_days = (target_date - now).days
        remaining_months = remaining_days / 30
        
        # Normalize currencies
        goal_currency = goal.currency
        try:
            from utils.currency import convert_amount as _convert
        except Exception:
            def _convert(amount: float, from_code: str, to_code: str) -> float:
                return amount
        
        # Determine current amount in goal currency
        if override_current_amount is not None:
            # override is assumed to be in base currency; convert to goal currency
            current_amt_goal = _convert(float(override_current_amount), base_currency_code, goal_currency)
        else:
            # stored current_amount assumed to be in goal currency already
            current_amt_goal = float(getattr(goal, 'current_amount', 0.0) or 0.0)
        
        progress_data = {
            "current_amount": current_amt_goal,
            "target_amount": goal.target_amount,
            "progress_percent": round((
                ((current_amt_goal) / goal.target_amount) * 100), 2
            ) if goal.target_amount else 0,
            "remaining_days": remaining_days,
            "remaining_months": remaining_months
        }
        
        if goal.type == "savings":
            progress_data["required_monthly"] = (
                (goal.target_amount - progress_data["current_amount"]) / max(remaining_months, 1)
            )
            # monthly_summary values are in base currency; convert to goal currency for display
            monthly_savings_base = float(monthly_summary.get("savings", 0) or 0)
            progress_data["current_monthly"] = _convert(monthly_savings_base, base_currency_code, goal_currency)
            progress_data["currency"] = goal_currency
        
        return progress_data

    @staticmethod
    def compute_allocations(user_id: str, db, *, sort_by: str = 'created_at') -> Dict[str, float]:
        """Allocate lifetime current balance across active goals in a simple FIFO manner.

        Algorithm:
        - Pool = max(lifetime current_balance, 0)
        - Sort active (not completed) goals by sort_by ascending
        - For each goal: allocated = min(pool, goal.target_amount); pool -= allocated
        - Return mapping of goal_id -> allocated amount

        Note: This is a "hotwire" approach and ignores per-goal contributions.
        """
        # Get lifetime current balance as savings pool
        lifetime = calculate_lifetime_transaction_summary(user_id, db)
        pool = max(float(lifetime.get('current_balance', 0) or 0), 0.0)
        # Determine user's base currency for conversions
        user_doc = db.users.find_one({'_id': ObjectId(user_id)})
        base_ccy = (user_doc or {}).get('default_currency', 'USD').upper()
        try:
            from utils.currency import convert_amount as _convert
        except Exception:
            def _convert(amount: float, from_code: str, to_code: str) -> float:
                return amount

        # Fetch active goals
        goals_cursor = db.goals.find({"user_id": user_id, "is_completed": False})
        # Sort in Python to avoid index requirements
        goals_list = list(goals_cursor)
        goals_list.sort(key=lambda g: g.get(sort_by) or g.get('created_at') or now_utc())

        allocations: Dict[str, float] = {}
        for g in goals_list:
            gid = str(g.get('_id'))
            target = float(g.get('target_amount', 0) or 0)
            g_ccy = (g.get('currency') or base_ccy).upper()
            # Convert target into base currency for allocation math
            target_in_base = _convert(target, g_ccy, base_ccy)
            if pool <= 0 or target <= 0:
                allocations[gid] = 0.0
                continue
            amt = min(pool, target_in_base)
            allocations[gid] = round(amt, 2)  # allocation stored in base currency
            pool = round(pool - amt, 2)

        return allocations

    # -------- AI Enhancement Methods (reintroduced & adapted) --------
    @staticmethod
    async def _ai_enhance_goal(goal_id: Union[str, ObjectId], goal_data: Union[GoalInDB, Dict[str, Any]], db, ai_engine):
        """Async AI enhancement for a goal (priority, plan, metadata)."""
        from models.user import User  # local import to minimize circular refs
        from utils.ai_helper import run_goal_priority_analysis
        try:
            if isinstance(goal_id, ObjectId):
                goal_oid = goal_id
            else:
                goal_oid = ObjectId(goal_id)

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

            balance_info = user_obj.get_lifetime_transaction_summary()
            monthly_history = user_obj.get_recent_income_expense(months=3)

            context = {
                "goal": goal_dict,
                "user_monthly_income": user_obj.monthly_income,
                "user_expected_monthly_income_date": user_obj.usual_income_date,
                "user_balance": balance_info.get('current_balance', 0) if isinstance(balance_info, dict) else balance_info,
                "monthly_history": monthly_history,
                "user_lifetime_summary": user_obj.get_lifetime_transaction_summary(),
                "user_last_3_month_summary": monthly_history,
                "today": now_utc().isoformat(),
                "existing_goals": list(db.goals.find({
                    'user_id': user_id_str,
                    'is_completed': False,
                    '_id': {'$ne': goal_oid}
                }))
            }

            ai_analysis = await run_goal_priority_analysis(context, ai_engine)

            db.goals.update_one(
                {'_id': goal_oid},
                {'$set': {
                    'ai_priority': ai_analysis.get('priority_score', 0),
                    'ai_metadata': {
                        'urgency': ai_analysis.get('urgency'),
                        'impact': ai_analysis.get('financial_impact'),
                        'suggestions': ai_analysis.get('suggested_actions')
                    },
                    'ai_plan': ai_analysis.get('summary'),
                    'last_updated': now_utc()
                }}
            )
        except Exception as e:
            # Simple stderr logging; can integrate logger
            print(f"AI enhancement failed for goal {goal_id}: {e}\n{traceback.format_exc()}")

    @staticmethod
    def enhance_goal_background(goal: GoalInDB, db, ai_engine):
        """Spawn a daemon thread to run AI enhancement."""
        def runner():
            asyncio.run(Goal._ai_enhance_goal(goal.id, goal, db, ai_engine))
        threading.Thread(target=runner, daemon=True).start()

    @staticmethod
    def get_prioritized(user_id: str, db) -> List[dict]:
        goals = db.goals.find({'user_id': user_id}).sort('ai_priority', -1)
        return [GoalInDB(**g).model_dump(by_alias=True) for g in goals]

    @staticmethod
    def mark_as_completed(user_id: str, goal_id: ObjectId, db):
        db.goals.update_one(
            {'_id': goal_id, 'user_id': user_id},
            {'$set': {'is_completed': True, 'completed_date': now_utc(), 'last_updated': now_utc()}}
        )

