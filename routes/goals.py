from __future__ import annotations
from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, current_app
from flask_login import login_required, current_user
from bson import ObjectId
from datetime import datetime
from pydantic import ValidationError as PydValidationError
from models.goal import Goal, GoalCreate, GoalUpdate
from models.user import User
from utils.timezone_utils import now_utc, ensure_utc
from utils.finance_calculator import calculate_monthly_summary
from utils.currency import currency_service
from typing import Any
import asyncio, threading

# These are light imports used inside handlers only (avoid circular at import time)

def init_goals_blueprint(mongo, ai_engine, pastebin_client):
    """Initialize and return the goals blueprint.

    Endpoints keep their original endpoint names via explicit 'endpoint' arg so existing templates (url_for('goals')) still work.
    """
    bp = Blueprint('goals_bp', __name__)

    @bp.route('/goals', endpoint='goals')
    @login_required
    def goals():  # type: ignore[override]
        page = int(request.args.get('page', 1))
        per_page = 5
        skip = (page - 1) * per_page
        total_goals = mongo.db.goals.count_documents({'user_id': current_user.id})
        # Prefer user's persisted goals sort when rendering the initial goals page
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        # New schema: sort_modes dict with key 'goals'
        sort_param = ''
        if user_doc:
            sort_param = (user_doc.get('sort_modes') or {}).get('goals') or ''
        if not sort_param:
            sort_param = 'created_desc'
        # Pass resolved sort_param directly to Goal.get_user_goals (no DB-side attribute hack)
        # only need lightweight fields for listing; exclude ai_plan to save bandwidth
        proj = {'ai_plan': 0}
        goal_models = Goal.get_user_goals(current_user.id, mongo.db, skip, per_page, sort_mode=sort_param, projection=proj)
        monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
        user_doc = User.get_by_id(current_user.id, mongo.db)
        user_default_code = user_doc.default_currency
        allocations = Goal.compute_allocations(current_user.id, mongo.db)
        goals_with_progress = []
        for gm in goal_models:
            alloc_amt = allocations.get(gm.id, None)
            goals_with_progress.append((gm, Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)))
        total_pages = (total_goals + per_page - 1) // per_page
        from utils.request_metrics import summary as metrics_summary
        return render_template('goals.html', goals=goals_with_progress, page=page, total_pages=total_pages, perf_metrics=metrics_summary())

    @bp.route('/goals/add', methods=['POST'], endpoint='add_goal')
    @login_required
    def add_goal():  # type: ignore[override]
        goal_type = request.form.get('goal_type') or ''
        target_amount_raw = request.form.get('target_amount')
        target_currency = request.form.get('target_currency')
        description_val = request.form.get('description') or ''
        target_date_str = request.form.get('target_date')
        try:
            target_amount_val = float(target_amount_raw) if target_amount_raw is not None else None
        except ValueError:
            target_amount_val = None
        if not goal_type or target_amount_val is None or not description_val or not target_date_str:
            flash('All goal fields are required and must be valid.', 'danger')
            return redirect(url_for('goals_bp.goals'))
        try:
            parsed_date = ensure_utc(datetime.strptime(target_date_str, '%Y-%m-%d'))
        except Exception:
            flash('Invalid target date format.', 'danger')
            return redirect(url_for('goals_bp.goals'))
        if goal_type not in ('savings', 'purchase'):
            flash('Invalid goal type.', 'danger')
            return redirect(url_for('goals_bp.goals'))
        user_doc = User.get_by_id(current_user.id, mongo.db)
        user_default_code = user_doc.default_currency

        input_code = (target_currency or user_default_code).upper()
        goal_data = GoalCreate(
            user_id=current_user.id,
            type=goal_type,
            target_amount=target_amount_val,  # type: ignore[arg-type]
            currency=input_code,
            description=description_val,
            target_date=parsed_date  # type: ignore[arg-type]
        )
        goal = Goal.create(goal_data, mongo.db)
        Goal.enhance_goal_background(goal, mongo.db, ai_engine)
        flash('Goal created with AI optimization', 'success')
        return redirect(url_for('goals_bp.goals'))

    @bp.route('/goals/<goal_id>/complete', methods=['POST'], endpoint='complete_goal')
    @login_required
    def complete_goal(goal_id):  # type: ignore[override]
        update_data = GoalUpdate(is_completed=True, completed_date=now_utc())
        goal = Goal.update(goal_id, current_user.id, update_data, mongo.db)
        if goal:
            flash('Goal marked as completed.', 'success')
        else:
            flash('Goal not found.', 'danger')
        return redirect(url_for('goals_bp.goals'))

    @bp.route('/goals/<goal_id>/delete', methods=['POST'], endpoint='delete_goal')
    @login_required
    def delete_goal(goal_id):  # type: ignore[override]
        deleted = Goal.delete(goal_id, current_user.id, mongo.db)
        if deleted:
            flash('Goal deleted successfully.', 'success')
        else:
            flash('Goal not found.', 'danger')
        return redirect(url_for('goals_bp.goals'))

    @bp.route('/goals/<goal_id>/revalidate', methods=['POST'], endpoint='revalidate_goal')
    @login_required
    def revalidate_goal(goal_id):  # type: ignore[override]
        try:
            goal = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
            if not goal:
                flash('Goal not found.', 'danger')
                return redirect(url_for('goals_bp.goals'))
            if goal.get('ai_plan_paste_url'):
                async def _del_remote():
                    from models.goal import Goal as GoalModel
                    await GoalModel.delete_remote_ai_plan_if_any(goal, pastebin_client)
                threading.Thread(target=lambda: asyncio.run(_del_remote()), daemon=True).start()
            thread = threading.Thread(
                target=lambda: asyncio.run(
                    Goal._ai_enhance_goal(
                        ObjectId(goal_id),
                        goal,
                        mongo.db,
                        ai_engine
                    )
                ),
                daemon=True
            )
            thread.start()
            flash('Goal revalidation started. Refresh in a few seconds to see updates.', 'info')
        except Exception:
            flash('Failed to start goal revalidation.', 'danger')
        return redirect(url_for('goals_bp.goals'))

    # ---------------- GOALS JSON API -----------------
    @bp.route('/api/goals/list', endpoint='api_goals_list')
    @login_required
    def api_goals_list():  # type: ignore[override]
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 5, type=int)
        per_page = min(per_page, 50)
        skip = (page - 1) * per_page
        sort_param = (request.args.get('sort') or '').lower().strip()
        # Use central allowed sort options from User class for consistency
        allowed = User.SORT_MODE_OPTIONS['goals']
        allowed_sorts = set(allowed) | {''}
        if sort_param not in allowed_sorts:
            sort_param = ''
        # If client did not explicitly request a sort, prefer user's persisted preference
        if not sort_param:
            user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
            sort_param = (user_doc.get('sort_modes') or {}).get('goals') if user_doc else ''
        if not sort_param:
            sort_param = 'created_desc'
        total = mongo.db.goals.count_documents({'user_id': current_user.id})
        proj = {'ai_plan': 0}
        goal_models = Goal.get_user_goals(current_user.id, mongo.db, skip, per_page, sort_mode=sort_param or 'created_desc', projection=proj)
        monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_default_code = (user_doc or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
        allocations = Goal.compute_allocations(current_user.id, mongo.db)
        items: list[dict[str, Any]] = []
        page_goal_ids = [ObjectId(gm.id) for gm in goal_models]
        if page_goal_ids:
            existing_plan_ids = set(doc['_id'] for doc in mongo.db.goals.find({
                '_id': {'$in': page_goal_ids},
                'ai_plan': {'$exists': True, '$ne': None}
            }, {'_id': 1}))
        else:
            existing_plan_ids = set()
        for gm in goal_models:
            alloc_amt = allocations.get(gm.id, None)
            progress = Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)
            gdict = gm.model_dump(by_alias=True)
            td = gdict.get('target_date')
            if isinstance(td, datetime):
                gdict['target_date'] = td.isoformat()
            gdict['progress'] = progress
            gdict['has_ai_plan'] = (ObjectId(gm.id) in existing_plan_ids) or bool(gdict.get('ai_plan_paste_url'))
            items.append(gdict)
        return jsonify({'items': items, 'total': total, 'page': page, 'per_page': per_page, 'sort': sort_param or 'created_desc'})

    @bp.route('/api/goals', methods=['POST'], endpoint='api_goal_create')
    @login_required
    def api_goal_create():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
            user_default_code = (user_doc or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY'])
            payload = {
                'user_id': current_user.id,
                'type': data.get('goal_type'),
                'target_amount': data.get('target_amount'),
                'currency': (data.get('target_currency') or user_default_code).upper(),
                'description': (data.get('description') or '').strip(),
                'target_date': data.get('target_date'),
            }
            goal_data = GoalCreate(**payload)
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        goal = Goal.create(goal_data, mongo.db)
        Goal.enhance_goal_background(goal, mongo.db, ai_engine)
        return jsonify({'item': goal.model_dump(by_alias=True)})

    @bp.route('/api/goals/<goal_id>', methods=['PATCH'], endpoint='api_goal_update')
    @login_required
    def api_goal_update(goal_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            goal_update = GoalUpdate(**data)
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        goal = Goal.update(goal_id, current_user.id, goal_update, mongo.db)
        if not goal:
            return jsonify({'error': 'Not found or no changes'}), 404
        try:
            threading.Thread(
                target=lambda: asyncio.run(Goal._ai_enhance_goal(goal.id, goal, mongo.db, ai_engine)),
                daemon=True
            ).start()
            reval_started = True
        except Exception:
            reval_started = False
        return jsonify({'item': goal.model_dump(by_alias=True), 'revalidation_started': reval_started})

    @bp.route('/api/goals/<goal_id>/complete', methods=['POST'], endpoint='api_goal_complete')
    @login_required
    def api_goal_complete(goal_id):  # type: ignore[override]
        upd = GoalUpdate(is_completed=True, completed_date=now_utc())
        goal = Goal.update(goal_id, current_user.id, upd, mongo.db)
        if not goal:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'item': goal.model_dump(by_alias=True)})

    @bp.route('/api/goals/<goal_id>', methods=['DELETE'], endpoint='api_goal_delete')
    @login_required
    def api_goal_delete(goal_id):  # type: ignore[override]
        goal_doc = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
        if goal_doc and goal_doc.get('ai_plan_paste_url'):
            async def _del_remote():
                from models.goal import Goal as GoalModel
                await GoalModel.delete_remote_ai_plan_if_any(goal_doc, pastebin_client)
            threading.Thread(target=lambda: asyncio.run(_del_remote()), daemon=True).start()
        ok = Goal.delete(goal_id, current_user.id, mongo.db)
        if not ok:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'success': True})

    @bp.route('/api/goals/<goal_id>/revalidate', methods=['POST'], endpoint='api_goal_revalidate')
    @login_required
    def api_goal_revalidate(goal_id):  # type: ignore[override]
        goal = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
        if not goal:
            return jsonify({'error': 'Not found'}), 404
        if goal.get('ai_plan_paste_url'):
            async def _del_remote():
                from models.goal import Goal as GoalModel
                await GoalModel.delete_remote_ai_plan_if_any(goal, pastebin_client)
            threading.Thread(target=lambda: asyncio.run(_del_remote()), daemon=True).start()
        thread = threading.Thread(
            target=lambda: asyncio.run(
                Goal._ai_enhance_goal(ObjectId(goal_id), goal, mongo.db, ai_engine)
            ),
            daemon=True
        )
        thread.start()
        return jsonify({'success': True, 'message': 'Revalidation started'})

    @bp.route('/api/goals/<goal_id>/ai-plan', methods=['GET'], endpoint='get_goal_ai_plan')
    @login_required
    def get_goal_ai_plan(goal_id):  # type: ignore[override]
        goal_doc = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
        if not goal_doc:
            return jsonify({'error': 'Not found'}), 404
        if goal_doc.get('ai_plan'):
            return jsonify({'plan': goal_doc.get('ai_plan'), 'offloaded': False})
        url = goal_doc.get('ai_plan_paste_url')
        if url and pastebin_client:
            key = pastebin_client.extract_paste_key(url)
            if key:
                try:
                    raw = asyncio.run(pastebin_client.read_paste(key))
                    if raw:
                        return jsonify({'plan': raw, 'offloaded': True})
                except Exception:
                    pass
        return jsonify({'error': 'Plan unavailable'}), 404

    # Note: goals sort preference is now handled by the unified /api/sort-pref endpoint

    return bp
