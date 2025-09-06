"""Mongo persistence helpers for transactions (initial subset)."""
from __future__ import annotations

from typing import Any, Iterable, List, Dict
from bson import ObjectId


class TransactionRepository:
    """Thin Mongo access layer for transactions collection."""

    def __init__(self, db):
        self._col = db.transactions

    # ---- Create / Read ----
    def insert(self, doc: dict) -> ObjectId:
        return self._col.insert_one(doc).inserted_id

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
        return self.get_by_id(user_id, tx_id)

    # ---- Delete ----
    def delete(self, user_id: str, tx_id: ObjectId) -> bool:
        res = self._col.delete_one({'_id': tx_id, 'user_id': user_id})
        return res.deleted_count == 1


__all__ = ["TransactionRepository"]
