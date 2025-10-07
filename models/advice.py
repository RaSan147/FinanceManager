from datetime import datetime, timedelta, timezone
from bson import ObjectId
import json
from collections import defaultdict

class PurchaseAdvice:
    @staticmethod
    def save_advice(user_id, request_data, advice, db):
        # Build base document
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

        # safe-build summary to avoid errors if advice is not a dict
        summary = None
        if isinstance(advice, dict):
            reason_raw = advice.get('reason')
            if isinstance(reason_raw, str):
                reason_short = (reason_raw[:240] + '...') if len(reason_raw) > 240 else reason_raw
            else:
                reason_short = None
            summary = {
                'recommendation': advice.get('recommendation'),
                'reason': reason_short,
                'impact': advice.get('impact'),
                'amount_converted': advice.get('amount_converted'),
                'base_currency': advice.get('base_currency')
            }
        doc['advice_summary'] = summary

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
            {'user_id': user_id, 'is_archived': False},
            {'advice': 0}
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
        """Archive (offload) entries older than 30 days to Pastebin and delete body from DB.

        Behavior:
        - If pastebin client available: create paste for each, store URL, mark archived, and remove 'advice' field heavy content.
        - If not: simply mark archived but keep data local.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        old_entries = list(db.purchase_advice.find({
            'user_id': user_id,
            'created_at': {'$lt': cutoff},
            'is_archived': False
        }))

        if not old_entries:
            return 0

        migrated = 0
        if pastebin_client:
            for entry in old_entries:
                try:
                    payload = json.dumps(entry, default=str)
                    paste_url = await pastebin_client.create_paste(
                        title=f"Finance Advice {entry['_id']}",
                        content=payload,
                        private=True
                    )
                except Exception:
                    paste_url = None
                update_doc = {'is_archived': True, 'archived_at': datetime.now(timezone.utc)}
                if paste_url:
                    update_doc['pastebin_url'] = paste_url
                    # Remove bulky inline content after offload (shallow scrub)
                    update_doc['advice_offloaded'] = True
                db.purchase_advice.update_one({'_id': entry['_id']}, {'$set': update_doc, '$unset': {'advice': ''}})
                migrated += 1
        else:
            db.purchase_advice.update_many(
                {'user_id': user_id, 'created_at': {'$lt': cutoff}},
                {'$set': {'is_archived': True, 'archived_at': datetime.now(timezone.utc)}}
            )
            migrated = len(old_entries)
        return migrated

    @staticmethod
    async def delete_remote_if_any(entry: dict, pastebin_client=None):
        """Attempt to delete remote paste for a purchase advice entry if present."""
        if not pastebin_client:
            return False
        url = entry.get('pastebin_url')
        if not url:
            return False
        key = pastebin_client.extract_paste_key(url)
        if not key:
            return False
        try:
            return await pastebin_client.delete_paste(key)
        except Exception:
            return False