import json
import traceback
from bson import ObjectId
from datetime import datetime, timedelta
import asyncio
import logging
import threading

from flask_pymongo.wrappers import Database

from models.user import User
from utils.ai_priority_engine import FinancialBrain
from utils.finance_calculator import calculate_lifetime_transaction_summary, get_N_month_income_expense
# Configure basic logging for the module
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class Goal:
    """
    A class to manage user financial goals with AI integration.
    """

    @staticmethod
    async def create_with_ai(goal_data: dict, db: Database, ai_engine: FinancialBrain) -> ObjectId:
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

        def run_ai_enhancement():
            asyncio.run(Goal._ai_enhance_goal(goal_id, goal_data, db, ai_engine))

        thread = threading.Thread(target=run_ai_enhancement, daemon=True)
        thread.start()

        return goal_id
    
    @staticmethod
    async def _ai_enhance_goal(goal_id, goal_data, db: Database, ai_engine: FinancialBrain):
        """Performs the AI-powered analysis and updates the goal in the background."""
        try:
            print("\n=== Starting AI Goal Enhancement ===")
            
            # Ensure user_id is a string before converting to ObjectId
            user_id_str = goal_data['user_id']
            if not isinstance(user_id_str, str):
                raise ValueError(f"Invalid user_id type: {type(user_id_str)}")

            user = db.users.find_one({'_id': ObjectId(user_id_str)})
            if not user:
                raise ValueError(f"User with ID {user_id_str} not found")

            user_obj = User(user, db)

            balance_info = user_obj.get_lifetime_transaction_summary()

            # Get past 3 months' income and expenses
            monthly_history = user_obj.get_recent_income_expense(months=3)

            context = {
                "goal": goal_data,
                "user_monthly_income": user.get('monthly_income', 0),
                "user_expected_monthly_income_date": user_obj.usual_income_date,
                "user_balance": balance_info.get('current_balance', 0) if isinstance(balance_info, dict) else balance_info,
                "monthly_history": monthly_history,
                "today": datetime.utcnow().isoformat(),
                "existing_goals": list(db.goals.find({
                    'user_id': user_id_str,
                    'is_completed': False,
                    '_id': {'$ne': goal_id} # Exclude the current goal from the list
                }))
            }

            print("\n=== DEBUG: Gemini Input Context ===")
            print(json.dumps(context, indent=2, default=str))
            
            ai_analysis = await ai_engine.calculate_priority(context)
            
            print("\n=== DEBUG: Gemini Output ===")
            print(json.dumps(ai_analysis, indent=2))

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
                    'ai_plan': ai_analysis.get('summary'),
                    "last_updated": datetime.utcnow()
                }}
            )
            print("=== AI Enhancement Completed Successfully ===")
            
        except Exception as e:
            print(f"\n=== ERROR in _ai_enhance_goal: {str(e)} ===")
            print(traceback.format_exc())
            raise  # Re-raise the exception after logging

    @staticmethod
    def get_prioritized(user_id: str, db: Database) -> list:
        """Retrieves and sorts a user's goals by AI-assigned priority."""
        return list(db.goals.find({'user_id': user_id}).sort('ai_priority', -1))
    
    @staticmethod
    def get_user_goals(user_id: str, db: Database) -> list:
        """Retrieves all goals for a user, sorted by target date."""
        return list(db.goals.find({'user_id': user_id}).sort('target_date', 1))
    
    @staticmethod
    def get_active_goals(user_id: str, db: Database) -> list:
        """Retrieves a user's active (uncompleted) goals, sorted by target date."""
        return list(db.goals.find({
            'user_id': user_id,
            'is_completed': False
        }).sort('target_date', 1))
    
    @staticmethod
    def mark_as_completed(user_id: str, goal_id: ObjectId, db: Database):
        """Marks a specific goal as completed for a user."""
        db.goals.update_one(
            {'_id': goal_id, 'user_id': user_id},
            {'$set': {'is_completed': True, 'completed_date': datetime.utcnow()}}
        )
    
    @staticmethod
    def delete_goal(user_id: str, goal_id: ObjectId, db: Database):
        """Deletes a goal for a user."""
        db.goals.delete_one({'_id': goal_id, 'user_id': user_id})

    @staticmethod
    def calculate_goal_progress(goal_data, monthly_summary):
        target_date = goal_data['target_date']
        now = datetime.utcnow()

        total_saved = goal_data.get('current_amount', 0)  # Must track real saved total
        remaining_months = (target_date - now).days / 30
        target_amount = goal_data['target_amount']

        # Overdue tracking
        overdue_months = 0
        if target_date < now:
            overdue_months = abs(remaining_months)
            remaining_months = 0.01  # Prevent div/0, treat as "immediate"

        if goal_data['type'] == 'savings':
            required_monthly = (target_amount - total_saved) / max(remaining_months, 1)
            current_monthly = monthly_summary.get('savings', 0)
            progress = (total_saved / target_amount) * 100

            return {
                'progress_percent': round(progress, 1),
                'current': current_monthly,
                'required': max(required_monthly, 0),
                'overdue_months': round(overdue_months, 1)
            }

        elif goal_data['type'] == 'purchase':
            required_monthly = (target_amount - total_saved) / max(remaining_months, 1)
            progress = (total_saved / target_amount) * 100

            return {
                'progress_percent': round(progress, 1),
                'current': total_saved,
                'required': max(required_monthly, 0),
                'overdue_months': round(overdue_months, 1)
            }

        else:
            raise ValueError(f"Unknown goal type: {goal_data['type']}")

