"""Todo comment model & helpers."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional, Any
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator
from utils.timezone_utils import now_utc
from models.todo import TODO_COMMENT_MAX

class TodoCommentCreate(BaseModel):
    todo_id: str
    user_id: str
    body: str = Field(..., min_length=1, max_length=TODO_COMMENT_MAX)
    images: list[str] = Field(default_factory=list)

    @field_validator('body')
    @classmethod
    def _trim(cls, v: str):
        return v.strip()

class TodoCommentInDB(TodoCommentCreate):
    id: str = Field(..., alias="_id")
    created_at: datetime = Field(default_factory=now_utc)

    @field_validator('id', mode='before')
    @classmethod
    def _id(cls, v):
        if isinstance(v, ObjectId):
            return str(v)
        return v

class TodoComment:
    @staticmethod
    def create(db, data: TodoCommentCreate) -> TodoCommentInDB:
        doc = data.model_dump()
        doc['created_at'] = now_utc()
        res = db.todo_comments.insert_one(doc)
        return TodoCommentInDB(**{**doc, '_id': res.inserted_id})

    @staticmethod
    def list_for(db, todo_id: str, user_id: str, *, limit: int = 100):
        cur = db.todo_comments.find({'todo_id': todo_id, 'user_id': user_id}).sort([('created_at', 1)]).limit(limit)
        return [TodoCommentInDB(**d) for d in cur]

    @staticmethod
    def delete(db, comment_id: str, user_id: str) -> bool:
        res = db.todo_comments.delete_one({'_id': ObjectId(comment_id), 'user_id': user_id})
        return res.deleted_count == 1

__all__ = ['TodoCommentCreate', 'TodoCommentInDB', 'TodoComment']
