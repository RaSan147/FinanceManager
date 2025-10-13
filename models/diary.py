"""Diary entry models & helpers.

A lightweight journal/diary feature modeled after To-Do but simpler:
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
from models.blog import Blog

DIARY_CATEGORY_MAX = 64
DIARY_CONTENT_MAX = 20000  # generous
DIARY_COMMENT_MAX = 4000

class DiaryBase(BaseModel):
    user_id: str
    title: Optional[str] = Field(default=None, max_length=300)
    content: str = Field(default='', max_length=DIARY_CONTENT_MAX)
    # category is now a list of tag strings. Keep Optional to allow None.
    category: Optional[list[str]] = Field(default=None)
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
        # Accept either None, or a list of strings, or a comma-joined string (legacy).
        # Enforce each category item's length <= DIARY_CATEGORY_MAX and ignore
        # any non-string or empty values. Return None when no valid categories.
        if v is None:
            return None
        if isinstance(v, list):
            out = []
            for x in v:
                if not isinstance(x, str):
                    continue
                s = x.strip()
                if not s:
                    continue
                if len(s) > DIARY_CATEGORY_MAX:
                    # truncate long category names to the max allowed length
                    s = s[:DIARY_CATEGORY_MAX]
                out.append(s)
            return out if out else None
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            parts = []
            for p in (p.strip() for p in s.split(',') if p.strip()):
                if len(p) > DIARY_CATEGORY_MAX:
                    p = p[:DIARY_CATEGORY_MAX]
                parts.append(p)
            return parts if parts else None
        # For anything else, don't attempt to coerce — return None
        return None

class DiaryCreate(DiaryBase):
    pass

class DiaryUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=300)
    content: Optional[str] = Field(default=None, max_length=DIARY_CONTENT_MAX)
    # Update can accept None, list[str], or comma-joined string for backward compatibility
    category: Optional[list[str]] = Field(default=None)

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
        if isinstance(v, list):
            out = [str(x).strip() for x in v if isinstance(x, str) and x.strip()]
            return out if out else None
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            parts = [p.strip() for p in s.split(',') if p.strip()]
            return parts if parts else None
        try:
            s = str(v).strip()
            parts = [p.strip() for p in s.split(',') if p.strip()]
            return parts if parts else None
        except Exception:
            return None

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
    # internal Blog specialization for diary collections
    class _B(Blog):
        entries_collection = "diary_entries"
        categories_collection = "diary_categories"
        text_search_fields = ["title", "content"]
        category_max = DIARY_CATEGORY_MAX
    @staticmethod
    def create(data: DiaryCreate, db) -> DiaryInDB:
        doc = Diary._B.create_doc(data, db)
        return DiaryInDB(**doc)

    @staticmethod
    def get(entry_id: str, user_id: str, db) -> DiaryInDB | None:
        doc = Diary._B.get_doc(entry_id, user_id, db)
        return DiaryInDB(**doc) if doc else None

    @staticmethod
    def update(entry_id: str, user_id: str, patch: DiaryUpdate, db) -> DiaryInDB | None:
        doc = Diary._B.update_doc(entry_id, user_id, patch, db, allow_null=['title', 'content', 'category'])
        return DiaryInDB(**doc) if doc else None

    @staticmethod
    def delete(entry_id: str, user_id: str, db) -> bool:
        return Diary._B.delete_doc(entry_id, user_id, db)

    @staticmethod
    def list(user_id: str, db, *, q: str | None = None, category: str | None = None, skip: int = 0, limit: int = 20, sort: str = 'created_desc') -> tuple[list[DiaryInDB], int]:
        docs, total = Diary._B.list_docs(user_id, db, q=q, category=category, skip=skip, limit=limit, sort=sort)
        return [DiaryInDB(**d) for d in docs], total

    @staticmethod
    def list_categories(user_id: str, db) -> list[dict]:
        return Diary._B.list_categories(user_id, db)

    @staticmethod
    def add_category(user_id: str, name: str, db) -> dict:
        return Diary._B.add_category(user_id, name, db)

    @staticmethod
    def delete_category(user_id: str, name: str, db) -> bool:
        return Diary._B.delete_category(user_id, name, db)

    @staticmethod
    def prune_unused_categories(user_id: str, names: list[str], db) -> None:
        """Delete category records that have zero references in entries.

        For each provided name, attempt a safe delete via Blog.delete_category,
        which only removes the category if it is not referenced by any entry.
        """
        if not names:
            return
        for n in names:
            try:
                Diary._B.delete_category(user_id, n, db)
            except Exception:
                # Best-effort pruning; ignore failures
                pass

__all__ = ['DiaryCreate', 'DiaryUpdate', 'DiaryInDB', 'Diary', 'DIARY_CATEGORY_MAX', 'DIARY_CONTENT_MAX', 'DIARY_COMMENT_MAX']
