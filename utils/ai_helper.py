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


def _compact_goal_with_local_currency(goal_dict:dict|GoalInDB, user: User, current_balance: float, include_ai_analysis=False) -> dict:
    """Compact goal representation with amounts converted to user's local currency."""
    from utils.currency import currency_service
    compact_goal = Goal.compact_dict(goal_dict, include_ai_analysis=include_ai_analysis)
    goal_currency = compact_goal["currency"]

    compact_goal[f"current_balance_in_{goal_currency}"] = currency_service.convert_amount(current_balance, user.default_currency, goal_currency)

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

        # Respect user's saved goal sort preference when available (new sort_modes dict preferred)
        user_doc = db.users.find_one({'_id': ObjectId(user.id)})
        user_goal_sort = (user_doc.get('sort_modes') or {}).get('goals') if user_doc else None
        # Include AI analysis fields but exclude heavy ai_plan content
        proj = {
            'ai_plan': 0,
            'ai_priority': 1,
            'ai_urgency': 1,
            'ai_impact': 1,
            'ai_health_impact': 1,
            'ai_confidence': 1,
            'ai_suggestions': 1,
        }
        goals = Goal.get_active_goals(user.id, db, sort_mode=user_goal_sort, projection=proj)
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
        "- Do not include any scripts/css files or external links. Bootstrap 5.3.8 is already loaded in the DOM.\n"

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

    ( #return (
        "You are a financial planning assistant. "
        "Your task: evaluate the importance and urgency of the following financial goal, "
        "given the user's overall financial context.\n\n"
        f"{json.dumps(financial_context, indent=2, default=str)}\n\n"

        f"With the given context, evaluate the importance and urgency of this financial goal:\n"
        f"{json.dumps(compact_goal, indent=2, default=str)}\n\n"
        "Respond with a STRICT JSON object only. No explanations, no markdown, no extra text.\n\n"
        "JSON schema (all keys required unless noted):\n"
        "{\n"
        '  "priority_score": number (0-100, higher = more important to pursue soon),\n'
        '  "urgency": number (0-100, 0 = far in the future (>24 months), 100 = due now or overdue),\n'
        '  "financial_impact": number (0-100, map goal_amount/monthly_income ratio to 0..100; ratio 0->0, 10+->100),\n'
        '  "health_impact": number (0-100, 0 if not applicable),\n'
        '  "confidence": number (0-100, how confident this assessment is),\n'
        '  "suggested_actions": [array of 2-4 short actionable recommendations],\n'
        '''  "summary": string (1-2 concise sentences summarizing the goal's importance)\n'''
        "}\n\n"
        "Rules & guidance:\n"
        "- Use user_balance, income, expenses, and existing_goals for context.\n"
        "- Urgency heuristic: 0 when >24 months away, 100 when due today/overdue, scale in-between.\n"
        "- Financial impact: higher when target is large vs monthly income (ratio).\n"
        "- Compute priority_score with heavier emphasis on priority/urgency, but consider impact and (if applicable) health.\n"
        "- Keep all numeric values within 0-100.\n"
        "- If multiple goals exist, lower priority for less urgent or less impactful ones.\n"
        "- Ensure valid JSON with no trailing commas.\n"
    )

    return (
        """You are a financial planning assistant. Your job: evaluate the importance and urgency of a single financial goal in the context of the user's finances. Respond with a STRICT JSON object only (no explanations, no markdown, no extra text).
""" + f"""
Inputs:
- financial_context: {json.dumps(financial_context, indent=2, default=str)}


- goal to evaluate: {json.dumps(compact_goal, indent=2, default=str)}


""" + """
Output JSON schema (ALL KEYS REQUIRED). All numeric fields MUST be integers 0..100 (inclusive).

{
  "priority_score": integer (0-100)        - importance; higher => pursue sooner
  "urgency": integer (0-100)               - 0 when >24 months away, 100 when due today/overdue
  "financial_impact": integer (0-100)      - scale of goal size vs monthly_income (ratio); map ratio 0->0, 10+ ->100
  "health_impact": integer (0-100)         - 0 if not relevant; higher if goal affects health/wellbeing
  "confidence": integer (0-100)            - how confident the assistant is in these numbers
  "suggested_actions": [2-4 short strings] - short actionable steps (e.g., "pause discretionary X", "increase monthly savings by Y")
  "summary": string (one or two concise sentences)
}

Rules & Guidance:
- Use monthly_income and monthly_savings to infer affordability.
- Urgency heuristic: 0 when >24 months away, 100 when due today or overdue; scale linearly in-between.
- Financial impact: map goal_amount / monthly_income to 0..100; ratio >=10 ->100.
- Compute priority_score by blending urgency (heavier), financial_impact, and health_impact when applicable.
- Keep outputs integers 0..100. No trailing commas. Return only the JSON object.

Examples:
- If goal is due tomorrow and is large relative to income => urgency near 100, financial_impact high => priority high.
- If goal is 36 months away and small relative to income => urgency 0, financial_impact low => priority low.

Output only the JSON object (single line or pretty JSON is fine). Ensure valid JSON.
"""
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


async def get_goal_plan(goal_dict: dict, user: User) -> str:
    context = _build_financial_context(user)

    compact_goal = _compact_goal_with_local_currency(goal_dict, user, context["lifetime_summary"]["current_balance"], include_ai_analysis=True)
    compact_goal["months_left"] = max(1, (compact_goal.get("days_left", 0) or 0) // 30)

    prompt = f"""
You are an expert financial planner. You will be given two Python `dict` objects named `goal_to_plan_for` and `financial_context` (already parsed from JSON). Your job: produce a single VALID HTML fragment (a top-level `<div> ... </div>`) that renders a concise, step-by-step plan to achieve the goal.

**Important - output ONLY the HTML fragment. No explanations, no markdown, no extra text.**

**INPUTS** (available as Python `dict`s/json):

* `financial_context` - contains user profile (`name`, `monthly_income`, `usual_income_date`, `default_currency`), `today` (ISO), summaries (`monthly_summary`, `lifetime_summary`, `recent_3_months_summary`), `last_30_days_transactions`, and a `goals` list.

* `goal_to_plan_for` - contains: `description`, `target_amount`, `target_date` (ISO), `currency`, `days_left`, `current_balance_in_BDT` (or equivalent), plus any ai_* fields you can ignore.

financial context:
{json.dumps(context, indent=2, default=default_serializer)}

goal to plan for:
{json.dumps(compact_goal, indent=2, default=default_serializer)}

""" + """

If any field is missing, fall back to reasonable defaults (treat missing numeric values as 0, missing dates as `today`).

OUTPUT RULES (follow exactly):

* Return ONLY one top-level HTML fragment that begins with:
  `<div class="goal-plan card p-3"> ... </div>`
  No outer html/body tags, no extra text, no JSON metadata, no scripts, no comments.
* Use Bootstrap components and utility classes only (cards, rows, cols, badges, lists, small buttons). Assume Bootstrap is already loaded in the DOM.
* Use headings only `h4`, `h5`, or `h6`.
* Keep inline CSS minimal and non-invasive (tiny layout helpers like `style="min-width:0"` are allowed). Do NOT override theme colors or include external CSS/scripts.
* Do NOT include any machine-readable JSON blocks, `data-*` attributes, or hidden metadata.
* **Do NOT show any coverage or confidence badges anywhere** (coverage is shown elsewhere). Do not display any explicit "Confidence" value.
* Accessibility: add `aria-label` to meaningful badges/labels and use semantic HTML lists (`ol`, `ul`).
* BG is handled my theme. DO NOT set background colors manually (or classes like `bg-*`).

CALCULATION GUIDELINES (do these internally; do not print raw calculations):

* Required monthly savings = max(0, (target_amount - current_pool) / months_remaining) where:

  * `current_pool` = `financial_context["lifetime_summary"]["current_balance"]` if present else `goal_to_plan_for["current_balance_in_BDT"]` or 0.
  * `months_remaining` = `max(1, ceil(days_left / 30))` using `goal_to_plan_for["days_left"]` (fall back to date difference if days_left missing).
* Affordability indicator: choose one of `Affordable`, `Stretch`, `Unrealistic` based on ratio `(required_monthly_savings / max(1, monthly_income))`:

  * `Affordable` if ratio ≤ 0.25
  * `Stretch` if 0.25 < ratio ≤ 0.6
  * `Unrealistic` if ratio > 0.6
* Suggested spending reductions: pick top 2 expense categories from `recent_3_months_summary` or `expense_categories` with largest totals (exclude `lent out`). Provide short human-friendly labels like "Cut dining out" or "Reduce gadget spends".

VISUAL STRUCTURE (required order inside top-level div - follow strictly, but produce friendly wording and numbers):

1. Header strip (compact):

   * `h4` title: concise goal summary (≤ 8 words), e.g., "Buy MSI A850GL - Jan 2026".
   * small row of badges (inline) showing: **Target amount** (currency formatted; use symbol if available), **Target date** (short, e.g., "Jan 2026"), and **Days left** (e.g., "111 days"). Each as Bootstrap `badge` elements.
   * a single brief one-line subtitle (max 12 words), friendly and human (e.g., "Small, achievable upgrade - plan it simply.").

2. Main body: Bootstrap `row`

   * Left column (`col-md-8`):

     * Card "Plan" containing:

       * Prominent **Required monthly savings** (large text, currency formatted).
       * Ordered step-by-step plan (`<ol>`) with **4-8 actionable steps**. Each step must be a short imperative sentence (≤ 16 words). One step must be visually highlighted with a small badge reading **Start here** (use `span` with `badge bg-primary` near the step).
       * A small "Tips to stay on track" area with exactly **3 concise bullets** (<= 10 words each).
     * Tone: encouraging, practical, and non-technical. Use plain-language prompts like "Automate", "Pause", "Sell", "Add one-time".
   * Right column (`col-md-4`):

     * Card "Quick facts" containing:

       * **Current pool** (currency) shown as a short line.
       * **Affordability** indicator: one of the three labels (`Affordable`, `Stretch`, `Unrealistic`) rendered as a colored badge: `bg-success` for Affordable, `bg-warning` for Stretch, `bg-danger` for Unrealistic. Add `aria-label` describing the affordability.
       * **Top 2 suggested spending reductions** (two short bullets).
       * **Clear checkpoints** (replace confusing timelines). Provide **2 simple dated checkpoints** (human-friendly) such as:

         * `By <short date>` - `৳X saved` (or currency symbol used).
         * `At midpoint (≈ X days)` - `৳Y saved or action`.
       * Avoid multi-row machine-style timelines. Keep each checkpoint one short line.

3. Footer (small card or muted text):

   * **2-3 suggested actions** (very short lines with small emoji like 🔥 or ⚠️).
   * **Estimated difficulty** displayed as `"Difficulty: Low/Medium/High"` in a small badge (`bg-secondary`/`bg-warning`/`bg-danger`). Do NOT include a numeric confidence.

PRESENTATION GUIDELINES:

* Currency formatting: show symbol (if `currency` is "BDT" show the Bangladeshi Taka symbol `৳`) and two decimals, with thousands separators (e.g., `৳14,499.00`). If symbol unavailable, use currency code before number (e.g., `USD 1,234.56`).
* Keep paragraphs short (≤ 2 sentences). List items short (≤ 16 words).
* Use emoji / small unicode icons sparingly for visual flair (✓, ⚠️, 🔥).
* Use semantic lists (`ol`, `ul`) and spacing utilities (`mt-2`, `mb-2`) for clarity.
* Do not show any coverage or confidence badges or percentages anywhere.

ACCESSIBILITY:

* Add `aria-label` to the affordability badge and to the header badges.
* Use readable text sizes (`h5` for card titles, prominent numeric in a `div` with class `h4`).

EXAMPLE (for your internal formatting reference only - do NOT output this example):

* Header with title + badges (Target amount, Due, Days left).
* Left: Plan card with required monthly savings, ol steps with "Start here" badge on first step, tips.
* Right: Quick facts card with pool, affordability badge, top 2 cuts, 2 checkpoints.
* Footer: actions + Difficulty badge.

VALIDATION:

* The HTML must render cleanly inside an existing page and rely on Bootstrap for layout/styling.
* No `<script>`, no JSON, no hidden data attributes.
* Output ONLY the HTML fragment described - nothing else.

"""

    resp = await _BRAIN.aget_text(prompt)

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
        "urgency": 50,
        "financial_impact": 30,
        "health_impact": 0,
        "confidence": 50,
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
