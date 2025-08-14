import json
import os
from google import genai
from google.genai import types

from models.user import User
from .ai_engine import FinancialBrain

# Expect: export GEMINI_API_KEY="..."
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

SYSTEM = {"role": "system", "content": "You are a helpful financial advisor."}
def default_serializer(obj):
    if hasattr(obj, 'isoformat'):
        return obj.isoformat()
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")


def remove_markdown_code(data: str, md_type='json') -> str:
    start_fence = f"```{md_type}\n"
    end_fence = "```"

    if data.startswith(start_fence):
        data = data[len(start_fence):]

    if data.endswith(end_fence):
        data = data[:-len(end_fence)]

    return data.strip()

def _make_gemini_response(prompt):
    # gemini-2.5-pro is highest quality but hits quota faster than flash models.
    resp = client.models.generate_content(
        model="gemini-2.5-pro",
        contents=prompt
    )
    return str(resp.text).strip()

def get_ai_analysis(monthly_summary, goals, user: User):
    user_name = user.name

    monthly_income = user.monthly_income
    monthly_income_date = user.usual_income_date

    occupation = user.occupation
    lifetime_data = user.get_lifetime_transaction_summary()
    transaction_count = monthly_summary.get("transaction_count", "Unknown")
    income_categories = monthly_summary.get("income_categories", {})
    expense_categories = monthly_summary.get("expense_categories", {})

    prompt = (
        f"You are a helpful financial advisor.\n\n"
        f"User: {user_name}\n"
        f"Occupation: {occupation}\n"

        + ((
            f"Monthly Salary: ${monthly_income:,.2f}\n"
            f"Monthly Salary Date (day of month): {monthly_income_date}\n"
        ) if monthly_income_date else "") +

        f"Lifetime Transaction Summary: {lifetime_data}\n"
        f"This years Transaction Summary: {user.get_this_duration_summary(duration_type='year')}\n"
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

        "\n\nMake sure everything is in HTML, not in markdown. Feel free to use inline css (not much recommanded) [Note, it will be shown in sidebar. So avoid h1, h2 or extra big text, Do not force bg color, using bootstrap with clean UI motivation. BG/font color is handled by body.dark-mode/body [not .dark-mode]]"
    )
    return remove_markdown_code(_make_gemini_response(prompt), "html")

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


def get_purchase_advice(user: User, item_data: dict, weekly_spending: list, balance: float,
                        last_3_months_summary, usual_income_date, lifetime_summary=None):
    """Generate structured purchase advice JSON for a potential expense.

    Parameters:
      user: User object
      item_data: {description, amount, category?, tags?, urgency?}
      weekly_spending: list of weekly transactions (raw list)
      balance: current numeric balance
      last_3_months_summary: output of user.get_recent_income_expense(months=3)
      usual_income_date: int | None
      lifetime_summary: precomputed lifetime summary (optional, avoids repeat call)

    Returns dict with keys: recommendation, reason, alternatives, impact
    """
    lifetime_summary = lifetime_summary or user.get_lifetime_transaction_summary()
    total_week_spend = sum(t['amount'] for t in weekly_spending)

    prompt = (
        f"You are an objective financial advisor. Assess whether the user should buy an item.\n"
        f"User occupation: {user.occupation}\n"
        f"Item: {item_data.get('description')} (${item_data.get('amount')})\n"
        f"Category: {item_data.get('category', 'Auto-detect')}\n"
        f"Tags: {item_data.get('tags', [])}\n"
        f"Urgency: {item_data.get('urgency', 'unspecified')}\n"
        f"Weekly spending (total): ${total_week_spend}\n"
        f"Current balance: ${balance}\n"
        f"Monthly income: ${user.monthly_income or 0}\n"
        f"Usual income day-of-month: {usual_income_date}\n"
        f"Last 3 months summary: {last_3_months_summary}\n"
        f"Lifetime summary: {lifetime_summary}\n\n"
        "Return STRICT JSON ONLY (NO extra text, NO markdown): "
        "{\n"
        "  \"recommendation\": \"yes|no|maybe\",\n"
        "  \"reason\": \"Clear concise rationale (<220 chars).\",\n"
        "  \"alternatives\": [\"short alternative 1\", \"short alternative 2\"],\n"
        "  \"impact\": \"Brief statement of budget/goal impact.\"\n"
        "}"
    )

    raw = _make_gemini_response(prompt)
    clean = remove_markdown_code(raw, 'json')
    try:
        data = json.loads(clean)
        # Basic validation
        if not isinstance(data, dict) or 'recommendation' not in data:
            raise ValueError('Missing recommendation key')
    except Exception:
        data = {
            "recommendation": "maybe",
            "reason": "AI response could not be parsed reliably.",
            "alternatives": [],
            "impact": "unknown"
        }
    return data


# ---------------- Goal Priority (centralized prompt) -----------------
def _build_goal_priority_prompt(financial_context: dict) -> str:
    return f"""Analyze this financial context and provide priority assessment:
        
{json.dumps(financial_context, indent=2, default=str)}
        
Return JSON with:
- priority_score (0-100)
- urgency (days_remaining/total_days)
- financial_impact (amount/income)
- health_impact (for students)
- confidence (0-1)
- suggested_actions (array)
- summary (string)

Note: DO NOT USE ANY MARKDOWN OR HTML. Just return a JSON object.
"""

def _parse_goal_priority_response(response: str) -> dict:
    response = (response or '').strip() or '{"error": "Empty response from AI"}'
    if response.startswith("```json"):
        response = response[7:].strip()
    if response.endswith("```"):
        response = response[:-3].strip()
    try:
        data = json.loads(response)
        if not isinstance(data, dict):
            raise ValueError("Not a JSON object")
        if 'priority_score' not in data:
            data.setdefault('priority_score', 50)
        return data
    except Exception:
        return {
            "priority_score": 50,
            "urgency": 0.5,
            "financial_impact": 0.3,
            "health_impact": 0,
            "confidence": 0,
            "suggested_actions": ["Review manually"],
            "summary": "Automatic fallback response (parse failure)."
        }

async def run_goal_priority_analysis(financial_context: dict, ai_engine:FinancialBrain) -> dict:
    """Async helper to get goal priority analysis using centralized prompt."""
    prompt = _build_goal_priority_prompt(financial_context)
    try:
        if hasattr(ai_engine, '_async_get_ai_response'):
            raw = await ai_engine._async_get_ai_response(prompt)
        else:
            raw = ai_engine._get_ai_response(prompt)  # type: ignore
    except Exception as e:
        raw = json.dumps({"error": str(e)})
    return _parse_goal_priority_response(raw)
