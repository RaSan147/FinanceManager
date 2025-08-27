# finance_utils.py
from datetime import datetime, timezone, timedelta
from utils.timezone_utils import now_utc, ensure_utc
from collections import defaultdict
from typing import Any, Dict, cast, List, Tuple, Optional
import uuid

# ---------------- In-memory session cache -----------------
# A lightweight (process-local) cache to avoid multiple Mongo round trips during
# a single higher-level operation (e.g. building AI analysis). A caller creates
# a cache session (create_cache_session) which pre-loads all user transactions
# once. Subsequent calls to the existing helper functions can pass cache_id to
# reuse that list with pure-Python filtering, sorting, and pagination.
#
# Not persistent and safe only for the lifetime of the Python process. Caller
# is responsible for discarding cache_id when done. Memory growth is bounded by
# explicit drop_cache_session or process lifetime.

_TX_CACHE: dict[str, Dict[str, Any]] = {}
_CACHE_KEY_TRANSACTIONS = 'transactions'


def create_cache_session(user_id: str, db) -> str:
    """Create a cache session for a user and return cache_id.

    Loads all user transactions once. Returns UUID4 string.
    If a session already exists for same user with identical data needs, a new
    session is still created (isolation). Caller should drop when finished.
    """
    cache_id = str(uuid.uuid4())
    all_tx = list(db.transactions.find({'user_id': user_id}))
    _TX_CACHE[cache_id] = {
        'user_id': user_id,
        _CACHE_KEY_TRANSACTIONS: all_tx,
        'created_at': now_utc(),
        'count': len(all_tx)
    }
    return cache_id


def drop_cache_session(cache_id: str) -> None:
    """Remove a cache session (idempotent)."""
    _TX_CACHE.pop(cache_id, None)


def _get_cached_transactions(cache_id: Optional[str], user_id: str) -> Optional[List[Dict[str, Any]]]:
    if not cache_id:
        return None
    entry = _TX_CACHE.get(cache_id)
    if not entry or entry.get('user_id') != user_id:
        return None
    return entry.get(_CACHE_KEY_TRANSACTIONS)  # type: ignore

# Shared duration map (approximate days) for period summaries
DURATION_MAP: dict[str, int] = {
    'day': 1,
    'week': 7,
    'month': 30,  # rolling 30 day window (not calendar aware) for quick summaries
    'year': 365
}

def get_transactions(
    user_id: str,
    db,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    *,
    sort: list[tuple[str, int]] | None = None,
    skip: int | None = None,
    limit: int | None = None,
    cache_id: str | None = None,
    clean: bool = False
) -> list[Dict[str, Any]]:
    """Fetch transactions for a user (Mongo) OR from an in-memory cache session.

    When cache_id is provided (and valid), all filtering/sorting/pagination is
    performed in Python on the preloaded list to eliminate extra DB queries.
    The behavioral contract matches Mongo usage for common operations.
    """
    def cleaner(transactions:List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove ID and UserID fields from transactions."""
        for t in transactions:
            t.pop('id', None)
            t.pop("_id", None)
            t.pop('user_id', None)
        return transactions

    cached = _get_cached_transactions(cache_id, user_id)
    if cached is not None:
        data = cached
        # Date filter (simulate Mongo range if both provided)
        if start_date and end_date:
            s_dt = ensure_utc(start_date)
            e_dt = ensure_utc(end_date)
            # s_dt and e_dt should be timezone-aware datetimes (ensure_utc returns dt or None; with input dt -> not None)
            if s_dt is None or e_dt is None:
                return []  # defensive, shouldn't happen
            tmp = []
            for t in data:
                d = ensure_utc(t.get('date'))
                if d and s_dt <= d < e_dt:
                    tmp.append(t)
            data = tmp
        # Sort: Mongo allows list of (field, direction)
        if sort:
            for field, direction in reversed(sort):  # apply in reverse for stability
                reverse = direction == -1
                data.sort(key=lambda t, f=field: (t.get(f) is None, t.get(f)), reverse=reverse)
        # Skip & limit
        if skip:
            data = data[skip:]
        if limit:
            data = data[:limit]


        data = list(data)
        if clean:
            data = cleaner(data)
        return data

    # Fallback to Mongo query path
    query: Dict[str, Any] = {'user_id': user_id}
    if start_date and end_date:
        query['date'] = {'$gte': ensure_utc(start_date), '$lt': ensure_utc(end_date)}
    cursor = db.transactions.find(query)
    if sort:
        cursor = cursor.sort(sort)
    if skip:
        cursor = cursor.skip(skip)
    if limit:
        cursor = cursor.limit(limit)

    data = list(cursor)

    if clean:
        data = cleaner(data)
    return data


def calculate_summary(user_id, db, start_date: datetime, end_date: datetime, *, cache_id: str | None = None):
    """Calculate income, expenses, savings, category breakdowns for a given period.

    NOTE: Core aggregation function used by higher level helpers. Keeps return shape stable.
    """
    transactions = get_transactions(user_id, db, start_date, end_date, cache_id=cache_id)

    total_income = 0.0
    total_expenses = 0.0
    income_categories: defaultdict[str, float] = defaultdict(float)
    expense_categories: defaultdict[str, float] = defaultdict(float)

    for t in transactions:
        amount = round(t.get('amount', 0.0), 2)
        t_type = t.get('type')
        category = t.get('category', 'uncategorized')
        if t_type == 'income':
            total_income += amount
            income_categories[category] += amount
        elif t_type == 'expense':
            total_expenses += amount
            expense_categories[category] += amount

    return {
        'total_income': round(total_income, 2),
        'total_expenses': round(total_expenses, 2),
        'savings': round(total_income - total_expenses, 2),
        'income_categories': dict(income_categories),
        'expense_categories': dict(expense_categories),
        'transaction_count': len(transactions)
    }


def calculate_period_summary(user_id: str, db, days: int, *, cache_id: str | None = None) -> dict[str, Any]:
    """High level helper: summary for the last N days ending now.

    Adds from_date / to_date keys for convenience.
    """
    end_date = now_utc()
    start_date = end_date - timedelta(days=days)
    summary = calculate_summary(user_id, db, start_date, end_date, cache_id=cache_id)

    # Derive earliest actual transaction date (may be later than start_date if no earlier tx)
    tx_dates = [ensure_utc(t.get('date')) for t in get_transactions(user_id, db, start_date, end_date, cache_id=cache_id)]
    tx_dates = [d for d in tx_dates if d is not None]
    earliest = min(tx_dates) if tx_dates else ensure_utc(start_date)
    summary.update({
        'from_date': earliest,
        'to_date': end_date
    })
    return summary


def get_expense_amounts_for_period(user_id: str, db, days: int, *, cache_id: str | None = None) -> list[float]:
    """Return just the expense amounts for the last N days (utility for sparkline / charts)."""
    end_date = now_utc()
    start_date = end_date - timedelta(days=days)
    return [
        round(t.get('amount', 0.0), 2)
        for t in get_transactions(user_id, db, start_date, end_date, cache_id=cache_id)
        if t.get('type') == 'expense'
    ]


def calculate_monthly_summary(user_id, db, year=None, month=None, *, cache_id: str | None = None):
    """Wrapper for calculating the current or specified month's summary."""
    today = now_utc()
    if year is None:
        year = today.year
    if month is None:
        month = today.month

    start_date = cast(datetime, ensure_utc(datetime(year, month, 1)))
    if month == 12:
        end_date = cast(datetime, ensure_utc(datetime(year + 1, 1, 1)))
    else:
        end_date = cast(datetime, ensure_utc(datetime(year, month + 1, 1)))

    summary = calculate_summary(user_id, db, start_date, end_date, cache_id=cache_id)
    summary['month'] = start_date.strftime('%B %Y')
    
    return summary


def get_N_month_income_expense(user_id, db, n=3, *, cache_id: str | None = None) -> list[dict[str, Any]]:
    """Get income and expenses for the last N months."""
    now = now_utc()
    results = []
    for i in range(n):
        year = now.year
        month = now.month - i
        while month <= 0:
            month += 12
            year -= 1
        results.append(calculate_monthly_summary(user_id, db, year, month, cache_id=cache_id))
    return results


def calculate_lifetime_transaction_summary(user_id, db, *, cache_id: str | None = None):
    """Get lifetime totals for a user."""
    transactions = get_transactions(user_id, db, cache_id=cache_id)
    return {
        'total_income': round(sum(t['amount'] for t in transactions if t.get('type') == 'income'), 2),
        'total_expenses': round(sum(t['amount'] for t in transactions if t.get('type') == 'expense'), 2),
        'current_balance': round(sum(t['amount'] if t.get('type') == 'income' else -t.get('amount', 0) for t in transactions), 2),
        'total_transactions': len(transactions),
        "currency": transactions[0]['base_currency'] if transactions else 'USD'
    }

# Public cache-related helpers exported for external use.
__all__ = [
    'DURATION_MAP',
    'create_cache_session', 'drop_cache_session', 'get_transactions',
    'calculate_summary', 'calculate_period_summary', 'get_expense_amounts_for_period',
    'calculate_monthly_summary', 'get_N_month_income_expense', 'calculate_lifetime_transaction_summary'
]
