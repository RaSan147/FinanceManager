from bson import ObjectId
from datetime import datetime

class Transaction:
    @staticmethod
    def create_transaction(transaction_data, db):
        return db.transactions.insert_one(transaction_data).inserted_id
    
    @staticmethod
    def get_user_transactions(user_id, db, page=1, per_page=10):
        skip = (page - 1) * per_page
        return list(db.transactions.find({'user_id': user_id})
                         .sort([('date', -1), ('created_at', -1)])
                         .skip(skip)
                         .limit(per_page))
    
    @staticmethod
    def get_recent_transactions(user_id, db, limit=5):
        return list(db.transactions.find({'user_id': user_id})
                         .sort([('date', -1), ('created_at', -1)])
                         .limit(limit))
    
    @staticmethod
    def count_user_transactions(user_id, db):
        return db.transactions.count_documents({'user_id': user_id})
    
    @staticmethod
    def delete_transaction(user_id, transaction_id, db):
        db.transactions.delete_one({'_id': transaction_id, 'user_id': user_id})