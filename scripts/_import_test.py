import traceback
import sys
import os

# Ensure project root is on sys.path for local import tests
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

try:
    import utils.mongo_cache as mc
    import utils.finance_calculator as fc
    import routes.dashboard as db
    print('Imported modules OK')
    # Print sample stats
    try:
        if hasattr(mc.MongoCache, '__name__'):
            print('MongoCache class present')
    except Exception:
        pass
except Exception:
    traceback.print_exc()
    raise
