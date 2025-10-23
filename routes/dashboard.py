from flask import Blueprint, render_template, jsonify, current_app
from flask_login import login_required, current_user
from bson import ObjectId
from datetime import datetime
import time
from utils.request_metrics import summary as metrics_summary
from models.transaction import Transaction
from models.goal import Goal
from models.user import User
from utils.timezone_utils import now_utc


def init_dashboard_blueprint(mongo):
    bp = Blueprint('dashboard', __name__)

    # Preserve original endpoint name 'index' for templates using url_for('index')
    @bp.route('/', endpoint='index')
    @login_required
    def index():
        # Render a lightweight shell; client JS fetches data via /api/dashboard.
        return render_template('index.html', perf_metrics=metrics_summary())

    @bp.route('/api/dashboard')
    @login_required
    def api_dashboard():
        if mongo.db is None:
            return jsonify({'error': 'Database connection error'}), 500
        # fetch user document for preferences and currency
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        if not user:
            return jsonify({'error': 'User not found'}), 404
        from utils.finance_calculator import create_cache_session, drop_cache_session
        timings: dict[str, float] = {}
        t0 = time.perf_counter()
        step_start = t0
        cache_id = create_cache_session(current_user.id, mongo.db)
        try:
            recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db, cache_id=cache_id)
            timings['recent_transactions_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            rtx = []
            for t in recent_transactions:
                t = dict(t)
                if '_id' in t:
                    t['_id'] = str(t['_id'])
                rtx.append(t)
            timings['recent_transactions_massage_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            from utils.finance_calculator import calculate_monthly_summary
            from utils.currency import currency_service
            monthly_summary = calculate_monthly_summary(current_user.id, mongo.db, cache_id=cache_id)
            timings['monthly_summary_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            full_balance = User(user, mongo.db).get_lifetime_transaction_summary_cached(cache_id=cache_id)
            timings['lifetime_summary_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            # Reuse user fetched earlier for preferences
            user_goal_sort = (user.get('sort_modes') or {}).get('goals') if user else None
            # Dashboard no longer embeds goals server-side. Clients should fetch /api/goals/trimmed
            timings['active_goals_fetch_ms'] = 0.0
            timings['allocations_ms'] = 0.0
            timings['goal_loop_ms'] = 0.0
            step_start = time.perf_counter()

            days_until_income = None
            if user.get('usual_income_date'):
                today = now_utc().day
                income_day = int(user['usual_income_date'])
                if today <= income_day:
                    days_until_income = income_day - today
                else:
                    from calendar import monthrange
                    now = now_utc()
                    last_day = monthrange(now.year, now.month)[1]
                    days_until_income = (last_day - today) + income_day

            timings['post_goal_loop_ms'] = (time.perf_counter() - step_start) * 1000.0
            # Determine user's default currency for API responses
            user_default_code = (user or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
            timings['total_request_ms'] = (time.perf_counter() - t0) * 1000.0
            current_app.logger.info(f"API dashboard timings (ms): { {k: round(v,2) for k,v in timings.items()} }")

            resp = {
                'monthly_summary': monthly_summary,
                'lifetime': full_balance,
                'recent_transactions': rtx,
                'days_until_income': days_until_income,
                'currency': {
                    'code': user_default_code,
                    'symbol': currency_service.get_currency_symbol(user_default_code)
                },
                'step_timings': timings
            }
            return jsonify(resp)
        finally:
            try:
                drop_cache_session(cache_id)
            except Exception:
                pass

    return bp
