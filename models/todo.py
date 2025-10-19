"""Todo models & persistence utilities.

Feature: General (non-financial) personal to-do list items with categories and stages.

Stages reflect lifecycle: wondering -> planning -> in_progress -> paused -> gave_up -> done (extensible).

Mongo Collections Used:
 - todo
 - todo_categories (optional user-defined categories)

Indexing is handled in utils.db_indexes.ensure_indexes.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, List, Literal, Any, Dict
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator

from utils.timezone_utils import now_utc, ensure_utc
from models.blog import Blog

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
    # Category tags: store as list of strings (like Diary)
    category: Optional[list[str]] = Field(default=None)
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
        # Accept None, list[str], or comma-joined string (legacy). Truncate to max length.
        if v is None:
            return None
        if isinstance(v, list):
            out: list[str] = []
            for x in v:
                if not isinstance(x, str):
                    continue
                s = x.strip()
                if not s:
                    continue
                if len(s) > TODO_CATEGORY_MAX:
                    s = s[:TODO_CATEGORY_MAX]
                out.append(s)
            return out if out else None
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            parts: list[str] = []
            for p in (p.strip() for p in s.split(',') if p.strip()):
                if len(p) > TODO_CATEGORY_MAX:
                    p = p[:TODO_CATEGORY_MAX]
                parts.append(p)
            return parts if parts else None
        return None

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
    # Mirror create (list of strings)
    category: Optional[list[str]] = Field(default=None)
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

    # internal Blog specialization for todo collections
    class _B(Blog):
        entries_collection = "todo"
        categories_collection = "todo_categories"
        text_search_fields = ["title", "description"]
        category_max = TODO_CATEGORY_MAX

    @staticmethod
    def create(data: TodoCreate, db) -> TodoInDB:
        # Use shared Blog storage helper
        # set collection names on Blog via subclass attributes when needed
        # For compatibility we call Blog.create_doc but ensure the correct collection name
        # by temporarily copying class attributes.
        doc = Todo._B.create_doc(data, db)
        return TodoInDB(**doc)

    @staticmethod
    def get(todo_id: str, user_id: str, db) -> TodoInDB | None:
        doc = Todo._B.get_doc(todo_id, user_id, db)
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
        existing = db.todo.find_one({"_id": ObjectId(todo_id), "user_id": user_id})
        if not existing:
            return None
        # Allow explicit clearing (setting to None) for selected nullable fields
        allow_null = allow_null or []
        upd_raw: dict[str, Any] = {}
        # Only iterate fields explicitly provided by the client. This ensures
        # we don't accidentally touch fields that were omitted. Empty strings
        # provided in the payload will be included here and applied as-is.
        for k, v in patch.model_dump(exclude_unset=True).items():
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
        doc = db.todo.find_one_and_update(
            {"_id": ObjectId(todo_id), "user_id": user_id},
            update_ops,
            return_document=True,
        )
        return TodoInDB(**doc) if doc else None

    @staticmethod
    def delete(todo_id: str, user_id: str, db) -> bool:
        res = db.todo.delete_one({"_id": ObjectId(todo_id), "user_id": user_id})
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
        # Use blog listing for common filtering, then apply stage filter if present
        docs, total = Todo._B.list_docs(user_id, db, q=q, category=category, skip=skip, limit=limit, sort=sort)
        if stage:
            docs = [d for d in docs if d.get("stage") == stage]
            total = len(docs) if q is None and category is None else sum(1 for d in docs)
        return [TodoInDB(**d) for d in docs], total

    @staticmethod
    def list_categories(user_id: str, db) -> list[dict]:
        return Todo._B.list_categories(user_id, db)

    @staticmethod
    def add_category(user_id: str, name: str, db) -> dict:
        return Todo._B.add_category(user_id, name, db)

    @staticmethod
    def delete_category(user_id: str, name: str, db) -> bool:
        return Todo._B.delete_category(user_id, name, db)
