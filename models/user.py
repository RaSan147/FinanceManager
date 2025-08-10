# user.py
from bson import ObjectId
from flask_login import UserMixin
from datetime import datetime, timedelta
from flask_pymongo.wrappers import Database

from utils.finance_calculator import (
    get_N_month_income_expense,
    calculate_lifetime_transaction_summary
)


class User(UserMixin):
    def __init__(self, user_data, db: Database):
        self.id = str(user_data['_id'])
        self.email = user_data['email']
        self.name = user_data.get('name', '')
        self.created_at = user_data.get('created_at')
        self.occupation = user_data.get('occupation', '')  # Added occupation field
        self.usual_income_date = user_data.get('usual_income_date', None)
        self.db = db

    def get_recent_income_expense(self, months=3):
        """
        Returns a list of dicts for the past N months with:
        - month (e.g. 'August 2025')
        - total_income
        - total_expenses
        - savings
        - category breakdowns
        """
        return get_N_month_income_expense(self.id, self.db, n=months)

    def get_this_duration_details(self, week=False, month=False) -> list:
        """Returns total spending for the current week or month."""
        if not (week or month) or (week and month):
            raise ValueError("Specify either week=True or month=True")
        if week:
            return list(t['amount'] for t in self.db.transactions.find({
                'user_id': self.id,
                'date': {'$gte': datetime.utcnow() - timedelta(days=7)},
                'type': 'expense'
            }))
        elif month:
            return list(t['amount'] for t in self.db.transactions.find({
                'user_id': self.id,
                'date': {'$gte': datetime.utcnow() - timedelta(days=30)},
                'type': 'expense'
            }))
        return []

    def get_lifetime_transaction_summary(self):
        """
        Returns lifetime totals for the user:
        - total_income
        - total_expenses
        - current_balance
        - total_transactions
        """
        return calculate_lifetime_transaction_summary(self.id, self.db)
