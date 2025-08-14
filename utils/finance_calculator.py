# finance_utils.py
from datetime import datetime, timezone
from utils.timezone_utils import now_utc, ensure_utc
from collections import defaultdict
from typing import Any

def get_transactions(user_id, db, start_date=None, end_date=None):
    """Fetch transactions for a user with optional date filtering."""
    query = {'user_id': user_id}
    if start_date and end_date:
        query['date'] = {'$gte': start_date, '$lt': end_date}
    return list(db.transactions.find(query))


def calculate_summary(user_id, db, start_date, end_date):
    """Calculate income, expenses, savings, and category breakdowns for a given period."""
    transactions = get_transactions(user_id, db, start_date, end_date)

    total_income = 0.0
    total_expenses = 0.0
    income_categories = defaultdict(float)
    expense_categories = defaultdict(float)

    for t in transactions:
        amount = round(t['amount'], 2)
        if t['type'] == 'income':
            total_income += amount
            income_categories[t['category']] += amount
        elif t['type'] == 'expense':
            total_expenses += amount
            expense_categories[t['category']] += amount

    return {
        'total_income': round(total_income, 2),
        'total_expenses': round(total_expenses, 2),
        'savings': round(total_income - total_expenses, 2),
        'income_categories': dict(income_categories),
        'expense_categories': dict(expense_categories),
        'transaction_count': len(transactions)
    }


def calculate_monthly_summary(user_id, db, year=None, month=None):
    """Wrapper for calculating the current or specified month's summary."""
    today = now_utc()
    if year is None:
        year = today.year
    if month is None:
        month = today.month

    start_date = ensure_utc(datetime(year, month, 1))
    if month == 12:
        end_date = ensure_utc(datetime(year + 1, 1, 1))
    else:
        end_date = ensure_utc(datetime(year, month + 1, 1))

    summary = calculate_summary(user_id, db, start_date, end_date)
    summary['month'] = start_date.strftime('%B %Y')
    return summary


def get_N_month_income_expense(user_id, db, n=3) -> list[dict[str, Any]]:
    """Get income and expenses for the last N months."""
    now = now_utc()
    results = []
    for i in range(n):
        year = now.year
        month = now.month - i
        while month <= 0:
            month += 12
            year -= 1
        results.append(calculate_monthly_summary(user_id, db, year, month))
    return results


def calculate_lifetime_transaction_summary(user_id, db):
    """Get lifetime totals for a user."""
    transactions = get_transactions(user_id, db)
    return {
        'total_income': round(sum(t['amount'] for t in transactions if t['type'] == 'income'), 2),
        'total_expenses': round(sum(t['amount'] for t in transactions if t['type'] == 'expense'), 2),
        'current_balance': round(sum(t['amount'] if t['type'] == 'income' else -t['amount'] for t in transactions), 2),
        'total_transactions': len(transactions)
    }
