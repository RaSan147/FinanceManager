# finance_utils.py
from datetime import datetime, timezone, timedelta
from utils.timezone_utils import now_utc, ensure_utc
from collections import defaultdict
from typing import Any, Dict, cast, List, Tuple, Optional
from bson import ObjectId
import uuid
import logging
import threading
from utils.mongo_cache import MongoCache

# ---------------------------------------------------------------------------
# Mongo-backed cache (MANDATORY)
# The project now requires a Mongo-backed cache instance. All session creation,
# reads and invalidation are proxied to the MongoCache implementation. This
# removes any in-process fallback to avoid stale/fragmented caching behavior.
#
# Call `enable_mongo_cache(mongo.db)` during application startup (see app.py)
# before any cache-using helpers are invoked. If the cache is not enabled, the
# cache-related functions here will raise RuntimeError to fail fast and make the
# missing initialization obvious.
# ---------------------------------------------------------------------------

# Session TTL used by the Mongo cache (seconds)
_SESSION_TTL_SECONDS = int(60 * 60)  # 1 hour

# When the cached transaction list is larger than this threshold, prefer a
# MongoDB aggregation pipeline rather than materializing many documents into
# memory for each session.
AGGREGATION_THRESHOLD = 1000

# Logger for diagnostics
logger = logging.getLogger(__name__)

# Mandatory process-local MongoCache instance (set via enable_mongo_cache)
_MONGO_CACHE: Optional[MongoCache] = None


def enable_mongo_cache(db) -> MongoCache:
    """Enable a process-local MongoCache instance and return it.

    Call this once at app startup if you want to share cache sessions across
    workers in the same process (note: cross-process sharing still requires a
    shared DB; this provides a shared Mongo-backed cache instance per process).
    """
    global _MONGO_CACHE
    # Let any exceptions propagate — cache is mandatory and startup should
    # fail loudly if the MongoCache can't be created.
    _MONGO_CACHE = MongoCache(db)
    return _MONGO_CACHE


def get_mongo_cache_stats() -> dict:
    """Return stats from the enabled MongoCache or empty stats if disabled."""
    try:
        if _MONGO_CACHE is None:
            return {'enabled': False, 'sessions': 0, 'total_transactions': 0}
        stats = _MONGO_CACHE.get_stats()
        stats.update({'enabled': True})
        return stats
    except Exception:
        return {'enabled': False, 'sessions': 0, 'total_transactions': 0}


def create_cache_session(user_id: str, db) -> str:
    """Create a cache session for a user and return cache_id.

    This function requires the Mongo-backed cache to be enabled via
    `enable_mongo_cache(db)`. It will raise RuntimeError if the cache hasn't
    been initialized. Small user datasets (<= AGGREGATION_THRESHOLD) will be
    materialized and stored in the Mongo cache; larger datasets will store a
    session record without full transactions and callers will rely on
    aggregation for heavy workloads.
    """
    if _MONGO_CACHE is None:
        raise RuntimeError('Mongo-backed cache is not enabled. Call enable_mongo_cache(db) at startup')

    try:
        total_count = int(db.transactions.count_documents({'user_id': user_id}))
    except Exception:
        total_count = 0

    txs = None
    if total_count <= AGGREGATION_THRESHOLD:
        try:
            proj = {'ai_plan': 0, 'notes': 0}
            txs = list(db.transactions.find({'user_id': user_id}, proj).sort([('date', -1), ('created_at', -1)]))
        except Exception:
            logger.exception('create_cache_session: failed to preload transactions for user=%s', user_id)
            txs = None

    cid = _MONGO_CACHE.create_session(user_id, transactions=txs, ttl_seconds=_SESSION_TTL_SECONDS)
    return cid


# NOTE: in-process cleanup/no-op helpers removed — all session lifecycle is
# managed by the MongoCache implementation.


def drop_cache_session(cache_id: str) -> None:
    """Remove a cache session (idempotent).

    This proxies to the Mongo-backed cache and requires it to be enabled.
    """
    if _MONGO_CACHE is None:
        raise RuntimeError('Mongo-backed cache is not enabled. Call enable_mongo_cache(db) at startup')
    try:
        _MONGO_CACHE.drop_session(cache_id)
    except Exception:
        logger.exception('drop_cache_session: failed for %s', cache_id)


def _get_cached_transactions(cache_id: Optional[str], user_id: str) -> Optional[List[Dict[str, Any]]]:
    """Retrieve cached transactions for a session id from the Mongo cache.

    Raises RuntimeError if Mongo cache is not enabled.
    """
    if not cache_id:
        return None
    if _MONGO_CACHE is None:
        raise RuntimeError('Mongo-backed cache is not enabled. Call enable_mongo_cache(db) at startup')
    try:
        s = _MONGO_CACHE.get_session(cache_id)
        if s and s.get('user_id') == user_id:
            txs = s.get('transactions')
            return list(txs) if isinstance(txs, list) else None
    except Exception:
        logger.exception('mongo_cache: failed to read session %s', cache_id)
    return None

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
    # If we have a small in-memory cached list, do Python processing (fast for small N).
    # If no cache or the cached list is large, prefer a Mongo aggregation which
    # runs in C and avoids Python-loop overhead for thousands of transactions.
    cached = _get_cached_transactions(cache_id, user_id)

    if cached is not None and len(cached) <= AGGREGATION_THRESHOLD:
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

        transaction_count = len(transactions)
    else:
        # Build a Mongo aggregation to compute totals and per-category breakdowns.
        try:
            logger.debug(
                "finance_calculator: using aggregation for user=%s start=%s end=%s cached_len=%s",
                user_id, start_date, end_date, (len(cached) if cached is not None else 'None')
            )
            match = {'user_id': user_id}
            if start_date and end_date:
                match['date'] = {'$gte': ensure_utc(start_date), '$lt': ensure_utc(end_date)}

            pipeline = [
                {'$match': match},
                {'$facet': {
                    'type_totals': [
                        {'$group': {'_id': '$type', 'total': {'$sum': '$amount'}, 'count': {'$sum': 1}}}
                    ],
                    'cat_totals': [
                        {'$group': {'_id': {'type': '$type', 'category': {'$ifNull': ['$category', 'uncategorized']}}, 'total': {'$sum': '$amount'}}}
                    ],
                    'tx_count': [
                        {'$group': {'_id': None, 'count': {'$sum': 1}}}
                    ]
                }}
            ]

            res = list(db.transactions.aggregate(pipeline))
            if res:
                out = res[0]
            else:
                out = {'type_totals': [], 'cat_totals': [], 'tx_count': []}

            total_income = 0.0
            total_expenses = 0.0
            income_categories: defaultdict[str, float] = defaultdict(float)
            expense_categories: defaultdict[str, float] = defaultdict(float)

            for tt in out.get('type_totals', []):
                typ = tt.get('_id')
                total = float(tt.get('total') or 0.0)
                if typ == 'income':
                    total_income = round(total, 2)
                elif typ == 'expense':
                    total_expenses = round(total, 2)

            for ct in out.get('cat_totals', []):
                key = ct.get('_id') or {}
                typ = key.get('type')
                cat = key.get('category') or 'uncategorized'
                total = round(float(ct.get('total') or 0.0), 2)
                if typ == 'income':
                    income_categories[cat] += total
                elif typ == 'expense':
                    expense_categories[cat] += total

            txcount = out.get('tx_count') or []
            transaction_count = int(txcount[0].get('count')) if txcount else 0
        except Exception:
            # Log full exception so we can diagnose why aggregation falls back
            try:
                logger.exception("finance_calculator: aggregation failed for user=%s", user_id)
            except Exception:
                # Best-effort logging; never raise from here
                pass
            # Fallback to Python path if aggregation fails for any reason
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

            transaction_count = len(transactions)

    return {
        'total_income': round(total_income, 2),
        'total_expenses': round(total_expenses, 2),
        'savings': round(total_income - total_expenses, 2),
        'income_categories': dict(income_categories),
        'expense_categories': dict(expense_categories),
        'transaction_count': int(transaction_count)
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


def get_cache_stats() -> dict:
    """Return stats from the Mongo-backed cache. Raises if cache not enabled."""
    if _MONGO_CACHE is None:
        raise RuntimeError('Mongo-backed cache is not enabled. Call enable_mongo_cache(db) at startup')
    try:
        stats = _MONGO_CACHE.get_stats()
        stats.update({'enabled': True})
        return stats
    except Exception:
        logger.exception('get_cache_stats failed')
        return {'enabled': True, 'sessions': 0, 'total_transactions': 0}


def drop_user_cache_sessions(user_id: str) -> int:
    """Remove all cache sessions associated with a given user_id.

    Proxies to the Mongo cache implementation and returns the number of
    sessions removed. Raises if the Mongo cache is not enabled.
    """
    if _MONGO_CACHE is None:
        raise RuntimeError('Mongo-backed cache is not enabled. Call enable_mongo_cache(db) at startup')
    try:
        return _MONGO_CACHE.drop_user_sessions(user_id)
    except Exception:
        logger.exception('drop_user_cache_sessions failed for %s', user_id)
        return 0

# Public cache-related helpers exported for external use.
__all__ = [
    'DURATION_MAP',
    'create_cache_session', 'drop_cache_session', 'drop_user_cache_sessions', 'get_transactions',
    'calculate_summary', 'calculate_period_summary', 'get_expense_amounts_for_period',
    'calculate_monthly_summary', 'get_N_month_income_expense', 'calculate_lifetime_transaction_summary', 'get_cache_stats'
]
