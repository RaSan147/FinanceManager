# user.py
from bson import ObjectId
from flask_login import UserMixin
from datetime import datetime, timedelta
from flask_pymongo.wrappers import Database
from datetime import timezone
from utils.finance_calculator import (
    get_N_month_income_expense,
    calculate_lifetime_transaction_summary,
    calculate_period_summary,
    get_expense_amounts_for_period,
    DURATION_MAP,
    get_transactions
)
# Added timezone helpers
from utils.timezone_utils import now_utc, ensure_utc

"""Duration map moved to finance_calculator.DURATION_MAP to ensure single source of truth."""

class User(UserMixin):
    id: str
    email: str
    name: str
    created_at: datetime | None
    occupation: str
    usual_income_date: int | None
    monthly_income: float
    default_currency: str
    monthly_income_currency: str
    db: Database

    def __init__(self, user_data, db: Database):
        # Core identity and profile
        self.id = str(user_data['_id'])
        self.email = user_data['email']
        self.name = user_data.get('name', '')
        # UI / localization preferences
        self.language = user_data.get('language', 'en')  # default English
        self.created_at = user_data.get('created_at')
        self.occupation = user_data.get('occupation', '')
        self.usual_income_date = user_data.get('usual_income_date', None)
        # Financial profile
        self.monthly_income = user_data.get('monthly_income', 0)
        # Currency preferences
        self.default_currency = user_data.get('default_currency', 'USD')
        self.monthly_income_currency = user_data.get('monthly_income_currency', self.default_currency)
        # DB handle
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

    def get_this_duration_details(self, duration_type: str = 'week') -> list[dict]:
        """Return full financial details for a rolling duration window (for charts/sparklines)."""
        if duration_type not in DURATION_MAP:
            raise ValueError("Invalid duration type. Choose from 'day', 'week', 'month', 'year'.")
        return get_transactions(
            self.id,
            self.db,
            start_date=now_utc() - timedelta(days=DURATION_MAP[duration_type]),
            end_date=now_utc()
        )

    def get_this_duration_summary(self, duration_type: str = 'week') -> dict:
        """Return full financial summary for a rolling duration window (income, expenses, savings)."""
        if duration_type not in DURATION_MAP:
            raise ValueError("Invalid duration type. Choose from 'day', 'week', 'month', 'year'.")
        return calculate_period_summary(self.id, self.db, DURATION_MAP[duration_type])

    def get_lifetime_transaction_summary(self):
        """
        Returns lifetime totals for the user:
        - total_income
        - total_expenses
        - current_balance
        - total_transactions
        """
        return calculate_lifetime_transaction_summary(self.id, self.db)
