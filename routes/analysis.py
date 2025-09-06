from flask import Blueprint, render_template, jsonify, current_app, flash, redirect, url_for
from flask_login import login_required, current_user
from bson import ObjectId
from models.goal import Goal
from models.user import User
from utils.request_metrics import summary as metrics_summary

def init_analysis_blueprint(mongo, ai_engine):
    bp = Blueprint('analysis_bp', __name__, url_prefix='')

    @bp.route('/analysis', endpoint='analysis')
    @login_required
    def analysis():
        from app import calculate_monthly_summary
        monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
        goal_models = Goal.get_active_goals(current_user.id, mongo.db)
        allocations = Goal.compute_allocations(current_user.id, mongo.db)
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_default_code = (user_doc or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
        goals = []
        for gm in goal_models:
            alloc_amt = allocations.get(gm.id, None)
            progress = Goal.calculate_goal_progress(
                gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code
            )
            gd = gm.model_dump(by_alias=True)
            gd['progress'] = progress
            if alloc_amt is not None:
                gd['allocated_amount'] = alloc_amt
            goals.append(gd)
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        ai_analysis = user.get('ai_analysis') if user else None
        return render_template('analysis.html',
                               summary=monthly_summary,
                               goals=goals,
                               ai_analysis=ai_analysis,
                               perf_metrics=metrics_summary())

    @bp.route('/analysis/run', methods=['POST'])
    @login_required
    def run_ai_analysis():
        if mongo.db is None:
            flash('Database connection error.', 'danger')
            return redirect(url_for('analysis_bp.analysis'))
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_obj = User(user, db=mongo.db)
        from app import get_ai_analysis
        ai_analysis = get_ai_analysis(user_obj)
        mongo.db.users.update_one(
            {'_id': ObjectId(current_user.id)},
            {'$set': {'ai_analysis': ai_analysis}}
        )
        flash('AI analysis updated.', 'success')
        return redirect(url_for('analysis_bp.analysis'))

    return bp
