import json
import time
from typing import Any, List, Optional
from bson import ObjectId

from models.user import User
from models.goal import Goal, GoalInDB

from utils.timezone_utils import now_utc
from datetime import datetime, timedelta
from utils.finance_calculator import (
    calculate_monthly_summary,
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


def _compact_goal_with_local_currency(goal_dict:dict|GoalInDB, user: User, lifetime_balance: float) -> dict:
    """Compact goal representation with amounts converted to user's local currency."""
    from utils.currency import currency_service
    compact_goal = Goal.compact_dict(goal_dict)
    goal_currency = compact_goal["currency"]

    compact_goal[f"lifetime_balance_in_{goal_currency}"] = currency_service.convert_amount(lifetime_balance, user.default_currency, goal_currency)

    return compact_goal

def _build_financial_context(user: User) -> dict:
    """
    Build a reusable financial context dictionary for prompts.
    Can be used in goal prioritization, analysis, or other AI-driven features.
    """
    db = user.db
    monthly_summary = calculate_monthly_summary(user.id, db)

    # Default fallbacks
    lifetime_summary = None
    year_summary = None
    last_30D_details = []
    recent_3M_summary = []
    cache_id = None

    try:
        # Use cache for efficiency
        cache_id = create_cache_session(user.id, db)
        lifetime_summary = calculate_lifetime_transaction_summary(user.id, db, cache_id=cache_id)
        year_summary = calculate_period_summary(user.id, db, 365, cache_id=cache_id)
        end_now = now_utc()
        start_30 = end_now - timedelta(days=30)
        last_30D_details = get_transactions(user.id, db, start_30, end_now, cache_id=cache_id, clean=True)
        recent_3M_summary = get_N_month_income_expense(user.id, db, n=3, cache_id=cache_id)

        goals = Goal.get_active_goals(user.id, db)
        compact_goals = [_compact_goal_with_local_currency(g, user, lifetime_summary["current_balance"]) for g in goals]


    finally:
        if cache_id:
            drop_cache_session(cache_id)


    # Simplify goals for JSON serialization

    return {
        "user": {
            "name": user.name,
            "occupation": user.occupation,
            "default_currency": user.default_currency,
            "monthly_income": user.monthly_income,
            "usual_income_date": user.usual_income_date,
        },
        "today": now_utc().isoformat(),
        "monthly_summary": monthly_summary,
        "income_categories": monthly_summary.get("income_categories", {}),
        "expense_categories": monthly_summary.get("expense_categories", {}),
        "lifetime_summary": lifetime_summary,
        "year_summary": year_summary,
        "last_30_days_transactions": last_30D_details,
        "recent_3_months_summary": recent_3M_summary,
        "goals": compact_goals,
    }

# ---------------- Prompt Builders -----------------
def _analysis_prompt(user: User) -> str:

    # Pull multi-period data using a single cached transaction load to reduce Mongo hits.

    financial_context = _build_financial_context(user)

    prompt = (
        "You are a helpful financial advisor.\n"
        "Your task: generate a short HTML (no markdown) sidebar report on the user's financial health.\n"
        "Follow these formatting guidelines:\n"
        "- Output must be valid HTML using Bootstrap classes for layout.\n"
        "- Keep inline CSS minimal and avoid overriding theme colors or backgrounds.\n"
        "- Use headings h4-h6 only.\n"
        "- Use concise paragraphs and cards for clarity.\n"
        "- Keep total output under 1000 words, but cover all key financial details.\n"
        f"- Amounts are in {user.default_currency}.\n"
        "- Maintain a professional but encouraging tone.\n\n"
        "- Avoid duplicating tables/transactions that are already shown elsewhere in the main report."

        f"\n\nUser Context: \n {json.dumps(financial_context, indent=2, default=str)}\n\n"

        "HTML structure to follow: (Recommended, but adapt if needed)\n"
        "<div class='financial-report'>\n"
        "  <!-- Intro Section -->\n"
        "  <div class='mb-3'>\n"
        "    <p class='text-muted'>[Short friendly overview of financial health]</p>\n"
        "  </div>\n"
        "\n"
        "  <!-- Savings & Cashflow Snapshot -->\n"
        "  <div class='card mb-3'>\n"
        "    <div class='card-body'>\n"
        "      <h5 class='card-title mb-3'>Savings & Cashflow</h5>\n"
        "      <p class='small mb-2'>This month you saved <strong>[X%]</strong> of your income.</p>\n"
        "      <div class='progress mb-2' style='height:6px;'>\n"
        "        <div class='progress-bar bg-success' style='width:[X%];'></div>\n"
        "      </div>\n"
        "      <p class='small text-muted mb-0'>[Encouraging note on whether savings trend is positive or needs attention]</p>\n"
        "    </div>\n"
        "  </div>\n"
        "\n"
        "  <!-- Budget Allocation Overview -->\n"
        "  <div class='card mb-3'>\n"
        "    <div class='card-body'>\n"
        "      <h5 class='card-title mb-3'>Where Your Money Goes</h5>\n"
        "      <ul class='list-group list-group-flush small'>\n"
        "        <li class='list-group-item d-flex justify-content-between'><span>Essentials</span><span>[%]</span></li>\n"
        "        <li class='list-group-item d-flex justify-content-between'><span>Discretionary</span><span>[%]</span></li>\n"
        "        <li class='list-group-item d-flex justify-content-between'><span>Investments/Savings</span><span>[%]</span></li>\n"
        "      </ul>\n"
        "    </div>\n"
        "  </div>\n"
        "\n"
        "  <!-- Goals Progress -->\n"
        "  <div class='card mb-3'>\n"
        "    <div class='card-body'>\n"
        "      <h5 class='card-title mb-3'>Your Goals</h5>\n"
        "      <div class='mb-2'>\n"
        "        <p class='small mb-1'><strong>[Goal Name]</strong></p>\n"
        "        <div class='progress' style='height:6px;'>\n"
        "          <div class='progress-bar' role='progressbar' style='width:[X%];'></div>\n"
        "        </div>\n"
        "        <p class='small text-muted mb-0'>[Current vs Target Amount]</p>\n"
        "      </div>\n"
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


def _goal_priority_prompt(user: User, goal: dict) -> str:
    financial_context = _build_financial_context(user)
    compact_goal = _compact_goal_with_local_currency(goal, user, financial_context["lifetime_summary"]["current_balance"])

    return (
        "You are a financial planning assistant. "
        "Your task: evaluate the importance and urgency of the following financial goal, "
        "given the user's overall financial context.\n\n"
        f"{json.dumps(financial_context, indent=2, default=str)}\n\n"

        f"With The given context, you need to evaluate the importance and urgency of the following financial goal:\n"
        f"{json.dumps(compact_goal, indent=2, default=str)}\n\n"
        "Respond with a STRICT JSON object only. No explanations, no markdown, no extra text.\n\n"
        "JSON schema (all keys required unless noted):\n"
        "{\n"
        '  "priority_score": integer (0-100, higher = more important to pursue soon),\n'
        '  "urgency": float (0.0-1.0, representing days_remaining / total_days until target),\n'
        '  "financial_impact": float (goal_amount ÷ monthly_income, capped at 10),\n'
        '  "health_impact": float (0.0-1.0, only relevant for students/health-related goals, else 0),\n'
        '  "confidence": float (0.0-1.0, how confident this assessment is),\n'
        '  "suggested_actions": [array of 2-4 short actionable recommendations],\n'
        '''  "summary": string (1-2 concise sentences summarizing the goal's importance)\n'''
        "}\n\n"
        "Rules:\n"
        "- Use user_balance, income, expenses, and existing_goals for context.\n"
        "- Consider deadline proximity for urgency.\n"
        "- Consider affordability (impact vs income) for priority.\n"
        "- If multiple goals exist, lower priority for less urgent ones.\n"
        "- Ensure valid JSON, no trailing commas.\n"
    )


# ---------------- Public API -----------------
def get_ai_analysis(user: User) -> str:
    """Return HTML analysis for the sidebar (no markdown)."""
    start = time.perf_counter()
    prompt = _analysis_prompt(user)
    with open("ai_prompt.log", "a", encoding="utf-8") as f:
        f.write(f"Prompt generated at {datetime.now()}: {prompt}\n")
    end = time.perf_counter()
    print(f"Prompt generation took {end - start:.2f} seconds")

    start = time.perf_counter()
    raw = _BRAIN.get_text(prompt)
    end = time.perf_counter()
    print(f"AI response generation took {end - start:.2f} seconds")
    return _strip(raw, md_type="html")


def get_goal_plan(goal_dict: dict, user: User) -> str:
    context = _build_financial_context(user)

    compact_goal = _compact_goal_with_local_currency(goal_dict, user, context["lifetime_summary"]["current_balance"])

    prompt = (
        "You are a helpful financial planner.\n\n"
        f"You need to create a step-by-step plan to achieve the following financial goal:\n\n"
        f"{json.dumps(compact_goal, indent=2, default=default_serializer)}\n\n"
        "Complete Financial Context:\n"
        f"{json.dumps(context, indent=2, default=default_serializer)}\n\n"
        "Provide a step-by-step plan to achieve this goal. Include:\n"
        "1) required monthly savings\n"
        "2) suggested spending reductions\n"
        "3) timeline milestones\n"
        "4) tips to stay on track"

        "\n\nOUTPUT CONDITION: \n"
        "- Output must be valid HTML (partial, rendered in <div>) using Bootstrap (Already loaded in DOM) classes for layout.\n"
        "- Keep inline CSS minimal and avoid overriding theme colors or backgrounds.\n"
        "- Use headings h4-h6 only.\n"
        "- Use concise paragraphs and cards for clarity.\n"
    )
    resp = _BRAIN.get_text(prompt)

    return _strip(resp, md_type="html")


def get_purchase_advice(
    user: User,
    item_data: dict,
    weekly_spending: list,
    balance: float,
):
    """Generate structured purchase advice JSON for a potential expense.

    Returns dict with keys: recommendation, reason, alternatives, impact.
    """
    context = _build_financial_context(user)
    lifetime_summary = context["lifetime_summary"]
    last_3_months_summary = context["recent_3_months_summary"]

    # Normalize weekly spending
    if weekly_spending and isinstance(weekly_spending[0], (int, float)):
        total_week_spend = round(sum(float(x) for x in weekly_spending), 2)
    else:
        total_week_spend = round(sum(float(getattr(t, 'amount', t.get('amount', 0))) for t in weekly_spending), 2)

    # Compact goals to reduce token usage
    goals_repr = []
    for g in context["goals"][:5]:
        goals_repr.append({
            "desc": g.get("description"),
            "target": g.get("target_amount"),
            "due": g.get("target_date"),
        })

    currency = user.default_currency
    prompt = (
        "You are an objective financial advisor. Assess whether the user should buy an item.\n"
        f"User: {context['user']['name']} ({context['user']['occupation']})\n"
        f"Item: {item_data.get('description')} ({currency} {item_data.get('amount')})\n"
        f"Category: {item_data.get('category', 'Auto-detect')}\n"
        f"Tags: {item_data.get('tags', [])}\n"
        f"Urgency: {item_data.get('urgency', 'unspecified')}\n"
        f"Weekly spending (total): {currency} {total_week_spend}\n"
        f"Current balance: {currency} {balance}\n"
        f"Monthly income: {currency} {user.monthly_income or 0}\n"
        f"Usual income day-of-month: {user.usual_income_date}\n"
        f"Last 3 months summary: {last_3_months_summary}\n"
        f"Lifetime summary: {lifetime_summary}\n\n"
        f"Active goals (max 5): {goals_repr}\n\n"
        "Return STRICT JSON ONLY (NO extra text, NO markdown, NO comments): {\n"
        '  "recommendation": "yes|no|maybe\",\n'
        '  "reason": "Clear concise rationale (<220 chars).\",\n'
        '  "alternatives": ["short alt 1", "short alt 2"],\n'
        '  "impact": "Brief statement of budget/goal impact."\n'
        "}"
    )

    fallback = {
        "recommendation": "maybe",
        "reason": "AI unavailable or parse failure.",
        "alternatives": [],
        "impact": "unknown",
    }

    data = _BRAIN.get_json(prompt, fallback=fallback)
    if "recommendation" not in data:
        data.update(fallback)
    return data


async def run_goal_priority_analysis(user: User, ai_engine: FinancialBrain, goal_dict: dict) -> dict:
    """Async helper for goal priority analysis returning structured JSON.

    Accepts an explicit engine (so callers can pass a shared instance).
    """
    prompt = _goal_priority_prompt(user, goal_dict)
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
