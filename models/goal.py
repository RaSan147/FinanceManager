from bson import ObjectId
from datetime import datetime
import asyncio
import logging
from utils.ai_priority_engine import FinancialBrain

# Configure basic logging for the module
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class Goal:
    """
    A class to manage user financial goals with AI integration.
    """

    @staticmethod
    async def create_with_ai(goal_data: dict, db, ai_engine) -> ObjectId:
        """
        Creates a new goal and triggers a background task for AI enhancement.

        Args:
            goal_data (dict): The data for the new goal. Must contain 'user_id'.
            db: The database connection object (e.g., a pymongo client).
            ai_engine: An instance of the AI service to be used for enhancement.

        Returns:
            ObjectId: The ID of the newly created goal.
        """
        if 'user_id' not in goal_data:
            raise ValueError("Goal data must contain 'user_id'.")

        goal_id = db.goals.insert_one(goal_data).inserted_id
        
        
        # AI enhancement in the background
        def log_task_exception(task):
            """Logs exceptions from the background task, ignoring CancelledError."""
            try:
                # Check if the task was cancelled
                if task.cancelled():
                    logging.info(f"Background AI task for goal {goal_id} was cancelled gracefully.")
                    return

                # If not cancelled, check for other exceptions
                exc = task.exception()
                if exc is not None:
                    # Log the exception if it's not a CancelledError
                    logging.error(f"Background AI task for goal {goal_id} failed: {exc}", exc_info=True)
            except asyncio.CancelledError:
                # This should not be hit with the new logic, but it's a good defensive measure
                logging.info(f"Background AI task for goal {goal_id} was cancelled gracefully (defensive).")
            except Exception as e:
                # Defensive: Handle potential errors in retrieving the exception itself
                logging.error(f"An unexpected error occurred in the task done callback: {e}")

        # Create and schedule the background task
        task = asyncio.create_task(
            Goal._ai_enhance_goal(goal_id, goal_data, db, ai_engine)
        )
        task.add_done_callback(log_task_exception)
        
        return goal_id
    
    @staticmethod
    async def _ai_enhance_goal(goal_id: ObjectId, goal_data: dict, db, ai_engine: FinancialBrain):
        """
        Performs the AI-powered analysis and updates the goal in the background.

        Args:
            goal_id (ObjectId): The ID of the goal to enhance.
            goal_data (dict): The initial data of the goal.
            db: The database connection object.
            ai_engine: The AI service instance.
        """
        try:
            # Ensure user_id is a string before converting to ObjectId
            user_id_str = goal_data['user_id']
            if not isinstance(user_id_str, str):
                logging.error(f"Invalid user_id type: {type(user_id_str)} for goal {goal_id}")
                return

            user = db.users.find_one({'_id': ObjectId(user_id_str)})
            if not user:
                logging.warning(f"User with ID {user_id_str} not found for goal {goal_id}. Skipping AI enhancement.")
                return

            context = {
                "goal": goal_data,
                "user_income": user.get('monthly_income', 0),
                "existing_goals": list(db.goals.find({
                    'user_id': user_id_str,
                    'is_completed': False,
                    '_id': {'$ne': goal_id} # Exclude the current goal from the list
                }))
            }
            
            # Call the AI service
            ai_analysis = await ai_engine.calculate_priority(context)
            
            # Update the goal with the AI analysis results
            db.goals.update_one(
                {'_id': goal_id},
                {'$set': {
                    'ai_priority': ai_analysis.get('priority_score', 0),
                    'ai_metadata': {
                        'urgency': ai_analysis.get('urgency'),
                        'impact': ai_analysis.get('financial_impact'),
                        'suggestions': ai_analysis.get('suggested_actions')
                    },
                    'ai_plan': ai_analysis.get('summary')
                }}
            )
            logging.info(f"AI enhancement completed for goal {goal_id}.")

        except Exception as e:
            logging.error(f"Failed to enhance goal {goal_id} with AI: {e}", exc_info=True)

    @staticmethod
    def get_prioritized(user_id: str, db) -> list:
        """Retrieves and sorts a user's goals by AI-assigned priority."""
        return list(db.goals.find({'user_id': user_id}).sort('ai_priority', -1))
    
    @staticmethod
    def get_user_goals(user_id: str, db) -> list:
        """Retrieves all goals for a user, sorted by target date."""
        return list(db.goals.find({'user_id': user_id}).sort('target_date', 1))
    
    @staticmethod
    def get_active_goals(user_id: str, db) -> list:
        """Retrieves a user's active (uncompleted) goals, sorted by target date."""
        return list(db.goals.find({
            'user_id': user_id,
            'is_completed': False
        }).sort('target_date', 1))
    
    @staticmethod
    def mark_as_completed(user_id: str, goal_id: ObjectId, db):
        """Marks a specific goal as completed for a user."""
        db.goals.update_one(
            {'_id': goal_id, 'user_id': user_id},
            {'$set': {'is_completed': True, 'completed_date': datetime.utcnow()}}
        )
    
    @staticmethod
    def delete_goal(user_id: str, goal_id: ObjectId, db):
        """Deletes a goal for a user."""
        db.goals.delete_one({'_id': goal_id, 'user_id': user_id})