from datetime import datetime, timedelta

def calculate_monthly_summary(user_id, db):
    # Get the first and last day of the current month
    today = datetime.utcnow()
    first_day = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # First day of next month
    if first_day.month == 12:
        first_day_next_month = first_day.replace(year=first_day.year + 1, month=1)
    else:
        first_day_next_month = first_day.replace(month=first_day.month + 1)
    # Query using $gte and $lt
    transactions = list(db.transactions.find({
        'user_id': user_id,
        'date': {'$gte': first_day, '$lt': first_day_next_month}
    }))
    
    # Calculate totals
    total_income = 0
    total_expenses = 0
    expense_categories = {}
    income_categories = {}
    
    for t in transactions:
        if t['type'] == 'income':
            total_income += t['amount']
            income_categories[t['category']] = income_categories.get(t['category'], 0) + t['amount']
        else:
            total_expenses += t['amount']
            expense_categories[t['category']] = expense_categories.get(t['category'], 0) + t['amount']
    
    savings = total_income - total_expenses
    
    return {
        'month': first_day.strftime('%B %Y'),
        'total_income': total_income,
        'total_expenses': total_expenses,
        'savings': savings,
        'income_categories': income_categories,
        'expense_categories': expense_categories
    }

def calculate_goal_progress(goal, monthly_summary):
    if goal['type'] == 'savings':
        # For savings goals, progress is based on monthly savings
        remaining_months = max((goal['target_date'] - datetime.utcnow()).days / 30, 1)
        required_monthly = goal['target_amount'] / remaining_months
        current_monthly = monthly_summary['savings']
        progress = min((current_monthly / required_monthly) * 100, 100)
        return {
            'progress_percent': round(progress, 1),
            'current': current_monthly,
            'required': required_monthly
        }
    else:
        # For purchase goals, progress is based on accumulated savings
        progress = min((monthly_summary['savings'] / goal['target_amount']) * 100, 100)
        return {
            'progress_percent': round(progress, 1),
            'current': monthly_summary['savings'],
            'required': goal['target_amount']
        }

def calculate_total_balance(user_id, db):
    transactions = list(db.transactions.find({'user_id': user_id}))

    income = sum(t['amount'] for t in transactions if t['type'] == 'income')
    expenses = sum(t['amount'] for t in transactions if t['type'] == 'expense')

    return round(income - expenses, 2)
