"""Diagnostic script: verify CACHE_MONGO_URI, database selection, collection presence, and FX doc existence.

Run: python scripts/check_fx_cache.py

This script prints the raw and stripped env values, the DB chosen by get_default_database() (or fallback), available collections, and the FX document (if present).
"""

from dotenv import load_dotenv
load_dotenv()

from config import Config
from pymongo import MongoClient


def _strip_quotes(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    return v


def main():
    raw_cache_uri = Config.CACHE_MONGO_URI
    raw_backend = Config.CURRENCY_CACHE_BACKEND
    raw_coll = Config.CURRENCY_MONGO_COLLECTION
    raw_doc = Config.CURRENCY_MONGO_DOC_ID

    print('Raw env:')
    print('  CACHE_MONGO_URI =', repr(raw_cache_uri))
    print('  CURRENCY_CACHE_BACKEND =', repr(raw_backend))
    print('  CURRENCY_MONGO_COLLECTION =', repr(raw_coll))
    print('  CURRENCY_MONGO_DOC_ID =', repr(raw_doc))

    cache_uri = _strip_quotes(raw_cache_uri) if raw_cache_uri is not None else None
    backend = (_strip_quotes(raw_backend) or '').lower() if raw_backend is not None else None
    coll = _strip_quotes(raw_coll) if raw_coll is not None else None
    doc_id = _strip_quotes(raw_doc) if raw_doc is not None else None

    print('\nEffective values (quotes stripped):')
    print('  CACHE_MONGO_URI =', repr(cache_uri))
    print('  CURRENCY_CACHE_BACKEND =', repr(backend))
    print('  CURRENCY_MONGO_COLLECTION =', repr(coll))
    print('  CURRENCY_MONGO_DOC_ID =', repr(doc_id))

    if not cache_uri:
        print('\nNo CACHE_MONGO_URI configured. Set CACHE_MONGO_URI in your .env and restart.')
        return

    try:
        client = MongoClient(cache_uri)
    except Exception as e:
        print('\nFailed to create MongoClient:', e)
        return

    try:
        default_db = client.get_default_database()
    except Exception as e:
        print('\nget_default_database() raised exception:', e)
        default_db = None

    if default_db is not None:
        print('\nget_default_database() ->', default_db.name)
    else:
        print('\nget_default_database() -> None')

    # fallback name used by app
    fallback_name = 'self_finance_tracker_cache'
    # Database objects are not truthy; compare explicitly to None
    db = default_db if default_db is not None else client[fallback_name]
    print('Using database name:', db.name)

    try:
        cols = db.list_collection_names()
        print('Collections in DB:', cols)
    except Exception as e:
        print('Failed to list collections:', e)
        cols = []

    effective_coll = coll or 'system_fx_rates'
    print('\nChecking collection:', effective_coll)
    if effective_coll in cols:
        print('Collection exists')
        try:
            doc_key = doc_id or 'rates_usd_per_unit'
            doc = db[effective_coll].find_one({'_id': doc_key})
            print('Document with _id=' + doc_key + ':')
            print(doc)
        except Exception as e:
            print('Failed to read document:', e)
    else:
        print('Collection not present. No cached FX rates found.')


if __name__ == '__main__':
    main()
