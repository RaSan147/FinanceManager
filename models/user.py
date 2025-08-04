from bson import ObjectId
from flask_login import UserMixin

class User(UserMixin):
    def __init__(self, user_data):
        self.id = str(user_data['_id'])
        self.email = user_data['email']
        self.name = user_data.get('name', '')
        self.created_at = user_data.get('created_at')