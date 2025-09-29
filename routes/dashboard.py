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
        if mongo.db is None:
            return render_template('error.html', message='Database connection error.')
        # Create a per-request in-memory transaction cache to avoid multiple
        # DB scans when rendering the dashboard (recent tx, monthly summary,
        # lifetime summary, allocations all scan transactions).
        # Timings for profiling
        timings: dict[str, float] = {}
        t0 = time.perf_counter()
        step_start = t0
        from utils.finance_calculator import create_cache_session, drop_cache_session
        cache_id = create_cache_session(current_user.id, mongo.db)
        try:
            # core user & tx data
            recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db, cache_id=cache_id)
            timings['recent_transactions_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
            timings['user_fetch_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            user_obj = User(user, mongo.db)
            user_default_code = (user or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
            timings['user_obj_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            # ensure goals have a currency set (best-effort, non-fatal)
            # Only run update if there exists at least one goal missing currency to avoid
            # doing a write on every request.
            try:
                if mongo.db.goals.find_one({'user_id': current_user.id, 'currency': {'$exists': False}}):
                    mongo.db.goals.update_many(
                        {'user_id': current_user.id, 'currency': {'$exists': False}},
                        {'$set': {'currency': user_default_code}}
                    )
            except Exception:
                pass
            timings['maybe_fix_goals_currency_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            # Respect user's saved goals sorting preference when available
            # Reuse fetched `user` above for preferences
            user_goal_sort = (user.get('sort_modes') or {}).get('goals') if user else None

            # Only need core fields for dashboard; exclude heavy ai_plan content
            proj = {'ai_plan': 0}
            active_goal_models = Goal.get_active_goals(current_user.id, mongo.db, sort_mode=user_goal_sort, projection=proj)
            timings['active_goals_fetch_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            # Use cached transactions for the heavy helpers
            from utils.finance_calculator import calculate_monthly_summary
            monthly_summary = calculate_monthly_summary(current_user.id, mongo.db, cache_id=cache_id)
            timings['monthly_summary_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            full_balance = user_obj.get_lifetime_transaction_summary_cached(cache_id=cache_id)
            timings['lifetime_summary_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            # Pass the already-fetched active_goal_models into compute_allocations to
            # avoid re-querying the goals collection inside the allocation routine.
            allocations = Goal.compute_allocations(current_user.id, mongo.db, cache_id=cache_id, goals_list=active_goal_models)
            timings['allocations_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            active_goals = []
            for gm in active_goal_models:
                alloc_amt = allocations.get(gm.id, None)
                progress = Goal.calculate_goal_progress(
                    gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code
                )
                gd = gm.model_dump(by_alias=True)
                gd['progress'] = progress
                if alloc_amt is not None:
                    gd['allocated_amount'] = alloc_amt
                active_goals.append(gd)
            timings['goal_loop_ms'] = (time.perf_counter() - step_start) * 1000.0
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

            timings['before_render_ms'] = (time.perf_counter() - step_start) * 1000.0
            render_start = time.perf_counter()

            resp = render_template(
                'index.html',
                transactions=recent_transactions,
                goals=active_goals,
                summary=monthly_summary,
                balance=full_balance,
                days_until_income=days_until_income,
                user_language=(user or {}).get('language','en'),
                perf_metrics=metrics_summary(),
                step_timings=timings
            )
            timings['render_ms'] = (time.perf_counter() - render_start) * 1000.0
            timings['total_request_ms'] = (time.perf_counter() - t0) * 1000.0
            current_app.logger.info(f"Dashboard timings (ms): { {k: round(v,2) for k,v in timings.items()} }")
            return resp
        finally:
            try:
                drop_cache_session(cache_id)
            except Exception:
                pass

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
            proj = {'ai_plan': 0}
            active_goal_models = Goal.get_active_goals(current_user.id, mongo.db, sort_mode=user_goal_sort, projection=proj)
            timings['active_goals_fetch_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            allocations = Goal.compute_allocations(current_user.id, mongo.db, cache_id=cache_id, goals_list=active_goal_models)
            timings['allocations_ms'] = (time.perf_counter() - step_start) * 1000.0
            step_start = time.perf_counter()

            user_default_code = (user or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
            goals = []
            for gm in active_goal_models:
                alloc_amt = allocations.get(gm.id, None)
                progress = Goal.calculate_goal_progress(
                    gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code
                )
                gd = gm.model_dump(by_alias=True)
                td = gd.get('target_date')
                if isinstance(td, datetime):
                    gd['target_date'] = td.isoformat()
                gd['progress'] = progress
                if alloc_amt is not None:
                    gd['allocated_amount'] = alloc_amt
                if '_id' in gd:
                    gd['_1d'] = str(gd['_id'])
                goals.append(gd)
            timings['goal_loop_ms'] = (time.perf_counter() - step_start) * 1000.0
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
            timings['total_request_ms'] = (time.perf_counter() - t0) * 1000.0
            current_app.logger.info(f"API dashboard timings (ms): { {k: round(v,2) for k,v in timings.items()} }")

            resp = {
                'monthly_summary': monthly_summary,
                'lifetime': full_balance,
                'recent_transactions': rtx,
                'goals': goals,
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
