from bson import ObjectId
from flask_login import UserMixin


class User(UserMixin):
    def __init__(self, user_data):
        self.id = str(user_data['_id'])
        self.email = user_data['email']
        self.name = user_data.get('name', '')
        self.created_at = user_data.get('created_at')
        self.occupation = user_data.get('occupation', '')  # Added occupation field

    @staticmethod
    def get_N_month_income_expense(user_id, db, n=3):
        """
        Returns a list of dicts for the past 3 months, each with:
        - month (e.g. 'August 2025')
        - total_income
        - total_expenses
        """
        from datetime import datetime, timedelta
        import calendar
        now = datetime.utcnow()
        results = []
        for i in range(n):
            # Get the first day of the month i months ago
            year = now.year
            month = now.month - i
            while month <= 0:
                month += 12
                year -= 1
            first_day = datetime(year, month, 1)
            # Get the first day of the next month
            if month == 12:
                next_month = datetime(year + 1, 1, 1)
            else:
                next_month = datetime(year, month + 1, 1)
            transactions = list(db.transactions.find({
                'user_id': user_id,
                'date': {'$gte': first_day, '$lt': next_month}
            }))
            total_income = round(sum(t['amount'] for t in transactions if t['type'] == 'income'), 2)
            total_expenses = round(sum(t['amount'] for t in transactions if t['type'] == 'expense'), 2)
            results.append({
                'month': first_day.strftime('%B %Y'),
                'total_income': total_income,
                'total_expenses': total_expenses
            })
        return results