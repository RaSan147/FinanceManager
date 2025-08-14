import json
import time
from typing import List, Optional
from bson import ObjectId

from models.user import User
from models.goal import GoalInDB
from utils.timezone_utils import now_utc
from datetime import timedelta
from utils.finance_calculator import (
    create_cache_session,
    drop_cache_session,
    calculate_lifetime_transaction_summary,
    calculate_period_summary,
    get_transactions,
    get_N_month_income_expense,
)
from .ai_engine import FinancialBrain

"""High-level AI helper functions built atop FinancialBrain.

This module centralizes prompt construction for:
 - Sidebar financial analysis (HTML output)
 - Goal planning text output
 - Purchase advice (strict JSON)
 - Goal priority analysis (async JSON)

It defers transport, retries, model selection, and fence stripping to
`FinancialBrain` so we keep a single place for low-level AI concerns.
"""

# Single shared engine instance for helper-level calls.
_BRAIN = FinancialBrain()


# ---------------- Serialization helpers -----------------
def default_serializer(obj):
    """Serialize extra types for json.dumps used in AI prompts.

    Handles:
    - bson.ObjectId -> str
    - datetime/date objects (anything with isoformat attr) -> ISO8601 string
    Falls back to raising TypeError so unexpected types are surfaced early.
    """
    if isinstance(obj, ObjectId):
        return str(obj)
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")


def _strip(text: str, md_type: str) -> str:
    return FinancialBrain.strip_fences(text, md_type)


# ---------------- Prompt Builders -----------------
def _analysis_prompt(monthly_summary, goals: List[GoalInDB], user: User) -> str:
    income_categories = monthly_summary.get("income_categories", {})
    expense_categories = monthly_summary.get("expense_categories", {})

    # Pull multi-period data using a single cached transaction load to reduce Mongo hits.
    cache_id = None
    lifetime_summary = None
    year_summary = None
    last_30_details = []
    recent_3_month = []
    try:
        cache_id = create_cache_session(user.id, user.db)
        lifetime_summary = calculate_lifetime_transaction_summary(user.id, user.db, cache_id=cache_id)
        year_summary = calculate_period_summary(user.id, user.db, 365, cache_id=cache_id)  # rolling year
        end_now = now_utc()
        start_30 = end_now - timedelta(days=30)
        last_30_details = get_transactions(user.id, user.db, start_30, end_now, cache_id=cache_id)[:10]
        recent_3_month = get_N_month_income_expense(user.id, user.db, n=3, cache_id=cache_id)
    except Exception:
        # Fallback to existing per-call helper methods if cache path fails.
        lifetime_summary = user.get_lifetime_transaction_summary()
        year_summary = user.get_this_duration_summary(duration_type='year')
        last_30_details = user.get_this_duration_details(duration_type='month')[:10]
        recent_3_month = user.get_recent_income_expense(months=3)
    finally:
        if cache_id:
            drop_cache_session(cache_id)

    goals_compact = [
        {
            "description": g.description,
            "target_amount": g.target_amount,
            "target_date": g.target_date,
        }
        for g in goals
    ]

    prompt = (
        "You are a helpful financial advisor.\n"
        "Your task: generate a short HTML (no markdown) sidebar report on the user's financial health.\n"
        "Follow these formatting guidelines:\n"
        "- Output must be valid HTML using Bootstrap classes for layout.\n"
        "- Keep inline CSS minimal and avoid overriding theme colors or backgrounds.\n"
        "- Use headings h4–h6 only.\n"
        "- Use concise paragraphs and cards for clarity.\n"
        "- Keep total output under 1000 words, but cover all key financial details.\n"
        "- Amounts are in USD.\n"
        "- Maintain a professional but encouraging tone.\n\n"
        "- Avoid adding financial/balance snapshots or detailed transaction lists (They are already visible in the report)."
        f"User: {user.name}\n"
        f"Occupation: {user.occupation}\n"
        + (
            f"Monthly Salary: ${user.monthly_income:,.2f}\n"
            f"Monthly Salary Date (day of month): {user.usual_income_date}\n"
            if user.usual_income_date else ""
        )
        + f"Current date: {now_utc()}\n"
        f"Lifetime Summary: {lifetime_summary}\n"
        f"This Year Summary: {year_summary}\n"
        f"This Month: Income ${monthly_summary['total_income']:,.2f}, "
        f"Expenses ${monthly_summary['total_expenses']:,.2f}, "
        f"Savings ${monthly_summary['savings']:,.2f}, "
        f"Transactions: {monthly_summary.get('transaction_count', 'Unknown')}\n\n"

        "Income Breakdown by Category:\n"
        f"{json.dumps(income_categories, indent=2, default=default_serializer)}\n\n"
        "Expense Breakdown by Category:\n"
        f"{json.dumps(expense_categories, indent=2, default=default_serializer)}\n\n"

        "Last 30 days transactions:\n"
        f"{json.dumps(last_30_details, indent=2, default=default_serializer)}\n\n"

        "Recent 3-month income/expense summary:\n"
        f"{json.dumps(recent_3_month, indent=2, default=default_serializer)}\n\n"

        "Active Goals:\n"
        f"{json.dumps(goals_compact, indent=2, default=default_serializer)}\n\n"

        "HTML structure to follow: (Recommended, but you can modify as needed)\n"
        "<div class='financial-report'>\n"
        "  <!-- Intro Section -->\n"
        "  <div class='mb-3'>\n"
        "    <p class='text-muted'>[Short friendly overview of financial health]</p>\n"
        "  </div>\n"
        "\n"
        "  <!-- Top Expenses -->\n"
        "  <div class='card mb-3'>\n"
        "    <div class='card-body'>\n"
        "      <h5 class='card-title mb-3'>Top Expenses</h5>\n"
        "      <ul class='list-group list-group-flush small'>\n"
        "        <li class='list-group-item d-flex justify-content-between'><span>[Category]</span><span class='badge bg-secondary rounded-pill'>$[Amount]</span></li>\n"
        "      </ul>\n"
        "    </div>\n"
        "  </div>\n"
        "\n"
        "  <!-- Recommendations -->\n"
        "  <div class='card mb-3'>\n"
        "    <div class='card-body'>\n"
        "      <h5 class='card-title mb-3'>Recommendations & Insights</h5>\n"
        "      <div class='card mb-2 bg-light'>\n"
        "        <div class='card-body p-3'>\n"
        "          <h6 class='card-subtitle mb-2 text-muted'>[Recommendation Title]</h6>\n"
        "          <p class='card-text small'>[Recommendation text]</p>\n"
        "        </div>\n"
        "      </div>\n"
        "    </div>\n"
        "  </div>\n"
        "\n"
        "  <!-- Closing Note -->\n"
        "  <div class='card'>\n"
        "    <div class='card-body text-center'>\n"
        "      <p class='card-text text-muted small mb-0'>[Friendly motivational closing]</p>\n"
        "    </div>\n"
        "  </div>\n"
        "</div>\n"
    )


    return prompt


def _goal_priority_prompt(financial_context: dict) -> str:
    return (
        "Analyze this financial context and provide priority assessment:\n\n"
        f"{json.dumps(financial_context, indent=2, default=str)}\n\n"
        "Return JSON with:\n"
        "- priority_score (0-100)\n"
        "- urgency (days_remaining/total_days)\n"
        "- financial_impact (amount/income)\n"
        "- health_impact (for students)\n"
        "- confidence (0-1)\n"
        "- suggested_actions (array)\n"
        "- summary (string)\n\n"
        "Note: DO NOT USE ANY MARKDOWN OR HTML. Just return a JSON object.\n"
    )


# ---------------- Public API -----------------
def get_ai_analysis(monthly_summary, goals: List[GoalInDB], user: User) -> str:
    """Return HTML analysis for the sidebar (no markdown)."""
    start = time.perf_counter()
    prompt = _analysis_prompt(monthly_summary, goals, user)
    end = time.perf_counter()
    print(f"Prompt generation took {end - start:.2f} seconds")

    start = time.perf_counter()
    raw = _BRAIN.get_text(prompt)
    end = time.perf_counter()
    print(f"AI response generation took {end - start:.2f} seconds")
    return _strip(raw, md_type="html")


def get_goal_plan(goal_type: str, target_amount: float, target_date, current_finances, user_income: float) -> str:
    prompt = (
        "You are a helpful financial planner.\n\n"
        f"Goal Type: {goal_type}\n"
        f"Target Amount: ${target_amount:,.2f}\n"
        f"Target Date: {target_date}\n\n"
        "Current Financial Situation:\n"
        f"Monthly Income: ${user_income:,.2f}\n"
        f"Monthly Expenses: ${current_finances['total_expenses']:,.2f}\n"
        f"Monthly Savings: ${current_finances['savings']:,.2f}\n\n"
        "Expense Breakdown:\n"
        f"{json.dumps(current_finances['expense_categories'], indent=2, default=default_serializer)}\n\n"
        "Provide a step-by-step plan to achieve this goal. Include: 1) required monthly savings 2) spending reductions 3) timeline milestones 4) tips to stay on track."
    )
    return _BRAIN.get_text(prompt)


def get_purchase_advice(
    user: User,
    item_data: dict,
    weekly_spending: list,
    balance: float,
    last_3_months_summary,
    usual_income_date,
    lifetime_summary=None,
    active_goals: List[GoalInDB] | None = None
):
    """Generate structured purchase advice JSON for a potential expense.

    Returns dict with keys: recommendation, reason, alternatives, impact.
    Maintains backward compatible signature for existing callers.
    """
    lifetime_summary = lifetime_summary or user.get_lifetime_transaction_summary()
    # weekly_spending may be a list of raw floats OR transaction dicts. Normalize.
    if weekly_spending and isinstance(weekly_spending[0], (int, float)):
        total_week_spend = round(sum(float(x) for x in weekly_spending), 2)
    else:
        total_week_spend = round(sum(float(getattr(t, 'amount', t.get('amount', 0))) for t in weekly_spending), 2)

    goals_repr = []
    if active_goals:
        for g in active_goals[:5]:  # limit token usage
            try:
                goals_repr.append({
                    'desc': g.description,
                    'target': g.target_amount,
                    'current': getattr(g, 'current_amount', 0),
                    'due': g.target_date.isoformat() if getattr(g, 'target_date', None) else None,
                    'priority': getattr(g, 'ai_priority', None)
                })
            except Exception:
                continue

    prompt = (
        "You are an objective financial advisor. Assess whether the user should buy an item.\n"
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
        f"Active financial goals (capped 5): {goals_repr}\n\n"
        "Return STRICT JSON ONLY (NO extra text, NO markdown, NO comments): {\n"
        "  \"recommendation\": \"yes|no|maybe\",\n"
        "  \"reason\": \"Clear concise rationale (<220 chars).\",\n"
        "  \"alternatives\": [\"short alt 1\", \"short alt 2\"],\n"
        "  \"impact\": \"Brief statement of budget/goal impact.\"\n"
        "}"
    )

    fallback = {
        "recommendation": "maybe",
        "reason": "AI unavailable or parse failure.",
        "alternatives": [],
        "impact": "unknown"
    }

    data = _BRAIN.get_json(prompt, fallback=fallback)
    # minimal sanity
    if 'recommendation' not in data:
        data.update(fallback)
    return data


async def run_goal_priority_analysis(financial_context: dict, ai_engine: FinancialBrain) -> dict:
    """Async helper for goal priority analysis returning structured JSON.

    Accepts an explicit engine (so callers can pass a shared instance).
    """
    prompt = _goal_priority_prompt(financial_context)
    fallback = {
        "priority_score": 50,
        "urgency": 0.5,
        "financial_impact": 0.3,
        "health_impact": 0,
        "confidence": 0,
        "suggested_actions": ["Review manually"],
        "summary": "Fallback (AI unavailable)"
    }
    try:
        data = await ai_engine.aget_json(prompt, fallback=fallback)
    except Exception:
        data = fallback
    if 'priority_score' not in data:
        data['priority_score'] = fallback['priority_score']
    return data

__all__ = [
    'get_ai_analysis',
    'get_goal_plan',
    'get_purchase_advice',
    'run_goal_priority_analysis'
]
