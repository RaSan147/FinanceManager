"""Todo models & persistence utilities.

Feature: General (non-financial) personal to-do list items with categories and stages.

Stages reflect lifecycle: wondering -> planning -> in_progress -> paused -> gave_up -> done (extensible).

Mongo Collections Used:
 - todos
 - todo_categories (optional user-defined categories)

Indexing is handled in utils.db_indexes.ensure_indexes.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, List, Literal, Any, Dict
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator

from utils.timezone_utils import now_utc, ensure_utc

# ----- Constants -----

TODO_STAGES = [
    "wondering",
    "planning",
    "in_progress",
    "paused",
    "gave_up",
    "done",
]

DEFAULT_TODO_STAGE = "wondering"


# ----- Limits / Config -----
TODO_CATEGORY_MAX = 64  # standardized tag length
TODO_DESC_TRUNCATE_LEN = 400  # UI truncate length
TODO_COMMENT_MAX = 2000
TODO_STAGE_HISTORY_MAX = 50

# ----- Pydantic Schemas -----

class TodoBase(BaseModel):
    user_id: str
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    # Category free-text (user defined) limited to 60 chars (front & back)
    category: Optional[str] = Field(default=None, max_length=TODO_CATEGORY_MAX)
    stage: Literal[
        "wondering", "planning", "in_progress", "paused", "gave_up", "done"
    ] = Field(default=DEFAULT_TODO_STAGE)
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)
    # Stage history (embedded, newest appended; trimmed server-side)
    stage_events: list[dict] = Field(default_factory=list)
    # New tracking fields (kanban enhancements)
    stage_updated_at: datetime = Field(default_factory=now_utc)
    completed_at: Optional[datetime] = None
    due_date: Optional[datetime] = None

    @field_validator("title")
    @classmethod
    def _trim_title(cls, v):
        return v.strip()

    @field_validator("description")
    @classmethod
    def _trim_desc(cls, v):
        return v.strip()

    @field_validator("category")
    @classmethod
    def _norm_cat(cls, v):
        if v is None:
            return None
        v2 = v.strip()
        return v2 if v2 else None

    @field_validator("due_date", mode="before")
    @classmethod
    def _parse_due_date(cls, v):
        if not v:
            return None
        if isinstance(v, datetime):
            return ensure_utc(v)
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            # Try basic date-only (YYYY-MM-DD)
            try:
                if len(s) == 10:
                    from datetime import datetime as _dt
                    return ensure_utc(_dt.strptime(s, "%Y-%m-%d"))
                # Otherwise ISO parse
                from datetime import datetime as _dt
                return ensure_utc(_dt.fromisoformat(s))
            except Exception:
                return None
        return None


class TodoCreate(TodoBase):
    pass


class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    # Mirror create constraint (<=60 chars)
    category: Optional[str] = Field(default=None, max_length=TODO_CATEGORY_MAX)
    stage: Optional[Literal[
        "wondering", "planning", "in_progress", "paused", "gave_up", "done"
    ]] = None
    due_date: Optional[datetime | str] = None

    @field_validator("title")
    @classmethod
    def _trim_title(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("description")
    @classmethod
    def _trim_desc(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("category")
    @classmethod
    def _norm_cat(cls, v):
        if v is None:
            return None
        v2 = v.strip()
        return v2 if v2 else None

    @field_validator("due_date", mode="before")
    @classmethod
    def _parse_due_date(cls, v):
        if not v:
            return None
        if isinstance(v, datetime):
            return ensure_utc(v)
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            try:
                if len(s) == 10:
                    from datetime import datetime as _dt
                    return ensure_utc(_dt.strptime(s, "%Y-%m-%d"))
                from datetime import datetime as _dt
                return ensure_utc(_dt.fromisoformat(s))
            except Exception:
                return None
        return None


class TodoInDB(TodoBase):
    id: str = Field(..., alias="_id")

    @field_validator("id", mode="before")
    @classmethod
    def _norm_id(cls, v):
        if isinstance(v, ObjectId):
            return str(v)
        if not ObjectId.is_valid(v):  # type: ignore[arg-type]
            raise ValueError("Invalid ObjectId")
        return str(v)


__all__ = [
    "TodoCreate",
    "TodoUpdate",
    "TodoInDB",
    "Todo",
    "TODO_STAGES",
    "TODO_CATEGORY_MAX",
    "TODO_DESC_TRUNCATE_LEN",
    "TODO_COMMENT_MAX",
    "TODO_STAGE_HISTORY_MAX",
]


class Todo:
    """Static CRUD helpers for Todo records."""

    @staticmethod
    def create(data: TodoCreate, db) -> TodoInDB:
        doc = data.model_dump()
        res = db.todos.insert_one(doc)
        return TodoInDB(**{**doc, "_id": res.inserted_id})

    @staticmethod
    def get(todo_id: str, user_id: str, db) -> TodoInDB | None:
        doc = db.todos.find_one({"_id": ObjectId(todo_id), "user_id": user_id})
        return TodoInDB(**doc) if doc else None

    @staticmethod
    def update(
        todo_id: str,
        user_id: str,
        patch: TodoUpdate,
        db,
        *,
        allow_null: list[str] | None = None,
    ) -> TodoInDB | None:
        existing = db.todos.find_one({"_id": ObjectId(todo_id), "user_id": user_id})
        if not existing:
            return None
        # Allow explicit clearing (setting to None) for selected nullable fields
        allow_null = allow_null or []
        upd_raw: dict[str, Any] = {}
        for k, v in patch.model_dump().items():
            if v is not None:
                upd_raw[k] = v
            elif k in allow_null:
                # Explicitly clear field; represent as None (will be $unset below)
                upd_raw[k] = None
        if not upd_raw:
            return TodoInDB(**existing)
        now = now_utc()
        upd_raw["updated_at"] = now
        stage_changed = False
        if "stage" in upd_raw and upd_raw["stage"] != existing.get("stage"):
            stage_changed = True
            upd_raw["stage_updated_at"] = now
            if upd_raw["stage"] == "done":
                upd_raw["completed_at"] = now
            else:
                # If moving away from done, clear completion timestamp
                if existing.get("completed_at"):
                    upd_raw["completed_at"] = None
        set_fields = {k: v for k, v in upd_raw.items() if v is not None}
        unset_fields = {k: "" for k, v in upd_raw.items() if v is None}
        update_ops: dict[str, Any] = {}
        if set_fields:
            update_ops["$set"] = set_fields
        if unset_fields:
            update_ops["$unset"] = unset_fields
        if stage_changed:
            # Append stage event (trim to last N)
            update_ops["$push"] = {
                "stage_events": {
                    "$each": [{
                        "from": existing.get("stage"),
                        "to": upd_raw.get("stage"),
                        "at": now
                    }],
                    "$slice": -TODO_STAGE_HISTORY_MAX
                }
            }
        if not update_ops:
            return TodoInDB(**existing)
        doc = db.todos.find_one_and_update(
            {"_id": ObjectId(todo_id), "user_id": user_id},
            update_ops,
            return_document=True,
        )
        return TodoInDB(**doc) if doc else None

    @staticmethod
    def delete(todo_id: str, user_id: str, db) -> bool:
        res = db.todos.delete_one({"_id": ObjectId(todo_id), "user_id": user_id})
        return res.deleted_count == 1

    @staticmethod
    def list(
        user_id: str,
        db,
        *,
        q: str | None = None,
        stage: str | None = None,
        category: str | None = None,
        skip: int = 0,
        limit: int = 20,
        sort: str = "created_desc",
    ) -> tuple[list[TodoInDB], int]:
        filt: Dict[str, Any] = {"user_id": user_id}
        if stage:
            filt["stage"] = stage
        if category:
            filt["category"] = category
        if q:
            filt["$or"] = [
                {"title": {"$regex": q, "$options": "i"}},
                {"description": {"$regex": q, "$options": "i"}},
            ]
        sort_map: dict[str, list[tuple[str, int]]] = {
            "created_desc": [("created_at", -1)],
            "created_asc": [("created_at", 1)],
            "updated_desc": [("updated_at", -1)],
            "updated_asc": [("updated_at", 1)],
            "title": [("title", 1)],
            "due_date": [("due_date", 1), ("created_at", -1)],
        }
        mongo_sort = sort_map.get(sort, sort_map["created_desc"])
        total = db.todos.count_documents(filt)
        cursor = db.todos.find(filt).sort(mongo_sort).skip(skip).limit(limit)
        return [TodoInDB(**d) for d in cursor], total

    @staticmethod
    def list_categories(user_id: str, db) -> list[dict]:
        return list(db.todo_categories.find({"user_id": user_id}).sort([("name", 1)]))

    @staticmethod
    def add_category(user_id: str, name: str, db) -> dict:
        norm = name.strip()
        if not norm:
            raise ValueError("Category name required")
        if len(norm) > 60:
            raise ValueError("Category max length is 60 characters")
        existing = db.todo_categories.find_one({"user_id": user_id, "name": norm})
        if existing:
            return existing
        doc = {"user_id": user_id, "name": norm, "created_at": now_utc()}
        db.todo_categories.insert_one(doc)
        return doc

    @staticmethod
    def delete_category(user_id: str, name: str, db) -> bool:
        # Only allow deletion if no todos reference it (safety)
        used = db.todos.find_one({"user_id": user_id, "category": name})
        if used:
            return False
        res = db.todo_categories.delete_one({"user_id": user_id, "name": name})
        return res.deleted_count == 1
