"""Lightweight Mongo-backed cache for process-shared session data.

This module provides a minimal cache stored in a MongoDB collection. It's
intended as an optional cross-process backend for short-lived session-like
payloads (for example, precomputed transaction payloads). Documents are
explicitly given an ``expires_at`` UTC timestamp and a MongoDB TTL index is
created (expireAfterSeconds=0) so the server's TTL monitor removes expired
documents.

Quick usage:
    from utils.mongo_cache import MongoCache
    cache = MongoCache(db)
    cid = cache.create_session(user_id, transactions=tx_list, ttl_seconds=3600)
    sess = cache.get_session(cid)
    cache.drop_session(cid)
    cache.drop_user_sessions(user_id)
    cache.get_stats()

Notes / warnings:
- Avoid storing very large transaction lists: they increase DB size and
    network usage. Prefer storing compact metadata or precomputed payloads.
- TTL index creation is best-effort on initialization; the Mongo user must
    have index privileges for creation to succeed. The TTL monitor relies on
    the server clock: ``expires_at`` is stored in UTC to avoid ambiguity.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from datetime import datetime, timedelta
import uuid
import logging

logger = logging.getLogger(__name__)


class MongoCache:
    def __init__(self, db, collection_name: str = 'local_cache'):
        self.db = db
        self.col = db[collection_name]
        # Ensure useful indexes (``_id`` is the default PK). TTL index on
        # ``expires_at`` (expireAfterSeconds=0 because we set the exact expiry
        # time per-document). This is best-effort: index creation may fail if
        # permissions are missing.
        try:
            # expireAfterSeconds set to 0 because we set explicit expires_at
            self.col.create_index('expires_at', expireAfterSeconds=0)
            self.col.create_index('user_id')
        except Exception:
            # best-effort
            logger.exception('mongo_cache: failed to create indexes')
    def create_session(self, user_id: str, transactions: Optional[List[Dict[str, Any]]] = None, *, ttl_seconds: int = 3600) -> str:
        """Create a cache session and return a cache_id.

        The returned ``cache_id`` is stored as the document ``_id``. ``created_at``
        and ``expires_at`` are UTC datetimes. ``transactions`` (if provided) are
        stored as-is; callers should avoid storing extremely large lists.
        """
        cache_id = str(uuid.uuid4())
        now = datetime.utcnow()
        doc: Dict[str, Any] = {
            '_id': cache_id,
            'user_id': user_id,
            'created_at': now,
            'expires_at': now + timedelta(seconds=ttl_seconds),
            'count': len(transactions) if transactions is not None else 0,
        }
        if transactions is not None:
            # Store transactions as-is; caller should avoid storing extremely
            # large lists (this increases DB and network costs).
            doc['transactions'] = transactions
        try:
            self.col.insert_one(doc)
        except Exception:
            logger.exception('mongo_cache: failed to create session for user=%s', user_id)
            # fallback: return id but session may not exist
        return cache_id

    def get_session(self, cache_id: str) -> Optional[Dict[str, Any]]:
        """Return the session document or ``None`` if missing/expired.

        This returns the raw document as stored in MongoDB. Callers should be
        prepared to handle Mongo-native types (ObjectId, datetimes, etc.),
        although this cache stores ``_id`` as a UUID string.
        """
        try:
            doc = self.col.find_one({'_id': cache_id})
            if not doc:
                return None
            # convert Object-like types only as needed by callers
            return doc
        except Exception:
            logger.exception('mongo_cache: failed to read session %s', cache_id)
            return None

    def drop_session(self, cache_id: str) -> bool:
        try:
            res = self.col.delete_one({'_id': cache_id})
            return res.deleted_count == 1
        except Exception:
            logger.exception('mongo_cache: failed to drop session %s', cache_id)
            return False

    def drop_user_sessions(self, user_id: str) -> int:
        try:
            res = self.col.delete_many({'user_id': user_id})
            return int(res.deleted_count or 0)
        except Exception:
            logger.exception('mongo_cache: failed to drop sessions for user %s', user_id)
            return 0

    def get_stats(self) -> Dict[str, int]:
        try:
            total_sessions = self.col.count_documents({})
            total_tx = 0
            # sum counts (fast) - projection helps avoid transferring large arrays
            for d in self.col.find({}, {'count': 1}):
                try:
                    total_tx += int(d.get('count') or 0)
                except Exception:
                    continue
            return {'sessions': int(total_sessions), 'total_transactions': int(total_tx)}
        except Exception:
            logger.exception('mongo_cache: failed to collect stats')
            return {'sessions': 0, 'total_transactions': 0}
