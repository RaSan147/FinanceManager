from flask import Blueprint, render_template, jsonify, current_app
from flask_login import login_required, current_user
from bson import ObjectId
from datetime import datetime
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
        recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db)
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_obj = User(user, mongo.db)
        user_default_code = (user or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
        try:
            mongo.db.goals.update_many(
                {'user_id': current_user.id, 'currency': {'$exists': False}},
                {'$set': {'currency': user_default_code}}
            )
        except Exception:
            pass
        # Respect user's saved goals sorting preference when available
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        # Prefer new sort_modes dict
        user_goal_sort = (user_doc.get('sort_modes') or {}).get('goals') if user_doc else None
        # Only need core fields for dashboard; exclude heavy ai_plan content
        proj = {'ai_plan': 0}
        active_goal_models = Goal.get_active_goals(current_user.id, mongo.db, sort_mode=user_goal_sort, projection=proj)
        from app import calculate_monthly_summary  # lazy import to avoid circular
        monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
        full_balance = user_obj.get_lifetime_transaction_summary()
        allocations = Goal.compute_allocations(current_user.id, mongo.db)
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
        return render_template(
            'index.html',
            transactions=recent_transactions,
            goals=active_goals,
            summary=monthly_summary,
            balance=full_balance,
            days_until_income=days_until_income,
            user_language=(user or {}).get('language','en'),
            perf_metrics=metrics_summary()
        )

    @bp.route('/api/dashboard')
    @login_required
    def api_dashboard():
        if mongo.db is None:
            return jsonify({'error': 'Database connection error'}), 500
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        if not user:
            return jsonify({'error': 'User not found'}), 404
        recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db)
        rtx = []
        for t in recent_transactions:
            t = dict(t)
            if '_id' in t:
                t['_id'] = str(t['_id'])
            rtx.append(t)
        from app import calculate_monthly_summary, currency_service
        monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
        full_balance = User(user, mongo.db).get_lifetime_transaction_summary()
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_goal_sort = (user_doc.get('sort_modes') or {}).get('goals') if user_doc else None
        proj = {'ai_plan': 0}
        active_goal_models = Goal.get_active_goals(current_user.id, mongo.db, sort_mode=user_goal_sort, projection=proj)
        allocations = Goal.compute_allocations(current_user.id, mongo.db)
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
                gd['_id'] = str(gd['_id'])
            goals.append(gd)
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
        return jsonify({
            'monthly_summary': monthly_summary,
            'lifetime': full_balance,
            'recent_transactions': rtx,
            'goals': goals,
            'days_until_income': days_until_income,
            'currency': {
                'code': user_default_code,
                'symbol': currency_service.get_currency_symbol(user_default_code)
            }
        })

    return bp
