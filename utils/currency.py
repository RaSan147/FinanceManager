"""Currency utilities: symbols, conversion, and supported codes with daily FX refresh.

This module provides currency conversion helpers. It maintains a cached map of
"USD-per-unit" for many currencies and refreshes it at most once per day from a
public API (no key required). All conversions go via USD as an intermediary for
simplicity: amount_usd = amount * USD_PER_UNIT[from]; then amount_out = amount_usd / USD_PER_UNIT[to].

Environment variables (optional):
- CURRENCY_API_URL: Override FX source (default: https://api.exchangerate.host/latest?base=USD).
- CURRENCY_RATES_TTL_SECONDS: Cache TTL in seconds (default: 86400, i.e., 24h).
- CURRENCY_RATES_CACHE_FILE: Where to store the cache file (default: utils/fx_rates_cache.json).

Network failures or missing data fall back to a small static rate table.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Dict, Any
from urllib.request import urlopen
from urllib.error import URLError, HTTPError

# Static fallback: USD-per-unit mapping (1 unit of currency equals X USD)
# Example: 1 EUR = 1.10 USD -> {"EUR": 1.10}
STATIC_USD_PER_UNIT: Dict[str, float] = {
    "USD": 1.0,
    "BDT": 0.0086,
    "EUR": 1.10,
    "GBP": 1.27,
    "JPY": 0.0069,
    "AUD": 0.67,
    "CAD": 0.73,
    "INR": 0.012,
}

# Mutable, runtime mapping (will be hydrated from cache/API). Start with fallback.
USD_PER_UNIT: Dict[str, float] = dict(STATIC_USD_PER_UNIT)


SYMBOLS: Dict[str, str] = {
    "USD": "$",
    "BDT": "৳",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "AUD": "A$",
    "CAD": "C$",
    "INR": "₹",
}


SUPPORTED_CURRENCIES = list(USD_PER_UNIT.keys())

# Configs (env-overridable)
_API_URL = os.getenv("CURRENCY_API_URL", "https://api.exchangerate.host/latest?base=USD")
_TTL_SECONDS = int(os.getenv("CURRENCY_RATES_TTL_SECONDS", "86400"))  # 24h
_CACHE_FILE = os.getenv(
    "CURRENCY_RATES_CACHE_FILE",
    os.path.join(os.path.dirname(__file__), "fx_rates_cache.json"),
)

_last_load_ts: float | None = None  # unix epoch seconds when rates were fetched/loaded


def _update_supported_list() -> None:
    global SUPPORTED_CURRENCIES
    SUPPORTED_CURRENCIES = list(USD_PER_UNIT.keys())


def _load_cache_if_fresh() -> bool:
    global USD_PER_UNIT, _last_load_ts
    try:
        if not os.path.exists(_CACHE_FILE):
            return False
        with open(_CACHE_FILE, "r", encoding="utf-8") as f:
            data: Dict[str, Any] = json.load(f)
        fetched_at = float(data.get("fetched_at", 0))
        ttl = int(data.get("ttl_seconds", _TTL_SECONDS))
        if fetched_at <= 0 or (time.time() - fetched_at) > ttl:
            return False
        mapping = data.get("usd_per_unit") or {}
        if not isinstance(mapping, dict) or not mapping:
            return False
        # Normalize keys upper and values float
        USD_PER_UNIT = {str(k).upper(): float(v) for k, v in mapping.items() if float(v) > 0}
        _update_supported_list()
        _last_load_ts = fetched_at
        return True
    except Exception:
        return False


def _save_cache() -> None:
    try:
        payload = {
            "source": _API_URL,
            "fetched_at": _last_load_ts or time.time(),
            "ttl_seconds": _TTL_SECONDS,
            "usd_per_unit": USD_PER_UNIT,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        os.makedirs(os.path.dirname(_CACHE_FILE), exist_ok=True)
        with open(_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        # Swallow cache write failures; keep in-memory rates.
        pass


def _fetch_rates_from_api() -> Dict[str, float] | None:
    """Fetch latest rates and convert to USD-per-unit mapping.

    Uses exchangerate.host with base=USD, which returns rates like: 1 USD -> X CODE.
    We need USD-per-unit, so USD_PER_UNIT[CODE] = 1 / rate[CODE].
    """
    try:
        with urlopen(_API_URL, timeout=10) as resp:
            if resp.status != 200:
                return None
            raw = resp.read()
        data = json.loads(raw.decode("utf-8"))
        rates = data.get("rates")
        if not isinstance(rates, dict) or not rates:
            return None
        out: Dict[str, float] = {"USD": 1.0}
        for code, rate in rates.items():
            try:
                code_u = str(code).upper()
                r = float(rate)
                if r > 0:
                    out[code_u] = round(1.0 / r, 8)
            except Exception:
                continue
        # Keep known symbols even if not provided by API
        for k, v in STATIC_USD_PER_UNIT.items():
            out.setdefault(k, v)
        return out
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None


def refresh_rates(force: bool = False) -> bool:
    """Refresh USD_PER_UNIT from cache/API.

    - If cache file is present and fresh, load it.
    - Otherwise, fetch from API and cache it.
    - On failure, keep current in-memory mapping.

    Returns True if a fresh mapping is available (from cache or API), else False.
    """
    global USD_PER_UNIT, _last_load_ts
    now = time.time()
    if not force and _last_load_ts and (now - _last_load_ts) < _TTL_SECONDS:
        return True

    # Try cache first (unless force)
    if not force and _load_cache_if_fresh():
        return True

    # Fetch from API
    mapping = _fetch_rates_from_api()
    if mapping:
        USD_PER_UNIT = mapping
        _update_supported_list()
        _last_load_ts = now
        _save_cache()
        return True

    # As a last resort, keep existing mapping or reset to static fallback if empty
    if not USD_PER_UNIT:
        USD_PER_UNIT = dict(STATIC_USD_PER_UNIT)
        _update_supported_list()
        _last_load_ts = now
    return False


def _ensure_fresh() -> None:
    # Best-effort refresh; ignore outcome.
    try:
        refresh_rates(force=False)
    except Exception:
        pass


def get_currency_symbol(code: str | None) -> str:
    if not code:
        return "$"
    return SYMBOLS.get(code.upper(), "$")


def is_supported(code: str | None) -> bool:
    _ensure_fresh()
    return bool(code) and code.upper() in USD_PER_UNIT


def convert_amount(amount: float, from_code: str, to_code: str) -> float:
    """Convert amount from one currency to another using fixed USD mapping.

    If either currency code is unknown, returns the original amount unchanged.
    """
    print("Converting amount...")
    start_time = time.perf_counter()
    _ensure_fresh()
    if not is_supported(from_code) or not is_supported(to_code):
        return amount
    f = USD_PER_UNIT[from_code.upper()]
    t = USD_PER_UNIT[to_code.upper()]
    if f <= 0 or t <= 0:
        return amount
    amount_usd = amount * f  # amount (from) -> USD
    out = amount_usd / t      # USD -> (to)
    # round to 2 decimals for money display/storage

    end_time = time.perf_counter()
    duration = end_time - start_time
    print(f"Conversion completed in {duration:.4f} seconds")
    return round(out, 2)


__all__ = [
    "USD_PER_UNIT",
    "SYMBOLS",
    "SUPPORTED_CURRENCIES",
    "get_currency_symbol",
    "convert_amount",
    "is_supported",
    "refresh_rates",
]

# Initialize mapping from cache/API on import (non-fatal if offline)
_ensure_fresh()
