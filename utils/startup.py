"""Centralized startup utilities for local and Gunicorn master warmup.

This module exposes two helper entrypoints:
- run_local_startup(mongo, pastebin_client): full startup for a single process
  (used when running the dev server or inside a single-process environment).
- run_master_global_warmup(mongo_uri=None): safe warmup to run once in the
  Gunicorn master process before workers fork (avoids using app-level clients).

The intent is to keep the actual logic in a single place so both local runs
and Gunicorn can share the same behavior while avoiding double-runs.
"""
from __future__ import annotations

import asyncio
import threading
import time
import traceback
import os
from datetime import datetime, timezone
from typing import Any, Optional

from utils.currency import currency_service
from utils.db_indexes import ensure_indexes

try:
    from pymongo import MongoClient
except Exception:
    MongoClient = None  # type: ignore


def _warmup_db(db: Any) -> None:
    try:
        # Touch a few collections to warm connection pools and Pydantic
        try:
            db.users.find_one({}, {"_id": 1})
        except Exception:
            pass
        try:
            db.transactions.find_one({}, {"_id": 1})
        except Exception:
            pass
        try:
            sample_goal = db.goals.find_one({}, {"_id": 1})
            if sample_goal:
                from models.goal import GoalInDB
                try:
                    _ = GoalInDB(**sample_goal)
                except Exception:
                    pass
        except Exception:
            pass
    except Exception:
        pass


def _run_archival_cycle(db: Any, pastebin_client: Any) -> None:  # pragma: no cover (background)
    try:
        users = list(db.users.find({}, {"_id": 1}))
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def _do_all():
            total_adv = 0
            total_goals = 0
            for u in users:
                uid = str(u["_id"])
                try:
                    from models.advice import PurchaseAdvice
                    total_adv += await PurchaseAdvice.archive_old_entries(uid, db, pastebin_client)
                except Exception:
                    pass
                try:
                    from models.goal import Goal as GoalModel
                    total_goals += await GoalModel.offload_old_ai_plans(uid, db, pastebin_client)
                except Exception:
                    pass
            print(f"[ArchiveCycle] Migrated {total_adv} purchase advices and {total_goals} goal plans.")

        loop.run_until_complete(_do_all())
    except Exception as e:
        print(f"Archive cycle error: {e}")
    finally:
        # schedule next run in 24h
        T = threading.Timer(24 * 3600, lambda: _run_archival_cycle(db, pastebin_client))
        T.daemon = True
        T.start()


def run_local_startup(mongo: Any, pastebin_client: Optional[Any] = None) -> None:
    """Full startup for a single process (dev server or container worker).

    This uses the provided PyMongo wrapper (flask_pymongo) to initialize
    the currency service with a Mongo cache backend, refresh rates
    synchronously, warm up DB/Pydantic, ensure indexes, and start the
    archival cycle in a background timer.
    """
    try:
        # Configure currency service to use Mongo backend and block on refresh
        try:
            currency_service.re_initialize(db=mongo.db, cache_backend='mongo', mongo_collection='system_fx_rates', mongo_doc_id='rates_usd_per_unit')
            currency_service.refresh_rates(force=True)
        except Exception as _e:
            print(f"[startup] Warning: currency refresh failed during startup: {_e}")
    except Exception:
        pass

    # Warmup (touch DB / Pydantic validators)
    try:
        if mongo.db is not None:
            _warmup_db(mongo.db)
    except Exception:
        pass

    # Ensure DB indexes using the provided DB instance
    try:
        if mongo.db is not None:
            ensure_indexes(mongo.db)
    except Exception as _e:
        print(f"[startup] Failed to ensure DB indexes during startup: {_e}")

    # Start the archival timer shortly after startup
    try:
        if mongo.db is not None:
            archival_T = threading.Timer(5, lambda: _run_archival_cycle(mongo.db, pastebin_client))
            archival_T.daemon = True
            archival_T.start()
    except Exception:
        pass


def run_master_global_warmup(cache_mongo_uri: Optional[str] = None) -> None:
    """Safe warmup to run once in Gunicorn master before workers fork.

    This should avoid using application-level clients. It performs a
    currency refresh (file-backed) and, if a Mongo URI is provided, will
    create a short-lived MongoClient to ensure DB indexes.
    """
    try:
        # Keep file-backed cache for master process (no DB passed)
        currency_service.re_initialize(db=None, cache_backend='file', cache_file=os.path.join(os.path.dirname(__file__), 'fx_rates_cache.json'))
        currency_service.refresh_rates(force=True)
    except Exception as _e:
        print(f"[gunicorn-startup] Warning: currency refresh failed in master: {_e}")

    if not cache_mongo_uri:
        return

    if MongoClient is None:
        print("[gunicorn-startup] pymongo not available; skipping master DB index ensure")
        return

    try:
        # Use a short-lived client to avoid shared sockets across forks
        client = MongoClient(cache_mongo_uri)
        try:
            # Prefer any DB encoded in the URI, else fall back to a common name
            db = client.get_default_database()
            if db is None:
                # If no default DB in URI, fall back to a known cache DB name
                db = client['self_finance_tracker_cache']

            # Ensure indexes (best-effort)
            try:
                ensure_indexes(db)
            except Exception as _e:
                print(f"[gunicorn-startup] Warning: ensure_indexes failed: {_e}")

            # Additionally: perform a short-lived Mongo-backed FX refresh so the
            # master process can populate the shared cache DB for workers. We
            # create a local CurrencyService instance bound to this short-lived
            # DB to avoid mutating the module-level currency_service which the
            # app may reconfigure after forking.
            try:
                from utils.currency import CurrencyService
                cs = CurrencyService(db=db, cache_backend='mongo')
                cs.refresh_rates(force=True)
            except Exception as _e:
                print(f"[gunicorn-startup] Warning: short-lived mongo FX refresh failed: {_e}")
        finally:
            try:
                client.close()
            except Exception:
                pass
    except Exception as _e:
        print(f"[gunicorn-startup] Failed to run master DB tasks: {_e}")
