from datetime import datetime, timedelta, timezone
import json
from bson import ObjectId
from flask_pymongo.wrappers import Database

from models.user import User
from models.goal import Goal, GoalInDB
from utils.ai_engine import FinancialBrain
from utils.ai_helper import get_purchase_advice

class SpendingAdvisor:
    def __init__(self, ai_engine: FinancialBrain, db: Database):
        self.ai = ai_engine
        self.db = db

    def evaluate_purchase(self, user_id, item_data):
        """Return structured AI purchase advice for a prospective transaction."""
        user_doc = self.db.users.find_one({'_id': ObjectId(user_id)})
        if not user_doc:
            return {
                "recommendation": "no",
                "reason": "User not found.",
                "alternatives": [],
                "impact": "unknown"
            }

        user_obj = User(user_doc, self.db)
        weekly_spending = user_obj.get_this_duration_details(duration_type='week')
        last_3_months_transactions = user_obj.get_recent_income_expense(months=3)
        lifetime_summary = user_obj.get_lifetime_transaction_summary()
        balance = lifetime_summary.get('current_balance', 0)
        usual_income_date = user_doc.get('usual_income_date')
        active_goals: list[GoalInDB] = Goal.get_active_goals(user_id, self.db)

        return get_purchase_advice(
            user=user_obj,
            item_data=item_data,
            weekly_spending=weekly_spending,
            balance=balance,
        )