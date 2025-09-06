from bson import ObjectId
from datetime import datetime, timezone
from utils.finance_calculator import get_transactions
from typing import Optional, Dict, Any

"""Centralized category definitions with multilanguage label support.

Structure:
TRANSACTION_CATEGORIES = {
  'income': {
      'salary': {'en': 'Salary'},
      ...
  },
  'expense': { ... }
}

Future languages can add keys (e.g., 'es', 'fr').
"""
TRANSACTION_CATEGORIES: dict[str, dict[str, dict[str, str]]] = {
    'income': {
        'salary': {'en': 'Salary'},
        'freelance': {'en': 'Freelance'},
        'investment': {'en': 'Investment'},
        'gift': {'en': 'Gift'},
        'borrowed': {'en': 'Borrowed (Loan Taken)'},
        'repaid to me': {'en': 'Repaid to Me (Debt Received)'},
        'other': {'en': 'Other Income'},
    },
    'expense': {
        'housing': {'en': 'Housing'},
        'food': {'en': 'Food'},
        'transportation': {'en': 'Transportation'},
        'entertainment': {'en': 'Entertainment'},
        'health': {'en': 'Health'},
        'education': {'en': 'Education'},
        'shopping': {'en': 'Shopping'},
        'work': {'en': 'Work'},
        'lent out': {'en': 'Lent Out (Loan Given)'},
        'repaid by me': {'en': 'Repaid by Me (Debt Payment)'},
        'other': {'en': 'Other Expense'},
    }
}

def _category_values(kind: str) -> set[str]:
    return set(TRANSACTION_CATEGORIES.get(kind, {}).keys())

class Transaction:
    @staticmethod
    def create_transaction(transaction_data, db):
        return db.transactions.insert_one(transaction_data).inserted_id
    
    @staticmethod
    def get_user_transactions(user_id, db, page=1, per_page=10):
        skip = (page - 1) * per_page
        return get_transactions(
            user_id, db,
            sort=[('date', -1), ('created_at', -1)],
            skip=skip,
            limit=per_page
        )
    
    @staticmethod
    def get_recent_transactions(user_id, db, limit=5):
        return get_transactions(
            user_id, db,
            sort=[('date', -1), ('created_at', -1)],
            limit=limit
        )
    
    @staticmethod
    def count_user_transactions(user_id, db):
        return db.transactions.count_documents({'user_id': user_id})
    
    @staticmethod
    def delete_transaction(user_id, transaction_id, db):
        db.transactions.delete_one({'_id': transaction_id, 'user_id': user_id})

    # -------- New helpers for editing --------
    @staticmethod
    def get_transaction(user_id: str, transaction_id: ObjectId, db) -> Optional[dict]:
        return db.transactions.find_one({'_id': transaction_id, 'user_id': user_id})

    @staticmethod
    def update_transaction(user_id: str, transaction_id: ObjectId, update_data: Dict[str, Any], db) -> Optional[dict]:
        """Update a transaction and return the updated document.

        Only provided fields in update_data are modified. 'updated_at' is always bumped.
        """
        if not update_data:
            return Transaction.get_transaction(user_id, transaction_id, db)
        update_data['updated_at'] = datetime.now(timezone.utc)
        db.transactions.update_one({'_id': transaction_id, 'user_id': user_id}, {'$set': update_data})
        return Transaction.get_transaction(user_id, transaction_id, db)

    # ---------------- Category Utilities -----------------
    @staticmethod
    def category_label(kind: str, value: str, lang: str = 'en') -> Optional[str]:
        entry = TRANSACTION_CATEGORIES.get(kind, {}).get(value)
        if not entry:
            return None
        return entry.get(lang) or entry.get('en')

    @staticmethod
    def is_valid_category(kind: str, value: str) -> bool:
        return value in _category_values(kind)

    @staticmethod
    def all_categories() -> dict[str, dict[str, dict[str, str]]]:
        return TRANSACTION_CATEGORIES