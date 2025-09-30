"""Force-refresh FX rates via CurrencyService and show DB document/state.

Run: python scripts/force_refresh_fx.py

This will:
 - connect to CACHE_MONGO_URI
 - import CurrencyService and re_initialize it against the cache DB
 - call refresh_rates(force=True)
 - print results and the stored document (if any)
"""

from dotenv import load_dotenv
load_dotenv()

from config import Config
import sys
import traceback
from pathlib import Path
from pymongo import MongoClient

# Ensure repo root is on sys.path so imports like `from utils.currency` work when
# running this script directly.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from utils.currency import CurrencyService


def _strip_quotes(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    return v


def main():
    cache_uri = _strip_quotes(Config.CACHE_MONGO_URI)
    if not cache_uri:
        print('CACHE_MONGO_URI not set; cannot proceed')
        return
    client = MongoClient(cache_uri)
    try:
        cache_db = client.get_default_database() or client['self_finance_tracker_cache']
    except Exception:
        cache_db = client['self_finance_tracker_cache']

    print('Using DB:', cache_db.name)

    backend = (_strip_quotes(Config.CURRENCY_CACHE_BACKEND) or 'mongo').lower()
    coll = _strip_quotes(Config.CURRENCY_MONGO_COLLECTION) or 'system_fx_rates'
    doc_id = _strip_quotes(Config.CURRENCY_MONGO_DOC_ID) or 'rates_usd_per_unit'

    print('Re-initializing CurrencyService with backend=%s, coll=%s, doc=%s' % (backend, coll, doc_id))
    cs = CurrencyService()
    # ensure we force mongo backend
    cs.re_initialize(db=cache_db, cache_backend=backend, mongo_collection=coll, mongo_doc_id=doc_id)

    print('Calling refresh_rates(force=True) ...')
    try:
        ok = cs.refresh_rates(force=True)
        print('refresh_rates returned:', ok)
    except Exception:
        print('refresh_rates raised:')
        traceback.print_exc()

    print('\nCollections now present:', cache_db.list_collection_names())
    try:
        doc = cache_db[coll].find_one({'_id': doc_id})
        print('\nDocument (if present):')
        print(doc)
    except Exception:
        print('\nFailed to read document:')
        traceback.print_exc()
    # If no document was written by refresh (common if API unavailable), try a
    # manual save of the current in-memory rates to see if write permissions
    # and collection access are OK. This helps distinguish network failures
    # from DB permission/config issues.
    try:
        if doc is None:
            print('\nNo document found; attempting manual save of in-memory rates...')
            try:
                cs._save_cache(api_url='manual_save_script')
                doc2 = cache_db[coll].find_one({'_id': doc_id})
                print('Post-manual-save document:')
                print(doc2)
            except Exception:
                print('Manual save failed:')
                traceback.print_exc()
    except Exception:
        pass

if __name__ == '__main__':
    main()
