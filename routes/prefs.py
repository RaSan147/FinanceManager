from __future__ import annotations
from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user
from models.user import User


def init_prefs_blueprint(mongo):
    bp = Blueprint('prefs_bp', __name__)

    @bp.route('/api/sort-pref', methods=['POST'], endpoint='api_sort_pref')
    @login_required
    def api_sort_pref():  # type: ignore[override]
        """Unified endpoint to persist per-user sort preferences.

        Expects JSON: { name: 'goals'|'todo'|'diary', sort: '...' }
        """
        data = request.get_json(force=True, silent=True) or {}
        name = (data.get('name') or '').strip()
        sort = (data.get('sort') or '').strip().lower()
        if not name or not sort:
            return jsonify({'error': 'name and sort required'}), 400
        # Only allow a small whitelist of names we support
        allowed_names = {'goals', 'todo', 'diary'}
        if name not in allowed_names:
            return jsonify({'error': 'unknown preference name'}), 400
        user_obj = User.get_by_id(current_user.id, mongo.db)
        if not user_obj or not getattr(user_obj, 'set_sort_mode', None):
            return jsonify({'error': 'unsupported'}), 400
        ok = user_obj.set_sort_mode(name, sort)
        if not ok:
            # Provide allowed values to help callers debug
            allowed = getattr(user_obj, 'SORT_MODE_OPTIONS', {}).get(name)
            return jsonify({'error': 'invalid sort', 'allowed': list(allowed) if allowed else None}), 400
        return jsonify({'success': True, 'name': name, 'sort': sort})

    return bp
