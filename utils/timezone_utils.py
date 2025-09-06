from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional, Iterable, Union
import re

__all__ = [
    'now_utc',
    'ensure_utc',
    'iso_utc',
    'parse_datetime_any',
    'parse_date_only',
]

def now_utc() -> datetime:
    """Return current UTC time as timezone-aware datetime (single source of truth).

    Rationale: We deliberately avoid network (NTP) calls here to keep requests fast
    and eliminate external dependency / failure modes. System clock skew should be
    handled at the host/infra level, not per-request.
    """
    return datetime.now(timezone.utc)


def ensure_utc(dt: Optional[datetime]):
    """Return a UTC-aware datetime.

    Normalization rules:
    - None -> None
    - Naive -> assume it's already UTC (attach tzinfo only)
    - Aware non-UTC -> convert via astimezone
    - Aware UTC -> returned as-is
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    if dt.tzinfo is timezone.utc:  # exact object identity check
        return dt
    return dt.astimezone(timezone.utc)


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    """Return ISO 8601 string (UTC) or None."""
    dt = ensure_utc(dt)
    return dt.isoformat() if dt else None


# -------------------- Flexible parsing helpers --------------------

_COMMON_INPUT_FORMATS: tuple[str, ...] = (
    # Most specific first
    '%Y-%m-%d %H:%M:%S%z',
    '%Y-%m-%d %H:%M:%S.%f%z',
    '%Y-%m-%d %H:%M:%S',
    '%Y-%m-%d %H:%M',
    '%Y/%m/%d %H:%M:%S%z',
    '%Y/%m/%d %H:%M:%S',
    '%Y/%m/%d %H:%M',
)

_DATE_ONLY_FORMATS: tuple[str, ...] = (
    '%Y-%m-%d',
    '%Y/%m/%d',
)

_ISO_BASIC_RE = re.compile(r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:?\d{2})?$')

def _try_formats(value: str, formats: Iterable[str]) -> Optional[datetime]:
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None

def parse_datetime_any(value: Union[str, datetime], *, assume_utc_if_naive: bool = True) -> datetime:
    """Parse a wide variety of datetime string formats into an aware UTC datetime.

    Accepted input:
    - datetime object (returned normalized to UTC)
    - ISO 8601 (via datetime.fromisoformat / fallback regex quick test)
    - A curated list of common formats (see _COMMON_INPUT_FORMATS)
    - Date-only strings (midnight UTC)

    Behavior:
    - If parsed result is naive and assume_utc_if_naive=True, tzinfo=UTC is attached.
    - If naive and assume_utc_if_naive=False, local timezone is NOT inferred; UTC is still attached
      (project convention avoids ambiguous local conversions on server side).
    """
    if isinstance(value, datetime):
        # ensure_utc returns Optional[datetime]; value is not None so cast
        return ensure_utc(value)  # type: ignore[return-value]
    if not isinstance(value, str):
        raise TypeError('parse_datetime_any expects str or datetime')
    raw = value.strip()

    # Fast path: ISO 8601
    if 'T' in raw or _ISO_BASIC_RE.match(raw):
        try:
            dt = datetime.fromisoformat(raw.replace('Z', '+00:00'))
            if dt.tzinfo is None and assume_utc_if_naive:
                dt = dt.replace(tzinfo=timezone.utc)
            return ensure_utc(dt)  # type: ignore[return-value]
        except ValueError:
            pass  # fallthrough to other strategies

    # Try full datetime formats
    dt = _try_formats(raw, _COMMON_INPUT_FORMATS)
    if dt:
        if dt.tzinfo is None and assume_utc_if_naive:
            dt = dt.replace(tzinfo=timezone.utc)
        return ensure_utc(dt)  # type: ignore[return-value]

    # Try date-only formats -> midnight UTC
    d_only = _try_formats(raw, _DATE_ONLY_FORMATS)
    if d_only:
        return ensure_utc(d_only.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc))  # type: ignore[return-value]

    raise ValueError(f"Unrecognized datetime format: {value!r}")


def parse_date_only(value: Union[str, datetime]) -> datetime:
    """Parse a date-only value and return a UTC midnight datetime.

    - If a datetime is passed, its date component is used (time discarded) after UTC normalization.
    - Accepted formats include YYYY-MM-DD and YYYY/MM/DD.
    """
    if isinstance(value, datetime):
        v = ensure_utc(value)
        return v.replace(hour=0, minute=0, second=0, microsecond=0)
    if not isinstance(value, str):
        raise TypeError('parse_date_only expects str or datetime')
    raw = value.strip()
    d_only = _try_formats(raw, _DATE_ONLY_FORMATS)
    if not d_only:
        raise ValueError(f'Unrecognized date-only format: {value!r}')
    return d_only.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
