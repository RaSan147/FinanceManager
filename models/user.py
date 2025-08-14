# user.py
from bson import ObjectId
from flask_login import UserMixin
from datetime import datetime, timedelta
from flask_pymongo.wrappers import Database
from datetime import timezone
from utils.finance_calculator import (
    get_N_month_income_expense,
    calculate_lifetime_transaction_summary
)
# Added timezone helpers
from utils.timezone_utils import now_utc, ensure_utc

DURATION_MAP = {
    "day": 1,
    'week': 7,
    'month': 30,
    'year': 365
}

class User(UserMixin):
    def __init__(self, user_data, db: Database):
        self.id = str(user_data['_id'])
        self.email = user_data['email']
        self.name = user_data.get('name', '')
        self.created_at = user_data.get('created_at')
        self.occupation = user_data.get('occupation', '')  # Added occupation field
        self.usual_income_date = user_data.get('usual_income_date', None)
        self.monthly_income = user_data.get('monthly_income', 0)
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

    def get_this_duration_details(self, duration_type:str='week') -> list:
        """
        Returns total spending for the current week or month.
        
        Args:
            duration_type (str): The duration type to filter by ('week', 'day', 'month', 'year')
        """

        if duration_type not in DURATION_MAP:
            raise ValueError("Invalid duration type. Choose from 'week', 'month', or 'year'.")
        return list(t['amount'] for t in self.db.transactions.find({
                'user_id': self.id,
                'date': {'$gte': now_utc() - timedelta(days=DURATION_MAP[duration_type])},
                'type': 'expense'
            }))
        return []

    def get_this_duration_summary(self, duration_type:str='week') -> dict:
        """
        Returns total income, spending for the last duration.

        Args:
            duration_type (str): The duration type to filter by ('week', 'day', 'month', 'year')
        """

        in_transactions = list(t for t in self.db.transactions.find({
            'user_id': self.id,
            'date': {'$gte': now_utc() - timedelta(days=DURATION_MAP[duration_type])},
            'type': 'income'
        }))

        out_transactions = list(t for t in self.db.transactions.find({
            'user_id': self.id,
            'date': {'$gte': now_utc() - timedelta(days=DURATION_MAP[duration_type])},
            'type': 'expense'
        }))

        # Normalize dates to UTC aware before min
        all_dates = [d for d in (ensure_utc(t.get('date')) for t in in_transactions + out_transactions) if d is not None]
        oldest_date = min(all_dates) if all_dates else None

        return {
            "total_income": sum(t['amount'] for t in in_transactions),
            "total_expenses": sum(t['amount'] for t in out_transactions),
            "from_date": oldest_date,
            "to_date": now_utc()
        }

    def get_lifetime_transaction_summary(self):
        """
        Returns lifetime totals for the user:
        - total_income
        - total_expenses
        - current_balance
        - total_transactions
        """
        return calculate_lifetime_transaction_summary(self.id, self.db)
