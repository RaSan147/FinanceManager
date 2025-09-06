"""Response helper utilities for consistent API envelopes.

All API endpoints should return this structure going forward:
{
    "data": <payload or null>,
    "meta": { optional metadata },
    "errors": [] | [ { code, message, details } ]
}
"""
from __future__ import annotations

from flask import jsonify
from typing import Any, Iterable


def json_success(data: Any = None, *, meta: dict | None = None, status: int = 200):

    payload = {
        "data": data,
        "meta": meta or {},
        "errors": []
    }
    return jsonify(payload), status


def json_error(message: str, *, code: str = "bad_request", details: Any | None = None, status: int = 400):
    payload = {
        "data": None,
        "meta": {},
        "errors": [
            {
                "code": code,
                "message": message,
                "details": details
            }
        ]
    }
    return jsonify(payload), status


__all__ = ["json_success", "json_error"]
