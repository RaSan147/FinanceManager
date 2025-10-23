from flask import Blueprint, render_template, jsonify, current_app, flash, redirect, url_for
from flask_login import login_required, current_user
from bson import ObjectId
from models.goal import Goal, Allocator as GoalAllocator
from models.user import User
from utils.request_metrics import summary as metrics_summary

def init_analysis_blueprint(mongo, ai_engine):
    bp = Blueprint('analysis_bp', __name__, url_prefix='')

    @bp.route('/analysis', endpoint='analysis')
    @login_required
    def analysis():
        from utils.finance_calculator import calculate_monthly_summary
        # Create an in-process transaction cache session to avoid multiple DB
        # round-trips when building the analysis page (monthly summary,
        # lifetime allocations, and per-goal progress all scan transactions).
        from utils.finance_calculator import create_cache_session, drop_cache_session
        cache_id = create_cache_session(current_user.id, mongo.db)
        try:
            monthly_summary = calculate_monthly_summary(current_user.id, mongo.db, cache_id=cache_id)
            user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
            user_goal_sort = (user_doc.get('sort_modes') or {}).get('goals') if user_doc else None

            # Use centralized helper to prepare goals for view (honors user sort preference)
            # Reuse the same cache session so allocations and progress can use cached txs
            prep = Goal.prepare_goals_for_view(current_user.id, mongo.db, include_completed=False, page=1, per_page=100, sort_mode=user_goal_sort, projection={'ai_plan': 0}, cache_id=cache_id)
            goals = prep['items']

            user = user_doc
            ai_analysis = user.get('ai_analysis') if user else None
            return render_template('analysis.html',
                                   summary=monthly_summary,
                                   goals=goals,
                                   ai_analysis=ai_analysis,
                                   perf_metrics=metrics_summary())
        finally:
            try:
                drop_cache_session(cache_id)
            except Exception:
                pass

    @bp.route('/analysis/run', methods=['POST'])
    @login_required
    def run_ai_analysis():
        if mongo.db is None:
            flash('Database connection error.', 'danger')
            return redirect(url_for('analysis_bp.analysis'))
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_obj = User(user, db=mongo.db)
        from utils.ai_helper import get_ai_analysis
        ai_analysis = get_ai_analysis(user_obj)
        mongo.db.users.update_one(
            {'_id': ObjectId(current_user.id)},
            {'$set': {'ai_analysis': ai_analysis}}
        )
        flash('AI analysis updated.', 'success')
        return redirect(url_for('analysis_bp.analysis'))

    return bp
