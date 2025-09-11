import asyncio
import os
import threading
import traceback
from dotenv import load_dotenv
load_dotenv()


from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_pymongo import PyMongo
from flask_bcrypt import Bcrypt
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from datetime import datetime, timedelta, timezone
from bson import ObjectId
import json
from models.user import User
from models.transaction import Transaction, TRANSACTION_CATEGORIES
from models.loan import Loan
from models.goal import Goal, GoalCreate, GoalUpdate, GoalInDB
from utils.ai_helper import get_ai_analysis, get_goal_plan
from utils.finance_calculator import calculate_monthly_summary,  calculate_lifetime_transaction_summary
from typing import Any
from utils.currency import currency_service
from services.transaction_service import TransactionService
from schemas.transaction import TransactionCreate, TransactionPatch
from core.errors import ValidationError, NotFoundError
from pydantic import ValidationError as PydValidationError
from core.response import json_success, json_error
from utils.tools import is_allowed_email
from config import Config
# Added centralized timezone helpers
from utils.timezone_utils import now_utc, ensure_utc
from utils.request_metrics import start_request, finish_request, summary as metrics_summary
from utils.db_monitor import FlaskMongoCommandLogger

app = Flask(__name__)
app.config.from_object(Config)

# Pass real user IP to app
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)


from flask_limiter import Limiter
from flask_limiter.util import get_remote_address


# Initialize Limiter with default settings (by IP address)
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["5000 per day", "500 per hour"],  # Adjust as needed
    storage_uri=Config.MONGO_URI_LIMITER,
    strategy="sliding-window-counter",
    storage_options={
        "database_name": "self_finance_tracker_limiter"
    }
)

# Register PyMongo command listener for per-request DB timings BEFORE client creation
try:
    from pymongo import monitoring as _pym_monitoring
    _pym_monitoring.register(FlaskMongoCommandLogger())
except Exception as _e:
    print(f"[startup] Warning: Failed to register Mongo command listener early: {_e}")

mongo = PyMongo(app)
bcrypt = Bcrypt(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'  # type: ignore[attr-defined]
login_manager.login_message_category = 'warning'

# Configure currency service with Mongo backend and start background refresh
currency_service.re_initialize(db=mongo.db, cache_backend='mongo')
currency_service.refresh_rates()
threading.Thread(target=currency_service.background_initial_refresh, daemon=True).start()

# Ensure DB indexes exist on startup
try:
    from utils.db_indexes import ensure_indexes
    if mongo.db is not None:
        ensure_indexes(mongo.db)
except Exception as _e:
    # Non-fatal: continue even if indexing fails (logged to console)
    print(f"[startup] Failed to ensure DB indexes: {_e}")

# request lifecycle hooks for timing
@app.before_request
def _before_request_metrics():
    start_request()


@app.after_request
def _after_request_metrics(response):
    try:
        data = finish_request(status_code=response.status_code)
        if data:
            # Attach metrics for optional template usage
            response.headers['X-Request-Time-ms'] = str(round(data.get('total_ms') or 0, 2))
            # Log concise line to console
            app.logger.info(
                f"{request.method} {request.path} -> {response.status_code} | total={data['total_ms']:.1f}ms "
                f"db={data['db_count']}/{data['db_ms']:.1f}ms ai={data['ai_count']}/{data['ai_ms']:.1f}ms"
            )
            if app.config.get('LOG_PERF_DETAILS'):
                from utils.request_metrics import current
                rm = current()
                if rm:
                    for q in rm.db:
                        app.logger.info(
                            f"  DB {q.command_name} {q.database or ''}.{q.collection or ''} "
                            f"{q.duration_ms:.1f}ms ok={q.ok} returned={q.n_returned}"
                        )
                    for a in rm.ai:
                        app.logger.info(
                            f"  AI {a.model} {a.duration_ms:.1f}ms prompt={a.prompt_chars} chars resp={a.response_chars} chars"
                        )
    except Exception:
        pass
    return response

@app.context_processor
def inject_now():
    # Always provide UTC now (aware)
    return {'now': now_utc()}

@app.context_processor
def inject_config():
    # Expose selected config to templates
    return {'config': app.config}

@app.context_processor
def inject_currency():
    code = None
    try:
        if current_user and getattr(current_user, 'is_authenticated', False):
            user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
            if user:
                code = user.get('default_currency')
    except Exception:
        code = None
    if not code:
        code = app.config['DEFAULT_CURRENCY']
    supported = currency_service.supported_currencies
    return {
        'currency_code': code,
        'currency_symbol': currency_service.get_currency_symbol(code),
        'supported_currencies': supported,
        'currency_symbols': {c: currency_service.get_currency_symbol(c) for c in supported},
    }

@app.context_processor
def inject_perf_metrics():
    # Always make perf metrics available to templates (footer uses it)
    try:
        return {'perf_metrics': metrics_summary()}
    except Exception:
        return {}

@app.context_processor
def inject_tx_categories():
    # Provide transaction categories globally for modal availability on any page
    return {'tx_categories': TRANSACTION_CATEGORIES}

@login_manager.user_loader
def load_user(user_id):
    user_data = mongo.db.users.find_one({'_id': ObjectId(user_id)})
    if not user_data:
        return None
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return None

    return User(user_data, mongo.db)

# Custom JSON encoder to handle ObjectId and datetime
class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId):
            return str(o)
        if isinstance(o, datetime):
            return ensure_utc(o).isoformat()
        return json.JSONEncoder.default(self, o)

app.json_encoder = JSONEncoder  # type: ignore[attr-defined]

"""Dashboard index route moved to dashboard blueprint."""



@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
            return redirect(url_for('dashboard.index'))
    
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')

        if not is_allowed_email(email, Config.ONLY_ALLOWED_EMAILS, Config.ONLY_ALLOWED_EMAIL_DOMAINS):
            flash('Email not allowed.', 'danger')
            return redirect(url_for('login'))

        if mongo.db is None:
            flash('Database connection error.', 'danger')
            return redirect(url_for('logout'))

        user_data = mongo.db.users.find_one({'email': email})
        if user_data and bcrypt.check_password_hash(user_data['password'], password):
            user = User(user_data, mongo.db)
            login_user(user)
            next_page = request.args.get('next')
            return redirect(next_page or url_for('dashboard.index'))
        else:
            flash('Login failed. Check your email and password.', 'danger')
    
    return render_template('login.html', next=request.args.get('next'), perf_metrics=metrics_summary())

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
            return redirect(url_for('dashboard.index'))
    
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        name = request.form.get('name')

        if not is_allowed_email(
            email, 
            allowed_emails=Config.ONLY_ALLOWED_EMAILS, allowed_domains=Config.ONLY_ALLOWED_EMAIL_DOMAINS
        ):
            flash('Email not allowed.', 'danger')
            return redirect(url_for('register'))

        if mongo.db is None:
            flash('Database connection error.', 'danger')
            return redirect(url_for('logout'))

        if mongo.db.users.find_one({'email': email}):
            flash('Email already exists.', 'danger')
            return redirect(url_for('register'))
        
        hashed_password = bcrypt.generate_password_hash(password).decode('utf-8')
        
        user_data = {
            'email': email,
            'password': hashed_password,
            'name': name,
            'created_at': now_utc(),
            'default_currency': app.config['DEFAULT_CURRENCY'],
            'monthly_income_currency': app.config['DEFAULT_CURRENCY']
        }
        
        mongo.db.users.insert_one(user_data)
        flash('Account created successfully. Please login.', 'success')
        return redirect(url_for('login'))
    
    return render_template('register.html', perf_metrics=metrics_summary())

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# Add to imports
from utils.ai_engine import FinancialBrain
from utils.ai_spending_advisor import SpendingAdvisor

# Initialize AI components
ai_engine = FinancialBrain(app.config["GEMINI_API_KEY"])
# Ensure mongo.db is available before creating advisor
if mongo.db is None:
    raise RuntimeError("Database not initialized")
spending_advisor = SpendingAdvisor(ai_engine, mongo.db)

@app.route('/api/goals/prioritized')
@login_required
def get_prioritized_goals():
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return {"error": "Database connection error."}

    goals = Goal.get_prioritized(current_user.id, mongo.db)
    return jsonify(goals)

"""Goal add route moved to goals blueprint."""


"""Transaction related routes moved to blueprint in routes/transactions.py"""

"""Goals routes moved to goals blueprint."""

"""Profile route moved to profile blueprint."""


"""Goal completion moved to goals blueprint."""

"""Goal delete moved to goals blueprint."""

"""Analysis routes moved to analysis blueprint."""


# API routes
"""Transaction API endpoints now provided via blueprint."""

"""Transaction create endpoint moved to blueprint."""

"""Transaction delete endpoint moved to blueprint."""

"""Dashboard API moved to dashboard blueprint."""

"""Goals JSON list moved to goals blueprint."""

"""Goal create moved to goals blueprint."""

"""Goal update moved to goals blueprint."""

"""Goal complete moved to goals blueprint."""

"""Goal delete moved to goals blueprint."""

"""Goal revalidate moved to goals blueprint."""

"""Profile JSON API moved to profile blueprint."""

"""Loans list JSON moved to loans blueprint."""

"""Monthly summary endpoint moved to blueprint."""








# Add to imports
from models.advice import PurchaseAdvice
from utils.pastebin_client import PastebinClient

# Initialize Pastebin client with optional user credentials for deletion
pastebin_client = PastebinClient(
    Config.PASTEBIN_API_KEY,
    os.getenv('PASTEBIN_USERNAME'),
    os.getenv('PASTEBIN_PASSWORD')
)

# Simple daily archival scheduler (lightweight alternative to APScheduler)
_ARCHIVE_INTERVAL_SECONDS = 24 * 3600
def _run_archival_cycle():  # pragma: no cover (background)
    try:
        users = list(mongo.db.users.find({}, {'_id': 1}))
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        async def _do_all():
            total_adv = 0
            total_goals = 0
            for u in users:
                uid = str(u['_id'])
                try:
                    total_adv += await PurchaseAdvice.archive_old_entries(uid, mongo.db, pastebin_client)
                except Exception:
                    pass
                try:
                    from models.goal import Goal as GoalModel
                    total_goals += await GoalModel.offload_old_ai_plans(uid, mongo.db, pastebin_client)
                except Exception:
                    pass
            print(f"[ArchiveCycle] Migrated {total_adv} purchase advices and {total_goals} goal plans.")
        loop.run_until_complete(_do_all())
    except Exception as e:
        print(f"Archive cycle error: {e}")
    finally:
        T = threading.Timer(_ARCHIVE_INTERVAL_SECONDS, _run_archival_cycle)
        T.daemon = True
        T.start()

# Start first archival run shortly after startup
_archival_T = threading.Timer(5, _run_archival_cycle)
_archival_T.daemon = True
_archival_T.start()


"""AI advice delete moved to AI blueprint."""

# Lazy load purchase advice content (offloaded retrieval)
"""AI advice content moved to AI blueprint."""

# Lazy load goal AI plan (offloaded retrieval)
@app.route('/api/goals/<goal_id>/ai-plan', methods=['GET'])
@login_required
def get_goal_ai_plan(goal_id):
    goal_doc = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
    if not goal_doc:
        return jsonify({'error': 'Not found'}), 404
    if goal_doc.get('ai_plan'):
        return jsonify({'plan': goal_doc.get('ai_plan'), 'offloaded': False})
    url = goal_doc.get('ai_plan_paste_url')
    if url and pastebin_client:
        key = pastebin_client.extract_paste_key(url)
        if key:
            try:
                raw = asyncio.run(pastebin_client.read_paste(key))
                if raw:
                    return jsonify({'plan': raw, 'offloaded': True})
            except Exception:
                pass
    return jsonify({'error': 'Plan unavailable'}), 404

"""AI archive old moved to AI blueprint."""


"""AI purchase advice creation moved to AI blueprint."""


# Add these new endpoints
"""AI visualization data moved to AI blueprint."""

"""AI advice history moved to AI blueprint."""

"""Purchase advisor page moved to AI blueprint."""

"""AI advice action moved to AI blueprint."""

# Revalidate goal summary and priority
"""Goal revalidate moved to goals blueprint."""


# -------------------------------------------------------------
# Central error handling (HTML + JSON with optional tracebacks)
# -------------------------------------------------------------
from werkzeug.exceptions import HTTPException
from flask import Response

def _wants_json_response():
    best = request.accept_mimetypes.best_match(['application/json', 'text/html'])
    return best == 'application/json' and \
        request.accept_mimetypes[best] > request.accept_mimetypes['text/html']

@app.errorhandler(Exception)
def handle_any_exception(err):  # noqa: D401
    status_code = 500
    error_title = 'Internal Server Error'
    error_message = 'An unexpected error occurred.'

    if isinstance(err, HTTPException):
        status_code = err.code or 500
        error_title = err.name
        error_message = err.description

    show_details = app.debug or app.config.get('SHOW_DETAILED_ERRORS')
    tb_str = ''
    if show_details:
        tb_str = ''.join(traceback.format_exception(type(err), err, err.__traceback__))
        # log full traceback
        app.logger.error(f"Unhandled exception: {tb_str}")
    else:
        app.logger.error(f"Unhandled exception: {err}")

    if _wants_json_response():
        payload = {
            'error': error_title,
            'message': error_message,
            'status': status_code
        }
        if show_details:
            payload['traceback'] = tb_str
        return jsonify(payload), status_code

    return render_template(
        'error.html',
        status_code=status_code,
        error_title=error_title,
        error_message=error_message,
        traceback_str=tb_str,
        show_details=show_details,
        perf_metrics=metrics_summary()
    ), status_code

"""Loans HTML & actions moved to loans blueprint."""

# -------------------------------------------------------------
# Blueprint registration (must occur even when not __main__)
# -------------------------------------------------------------
def register_blueprints():
    """Idempotently register all blueprints.

    When running under a WSGI server or `flask run`, __name__ != '__main__',
    so blueprints must still be registered; otherwise url_for endpoints like
    'dashboard.index' are missing (causing BuildError).
    """
    from routes.transactions import init_transactions_blueprint
    from routes.goals import init_goals_blueprint
    from routes.profile import init_profile_blueprint
    from routes.dashboard import init_dashboard_blueprint
    from routes.analysis import init_analysis_blueprint
    from routes.loans import init_loans_blueprint
    from routes.ai_features import init_ai_blueprint
    from routes.todos import init_todos_blueprint
    from routes.diary import init_diary_blueprint

    # Only register if not already present (debug reloader imports twice)
    if 'dashboard' not in app.blueprints:
        app.register_blueprint(init_dashboard_blueprint(mongo))
    if 'transactions_routes' not in app.blueprints:
        app.register_blueprint(init_transactions_blueprint(mongo))
    if 'goals_bp' not in app.blueprints:
        app.register_blueprint(init_goals_blueprint(mongo, ai_engine, pastebin_client))
    if 'profile_bp' not in app.blueprints:
        app.register_blueprint(init_profile_blueprint(mongo))
    if 'analysis_bp' not in app.blueprints:
        app.register_blueprint(init_analysis_blueprint(mongo, ai_engine))
    if 'loans_bp' not in app.blueprints:
        app.register_blueprint(init_loans_blueprint(mongo))
    if 'ai_bp' not in app.blueprints:
        app.register_blueprint(init_ai_blueprint(mongo, spending_advisor, pastebin_client))
    if 'todos_bp' not in app.blueprints:
        app.register_blueprint(init_todos_blueprint(mongo))
    if 'diary_bp' not in app.blueprints:
        app.register_blueprint(init_diary_blueprint(mongo))


# Ensure blueprints are registered at import time
register_blueprints()

if __name__ == '__main__':
    # Already registered above; run the dev server
    app.run(debug=True, host="0.0.0.0", port=5000)