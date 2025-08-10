from datetime import datetime, timedelta
import json
from bson import ObjectId
from flask_pymongo.wrappers import Database

from models.user import User
from utils.ai_priority_engine import FinancialBrain

class SpendingAdvisor:
    def __init__(self, ai_engine: FinancialBrain, db:Database):
        self.ai = ai_engine
        self.db = db

    def evaluate_purchase(self, user_id, item_data):
        # Build context (simple version)
        user = self.db.users.find_one({'_id': ObjectId(user_id)})
        user_obj = User(user, self.db)
        weekly_spending = user_obj.get_this_duration_details(week=True)
        balance = self._calculate_balance(user_id)
        last_3_months_transactions = user_obj.get_recent_income_expense(months=3)
        usual_income_date = user.get('usual_income_date', None)

        # Prompt for AI
        prompt = (
            f"Should a {user_obj.occupation} make this purchase?\n"
            f"Item: {item_data['description']} (${item_data['amount']})\n"
            f"Category: {item_data.get('category', 'Auto-detect')}\n"
            f"Tags: {item_data.get('tags', [])}\n"
            f"Today: {datetime.utcnow().isoformat()}\n"
            f"Weekly spending: ${sum(t['amount'] for t in weekly_spending)}\n"
            f"Current balance: ${balance}\n"
            f"User income: ${user.get('monthly_income', 0)}\n"
            f"Usual income date (day of month): {usual_income_date}\n"
            f"Last 3 months transactions: {last_3_months_transactions}\n\n"
            f"Lifetime status: {user_obj.get_lifetime_transaction_summary()}\n\n"
            "Respond with JSON: "
            '{"recommendation": "yes/no/maybe", "reason": "...", "alternatives": [], "impact": "..."}'
        )

        # Get AI response
        ai_response = self.ai._get_ai_response(prompt)
        try:
            advice = json.loads(ai_response)
        except Exception:
            advice = {
                "recommendation": "maybe",
                "reason": "AI response could not be parsed.",
                "alternatives": [],
                "impact": "unknown"
            }
        return advice

    def _calculate_balance(self, user_id):
        transactions = list(self.db.transactions.find({'user_id': user_id}))
        income = sum(t['amount'] for t in transactions if t['type'] == 'income')
        expenses = sum(t['amount'] for t in transactions if t['type'] == 'expense')
        return round(income - expenses, 2)