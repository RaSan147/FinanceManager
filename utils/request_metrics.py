from __future__ import annotations

import dataclasses
import time
from typing import Any, Dict, List, Optional

from flask import g, has_request_context, request


@dataclasses.dataclass
class DBQuery:
    command_name: str
    database: Optional[str]
    collection: Optional[str]
    duration_ms: float
    ok: bool = True
    n_returned: Optional[int] = None
    summary: Optional[str] = None


@dataclasses.dataclass
class AICall:
    model: str
    duration_ms: float
    prompt_chars: int
    response_chars: int
    error: Optional[str] = None


@dataclasses.dataclass
class RequestMetrics:
    started_ts: float
    db: List[DBQuery]
    ai: List[AICall]
    total_ms: Optional[float] = None
    status_code: Optional[int] = None

    def summarize(self) -> Dict[str, Any]:
        db_ms = sum(q.duration_ms for q in self.db)
        ai_ms = sum(a.duration_ms for a in self.ai)
        return {
            "total_ms": self.total_ms,
            "db_ms": db_ms,
            "db_count": len(self.db),
            "ai_ms": ai_ms,
            "ai_count": len(self.ai),
            "status_code": self.status_code,
            "path": request.path if has_request_context() else None,
            "method": request.method if has_request_context() else None,
        }


def _ensure_metrics() -> Optional[RequestMetrics]:
    if not has_request_context():
        return None
    if not hasattr(g, "_req_metrics") or g._req_metrics is None:
        g._req_metrics = RequestMetrics(started_ts=time.perf_counter(), db=[], ai=[])
    return g._req_metrics


def start_request() -> None:
    _ensure_metrics()


def finish_request(status_code: int | None = None) -> Optional[Dict[str, Any]]:
    rm = _ensure_metrics()
    if not rm:
        return None
    rm.status_code = status_code
    rm.total_ms = (time.perf_counter() - rm.started_ts) * 1000.0
    return rm.summarize()


def record_db_query(
    command_name: str,
    *,
    database: Optional[str],
    collection: Optional[str],
    duration_ms: float,
    ok: bool = True,
    n_returned: Optional[int] = None,
    summary: Optional[str] = None,
) -> None:
    rm = _ensure_metrics()
    if not rm:
        return
    rm.db.append(DBQuery(
        command_name=command_name,
        database=database,
        collection=collection,
        duration_ms=duration_ms,
        ok=ok,
        n_returned=n_returned,
        summary=summary,
    ))


def record_ai_call(
    model: str,
    *,
    duration_ms: float,
    prompt_chars: int,
    response_chars: int,
    error: Optional[str] = None,
) -> None:
    rm = _ensure_metrics()
    if not rm:
        return
    rm.ai.append(AICall(
        model=model,
        duration_ms=duration_ms,
        prompt_chars=prompt_chars,
        response_chars=response_chars,
        error=error,
    ))


def current() -> Optional[RequestMetrics]:
    return _ensure_metrics()


def summary() -> Optional[Dict[str, Any]]:
    rm = _ensure_metrics()
    if not rm:
        return None
    # If total_ms not finalized yet, provide interim elapsed to avoid None in templates
    if rm.total_ms is None:
        interim = (time.perf_counter() - rm.started_ts) * 1000.0
        snap = rm.summarize()
        snap["total_ms"] = interim
        return snap
    return rm.summarize()
