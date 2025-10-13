"""Application configuration loaded from environment.

Keep development-friendly defaults here, but always set secure/production
values via environment variables. The comments explain intent and
acceptable environment formats where helpful.
"""

import os
from dotenv import load_dotenv
from datetime import timedelta

load_dotenv()


class Config:
    # Secret key used to sign cookies and other secrets. MUST be set for
    # production; a short development fallback is provided to make local
    # testing easier.
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key")

    # MongoDB connection string. Default points to a local DB for development.
    # Override in production with a managed connection string.
    MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/finance_tracker")

    # Third-party API keys. These may be empty/None during development.
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
    GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-pro")
    PASTEBIN_API_KEY = os.getenv("PASTEBIN_API_KEY")
    PASTEBIN_USERNAME = os.getenv("PASTEBIN_USERNAME")
    PASTEBIN_PASSWORD = os.getenv("PASTEBIN_PASSWORD")

    # Whitelists: supply comma-separated values in the environment. Empty
    # values are ignored.
    # Example: ONLY_ALLOWED_EMAILS="alice@example.com,bob@example.com"
    ONLY_ALLOWED_EMAILS = [
        e.strip() for e in os.getenv("ONLY_ALLOWED_EMAILS", "").split(",") if e.strip()
    ]

    # Example: ONLY_ALLOWED_EMAIL_DOMAINS="example.com,example.org"
    ONLY_ALLOWED_EMAIL_DOMAINS = [
        d.strip() for d in os.getenv("ONLY_ALLOWED_EMAIL_DOMAINS", "").split(",") if d.strip()
    ]

    # Optional alternate Mongo URI (used by a rate limiter or other small
    # subsystem). Falls back to the main MONGO_URI when not provided.
    MONGO_URI_LIMITER = os.getenv("MONGO_URI_LIMITER", MONGO_URI)

    # Cache DB URI used by currency/cache utilities. Defaults to a local
    # Mongo instance for development but can be set to an external cache DB.
    CACHE_MONGO_URI = os.getenv("CACHE_MONGO_URI", "mongodb://localhost:27017/")

    # Local cache collection name for file-backed or local caches.
    LOCAL_CACHE_COLLECTION = os.getenv("LOCAL_CACHE_COLLECTION", "local_cache")

    # Currency service cache backend preferences. Use 'mongo' to persist FX
    # rates into Mongo, or 'file' to use a local JSON file. Default prefers
    # mongo for deployments that provide a cache DB.
    CURRENCY_CACHE_BACKEND = os.getenv("CURRENCY_CACHE_BACKEND", "mongo")
    CURRENCY_MONGO_COLLECTION = os.getenv("CURRENCY_MONGO_COLLECTION", "system_fx_rates")
    CURRENCY_MONGO_DOC_ID = os.getenv("CURRENCY_MONGO_DOC_ID", "rates_usd_per_unit")
    # Currency fetch/backoff defaults
    CURRENCY_RATES_BACKOFF_SECONDS = int(os.getenv("CURRENCY_RATES_BACKOFF_SECONDS", "600"))
    CURRENCY_RATES_TTL_SECONDS = int(os.getenv("CURRENCY_RATES_TTL_SECONDS", "86400"))
    CURRENCY_RATES_CACHE_FILE = os.getenv("CURRENCY_RATES_CACHE_FILE", "fx_rates_cache.tmp.json")

    # Toggle showing full tracebacks in error responses. Treats the
    # environment value as truthy if it matches one of the listed strings.
    SHOW_DETAILED_ERRORS = str(os.getenv("SHOW_DETAILED_ERRORS", "0")).lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    # Default currency (ISO 4217). Stored uppercase to avoid downstream checks
    # needing to normalize values.
    DEFAULT_CURRENCY = os.getenv("DEFAULT_CURRENCY", "USD").upper()

    # Session / cookie defaults. Make sessions persistent by default so
    # installed PWAs (and browsers that treat sessions specially) will
    # retain the session across app restarts. Adjust these via environment
    # variables in production as appropriate.
    PERMANENT_SESSION_DAYS = int(os.getenv("PERMANENT_SESSION_DAYS", "30"))
    PERMANENT_SESSION_LIFETIME = timedelta(days=PERMANENT_SESSION_DAYS)

    # Controls the duration of the Flask-Login "remember me" cookie.
    REMEMBER_COOKIE_DAYS = int(os.getenv("REMEMBER_COOKIE_DAYS", "30"))
    REMEMBER_COOKIE_DURATION = timedelta(days=REMEMBER_COOKIE_DAYS)

    # Cookie attribute defaults. SESSION_COOKIE_SECURE should be enabled
    # in production (HTTPS). SESSION_COOKIE_SAMESITE may be None/"Lax"/"Strict"/"None".
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SECURE = str(os.getenv("SESSION_COOKIE_SECURE", "0")).lower() in {"1", "true", "yes", "on"}
    SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", "Lax")

    # Performance logging controls. Keep these off by default in production.
    LOG_PERF_DETAILS = str(os.getenv("LOG_PERF_DETAILS", "0")).lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    SHOW_PERF_FOOTER = str(os.getenv("SHOW_PERF_FOOTER", "1")).lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    # Image hosting: IMAGEKIT is the preferred option. Provide keys/endpoints
    # via environment variables. IMGBB support has been removed.
    IMAGEKIT_PRIVATE_KEY = os.getenv("IMAGEKIT_PRIVATE_KEY", "")
    IMAGEKIT_PUBLIC_KEY = os.getenv("IMAGEKIT_PUBLIC_KEY", "")
    IMAGEKIT_URL_ENDPOINT = os.getenv("IMAGEKIT_URL_ENDPOINT", "")
    IMAGEKIT_DEBUG = str(os.getenv("IMAGEKIT_DEBUG", "0")).lower() in {"1", "true", "yes", "on"}



    GUNICORN_TIMEOUT = int(os.getenv("GUNICORN_TIMEOUT", "30"))
    GUNICORN_WORKERS = int(os.getenv("GUNICORN_WORKERS", "2"))