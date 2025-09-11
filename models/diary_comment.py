"""Diary comment model & CRUD (mirrors todo comments)."""
from __future__ import annotations
from datetime import datetime
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator
from utils.timezone_utils import now_utc
from models.diary import DIARY_COMMENT_MAX

class DiaryCommentCreate(BaseModel):
    diary_id: str
    user_id: str
    body: str = Field(..., min_length=1, max_length=DIARY_COMMENT_MAX)
    images: list[str] = Field(default_factory=list)

    @field_validator('body')
    @classmethod
    def _trim(cls, v: str):
        return v.strip()

class DiaryCommentInDB(DiaryCommentCreate):
    id: str = Field(..., alias='_id')
    created_at: datetime = Field(default_factory=now_utc)

    @field_validator('id', mode='before')
    @classmethod
    def _id(cls, v):
        if isinstance(v, ObjectId):
            return str(v)
        return v

class DiaryComment:
    @staticmethod
    def create(db, data: DiaryCommentCreate) -> DiaryCommentInDB:
        doc = data.model_dump()
        doc['created_at'] = now_utc()
        res = db.diary_comments.insert_one(doc)
        return DiaryCommentInDB(**{**doc, '_id': res.inserted_id})

    @staticmethod
    def list_for(db, diary_id: str, user_id: str, *, limit: int = 300):
        cur = db.diary_comments.find({'diary_id': diary_id, 'user_id': user_id}).sort([('created_at', 1)]).limit(limit)
        return [DiaryCommentInDB(**d) for d in cur]

    @staticmethod
    def delete(db, comment_id: str, user_id: str) -> bool:
        res = db.diary_comments.delete_one({'_id': ObjectId(comment_id), 'user_id': user_id})
        return res.deleted_count == 1

__all__ = ['DiaryCommentCreate', 'DiaryCommentInDB', 'DiaryComment']
