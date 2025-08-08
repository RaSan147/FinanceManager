from datetime import datetime, timedelta
import json
from bson import ObjectId
from models.user import User
from utils.ai_priority_engine import FinancialBrain

class SpendingAdvisor:
    def __init__(self, ai_engine: FinancialBrain, db):
        self.ai = ai_engine
        self.db = db

    def evaluate_purchase(self, user_id, item_data):
        # Build context (simple version)
        user = self.db.users.find_one({'_id': ObjectId(user_id)}) or {}
        occupation = user.get('occupation', 'user') or 'user'
        weekly_spending = list(self.db.transactions.find({
            'user_id': user_id,
            'date': {'$gte': datetime.utcnow() - timedelta(days=7)},
            'type': 'expense'
        }))
        balance = self._calculate_balance(user_id)
        last_3_months_transactions = User.get_N_month_income_expense(user_id, self.db)
        usual_income_date = user.get('usual_income_date', None)

        # Prompt for AI
        prompt = (
            f"Should a {occupation} make this purchase?\n"
            f"Item: {item_data['description']} (${item_data['amount']})\n"
            f"Category: {item_data.get('category', 'Auto-detect')}\n"
            f"Tags: {item_data.get('tags', [])}\n"
            f"Today: {datetime.utcnow().isoformat()}\n"
            f"Weekly spending: ${sum(t['amount'] for t in weekly_spending)}\n"
            f"Current balance: ${balance}\n"
            f"User income: ${user.get('monthly_income', 0)}\n"
            f"Usual income date (day of month): {usual_income_date}\n"
            f"Last 3 months transactions: {last_3_months_transactions}\n\n"
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