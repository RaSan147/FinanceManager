from datetime import datetime, timedelta, timezone
from bson import ObjectId
import json
from collections import defaultdict

class PurchaseAdvice:
    @staticmethod
    def save_advice(user_id, request_data, advice, db):
        doc = {
            'user_id': user_id,
            'request': request_data,
            'advice': advice,
            'category': request_data.get('category', 'other'),
            'amount': float(request_data.get('amount', request_data.get('amount', 0))),
            'created_at': datetime.now(timezone.utc),
            'is_archived': False,
            'tags': request_data.get('tags', []),
            'user_action': 'unknown'  # can be 'followed', 'ignored', or 'unknown'
        }
        return db.purchase_advice.insert_one(doc).inserted_id

    @staticmethod
    def set_user_action(advice_id, user_id, action, db):
        """
        Update the user_action field for a given advice entry.
        action: 'followed' or 'ignored'
        """
        db.purchase_advice.update_one(
            {'_id': ObjectId(advice_id), 'user_id': user_id},
            {'$set': {'user_action': action}}
        )

    @staticmethod
    def get_recent_advices(user_id, db, limit=10):
        return list(db.purchase_advice.find(
            {'user_id': user_id, 'is_archived': False}
        ).sort('created_at', -1).limit(limit))

    @staticmethod
    def get_stats(user_id, db):
        # 30-day spending by category
        thirty_days_ago = datetime.now(timezone.utc) - timedelta(days=30)
        pipeline = [
            {'$match': {
                'user_id': user_id,
                'created_at': {'$gte': thirty_days_ago}
            }},
            {'$group': {
                '_id': '$category',
                'total_amount': {'$sum': '$amount'},
                'count': {'$sum': 1},
                'avg_amount': {'$avg': '$amount'}
            }},
            {'$sort': {'total_amount': -1}}
        ]
        return list(db.purchase_advice.aggregate(pipeline))

    @staticmethod
    def get_impact_on_goals(user_id, db):
        # Get all active goals
        goals = list(db.goals.find({
            'user_id': user_id,
            'is_completed': False
        }))

        # Calculate total recommended savings
        pipeline = [
            {'$match': {
                'user_id': user_id,
                'advice.recommendation': 'no',
                'created_at': {'$gte': datetime.now(timezone.utc) - timedelta(days=30)}
            }},
            {'$group': {
                '_id': None,
                'total_saved': {'$sum': '$amount'}
            }}
        ]
        saved_result = list(db.purchase_advice.aggregate(pipeline))
        total_saved = saved_result[0]['total_saved'] if saved_result else 0.0

        # Calculate potential impact on goals
        for goal in goals:
            try:
                gtype = goal.get('type')
                target_amount = float(goal.get('target_amount') or 0) if goal.get('target_amount') is not None else 0.0
                # Default potential_progress to 0 for non-savings or missing target
                if gtype == 'savings' and target_amount > 0:
                    progress = (float(total_saved) / target_amount) * 100.0
                    # clamp to [0, 100]
                    goal['potential_progress'] = max(0.0, min(100.0, progress))
                else:
                    goal['potential_progress'] = 0.0
                # Normalize target_amount to numeric for client display
                goal['target_amount'] = target_amount
            except Exception:
                goal['potential_progress'] = 0.0

        return {
            'goals': goals,
            'total_saved': total_saved,
            'timeframe': '30 days'
        }

    @staticmethod
    async def archive_old_entries(user_id, db, pastebin_client=None):
        # Archive entries older than 30 days
        old_entries = list(db.purchase_advice.find({
            'user_id': user_id,
            'created_at': {'$lt': datetime.now(timezone.utc) - timedelta(days=30)},
            'is_archived': False
        }))

        if pastebin_client:
            for entry in old_entries:
                paste_url = await pastebin_client.create_paste(
                    title=f"Finance Advice {entry['_id']}",
                    content=json.dumps(entry, default=str),
                    private=True
                )
                db.purchase_advice.update_one(
                    {'_id': entry['_id']},
                    {'$set': {'is_archived': True, 'pastebin_url': paste_url}}
                )
        else:
            db.purchase_advice.update_many(
                {'user_id': user_id, 'created_at': {'$lt': datetime.now(timezone.utc) - timedelta(days=30)}},
                {'$set': {'is_archived': True}}
            )