"""Mongo persistence helpers for transactions (initial subset)."""
from __future__ import annotations

from typing import Any, Iterable, List, Dict
from utils.finance_calculator import drop_user_cache_sessions
from bson import ObjectId
from datetime import datetime, timezone


class TransactionRepository:
    """Thin Mongo access layer for transactions collection."""

    def __init__(self, db):
        self._col = db.transactions

    # ---- Create / Read ----
    def insert(self, doc: dict) -> ObjectId:
        oid = self._col.insert_one(doc).inserted_id
        try:
            # Invalidate any in-process cache sessions for this user so subsequent
            # reads in the same process get fresh data. Cross-process invalidation
            # intentionally NOT performed (per user's request).
            uid = doc.get('user_id')
            if uid:
                drop_user_cache_sessions(uid)
        except Exception:
            pass
        return oid

    def get_by_id(self, user_id: str, tx_id: ObjectId) -> dict | None:
        return self._col.find_one({'_id': tx_id, 'user_id': user_id})

    def find_user_recent(self, user_id: str, limit: int = 5) -> list[dict]:
        return list(self._col.find({"user_id": user_id}).sort([("date", -1), ("created_at", -1)]).limit(limit))

    def find_user_paginated(self, user_id: str, skip: int, limit: int) -> list[dict]:
        return list(self._col.find({"user_id": user_id}).sort([("date", -1), ("created_at", -1)]).skip(skip).limit(limit))

    def count_user(self, user_id: str) -> int:
        return self._col.count_documents({"user_id": user_id})

    # ---- Update ----
    def update_fields(self, user_id: str, tx_id: ObjectId, update: dict) -> dict | None:
        self._col.update_one({'_id': tx_id, 'user_id': user_id}, {'$set': update})
        try:
            # Only drop local in-process sessions; do NOT attempt cross-process invalidation
            drop_user_cache_sessions(user_id)
        except Exception:
            pass
        return self.get_by_id(user_id, tx_id)

    # ---- Delete ----
    def delete(self, user_id: str, tx_id: ObjectId) -> bool:
        res = self._col.delete_one({'_id': tx_id, 'user_id': user_id})
        try:
            if res.deleted_count:
                # Only drop local in-process sessions; do not touch other processes
                drop_user_cache_sessions(user_id)
        except Exception:
            pass
        return res.deleted_count == 1


__all__ = ["TransactionRepository"]
