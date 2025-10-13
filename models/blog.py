from __future__ import annotations
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime
from bson import ObjectId
import re

from utils.timezone_utils import now_utc


class Blog:
    """Generic blog-like CRUD helpers for simple text entries + categories.

    Subclasses should set:
      - entries_collection: str
      - categories_collection: str
      - text_search_fields: list[str] (defaults to ['title','content'])
      - category_max: int

    The methods here operate on raw Mongo documents. Model-specific classes
    (e.g., Diary, Todo) should wrap results into their Pydantic InDB schemas.
    """

    entries_collection: str = "entries"
    categories_collection: str = "categories"
    text_search_fields: List[str] = ["title", "content"]
    category_max: int = 64

    @classmethod
    def create_doc(cls, data, db) -> Dict[str, Any]:
        doc = data.model_dump()
        col = db[cls.entries_collection]
        res = col.insert_one(doc)
        return {**doc, "_id": res.inserted_id}

    @classmethod
    def get_doc(cls, entry_id: str, user_id: str, db) -> Optional[Dict[str, Any]]:
        col = db[cls.entries_collection]
        doc = col.find_one({"_id": ObjectId(entry_id), "user_id": user_id})
        return doc

    @classmethod
    def delete_doc(cls, entry_id: str, user_id: str, db) -> bool:
        col = db[cls.entries_collection]
        res = col.delete_one({"_id": ObjectId(entry_id), "user_id": user_id})
        return res.deleted_count == 1

    @classmethod
    def update_doc(
        cls,
        entry_id: str,
        user_id: str,
        patch,
        db,
        *,
        allow_null: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        col = db[cls.entries_collection]
        existing = col.find_one({"_id": ObjectId(entry_id), "user_id": user_id})
        if not existing:
            return None
        allow_null = allow_null or []
        upd_raw: Dict[str, Any] = {}
        # If patch is a pydantic model, prefer to only iterate fields that
        # were actually provided by the caller. model_dump(exclude_unset=True)
        # preserves explicit nulls (None) when a client sent the field with
        # value null, while omitted fields are not present.
        if hasattr(patch, 'model_dump'):
            items = patch.model_dump(exclude_unset=True)
        else:
            # Fallback: assume patch is a dict-like object
            items = dict(patch)

        for k, v in items.items():
            # If the client sent explicit null and it's allowed, mark for unset
            if v is None:
                if k in (allow_null or []):
                    upd_raw[k] = None
                else:
                    # Client provided null for a field not allowed to be null -> ignore
                    continue
            else:
                # Respect whatever value client provided (including empty string)
                upd_raw[k] = v
        if not upd_raw:
            return existing
        upd_raw["updated_at"] = now_utc()
        set_fields = {k: v for k, v in upd_raw.items() if v is not None}
        unset_fields = {k: "" for k, v in upd_raw.items() if v is None}
        ops: Dict[str, Any] = {}
        if set_fields:
            ops["$set"] = set_fields
        if unset_fields:
            ops["$unset"] = unset_fields
        if not ops:
            return existing
        doc = col.find_one_and_update({"_id": ObjectId(entry_id), "user_id": user_id}, ops, return_document=True)
        return doc

    @classmethod
    def list_docs(
        cls,
        user_id: str,
        db,
        *,
        q: Optional[str] = None,
        category: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
        sort: str = "created_desc",
    ) -> Tuple[List[Dict[str, Any]], int]:
        col = db[cls.entries_collection]
        base: Dict[str, Any] = {"user_id": user_id}
        conditions: List[Dict[str, Any]] = []
        if category:
            # Case-insensitive exact match on category for both scalar and array storage
            safe = f"^{re.escape(category)}$"
            conditions.append({
                "$or": [
                    {"category": {"$regex": safe, "$options": "i"}},
                    {"category": {"$elemMatch": {"$regex": safe, "$options": "i"}}},
                ]
            })
        if q:
            conditions.append({"$or": [{f: {"$regex": q, "$options": "i"}} for f in cls.text_search_fields]})
        filt: Dict[str, Any]
        if conditions:
            filt = {"$and": [base] + conditions}
        else:
            filt = base
        sort_map: Dict[str, List[tuple]] = {
            "created_desc": [("created_at", -1)],
            "created_asc": [("created_at", 1)],
            "updated_desc": [("updated_at", -1)],
            "updated_asc": [("updated_at", 1)],
            "title": [("title", 1)],
        }
        mongo_sort = sort_map.get(sort, sort_map["created_desc"])
        total = col.count_documents(filt)
        cur = col.find(filt).sort(mongo_sort).skip(skip).limit(limit)
        return list(cur), total

    @classmethod
    def list_categories(cls, user_id: str, db) -> List[Dict[str, Any]]:
        return list(db[cls.categories_collection].find({"user_id": user_id}).sort([("name", 1)]))

    @classmethod
    def add_category(cls, user_id: str, name: str, db) -> Dict[str, Any]:
        norm = name.strip()
        if not norm:
            raise ValueError("Category name required")
        if len(norm) > cls.category_max:
            raise ValueError("Category too long")
        col = db[cls.categories_collection]
        existing = col.find_one({"user_id": user_id, "name": norm})
        if existing:
            return existing
        doc = {"user_id": user_id, "name": norm, "created_at": now_utc()}
        col.insert_one(doc)
        return doc

    @classmethod
    def delete_category(cls, user_id: str, name: str, db) -> bool:
        # Only allow deletion if no entry references it
        col_entries = db[cls.entries_collection]
        # Check both category string equals and category array contains the name
        used = col_entries.find_one({"user_id": user_id, "$or": [{"category": name}, {"category": {"$elemMatch": {"$eq": name}}}]})
        if used:
            return False
        res = db[cls.categories_collection].delete_one({"user_id": user_id, "name": name})
        return res.deleted_count == 1
