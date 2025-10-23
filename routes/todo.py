from __future__ import annotations

from flask import Blueprint, render_template, request, jsonify, redirect, url_for, flash
import logging
from config import Config
from datetime import datetime
from bson import ObjectId
from flask_login import login_required, current_user
from pydantic import ValidationError as PydValidationError
from models.todo import Todo, TodoCreate, TodoUpdate, TODO_STAGES, TODO_DESC_TRUNCATE_LEN, TODO_COMMENT_MAX
from models.todo_comment import TodoComment, TodoCommentCreate
from utils.imagekit_client import upload_image
from utils.request_metrics import summary as metrics_summary


def init_todo_blueprint(mongo):
    bp = Blueprint('todo_bp', __name__)

    # ------------- HTML PAGE -------------
    @bp.route('/todo', endpoint='todo')
    @login_required
    def todo_page():  # type: ignore[override]
        # Initial page render; JS will fetch list via API
        categories = Todo.list_categories(current_user.id, mongo.db)
        return render_template(
            'todo.html',
            todo_stages=TODO_STAGES,
            categories=categories,
            perf_metrics=metrics_summary()
        )

    # ------------- JSON API -------------
    @bp.route('/api/todo', methods=['GET'], endpoint='api_todo_list')
    @login_required
    def api_todo_list():  # type: ignore[override]
        q = request.args.get('q')
        stage = request.args.get('stage') or None
        category = request.args.get('category') or None
        page = max(1, int(request.args.get('page', 1)))
        per_page = min(100, int(request.args.get('per_page', 20)))
        skip = (page - 1) * per_page
        # Prefer explicit query param, otherwise use user's persisted preference via get_sort_mode
        sort = request.args.get('sort') or current_user.get_sort_mode('todo') or 'created_desc'
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

    @bp.route('/api/todo/<todo_id>/pin', methods=['POST'], endpoint='api_todo_toggle_pin')
    @login_required
    def api_todo_toggle_pin(todo_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        pinned = bool(data.get('pinned', True))
        patch = TodoUpdate(pinned=pinned)
        upd = Todo.update(todo_id, current_user.id, patch, mongo.db)
        if not upd:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'item': upd.model_dump(by_alias=True)})

    @bp.route('/api/todo', methods=['POST'], endpoint='api_todo_create')
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
        # Auto add categories if new (list semantics like Diary)
        if item.category:
            try:
                for name in (item.category or []):
                    Todo.add_category(current_user.id, name, mongo.db)
            except Exception:
                pass
        return jsonify({'item': item.model_dump(by_alias=True)})

    @bp.route('/api/todo/<todo_id>', methods=['PATCH'], endpoint='api_todo_update')
    @login_required
    def api_todo_update(todo_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            patch = TodoUpdate(**data)
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        # Fetch previous item to compare old vs new category for pruning
        prev = Todo.get(todo_id, current_user.id, mongo.db)
        prev_cats = (prev.category or []) if prev else []
        upd = Todo.update(
            todo_id,
            current_user.id,
            patch,
            mongo.db,
            allow_null=["description", "category", "due_date"],
        )
        if not upd:
            return jsonify({'error': 'Not found'}), 404
        try:
            # Ensure new categories exist (if any)
            if upd.category is not None:
                try:
                    for name in (upd.category or []):
                        Todo.add_category(current_user.id, name, mongo.db)
                except Exception:
                    pass
                # Prune removed categories
                removed = [n for n in prev_cats if n not in (upd.category or [])]
                for n in removed:
                    try:
                        Todo.delete_category(current_user.id, n, mongo.db)
                    except Exception:
                        pass
        except Exception:
            pass
        return jsonify({'item': upd.model_dump(by_alias=True)})

    # Stage-only fast update (lighter payload, avoids accidental clearing of other fields)
    @bp.route('/api/todo/<todo_id>/stage', methods=['PATCH'], endpoint='api_todo_stage_update')
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
    @bp.route('/api/todo/<todo_id>/detail', methods=['GET'], endpoint='api_todo_detail')
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
    @bp.route('/api/todo/<todo_id>/comments', methods=['POST'], endpoint='api_todo_comment_create')
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

    # Image upload (base64 or data URL) -> ImageKit (legacy name kept for route)
    @bp.route('/api/todo-images', methods=['POST'], endpoint='api_todo_image_upload')
    @login_required
    def api_todo_image_upload():  # type: ignore[override]
        """Upload a single image (base64 string or data URL) and return hosted URL.

        Returns 400 with a generic message unless debug flags are enabled.
        Debug enrichment triggers when either:
          * Environment variable IMAGEKIT_DEBUG is truthy, or
          * Config.SHOW_DETAILED_ERRORS is true
        """
        data = request.get_json(force=True, silent=True) or {}
        raw = data.get('image')
        if not raw:
            return jsonify({'error': 'image required'}), 400
        debug_enabled = (
            request.args.get('debug') is not None
            or getattr(Config, 'IMAGEKIT_DEBUG', False)
            or getattr(Config, 'SHOW_DETAILED_ERRORS', False)
        )
        # Fallback simple size heuristic (raw may be base64 or data URL)
        approx_bytes = None
        try:
            if isinstance(raw, str):
                if ';base64,' in raw:
                    approx_bytes = int(len(raw.split(';base64,',1)[1]) * 0.75)
                elif len(raw) < 200000 and all(c.isalnum() or c in '+/=' for c in raw.strip('=')):
                    approx_bytes = int(len(raw) * 0.75)
        except Exception:
            approx_bytes = None
        try:
            url = upload_image(raw)
        except Exception as e:
            # Log full stack server-side; return minimal message to client unless debug.
            logging.getLogger(__name__).exception('Todo image upload failed', extra={
                'user_id': getattr(current_user, 'id', None),
                'approx_bytes': approx_bytes,
                'remote_addr': request.remote_addr,
            })
            payload = {'error': 'Upload failed (image service)'}
            if debug_enabled:
                # Provide original message + basic context (avoid dumping user raw data)
                payload['detail'] = str(e)
                if approx_bytes is not None:
                    payload['approx_bytes'] = str(approx_bytes)
            return jsonify(payload), 400
        return jsonify({'url': url})

    @bp.route('/api/todo/<todo_id>', methods=['DELETE'], endpoint='api_todo_delete')
    @login_required
    def api_todo_delete(todo_id):  # type: ignore[override]
        # Capture previous category before deletion, to prune if becoming unused
        prev = Todo.get(todo_id, current_user.id, mongo.db)
        prev_cats = (prev.category or []) if prev else []
        ok = Todo.delete(todo_id, current_user.id, mongo.db)
        if not ok:
            return jsonify({'error': 'Not found'}), 404
        # Attempt to prune previous categories if now unused
        try:
            for n in (prev_cats or []):
                try:
                    Todo.delete_category(current_user.id, n, mongo.db)
                except Exception:
                    pass
        except Exception:
            pass
        return jsonify({'success': True})


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

    # Note: todo sort preference is now handled by the unified /api/sort-pref endpoint

    return bp
