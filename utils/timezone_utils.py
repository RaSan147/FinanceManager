from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional

def now_utc() -> datetime:
    """Return current UTC time as timezone-aware datetime."""
    return datetime.now(timezone.utc)


def ensure_utc(dt: Optional[datetime]):
    """Ensure a datetime is timezone-aware UTC.

    Rules:
    - None -> None
    - naive -> assume already UTC and attach tzinfo UTC
    - aware non-UTC -> convert to UTC
    - aware UTC -> unchanged
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    if dt.tzinfo is timezone.utc:
        return dt
    return dt.astimezone(timezone.utc)


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    dt = ensure_utc(dt)
    return dt.isoformat() if dt else None
