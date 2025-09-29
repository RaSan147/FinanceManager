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
        # Unified sort modes container (primary source of truth for list sort preferences)
        # Merge stored preferences over class defaults so every key exists
        stored = user_data.get('sort_modes', {}) or {}
        self.sort_modes = {**self.DEFAULT_SORT_MODES, **stored}

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

    def get_lifetime_transaction_summary_cached(self, cache_id: str | None = None):
        """Cached variant which accepts a cache_id created by utils.finance_calculator.create_cache_session.

        This lets callers avoid reloading transactions repeatedly within the same request.
        """
        return calculate_lifetime_transaction_summary(self.id, self.db, cache_id=cache_id)

    # --- UI preference helpers ---
    # NOTE: individual shorthand setters like `set_goal_sort` and `set_todo_sort`
    # have been removed in favor of the generic `set_sort_mode(name, sort)` API.

    # --- Generic sort-mode helpers ---
    # --- Class-level configuration for sorting ---
    # Define allowed sort mode values for each named list and the default per-list value.
    SORT_MODE_OPTIONS: dict[str, set[str]] = {
        'goals': {'created_desc', 'created_asc', 'target_date', 'target_date_desc', 'priority'},
        'todo': {'created_desc', 'created_asc', 'updated_desc', 'updated_asc', 'due_date'},
        'diary': {'created_desc', 'created_asc', 'updated_desc', 'updated_asc'},
    }

    DEFAULT_SORT_MODES: dict[str, str] = {
        'goals': 'created_desc',
        'todo': 'created_desc',
        'diary': 'created_desc',
    }

    # Removed get_sorting; use get_sort_mode which always returns a usable default

    def get_sort_mode(self, name: str, default: str | None = None):
        """Return the user's sort mode for `name`, validating against allowed values.

        If the user has no preference, returns the class default for that name. If the
        name is unknown, returns the provided `default` or None.
        """
        if not name:
            return default
        val = (self.sort_modes or {}).get(name)
        allowed = self.SORT_MODE_OPTIONS.get(name)
        if val and allowed and val in allowed:
            return val
        # fall back to class default for the name
        return self.DEFAULT_SORT_MODES.get(name, default)

    def set_sort_mode(self, name: str, sort: str, allowed: set[str] | None = None):
        """Persist a sort mode under `sort_modes.{name}` and update in-memory values.

        If `allowed` is not provided, the class-level `SORT_MODE_OPTIONS` for `name` is used.
        Returns True on success, False if value not allowed or unknown name.
        """
        if allowed is None:
            allowed = self.SORT_MODE_OPTIONS.get(name)
        if not allowed or sort not in allowed:
            return False
        # write into nested dict field
        self.db.users.update_one({'_id': ObjectId(self.id)}, {'$set': {f'sort_modes.{name}': sort}})
        # sync in-memory
        self.sort_modes[name] = sort
        return True

    @classmethod
    def get_by_email(cls, email: str, db: Database):
        user_doc = db.users.find_one({'email': email})
        if not user_doc:
            return None
        return cls(user_doc, db)

    @classmethod
    def get_by_id(cls, user_id: str, db: Database):
        user_doc = db.users.find_one({'_id': ObjectId(user_id)})
        if not user_doc:
            return None
        return cls(user_doc, db)
