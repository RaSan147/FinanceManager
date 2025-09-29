from __future__ import annotations
import os
import traceback
from flask import Blueprint, render_template, request, jsonify
from bson import ObjectId
from flask_login import login_required, current_user
from pydantic import ValidationError as PydValidationError
from models.diary import Diary, DiaryCreate, DiaryUpdate, DIARY_COMMENT_MAX
from models.diary_comment import DiaryComment, DiaryCommentCreate
from utils.imagekit_client import upload_image
from utils.request_metrics import summary as metrics_summary
from config import Config
import logging
logger = logging.getLogger(__name__)
AllowLog = os.getenv("IMAGEKIT_DEBUG") == '1'

def init_diary_blueprint(mongo):
    bp = Blueprint('diary_bp', __name__)

    @bp.route('/diary', endpoint='diary')
    @login_required
    def diary_page():  # type: ignore[override]
        categories = Diary.list_categories(current_user.id, mongo.db)
        return render_template('diary.html', categories=categories, perf_metrics=metrics_summary())

    @bp.route('/api/diary', methods=['GET'], endpoint='api_diary_list')
    @login_required
    def api_diary_list():  # type: ignore[override]
        q = request.args.get('q') or None
        category = request.args.get('category') or None
        page = max(1, int(request.args.get('page', 1)))
        per_page = min(100, int(request.args.get('per_page', 50)))
        skip = (page - 1) * per_page
        sort = (request.args.get('sort') or '').strip()
        # If client did not explicitly request sort, prefer user's persisted preference
        if not sort:
            user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)}) if hasattr(current_user, 'id') else None
            sort = (user_doc.get('sort_modes') or {}).get('diary') if user_doc else ''
        if not sort:
            sort = 'created_desc'
        items, total = Diary.list(current_user.id, mongo.db, q=q, category=category, skip=skip, limit=per_page, sort=sort)
        return jsonify({'items': [i.model_dump(by_alias=True) for i in items], 'total': total, 'page': page, 'per_page': per_page, 'sort': sort})

    @bp.route('/api/diary', methods=['POST'], endpoint='api_diary_create')
    @login_required
    def api_diary_create():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            payload = DiaryCreate(**{
                'user_id': current_user.id,
                'title': data.get('title'),
                'content': data.get('content') or '',
                'category': data.get('category'),
            })
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        item = Diary.create(payload, mongo.db)
        if item.category:
            try:
                Diary.add_category(current_user.id, item.category, mongo.db)
            except Exception:
                pass
        return jsonify({'item': item.model_dump(by_alias=True)})

    @bp.route('/api/diary/<entry_id>', methods=['PATCH'], endpoint='api_diary_update')
    @login_required
    def api_diary_update(entry_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        try:
            patch = DiaryUpdate(**data)
        except PydValidationError as ve:
            return jsonify({'errors': ve.errors()}), 400
        upd = Diary.update(entry_id, current_user.id, patch, mongo.db)
        if not upd:
            return jsonify({'error': 'Not found'}), 404
        if upd.category:
            try:
                Diary.add_category(current_user.id, upd.category, mongo.db)
            except Exception:
                pass
        return jsonify({'item': upd.model_dump(by_alias=True)})

    @bp.route('/api/diary/<entry_id>', methods=['DELETE'], endpoint='api_diary_delete')
    @login_required
    def api_diary_delete(entry_id):  # type: ignore[override]
        ok = Diary.delete(entry_id, current_user.id, mongo.db)
        if not ok:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'success': True})

    @bp.route('/api/diary/<entry_id>/detail', methods=['GET'], endpoint='api_diary_detail')
    @login_required
    def api_diary_detail(entry_id):  # type: ignore[override]
        item = Diary.get(entry_id, current_user.id, mongo.db)
        if not item:
            return jsonify({'error': 'Not found'}), 404
        comments = DiaryComment.list_for(mongo.db, entry_id, current_user.id, limit=500)
        return jsonify({'item': item.model_dump(by_alias=True), 'comments': [c.model_dump(by_alias=True) for c in comments], 'comment_max': DIARY_COMMENT_MAX})

    @bp.route('/api/diary/<entry_id>/comments', methods=['POST'], endpoint='api_diary_comment_create')
    @login_required
    def api_diary_comment_create(entry_id):  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        body = (data.get('body') or '').strip()
        images = data.get('images') or []
        if not isinstance(images, list):
            images = []
        try:
            payload = DiaryCommentCreate(diary_id=entry_id, user_id=current_user.id, body=body, images=images)
        except Exception as e:
            return jsonify({'error': str(e)}), 400
        comment = DiaryComment.create(mongo.db, payload)
        return jsonify({'comment': comment.model_dump(by_alias=True)})

    @bp.route('/api/diary/<entry_id>/comments', methods=['GET'], endpoint='api_diary_comment_list')
    @login_required
    def api_diary_comment_list(entry_id):  # type: ignore[override]
        # Ensure the diary entry belongs to current user
        item = Diary.get(entry_id, current_user.id, mongo.db)
        if not item:
            return jsonify({'error': 'Not found'}), 404
        comments = DiaryComment.list_for(mongo.db, entry_id, current_user.id, limit=500)
        return jsonify({'comments': [c.model_dump(by_alias=True) for c in comments], 'comment_max': DIARY_COMMENT_MAX})

    @bp.route('/api/diary-comments/<comment_id>', methods=['DELETE'], endpoint='api_diary_comment_delete')
    @login_required
    def api_diary_comment_delete(comment_id):  # type: ignore[override]
        ok = DiaryComment.delete(mongo.db, comment_id, current_user.id)
        if not ok:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'success': True})

    @bp.route('/api/diary-images', methods=['POST'], endpoint='api_diary_image_upload')
    @login_required
    def api_diary_image_upload():  # type: ignore[override]
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
            or os.getenv('IMAGEKIT_DEBUG', '').lower() in {'1','true','yes','on'}
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

    @bp.route('/api/diary-categories', methods=['GET'], endpoint='api_diary_categories')
    @login_required
    def api_diary_categories():  # type: ignore[override]
        cats = Diary.list_categories(current_user.id, mongo.db)
        return jsonify({'items': cats})

    @bp.route('/api/diary-categories', methods=['POST'], endpoint='api_diary_category_create')
    @login_required
    def api_diary_category_create():  # type: ignore[override]
        data = request.get_json(force=True, silent=True) or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'Name required'}), 400
        try:
            doc = Diary.add_category(current_user.id, name, mongo.db)
        except Exception as e:
            return jsonify({'error': str(e)}), 400
        return jsonify({'item': doc})

    @bp.route('/api/diary-categories/<name>', methods=['DELETE'], endpoint='api_diary_category_delete')
    @login_required
    def api_diary_category_delete(name):  # type: ignore[override]
        ok = Diary.delete_category(current_user.id, name, mongo.db)
        if not ok:
            return jsonify({'error': 'Cannot delete (in use or not found)'}), 400
        return jsonify({'success': True})

    return bp
