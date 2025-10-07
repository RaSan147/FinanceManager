from __future__ import annotations
from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, current_app
from flask_login import login_required, current_user
from bson import ObjectId
from typing import Any
from models.user import User
from utils.currency import currency_service
from utils.timezone_utils import now_utc


def init_profile_blueprint(mongo):
    bp = Blueprint('profile_bp', __name__)

    def _sanitize_user(doc: dict) -> dict:
        if not doc:
            return {}
        safe = {k: v for k, v in doc.items() if k not in {'password'}}
        if '_id' in safe:
            safe['_id'] = str(safe['_id'])
        return safe

    @bp.route('/profile', methods=['GET', 'POST'], endpoint='profile')
    @login_required
    def profile():  # type: ignore[override]
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        from utils.request_metrics import summary as metrics_summary
        if request.method == 'POST':
            monthly_income = request.form.get('monthly_income')
            usual_income_date = request.form.get('usual_income_date')
            occupation = request.form.get('occupation')
            default_currency = request.form.get('default_currency')
            monthly_income_currency = request.form.get('monthly_income_currency')
            language = request.form.get('language')
            update_data: dict[str, Any] = {}
            if monthly_income:
                try:
                    mi_val = float(monthly_income)
                    dc = (default_currency or user.get('default_currency') or current_app.config['DEFAULT_CURRENCY']).upper()
                    mic = (monthly_income_currency or dc).upper()
                    update_data['monthly_income'] = currency_service.convert_amount(mi_val, mic, dc)
                    update_data['monthly_income_currency'] = dc
                except ValueError:
                    flash('Monthly income must be a number.', 'danger')
            if usual_income_date:
                try:
                    day = int(usual_income_date)
                    if 1 <= day <= 31:
                        update_data['usual_income_date'] = day
                    else:
                        flash('Usual income date must be between 1 and 31.', 'danger')
                except ValueError:
                    flash('Usual income date must be a number between 1 and 31.', 'danger')
            if occupation is not None:
                update_data['occupation'] = occupation.strip()
            if default_currency:
                new_dc = default_currency.upper()
                old_dc = (user.get('default_currency') or current_app.config['DEFAULT_CURRENCY']).upper()
                update_data['default_currency'] = new_dc
                if new_dc != old_dc:
                    if 'monthly_income' not in update_data and user.get('monthly_income') is not None:
                        try:
                            update_data['monthly_income'] = currency_service.convert_amount(float(user['monthly_income']), old_dc, new_dc)
                            update_data['monthly_income_currency'] = new_dc
                        except Exception:
                            pass
                    try:
                        cursor = mongo.db.transactions.find({'user_id': current_user.id})
                        for tx in cursor:
                            amt = float(tx.get('amount', 0))
                            tx_base = (tx.get('base_currency') or old_dc).upper()
                            new_amt = currency_service.convert_amount(amt, tx_base, new_dc)
                            mongo.db.transactions.update_one({'_id': tx['_id']}, {'$set': {'amount': new_amt, 'base_currency': new_dc}})
                    except Exception:
                        pass
            if language:
                update_data['language'] = (language or 'en').lower()
            if update_data:
                mongo.db.users.update_one({'_id': ObjectId(current_user.id)}, {'$set': update_data})
                flash('Profile updated successfully.', 'success')
                return redirect(url_for('profile'))
        return render_template('profile.html', user=user, perf_metrics=metrics_summary())

    # JSON API
    @bp.route('/api/profile', methods=['GET'], endpoint='api_profile_get')
    @login_required
    def api_profile_get():  # type: ignore[override]
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        if not user:
            return jsonify({'error': 'User not found'}), 404
        return jsonify({'user': _sanitize_user(user)})

    @bp.route('/api/profile', methods=['PATCH'], endpoint='api_profile_update')
    @login_required
    def api_profile_update():  # type: ignore[override]
        user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        if not user:
            return jsonify({'error': 'User not found'}), 404
        data = request.get_json(silent=True) or {}
        update_data: dict[str, Any] = {}
        if 'monthly_income' in data and data['monthly_income'] is not None:
            try:
                mi_val = float(data['monthly_income'])
                dc = (data.get('default_currency') or user.get('default_currency') or current_app.config['DEFAULT_CURRENCY']).upper()
                mic = (data.get('monthly_income_currency') or dc).upper()
                update_data['monthly_income'] = currency_service.convert_amount(mi_val, mic, dc)
                update_data['monthly_income_currency'] = dc
            except ValueError:
                return jsonify({'error': 'monthly_income must be a number'}), 400
        if 'usual_income_date' in data and data['usual_income_date'] is not None:
            try:
                day = int(data['usual_income_date'])
                if 1 <= day <= 31:
                    update_data['usual_income_date'] = day
                else:
                    return jsonify({'error': 'usual_income_date must be 1-31'}), 400
            except ValueError:
                return jsonify({'error': 'usual_income_date must be int'}), 400
        if 'occupation' in data:
            update_data['occupation'] = (data.get('occupation') or '').strip()
        if 'default_currency' in data and data['default_currency']:
            new_dc = data['default_currency'].upper()
            old_dc = (user.get('default_currency') or current_app.config['DEFAULT_CURRENCY']).upper()
            update_data['default_currency'] = new_dc
            if new_dc != old_dc:
                if 'monthly_income' not in update_data and user.get('monthly_income') is not None:
                    try:
                        update_data['monthly_income'] = currency_service.convert_amount(float(user['monthly_income']), old_dc, new_dc)
                        update_data['monthly_income_currency'] = new_dc
                    except Exception:
                        pass
                try:
                    cursor = mongo.db.transactions.find({'user_id': current_user.id})
                    for tx in cursor:
                        amt = float(tx.get('amount', 0))
                        tx_base = (tx.get('base_currency') or old_dc).upper()
                        new_amt = currency_service.convert_amount(amt, tx_base, new_dc)
                        mongo.db.transactions.update_one({'_id': tx['_id']}, {'$set': {'amount': new_amt, 'base_currency': new_dc}})
                except Exception:
                    pass
        if 'language' in data and data['language']:
            update_data['language'] = (data['language'] or 'en').lower()
        if update_data:
            mongo.db.users.update_one({'_id': ObjectId(current_user.id)}, {'$set': update_data})
            user.update(update_data)
        return jsonify({'user': _sanitize_user(user)})

    @bp.route('/api/profile/export', methods=['POST'], endpoint='api_profile_export')
    @login_required
    def api_profile_export():
        """Return up to `limit` items for the requested export_type.
        Supported types: transactions, goals, diary, todos, loans, advice
        """
        data = request.get_json(silent=True) or {}
        export_type = (data.get('export_type') or '').strip().lower()
        try:
            limit = int(data.get('limit', 1000))
        except Exception:
            limit = 1000
        limit = max(1, min(1000, limit))

        collection_map = {
            'transactions': ('transactions', {'user_id': current_user.id}),
            'goals': ('goals', {'user_id': current_user.id}),
            'diary': ('diary', {'user_id': current_user.id}),
            'todos': ('todos', {'user_id': current_user.id}),
            'loans': ('loans', {'user_id': current_user.id}),
            'advice': ('purchase_advice', {'user_id': current_user.id}),
        }

        if export_type not in collection_map:
            return jsonify({'error': 'Unsupported export type'}), 400

        coll_name, query = collection_map[export_type]
        try:
            cursor = mongo.db[coll_name].find(query).sort('created_at', -1).limit(limit)
            items = []
            for doc in cursor:
                # sanitize document: convert _id and any ObjectId fields to str
                flat = {}
                for k, v in doc.items():
                    if k == '_id':
                        flat[k] = str(v)
                    else:
                        try:
                            # try to convert ObjectId-like values
                            from bson import ObjectId as _OID
                            if isinstance(v, _OID):
                                flat[k] = str(v)
                            else:
                                flat[k] = v
                        except Exception:
                            flat[k] = v
                items.append(flat)
            return jsonify({'items': items})
        except Exception as e:
            return jsonify({'error': 'Failed to fetch export data', 'message': str(e)}), 500

    return bp

