from flask import Blueprint, render_template, jsonify, request, current_app
from flask_login import login_required, current_user
from bson import ObjectId
from datetime import datetime, timedelta, timezone
import asyncio, json, threading, traceback
from utils.request_metrics import summary as metrics_summary
from models.advice import PurchaseAdvice


def init_ai_blueprint(mongo, spending_advisor, pastebin_client):
    bp = Blueprint('ai_bp', __name__)

    @bp.route('/purchase-advisor', endpoint='purchase_advisor')
    @login_required
    def purchase_advisor():
        return render_template('purchase_advisor.html', perf_metrics=metrics_summary())

    @bp.route('/api/ai/advice/<advice_id>', methods=['DELETE'])
    @login_required
    def delete_advice(advice_id):
        entry = mongo.db.purchase_advice.find_one({'_id': ObjectId(advice_id), 'user_id': current_user.id})
        if entry and entry.get('pastebin_url'):
            async def _del_remote():
                await PurchaseAdvice.delete_remote_if_any(entry, pastebin_client)
            threading.Thread(target=lambda: asyncio.run(_del_remote()), daemon=True).start()
        mongo.db.purchase_advice.delete_one({'_id': ObjectId(advice_id), 'user_id': current_user.id})
        return jsonify({'success': True})

    @bp.route('/api/ai/advice/<advice_id>', methods=['GET'])
    @login_required
    def get_advice_content(advice_id):
        doc = mongo.db.purchase_advice.find_one({'_id': ObjectId(advice_id), 'user_id': current_user.id})
        if not doc:
            return jsonify({'error': 'Not found'}), 404
        if 'advice' in doc and doc['advice'] is not None:
            return jsonify({'advice': doc['advice'], 'offloaded': False})
        url = doc.get('pastebin_url')
        if url:
            key = pastebin_client.extract_paste_key(url) if pastebin_client else None
            if key:
                try:
                    raw = asyncio.run(pastebin_client.read_paste(key))
                    if raw:
                        try:
                            remote_obj = json.loads(raw)
                            advice = remote_obj.get('advice') if isinstance(remote_obj, dict) else None
                            if advice is not None:
                                return jsonify({'advice': advice, 'offloaded': True})
                        except Exception:
                            pass
                except Exception:
                    pass
        return jsonify({'error': 'Advice content unavailable'}), 404

    @bp.route('/api/ai/archive-old', methods=['POST'])
    @login_required
    def archive_old_entries():
        asyncio.run(PurchaseAdvice.archive_old_entries(
            current_user.id,
            mongo.db,
            pastebin_client
        ))
        return jsonify({'success': True})

    @bp.route('/api/ai/purchase-advice', methods=['POST'])
    @login_required
    def get_purchase_advice():
        try:
            data = request.get_json(force=True, silent=True)
            if not data or 'amount' not in data or not data.get('description'):
                return jsonify({"error": "Description and price amount are required."}), 400
            try:
                amount = float(data['amount'])
                if amount <= 0:
                    raise ValueError
            except (ValueError, TypeError):
                return jsonify({"error": "Price must be a positive number."}), 400
            user_id = getattr(current_user, 'id', None)
            if not user_id:
                return jsonify({"error": "User not authenticated."}), 401
            user_doc = mongo.db.users.find_one({'_id': ObjectId(user_id)})
            user_base_currency = (user_doc or {}).get('default_currency', current_app.config['DEFAULT_CURRENCY']).upper()
            from app import currency_service
            input_currency = (data.get('currency') or user_base_currency).upper()
            converted_amount = currency_service.convert_amount(amount, input_currency, user_base_currency)
            item_data = {
                'description': data['description'],
                'amount': converted_amount,
                'amount_original': amount,
                'currency': input_currency,
                'base_currency': user_base_currency,
                'category': data.get('category'),
                'tags': data.get('tags', []),
                'urgency': data.get('urgency')
            }
            advice = spending_advisor.evaluate_purchase(user_id, item_data)
            advice = {
                **advice,
                'amount_converted': converted_amount,
                'base_currency': user_base_currency,
            }
            inserted_id = PurchaseAdvice.save_advice(user_id, item_data, advice, mongo.db)
            return jsonify(advice)
        except Exception as e:
            return jsonify({"error": "Internal server error."}), 500

    @bp.route('/api/ai/visualization-data')
    @login_required
    def get_visualization_data():
        impact = {
            'followed_count': mongo.db.purchase_advice.count_documents({
                'user_id': current_user.id,
                'user_action': 'followed',
                'created_at': {'$gte': datetime.now(timezone.utc) - timedelta(days=30)}
            }),
            'ignored_count': mongo.db.purchase_advice.count_documents({
                'user_id': current_user.id,
                'user_action': 'ignored',
                'created_at': {'$gte': datetime.now(timezone.utc) - timedelta(days=30)}
            })
        }
        categories = PurchaseAdvice.get_stats(current_user.id, mongo.db)
        trend = []
        for i in range(4):
            week_start = datetime.now(timezone.utc) - timedelta(weeks=(4-i))
            week_end = week_start + timedelta(weeks=1)
            week_data = list(mongo.db.purchase_advice.aggregate([{
                '$match': {
                    'user_id': current_user.id,
                    'created_at': {'$gte': week_start, '$lt': week_end}
                }},
                {'$group': {
                    '_id': None,
                    'total': {'$sum': '$amount'}
                }}
            ]))
            trend.append({
                'week': week_start.strftime('%b %d'),
                'amount': week_data[0]['total'] if week_data else 0
            })
        goal_impact = PurchaseAdvice.get_impact_on_goals(current_user.id, mongo.db)
        return jsonify({
            'impact': impact,
            'categories': categories,
            'trend': {
                'weeks': [t['week'] for t in trend],
                'amounts': [t['amount'] for t in trend]
            },
            'goal_impact': goal_impact
        })

    @bp.route('/api/ai/advice-history')
    @login_required
    def get_advice_history():
        try:
            page = int(request.args.get('page', 1))
            page_size = int(request.args.get('page_size', 5))
        except (TypeError, ValueError):
            page = 1
            page_size = 5
        skip = (page - 1) * page_size
        user_id = current_user.id
        total = mongo.db.purchase_advice.count_documents({'user_id': user_id, 'is_archived': False})
        advices = list(
            mongo.db.purchase_advice.find({'user_id': user_id, 'is_archived': False}, {'advice': 0})
            .sort('created_at', -1)
            .skip(skip)
            .limit(page_size)
        )
        for advice in advices:
            advice['_id'] = str(advice['_id'])
            if 'created_at' in advice:
                advice['created_at'] = advice['created_at'].isoformat()
            if 'request' in advice:
                if 'amount' in advice['request']:
                    try:
                        advice['request']['amount'] = float(advice['request']['amount'])
                    except Exception:
                        pass
                if 'amount_original' in advice['request']:
                    try:
                        advice['request']['amount_original'] = float(advice['request']['amount_original'])
                    except Exception:
                        pass
        return jsonify({
            'items': advices,
            'total': total,
            'page': page,
            'page_size': page_size
        })

    @bp.route('/api/ai/advice/<advice_id>/action', methods=['POST'])
    @login_required
    def set_advice_user_action(advice_id):
        data = request.get_json()
        action = data.get('action')
        if action not in ['followed', 'ignored']:
            return jsonify({'error': 'Invalid action'}), 400
        PurchaseAdvice.set_user_action(advice_id, current_user.id, action, mongo.db)
        return jsonify({'success': True})

    return bp
