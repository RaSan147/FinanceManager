from bson import ObjectId
from datetime import datetime
import asyncio



class Goal:
    @staticmethod
    async def create_with_ai(goal_data, db, ai_engine):
        goal_id = db.goals.insert_one(goal_data).inserted_id
        
        # AI enhancement in background
        def log_task_exception(task):
            try:
                exc = task.exception()
                if exc is not None:
                    import logging
                    logging.error(f"Background AI task failed: {exc}", exc_info=True)
            except Exception as e:
                pass  # Defensive: Cannot retrieve exception or already logged.

        task = asyncio.create_task(
            Goal._ai_enhance_goal(goal_id, goal_data, db, ai_engine)
        )
        task.add_done_callback(log_task_exception)
        return goal_id
    
    @staticmethod
    async def _ai_enhance_goal(goal_id, goal_data, db, ai_engine):
        import logging
        try:
            user = db.users.find_one({'_id': ObjectId(goal_data['user_id'])})
            context = {
                "goal": goal_data,
                "user_income": user.get('monthly_income', 0),
                "existing_goals": list(db.goals.find({
                    'user_id': goal_data['user_id'],
                    'is_completed': False
                }))
            }
            ai_analysis = await ai_engine.calculate_priority(context)
            db.goals.update_one(
                {'_id': goal_id},
                {'$set': {
                    'ai_priority': ai_analysis['priority_score'],
                    'ai_metadata': {
                        'urgency': ai_analysis['urgency'],
                        'impact': ai_analysis['financial_impact'],
                        'suggestions': ai_analysis['suggested_actions']
                    }
                }}
            )
        except Exception as e:
            logging.error(f"Failed to enhance goal with AI: {e}", exc_info=True)

    
    @staticmethod
    def get_prioritized(user_id, db):
        return list(db.goals.find({'user_id': user_id})
                         .sort('ai_priority', -1))
    
    @staticmethod
    def get_user_goals(user_id, db):
        return list(db.goals.find({'user_id': user_id}).sort('target_date', 1))
    
    @staticmethod
    def get_active_goals(user_id, db):
        return list(db.goals.find({
            'user_id': user_id,
            'is_completed': False
        }).sort('target_date', 1))
    
    @staticmethod
    def mark_as_completed(user_id, goal_id, db):
        db.goals.update_one(
            {'_id': goal_id, 'user_id': user_id},
            {'$set': {'is_completed': True}}
        )
    
    @staticmethod
    def delete_goal(user_id, goal_id, db):
        db.goals.delete_one({'_id': goal_id, 'user_id': user_id})
