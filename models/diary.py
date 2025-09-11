"""Diary entry models & helpers.

A lightweight journal/diary feature modeled after To-Dos but simpler:
- No stages / due dates
- Has: title (optional), content (rich markdown-like plain text), category tag
- Supports inline pasted images (stored externally via existing /api/diary-images uploader using ImageKit service)
- Allows comments (threaded like todo comments but simple flat list for now)
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional, Any, Dict
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator
from utils.timezone_utils import now_utc, ensure_utc

DIARY_CATEGORY_MAX = 64
DIARY_CONTENT_MAX = 20000  # generous
DIARY_COMMENT_MAX = 4000

class DiaryBase(BaseModel):
    user_id: str
    title: Optional[str] = Field(default=None, max_length=300)
    content: str = Field(default='', max_length=DIARY_CONTENT_MAX)
    category: Optional[str] = Field(default=None, max_length=DIARY_CATEGORY_MAX)
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)

    @field_validator('title')
    @classmethod
    def _trim_title(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator('content')
    @classmethod
    def _trim_content(cls, v):
        return v.strip()

    @field_validator('category')
    @classmethod
    def _norm_cat(cls, v):
        if v is None:
            return None
        v2 = v.strip()
        return v2 if v2 else None

class DiaryCreate(DiaryBase):
    pass

class DiaryUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=300)
    content: Optional[str] = Field(default=None, max_length=DIARY_CONTENT_MAX)
    category: Optional[str] = Field(default=None, max_length=DIARY_CATEGORY_MAX)

    @field_validator('title')
    @classmethod
    def _trim_title(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator('content')
    @classmethod
    def _trim_content(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator('category')
    @classmethod
    def _norm_cat(cls, v):
        if v is None:
            return None
        v2 = v.strip()
        return v2 if v2 else None

class DiaryInDB(DiaryBase):
    id: str = Field(..., alias='_id')

    @field_validator('id', mode='before')
    @classmethod
    def _norm_id(cls, v):
        if isinstance(v, ObjectId):
            return str(v)
        if not ObjectId.is_valid(v):  # type: ignore[arg-type]
            raise ValueError('Invalid ObjectId')
        return str(v)

class Diary:
    @staticmethod
    def create(data: DiaryCreate, db) -> DiaryInDB:
        doc = data.model_dump()
        res = db.diary_entries.insert_one(doc)
        return DiaryInDB(**{**doc, '_id': res.inserted_id})

    @staticmethod
    def get(entry_id: str, user_id: str, db) -> DiaryInDB | None:
        doc = db.diary_entries.find_one({'_id': ObjectId(entry_id), 'user_id': user_id})
        return DiaryInDB(**doc) if doc else None

    @staticmethod
    def update(entry_id: str, user_id: str, patch: DiaryUpdate, db) -> DiaryInDB | None:
        existing = db.diary_entries.find_one({'_id': ObjectId(entry_id), 'user_id': user_id})
        if not existing:
            return None
        upd_raw: Dict[str, Any] = {}
        for k, v in patch.model_dump().items():
            if v is not None:
                upd_raw[k] = v
            elif k in ('title', 'content', 'category'):
                upd_raw[k] = None
        if not upd_raw:
            return DiaryInDB(**existing)
        upd_raw['updated_at'] = now_utc()
        set_fields = {k: v for k, v in upd_raw.items() if v is not None}
        unset_fields = {k: '' for k, v in upd_raw.items() if v is None}
        ops: Dict[str, Any] = {}
        if set_fields:
            ops['$set'] = set_fields
        if unset_fields:
            ops['$unset'] = unset_fields
        if not ops:
            return DiaryInDB(**existing)
        doc = db.diary_entries.find_one_and_update({'_id': ObjectId(entry_id), 'user_id': user_id}, ops, return_document=True)
        return DiaryInDB(**doc) if doc else None

    @staticmethod
    def delete(entry_id: str, user_id: str, db) -> bool:
        res = db.diary_entries.delete_one({'_id': ObjectId(entry_id), 'user_id': user_id})
        return res.deleted_count == 1

    @staticmethod
    def list(user_id: str, db, *, q: str | None = None, category: str | None = None, skip: int = 0, limit: int = 20, sort: str = 'created_desc') -> tuple[list[DiaryInDB], int]:
        filt: Dict[str, Any] = {'user_id': user_id}
        if category:
            filt['category'] = category
        if q:
            filt['$or'] = [
                {'title': {'$regex': q, '$options': 'i'}},
                {'content': {'$regex': q, '$options': 'i'}},
            ]
        sort_map: dict[str, list[tuple[str, int]]] = {
            'created_desc': [('created_at', -1)],
            'created_asc': [('created_at', 1)],
            'updated_desc': [('updated_at', -1)],
            'updated_asc': [('updated_at', 1)],
            'title': [('title', 1)],
        }
        mongo_sort = sort_map.get(sort, sort_map['created_desc'])
        total = db.diary_entries.count_documents(filt)
        cur = db.diary_entries.find(filt).sort(mongo_sort).skip(skip).limit(limit)
        return [DiaryInDB(**d) for d in cur], total

    @staticmethod
    def list_categories(user_id: str, db) -> list[dict]:
        return list(db.diary_categories.find({'user_id': user_id}).sort([('name', 1)]))

    @staticmethod
    def add_category(user_id: str, name: str, db) -> dict:
        norm = name.strip()
        if not norm:
            raise ValueError('Category name required')
        if len(norm) > DIARY_CATEGORY_MAX:
            raise ValueError('Category too long')
        existing = db.diary_categories.find_one({'user_id': user_id, 'name': norm})
        if existing:
            return existing
        doc = {'user_id': user_id, 'name': norm, 'created_at': now_utc()}
        db.diary_categories.insert_one(doc)
        return doc

    @staticmethod
    def delete_category(user_id: str, name: str, db) -> bool:
        used = db.diary_entries.find_one({'user_id': user_id, 'category': name})
        if used:
            return False
        res = db.diary_categories.delete_one({'user_id': user_id, 'name': name})
        return res.deleted_count == 1

__all__ = ['DiaryCreate', 'DiaryUpdate', 'DiaryInDB', 'Diary', 'DIARY_CATEGORY_MAX', 'DIARY_CONTENT_MAX', 'DIARY_COMMENT_MAX']
