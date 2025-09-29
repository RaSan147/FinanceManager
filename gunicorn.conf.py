# Gunicorn configuration to run a global warmup once in the master process
import os
from utils.startup import run_master_global_warmup

# You can tune these worker settings for your deployment
bind = '0.0.0.0:5001'
workers = int(os.getenv('GUNICORN_WORKERS', '2'))
timeout = int(os.getenv('GUNICORN_TIMEOUT', '30'))


def on_starting(server):
    """Runs once in the Gunicorn master process before workers are forked."""
    print('[gunicorn] on_starting: performing global warmup')
    mongo_uri = os.getenv('MONGO_URI') or os.getenv('MONGO_CONNECTION')
    try:
        run_master_global_warmup(mongo_uri=mongo_uri)
    except Exception as e:
        print(f"[gunicorn] global warmup failed: {e}")


def post_fork(server, worker):
    print(f'[gunicorn] Worker forked: pid={worker.pid}')
