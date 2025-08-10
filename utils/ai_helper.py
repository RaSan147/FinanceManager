import json
import os
from google import genai
from google.genai import types

from models.user import User

# Expect: export GEMINI_API_KEY="..."
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

SYSTEM = {"role": "system", "content": "You are a helpful financial advisor."}
def default_serializer(obj):
    if hasattr(obj, 'isoformat'):
        return obj.isoformat()
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")

def _make_gemini_response(prompt):
    # gemini-2.5-pro is highest quality but hits quota faster than flash models.
    resp = client.models.generate_content(
        model="gemini-2.5-pro",
        contents=prompt
    )
    return resp.text.strip()

def get_ai_analysis(monthly_summary, goals, user: User):
    user_name = user.name
    usual_income_date = user.usual_income_date
    occupation = user.occupation
    lifetime_data = user.get_lifetime_transaction_summary()
    transaction_count = monthly_summary.get("transaction_count", "Unknown")
    income_categories = monthly_summary.get("income_categories", {})
    expense_categories = monthly_summary.get("expense_categories", {})

    prompt = (
        f"You are a helpful financial advisor.\n\n"
        f"User: {user_name}\n"
        f"Occupation: {occupation}\n"
        f"Usual Income Date (day of month): {usual_income_date}\n"
        f"Lifetime Transaction Summary: {lifetime_data}\n"
        f"This month's Income: ${monthly_summary['total_income']:,.2f}\n"
        f"This month's Expenses: ${monthly_summary['total_expenses']:,.2f}\n"
        f"This month's Savings: ${monthly_summary['savings']:,.2f}\n"
        f"This month's Transactions: {transaction_count}\n\n"
        f"This month's Income Breakdown by Category:\n"
        f"{json.dumps(income_categories, indent=2, default=default_serializer)}\n\n"
        f"This month's Expense Breakdown by Category:\n"
        f"{json.dumps(expense_categories, indent=2, default=default_serializer)}\n\n"
        f"Last 3 month Transaction summary:\n"
        f"{json.dumps(user.get_recent_income_expense(months=3), indent=2, default=default_serializer)}\n\n"
        f"Active Goals:\n"
        f"{json.dumps([{'description': g['description'], 'target_amount': g['target_amount'], 'target_date': g['target_date']} for g in goals], indent=2, default=default_serializer)}\n\n"
        "Provide a concise analysis of their financial health, spending patterns, and progress toward goals. "
        "Highlight any concerning patterns or opportunities for improvement. "
        "Offer 2-3 actionable recommendations."
    )
    return _make_gemini_response(prompt)

def get_goal_plan(goal_type, target_amount, target_date, current_finances, user_income):
    prompt = (
        f"You are a helpful financial planner.\n\n"
        f"Goal Type: {goal_type}\n"
        f"Target Amount: ${target_amount:,.2f}\n"
        f"Target Date: {target_date}\n\n"
        f"Current Financial Situation:\n"
        f"Monthly Income: ${user_income:,.2f}\n"
        f"Monthly Expenses: ${current_finances['total_expenses']:,.2f}\n"
        f"Monthly Savings: ${current_finances['savings']:,.2f}\n\n"
        f"Expense Breakdown:\n"
        f"{json.dumps(current_finances['expense_categories'], indent=2, default=default_serializer)}\n\n"
        "Provide a step-by-step plan to achieve this goal. Include:\n"
        "1. Required monthly savings 2. Potential areas to reduce spending 3. Timeline milestones 4. Tips to stay on track"
    )
    return _make_gemini_response(prompt)
