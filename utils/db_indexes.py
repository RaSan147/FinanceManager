"""Centralized MongoDB index definitions and ensure step.

Call ensure_indexes(db) once on startup to create/update indexes safely.

This module focuses on read/query patterns observed in the codebase:
- users: login by email; fetch by _id; ensure unique email
- transactions: list and date-range queries by user_id, sorted by date/created_at; recompute loans by user/category/counterparty
- goals: filtered by user_id + is_completed; sort by ai_priority and created_at
- loans: open-loan lookups by (user_id, direction, counterparty, status); listings by user/status
- purchase_advice: list by user and archive flag, sorted by created_at; 30-day analytics by user+created_at

Indexes are created idempotently and wrapped in try/except to avoid crashing
startup in case of existing duplicates that violate unique constraints. In such
cases, a warning is printed and the app continues running.
"""

from __future__ import annotations

from typing import Any
from pymongo import ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError, OperationFailure


def _safe_create_index(col, keys, *, name: str | None = None, unique: bool = False, partialFilterExpression: dict | None = None) -> None:
    """Create index without sending null options to Mongo.

    Some Mongo server versions reject fields like partialFilterExpression: null.
    Build kwargs dynamically and only include when provided.
    """
    try:
        kwargs: dict[str, Any] = {"background": True}
        if name is not None:
            kwargs["name"] = name
        if unique:
            kwargs["unique"] = True
        if partialFilterExpression is not None:
            kwargs["partialFilterExpression"] = partialFilterExpression
        col.create_index(keys, **kwargs)
    except DuplicateKeyError:
        # Likely existing duplicate data prevents unique index creation.
        print(f"[db-indexes] DuplicateKeyError creating index {name or keys} on {col.name}. Skipping unique creation.")
    except OperationFailure as e:
        print(f"[db-indexes] OperationFailure creating index {name or keys} on {col.name}: {e}")
    except Exception as e:
        print(f"[db-indexes] Unexpected error creating index {name or keys} on {col.name}: {e}")


def ensure_indexes(db: Any) -> None:
    """Create indexes across all collections used by the app.

    Safe to run multiple times. Uses background index builds when supported.
    """

    # users
    users = db.users
    _safe_create_index(users, [("email", ASCENDING)], name="uniq_email", unique=True)
    _safe_create_index(users, [("created_at", DESCENDING)], name="created_at_desc")

    # transactions
    tx = db.transactions
    # Support: find by user_id, sort by date desc, created_at desc; also supports count by user_id
    _safe_create_index(tx, [("user_id", ASCENDING), ("date", DESCENDING), ("created_at", DESCENDING)], name="user_date_created_desc")
    # Support recompute: user_id + related_person + category (+ date helps scans/time filters)
    _safe_create_index(tx, [("user_id", ASCENDING), ("related_person", ASCENDING), ("category", ASCENDING), ("date", DESCENDING)], name="user_person_category_date")
    # Standalone for date-range queries per user without explicit sort
    _safe_create_index(tx, [("user_id", ASCENDING), ("date", ASCENDING)], name="user_date_asc")

    # goals
    goals = db.goals
    _safe_create_index(goals, [("user_id", ASCENDING), ("is_completed", ASCENDING), ("created_at", DESCENDING)], name="user_active_created")
    _safe_create_index(goals, [("user_id", ASCENDING), ("ai_priority", DESCENDING)], name="user_ai_priority_desc")

    # loans
    loans = db.loans
    # Fast lookup for an open loan per user/direction/counterparty
    _safe_create_index(loans, [("user_id", ASCENDING), ("direction", ASCENDING), ("counterparty", ASCENDING), ("status", ASCENDING)], name="user_dir_cp_status")
    # Enforce at most 1 open loan per (user, direction, counterparty) when possible
    _safe_create_index(
        loans,
        [("user_id", ASCENDING), ("direction", ASCENDING), ("counterparty", ASCENDING)],
        name="uniq_open_loan",
        unique=True,
        partialFilterExpression={"status": "open"},
    )
    # Listings by user/status sorted by created_at
    _safe_create_index(loans, [("user_id", ASCENDING), ("status", ASCENDING), ("created_at", DESCENDING)], name="user_status_created_desc")

    # purchase_advice
    adv = db.purchase_advice
    _safe_create_index(adv, [("user_id", ASCENDING), ("is_archived", ASCENDING), ("created_at", DESCENDING)], name="user_archived_created_desc")
    _safe_create_index(adv, [("user_id", ASCENDING), ("created_at", DESCENDING)], name="user_created_desc")
    _safe_create_index(adv, [("user_id", ASCENDING), ("category", ASCENDING), ("created_at", DESCENDING)], name="user_category_created_desc")
    # For visualization and analytics queries
    _safe_create_index(adv, [("user_id", ASCENDING), ("user_action", ASCENDING), ("created_at", DESCENDING)], name="user_action_created_desc")
    _safe_create_index(adv, [("user_id", ASCENDING), ("advice.recommendation", ASCENDING), ("created_at", DESCENDING)], name="user_advice_rec_created_desc")

    # system_fx_rates (optional; accessed by _id only which is auto-indexed). No-op.

    # todo
    todo = db.todo
    _safe_create_index(todo, [("user_id", ASCENDING), ("created_at", DESCENDING)], name="todo_user_created_desc")
    _safe_create_index(todo, [("user_id", ASCENDING), ("updated_at", DESCENDING)], name="todo_user_updated_desc")
    _safe_create_index(todo, [("user_id", ASCENDING), ("stage", ASCENDING), ("created_at", DESCENDING)], name="todo_user_stage_created_desc")
    _safe_create_index(todo, [("user_id", ASCENDING), ("category", ASCENDING), ("created_at", DESCENDING)], name="todo_user_category_created_desc")
    _safe_create_index(todo, [("user_id", ASCENDING), ("due_date", ASCENDING)], name="todo_user_due_date_asc")

    todo_cats = db.todo_categories
    _safe_create_index(todo_cats, [("user_id", ASCENDING), ("name", ASCENDING)], name="todo_cat_user_name", unique=True)

    # diary entries
    try:
        diary = db.diary_entries
        _safe_create_index(diary, [("user_id", ASCENDING), ("created_at", DESCENDING)], name="diary_user_created_desc")
        _safe_create_index(diary, [("user_id", ASCENDING), ("updated_at", DESCENDING)], name="diary_user_updated_desc")
        _safe_create_index(diary, [("user_id", ASCENDING), ("category", ASCENDING), ("created_at", DESCENDING)], name="diary_user_category_created_desc")
        # Text-like search (regex) aided by compound prefix index on user_id; Mongo can't index arbitrary regex but this helps filtering by user fast.
    except Exception as _e:
        print(f"[db-indexes] Warning creating diary indexes: {_e}")

    try:
        diary_cats = db.diary_categories
        _safe_create_index(diary_cats, [("user_id", ASCENDING), ("name", ASCENDING)], name="diary_cat_user_name", unique=True)
    except Exception as _e:
        print(f"[db-indexes] Warning creating diary category indexes: {_e}")

    print("[db-indexes] Index ensure complete.")
