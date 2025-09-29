"""Currency utilities: class-based service for symbols, conversion, and FX refresh.

This module exposes a class `CurrencyService` encapsulating currency conversion
and rate refresh logic. It maintains a cached map of "USD-per-unit" for many
currencies and refreshes it at most once per day from a public API (no key
required). All conversions go via USD: amount_usd = amount * USD_PER_UNIT[from];
then amount_out = amount_usd / USD_PER_UNIT[to].

Environment variables (optional):
- CURRENCY_RATES_TTL_SECONDS: Cache TTL in seconds (default: 86400 = 24h).
- CURRENCY_RATES_BACKOFF_SECONDS: Backoff between failed fetch attempts (default: 600s).
- CURRENCY_RATES_CACHE_FILE: Cache file path when using file backend (default: utils/fx_rates_cache.json).
- CURRENCY_CACHE_BACKEND: 'file' or 'mongo' (default: file). If using 'mongo', prefer passing db from app.

App integration pattern:
- Create a single instance: `currency_service = CurrencyService(db=mongo.db, cache_backend='mongo')`.
- Call `currency_service.refresh_rates(force=True)` at startup.
- Start a background thread from the app: `threading.Thread(target=currency_service.background_initial_refresh, daemon=True).start()`.

Network failures or missing data fall back to a small static rate table.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
import traceback
from typing import Dict, Any
from urllib.request import urlopen
from urllib.error import URLError, HTTPError
import threading
from urllib.parse import urlparse

try:
	# Optional, only needed if using env-style Mongo client; app typically passes db directly
	from pymongo import MongoClient  # noqa: F401
except Exception:
	MongoClient = None  # type: ignore[assignment]


class CurrencyService:
	"""Class-based currency utilities with caching and optional Mongo-backed storage.

	- Supports file or Mongo cache for daily FX rates.
	- Thread-safe refresh and lookups.
	"""

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

	API_URLS = [
		"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
		"https://latest.currency-api.pages.dev/v1/currencies/usd.json",
	]

	def __init__(
		self,
		db: Any | None = None,
		cache_backend: str | None = None,
		cache_file: str | None = None,
		mongo_collection: str = "system_fx_rates",
		mongo_doc_id: str = "rates_usd_per_unit",
		supported_currencies: list[str] | None = None,
	):
		self._db = None
		self._mongo_collection_name = None
		self._mongo_doc_id = None
		self._rates_lock = threading.Lock()
		self.supported_currencies: list[str] = list(self.STATIC_USD_PER_UNIT.keys())

		# Simple in-memory conversion result cache to avoid repeated math and
		# background-trigger checks when many conversions are requested in a
		# single request (e.g. allocation algorithms). Keyed by (amt_rounded, from, to)
		self._conv_cache: Dict[tuple[float, str, str], float] = {}
		self._conv_cache_max = 2000


		self._backoff_seconds = int(os.getenv("CURRENCY_RATES_BACKOFF_SECONDS", "600"))
		self._ttl_seconds = int(os.getenv("CURRENCY_RATES_TTL_SECONDS", "86400"))  # 24h

		# Runtime state
		self._last_load_ts: float | None = None
		self._last_attempt_ts: float | None = None
		self._usd_per_unit: Dict[str, float] = dict(self.STATIC_USD_PER_UNIT)

		self._cache_file = os.path.join(os.path.dirname(__file__), "fx_rates_cache.json")
		self._cache_backend = os.getenv("CURRENCY_CACHE_BACKEND", "file")

		self.re_initialize(
			db=db,
			cache_backend=cache_backend,
			cache_file=cache_file,
			mongo_collection=mongo_collection,
			mongo_doc_id=mongo_doc_id,
			supported_currencies=supported_currencies,
		)

	def re_initialize(
		self,
		db: Any | None = None,
		cache_backend: str | None = None,
		cache_file: str | None = None,
		mongo_collection: str = "system_fx_rates",
		mongo_doc_id: str = "rates_usd_per_unit",
		supported_currencies: list[str] | None = None,
	):
		# Configs (env-overridable)
		self._cache_backend = (cache_backend or self._cache_backend).strip().lower()
		self._cache_file = cache_file or self._cache_file
		self._db = db
		self._mongo_collection_name = mongo_collection
		self._mongo_doc_id = mongo_doc_id

		# Supported currency list (fixed); defaults to STATIC_USD_PER_UNIT keys
		self.supported_currencies: list[str] = supported_currencies or self.supported_currencies

		# Try to initialize from cache without blocking on network
		try:
			if not self._load_cache_if_fresh():
				self._last_load_ts = time.time()
		except Exception:
			self._last_load_ts = time.time()

	def _get_collection(self):
		if self._cache_backend != "mongo" or self._db is None:
			return None
		try:
			return self._db[self._mongo_collection_name]
		except Exception:
			return None

	@staticmethod
	def _safe_positive_float(v: Any) -> bool:
		try:
			return float(v) > 0
		except Exception:
			return False

	def _apply_supported_filter(self, mapping: Dict[str, float]) -> Dict[str, float]:
		"""Return a mapping limited to supported currencies, filling gaps from static fallback."""
		out: Dict[str, float] = {}
		for code in self.supported_currencies:
			code_u = code.upper()
			v = mapping.get(code_u)
			if isinstance(v, (int, float)) and float(v) > 0:
				out[code_u] = round(float(v), 8)
			elif code_u in self.STATIC_USD_PER_UNIT:
				out[code_u] = self.STATIC_USD_PER_UNIT[code_u]
		# Always ensure USD exists
		out["USD"] = out.get("USD", 1.0) or 1.0
		return out

	def _load_cache_if_fresh(self) -> bool:
		try:
			if self._cache_backend == "mongo":
				col = self._get_collection()
				if col is not None:
					doc = col.find_one({"_id": self._mongo_doc_id})
					if doc:
						fetched_at = float(doc.get("fetched_at", 0))
						ttl = int(doc.get("ttl_seconds", self._ttl_seconds))
						if fetched_at > 0 and (time.time() - fetched_at) <= ttl:
							mapping = doc.get("usd_per_unit") or {}
							if isinstance(mapping, dict) and mapping:
								with self._rates_lock:
									normalized = {str(k).upper(): float(v) for k, v in mapping.items() if self._safe_positive_float(v)}
									self._usd_per_unit = self._apply_supported_filter(normalized)
							self._last_load_ts = fetched_at
							return True
				return False
			else:
				if not os.path.exists(self._cache_file):
					return False
				with open(self._cache_file, "r", encoding="utf-8") as f:
					data: Dict[str, Any] = json.load(f)
				fetched_at = float(data.get("fetched_at", 0))
				ttl = int(data.get("ttl_seconds", self._ttl_seconds))
				if fetched_at <= 0 or (time.time() - fetched_at) > ttl:
					return False
				mapping = data.get("usd_per_unit") or {}
				if not isinstance(mapping, dict) or not mapping:
					return False
				with self._rates_lock:
					normalized = {str(k).upper(): float(v) for k, v in mapping.items() if self._safe_positive_float(v)}
					self._usd_per_unit = self._apply_supported_filter(normalized)
				self._last_load_ts = fetched_at
				return True
		except Exception:
			return False

	def _save_cache(self, api_url: str) -> None:
		try:
			payload = {
				"source": api_url,
				"fetched_at": self._last_load_ts or time.time(),
				"ttl_seconds": self._ttl_seconds,
				"usd_per_unit": self._usd_per_unit,
				"generated_at": datetime.now(timezone.utc).isoformat(),
			}
			if self._cache_backend == "mongo":
				col = self._get_collection()
				if col is not None:
					col.update_one({"_id": self._mongo_doc_id}, {"$set": payload, "$setOnInsert": {"_id": self._mongo_doc_id}}, upsert=True)
					return
			# file fallback
			os.makedirs(os.path.dirname(self._cache_file), exist_ok=True)
			with open(self._cache_file, "w", encoding="utf-8") as f:
				json.dump(payload, f, ensure_ascii=False, indent=2)
		except Exception:
			# Swallow cache write failures; keep in-memory rates.
			pass

	def _fetch_rates_from_api(self) -> tuple[str, Dict[str, float] | None]:
		for api_url in self.API_URLS:
			try:
				with urlopen(api_url, timeout=10) as resp:
					if resp.status != 200:
						continue
					raw = resp.read()
				data = json.loads(raw.decode("utf-8"))
				rates = data.get("usd")
				if not isinstance(rates, dict) or not rates:
					continue
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
				for k, v in self.STATIC_USD_PER_UNIT.items():
					out.setdefault(k, v)
				return api_url, out
			except (HTTPError, URLError, TimeoutError, ValueError):
				continue
		return "", None

	def refresh_rates(self, force: bool = False) -> bool:
		"""Refresh internal USD-per-unit map from cache or public API.

		Returns True if fresh mapping is available.
		"""
		now = time.time()
		# If we have a recent load within TTL, do nothing.
		if not force and self._last_load_ts and (now - self._last_load_ts) < self._ttl_seconds:
			return True
		# Avoid hammering the network if last attempt was recent and we already have some mapping
		if not force and self._usd_per_unit and self._last_attempt_ts and (now - self._last_attempt_ts) < self._backoff_seconds:
			return True
		# Try cache first (unless force)
		if not force and self._load_cache_if_fresh():
			return True
		# Fetch from API
		self._last_attempt_ts = now
		api_url, mapping = self._fetch_rates_from_api()
		if mapping:
			with self._rates_lock:
				self._usd_per_unit = self._apply_supported_filter(mapping)
				# Clear conversion cache since new rates may change results
				try:
					self._conv_cache.clear()
				except Exception:
					pass
			self._last_load_ts = now
			self._save_cache(api_url=api_url)
			return True
		# As a last resort, keep existing mapping or reset to static fallback if empty
		if not self._usd_per_unit:
			with self._rates_lock:
				self._usd_per_unit = self._apply_supported_filter(self.STATIC_USD_PER_UNIT)
			self._last_load_ts = now
		return False

	def _ensure_fresh(self) -> None:
		# Keep for callers that explicitly want a synchronous ensure.
		# Prefer non-blocking background refresh in hot paths (e.g. conversions used in templates)
		try:
			self.refresh_rates(force=False)
		except Exception:
			pass

	def _refresh_in_thread(self, force: bool = False) -> None:
		"""Start a daemon thread to refresh rates without blocking the caller."""
		def _worker():
			try:
				self.refresh_rates(force=force)
			except Exception:
				# Swallow errors in background worker
				pass
		threading.Thread(target=_worker, daemon=True).start()

	def trigger_background_refresh_if_stale(self, force: bool = False) -> None:
		"""Trigger a non-blocking refresh if the cached rates appear stale.

		This is intended for high-frequency call sites (like currency conversions
		inside request rendering) where we prefer to return quickly using the
		current in-memory rates and update rates asynchronously instead of
		blocking on network I/O.
		"""
		now = time.time()
		# If caller requests force, always refresh in background
		if force:
			self._refresh_in_thread(force=True)
			return

		# If never loaded or TTL expired, and we haven't recently attempted, trigger refresh
		if self._last_load_ts is None or (now - (self._last_load_ts or 0)) > self._ttl_seconds:
			if self._last_attempt_ts and (now - self._last_attempt_ts) < self._backoff_seconds:
				# recent attempt in progress or recently failed — skip triggering
				return
			self._refresh_in_thread(force=False)

	def get_currency_symbol(self, code: str | None) -> str:
		if not code:
			return "$"
		return self.SYMBOLS.get(code.upper(), "$")

	def is_supported(self, code: str | None) -> bool:
		return bool(code) and code.upper() in self.supported_currencies

	def convert_amount(self, amount: float, from_code: str, to_code: str) -> float:
		"""Convert amount from one currency to another using current USD mapping.

		If either currency is unsupported or any rate invalid, returns the input amount unchanged.
		"""
		# Use a small in-memory cache to avoid repeating conversions during
		# heavy loops (allocations, sorting). Key on rounded amount and codes.
		try:
			key = (round(float(amount), 2), (from_code or '').upper(), (to_code or '').upper())
			cached = self._conv_cache.get(key)
			if cached is not None:
				return cached
		except Exception:
			# ignore cache errors and continue
			key = None

		# Trigger a background refresh if rates look stale, but don't block the request
		# on network I/O. Use the existing in-memory mapping immediately.
		try:
			self.trigger_background_refresh_if_stale()
		except Exception:
			# Defensive: fall back to synchronous ensure if the trigger fails
			self._ensure_fresh()
		if not self.is_supported(from_code) or not self.is_supported(to_code):
			return amount
		f = self._usd_per_unit.get(from_code.upper(), 0)
		t = self._usd_per_unit.get(to_code.upper(), 0)
		if f <= 0 or t <= 0:
			return amount
		amount_usd = amount * f
		out = amount_usd / t
		out_r = round(out, 2)
		# store in cache (bounded)
		try:
			if key is not None:
				if len(self._conv_cache) >= self._conv_cache_max:
					# simple eviction: clear half to avoid slow deletion loops
					for _ in range(self._conv_cache_max // 2):
						self._conv_cache.pop(next(iter(self._conv_cache)), None)
				self._conv_cache[key] = out_r
		except Exception:
			pass
		return out_r

	def background_initial_refresh(self):
		"""Non-blocking initial refresh; intended to be run inside a thread started by the app."""
		try:
			time.sleep(0.2)
			self.refresh_rates(force=True)
		except Exception:
			pass

	# Convenience accessors (read-only snapshots)
	@property
	def USD_PER_UNIT(self) -> Dict[str, float]:
		return dict(self._usd_per_unit)

	@property
	def SYMBOLS_MAP(self) -> Dict[str, str]:
		return dict(self.SYMBOLS)

# Public singleton instance (the app can reassign/configure this as needed)
currency_service = CurrencyService()

__all__ = [
	"CurrencyService",
	"currency_service",
]
