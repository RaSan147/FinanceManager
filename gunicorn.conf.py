# Gunicorn configuration to run a global warmup once in the master process
from config import Config
from utils.startup import run_master_global_warmup

# You can tune these worker settings for your deployment
bind = '0.0.0.0:5001'
workers = int(Config.GUNICORN_WORKERS)
timeout = int(Config.GUNICORN_TIMEOUT)


def on_starting(server):
    """Runs once in the Gunicorn master process before workers are forked."""
    print('[gunicorn] on_starting: performing global warmup')
    try:
        run_master_global_warmup(cache_mongo_uri=Config.CACHE_MONGO_URI)
    except Exception as e:
        print(f"[gunicorn] global warmup failed: {e}")


def post_fork(server, worker):
    print(f'[gunicorn] Worker forked: pid={worker.pid}')
