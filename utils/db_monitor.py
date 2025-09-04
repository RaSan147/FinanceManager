from __future__ import annotations

import time
from typing import Any, Optional

from flask import has_request_context
from pymongo.monitoring import CommandListener, CommandStartedEvent, CommandSucceededEvent, CommandFailedEvent

from .request_metrics import record_db_query


_interesting_cmds = {
    "find", "aggregate", "insert", "insertMany", "insertOne",
    "update", "updateOne", "updateMany", "delete", "deleteOne", "deleteMany",
    "count", "countDocuments", "distinct",
}


class _TimingStore:
    def __init__(self) -> None:
        self._t0: dict[int, float] = {}

    def start(self, event: CommandStartedEvent) -> None:
        self._t0[event.request_id] = time.perf_counter()

    def end(self, event_id: int) -> Optional[float]:
        t0 = self._t0.pop(event_id, None)
        if t0 is None:
            return None
        return (time.perf_counter() - t0) * 1000.0


_timing = _TimingStore()


class FlaskMongoCommandLogger(CommandListener):
    def started(self, event: CommandStartedEvent) -> None:  # type: ignore[override]
        if not has_request_context():
            return
        if event.command_name not in _interesting_cmds:
            return
        _timing.start(event)

    def succeeded(self, event: CommandSucceededEvent) -> None:  # type: ignore[override]
        if not has_request_context():
            return
        dur = _timing.end(event.request_id)
        if dur is None:
            return
        coll = None
        try:
            # Most commands have a collection name field equal to the command name
            cmd = event.command_name
            payload = event.reply or {}
            if isinstance(payload, dict):
                n_returned = None
                if cmd == "find":
                    n_returned = payload.get("cursor", {}).get("firstBatch", [])
                    n_returned = len(n_returned)
                elif cmd == "aggregate":
                    n_returned = payload.get("cursor", {}).get("firstBatch", [])
                    n_returned = len(n_returned)
                else:
                    n_returned = payload.get("n") or payload.get("nModified")
            else:
                n_returned = None
        except Exception:
            n_returned = None

        record_db_query(
            event.command_name,
            database=getattr(event, "database_name", None),
            collection=getattr(event, "command", {}).get(event.command_name) if hasattr(event, "command") else None,
            duration_ms=dur,
            ok=True,
            n_returned=n_returned,
        )

    def failed(self, event: CommandFailedEvent) -> None:  # type: ignore[override]
        if not has_request_context():
            return
        dur = _timing.end(event.request_id) or 0.0
        record_db_query(
            event.command_name,
            database=getattr(event, "database_name", None),
            collection=None,
            duration_ms=dur,
            ok=False,
            n_returned=None,
            summary=str(event.failure),
        )


__all__ = ["FlaskMongoCommandLogger"]
