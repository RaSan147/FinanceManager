from __future__ import annotations

from flask import Blueprint, render_template, request, jsonify, redirect, url_for, flash
from datetime import datetime
from bson import ObjectId
from flask_login import login_required, current_user
from pydantic import ValidationError as PydValidationError
from models.todo import Todo, TodoCreate, TodoUpdate, TODO_STAGES, TODO_DESC_TRUNCATE_LEN, TODO_COMMENT_MAX
from models.todo_comment import TodoComment, TodoCommentCreate
from utils.imgbb_client import upload_image, ImgbbError
from utils.request_metrics import summary as metrics_summary


def init_todos_blueprint(mongo):
    bp = Blueprint('todos_bp', __name__)

    # ------------- HTML PAGE -------------
    @bp.route('/todos', endpoint='todos')
    @login_required
    def todos_page():  # type: ignore[override]
        # Initial page render; JS will fetch list via API
        categories = Todo.list_categories(current_user.id, mongo.db)
        return render_template(
            'todos.html',
            todo_stages=TODO_STAGES,
            categories=categories,
            perf_metrics=metrics_summary()
        )

    # ------------- JSON API -------------
    @bp.route('/api/todos', methods=['GET'], endpoint='api_todos_list')
    @login_required
    def api_todos_list():  # type: ignore[override]
        q = request.args.get('q')
        stage = request.args.get('stage') or None
        category = request.args.get('category') or None
        page = max(1, int(request.args.get('page', 1)))
        per_page = min(100, int(request.args.get('per_page', 20)))
        skip = (page - 1) * per_page
        sort = request.args.get('sort') or getattr(current_user, 'todo_sort', 'created_desc')
        items, total = Todo.list(
            current_user.id,
            mongo.db,
            q=q,
            stage=stage,
            category=category,
            skip=skip,
            limit=per_page,
            sort=sort,
        )
        return jsonify({
            'items': [i.model_dump(by_alias=True) for i in items],
            'total': total,
            'page': page,
            'per_page': per_page,
            'sort': sort,
        })

    @bp.route('/api/todos', methods=['POST'], endpoint='api_todo_create')
    @login_required
    def api_todo_create():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            payload = TodoCreate(**{
                'user_id': current_user.id,
                'title': data.get('title'),
                'description': data.get('description') or '',
                'category': data.get('category'),
                'stage': data.get('stage') or 'wondering',
                'due_date': data.get('due_date'),
            })
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        item = Todo.create(payload, mongo.db)
        # Auto add category if new
        if item.category:
            try:
                Todo.add_category(current_user.id, item.category, mongo.db)
            except Exception:
                pass
        return jsonify({'item': item.model_dump(by_alias=True)})

    @bp.route('/api/todos/<todo_id>', methods=['PATCH'], endpoint='api_todo_update')
    @login_required
    def api_todo_update(todo_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            patch = TodoUpdate(**data)
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        upd = Todo.update(
            todo_id,
            current_user.id,
            patch,
            mongo.db,
            allow_null=["description", "category", "due_date"],
        )
        if not upd:
            return jsonify({'error': 'Not found'}), 404
        if upd.category:
            try:
                Todo.add_category(current_user.id, upd.category, mongo.db)
            except Exception:
                pass
        return jsonify({'item': upd.model_dump(by_alias=True)})

    # Stage-only fast update (lighter payload, avoids accidental clearing of other fields)
    @bp.route('/api/todos/<todo_id>/stage', methods=['PATCH'], endpoint='api_todo_stage_update')
    @login_required
    def api_todo_stage_update(todo_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        stage = data.get('stage')
        if stage not in TODO_STAGES:
            return jsonify({'error': 'invalid stage'}), 400
        # Reuse standard update for history side-effects
        patch = TodoUpdate(stage=stage)
        upd = Todo.update(
            todo_id,
            current_user.id,
            patch,
            mongo.db,
        )
        if not upd:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'item': upd.model_dump(by_alias=True)})

    # Todo detailed fetch (includes comments + stage history)
    @bp.route('/api/todos/<todo_id>/detail', methods=['GET'], endpoint='api_todo_detail')
    @login_required
    def api_todo_detail(todo_id):  # type: ignore[override]
        item = Todo.get(todo_id, current_user.id, mongo.db)
        if not item:
            return jsonify({'error': 'Not found'}), 404
        comments = TodoComment.list_for(mongo.db, todo_id, current_user.id, limit=500)
        return jsonify({
            'item': item.model_dump(by_alias=True),
            'comments': [c.model_dump(by_alias=True) for c in comments],
            'comment_max': TODO_COMMENT_MAX,
        })

    # Comments
    @bp.route('/api/todos/<todo_id>/comments', methods=['POST'], endpoint='api_todo_comment_create')
    @login_required
    def api_todo_comment_create(todo_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        body = (data.get('body') or '').strip()
        images = data.get('images') or []
        if not isinstance(images, list):
            images = []
        try:
            payload = TodoCommentCreate(todo_id=todo_id, user_id=current_user.id, body=body, images=images)
        except Exception as e:
            return jsonify({'error': str(e)}), 400
        comment = TodoComment.create(mongo.db, payload)
        return jsonify({'comment': comment.model_dump(by_alias=True)})

    @bp.route('/api/todo-comments/<comment_id>', methods=['DELETE'], endpoint='api_todo_comment_delete')
    @login_required
    def api_todo_comment_delete(comment_id):  # type: ignore[override]
        ok = TodoComment.delete(mongo.db, comment_id, current_user.id)
        if not ok:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'success': True})

    # Image upload (base64 or data URL) -> imgbb
    @bp.route('/api/todo-images', methods=['POST'], endpoint='api_todo_image_upload')
    @login_required
    def api_todo_image_upload():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        raw = data.get('image')
        if not raw:
            return jsonify({'error': 'image required'}), 400
        try:
            url = upload_image(raw)
        except ImgbbError as e:
            return jsonify({'error': str(e)}), 400
        return jsonify({'url': url})

    @bp.route('/api/todos/<todo_id>', methods=['DELETE'], endpoint='api_todo_delete')
    @login_required
    def api_todo_delete(todo_id):  # type: ignore[override]
        ok = Todo.delete(todo_id, current_user.id, mongo.db)
        if not ok:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'success': True})

    @bp.route('/api/todos/reorder', methods=['POST'], endpoint='api_todo_reorder')
    @login_required
    def api_todo_reorder():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        items = data.get('items')
        if not isinstance(items, list):
            return jsonify({'error': 'items list required'}), 400
        if len(items) > 500:
            return jsonify({'error': 'too many items'}), 400
        # Expect list of {id, sort_index}
        modified = 0
        for obj in items:
            if not isinstance(obj, dict):
                continue
            tid = obj.get('id') or obj.get('_id')
            si = obj.get('sort_index')
            if not tid or not isinstance(si, int):
                continue
            mongo.db.todos.update_one({'_id': ObjectId(tid), 'user_id': current_user.id}, {'$set': {'sort_index': si, 'updated_at': datetime.utcnow()}})
            modified += 1
        return jsonify({'updated': modified})

    # Category management
    @bp.route('/api/todo-categories', methods=['GET'], endpoint='api_todo_categories')
    @login_required
    def api_todo_categories():  # type: ignore[override]
        cats = Todo.list_categories(current_user.id, mongo.db)
        return jsonify({'items': cats})

    @bp.route('/api/todo-categories', methods=['POST'], endpoint='api_todo_category_create')
    @login_required
    def api_todo_category_create():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'Name required'}), 400
        try:
            doc = Todo.add_category(current_user.id, name, mongo.db)
        except Exception as e:
            return jsonify({'error': str(e)}), 400
        return jsonify({'item': doc})

    @bp.route('/api/todo-categories/<name>', methods=['DELETE'], endpoint='api_todo_category_delete')
    @login_required
    def api_todo_category_delete(name):  # type: ignore[override]
        ok = Todo.delete_category(current_user.id, name, mongo.db)
        if not ok:
            return jsonify({'error': 'Cannot delete (in use or not found)'}), 400
        return jsonify({'success': True})

    # Preference: save todo sort
    @bp.route('/api/todo-pref/sort', methods=['POST'], endpoint='api_todo_pref_sort')
    @login_required
    def api_todo_pref_sort():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        sort = data.get('sort')
        if not sort:
            return jsonify({'error': 'sort required'}), 400
        if not getattr(current_user, 'set_todo_sort', None):
            return jsonify({'error': 'unsupported'}), 400
        ok = current_user.set_todo_sort(sort)
        if not ok:
            return jsonify({'error': 'invalid sort'}), 400
        return jsonify({'success': True, 'sort': sort})

    return bp
