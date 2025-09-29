import os
import traceback
import asyncio
from dotenv import load_dotenv
load_dotenv()

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_pymongo import PyMongo
from flask_bcrypt import Bcrypt
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from datetime import datetime
from bson import ObjectId
import json

from config import Config
from models.user import User
from models.goal import Goal
from utils.currency import currency_service
from utils.timezone_utils import now_utc, ensure_utc
from utils.request_metrics import start_request, finish_request, summary as metrics_summary
from utils.startup import run_local_startup
from utils.tools import is_allowed_email
from utils.pastebin_client import PastebinClient
from utils.db_monitor import FlaskMongoCommandLogger
from utils.ai_engine import FinancialBrain
from utils.ai_spending_advisor import SpendingAdvisor


class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId):
            return str(o)
        if isinstance(o, datetime):
            return ensure_utc(o).isoformat()
        return super().default(o)


def create_app(config_object=Config):
    app = Flask(__name__)
    app.config.from_object(config_object)

    # Proxy fix to get real user IP when behind a proxy
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

    # Register pymongo command listener before client creation (best-effort)
    try:
        from pymongo import monitoring as _pym_monitoring
        _pym_monitoring.register(FlaskMongoCommandLogger())
    except Exception:
        app.logger.debug('Failed to register FlaskMongoCommandLogger early')

    # Extensions
    mongo = PyMongo(app)
    bcrypt = Bcrypt(app)
    login_manager = LoginManager(app)
    login_manager.login_view = 'login'
    login_manager.login_message_category = 'warning'

    # Initialize Mongo-backed cache (mandatory for finance helpers)
    # Cache must be present; fail startup if missing or initialization fails.
    from utils.finance_calculator import enable_mongo_cache
    from pymongo import MongoClient
    import os

    cache_uri = os.getenv('CACHE_MONGO_URI') or app.config.get('CACHE_MONGO_URI')
    if not cache_uri:
        # intentionally crash loudly if no cache URI is configured
        raise RuntimeError('CACHE_MONGO_URI not configured; application requires a local cache DB')

    client = MongoClient(cache_uri)
    try:
        cache_db = client.get_default_database() or client['self_finance_tracker_cache']
    except Exception:
        cache_db = client['self_finance_tracker_cache']

    # This will raise if MongoCache init fails
    enable_mongo_cache(cache_db)
    app.logger.info('Mongo-backed cache initialized using %s', getattr(cache_db, 'name', str(cache_db)))

    limiter = Limiter(
        key_func=get_remote_address,
        app=app,
        default_limits=["5000 per day", "500 per hour"],
        storage_uri=app.config.get('MONGO_URI_LIMITER'),
        strategy="sliding-window-counter",
        storage_options={"database_name": "self_finance_tracker_limiter"},
    )

    # Attach helpful objects to the app for other modules to access without re-creating
    app.mongo = mongo
    app.bcrypt = bcrypt
    app.login_manager = login_manager
    app.limiter = limiter

    # AI and external clients (some require DB to be available first)
    app.ai_engine = FinancialBrain(app.config.get("GEMINI_API_KEY"))

    pastebin_client = PastebinClient(
        app.config.get('PASTEBIN_API_KEY'),
        os.getenv('PASTEBIN_USERNAME'),
        os.getenv('PASTEBIN_PASSWORD')
    )
    app.pastebin_client = pastebin_client

    # Spending advisor requires a DB handle; create after PyMongo initialized
    try:
        app.spending_advisor = SpendingAdvisor(app.ai_engine, mongo.db)
    except Exception:
        app.spending_advisor = None
        app.logger.debug('Failed to initialize SpendingAdvisor')

    # JSON encoder
    app.json_encoder = JSONEncoder  # type: ignore[attr-defined]

    # Request lifecycle hooks
    @app.before_request
    def _before_request_metrics():
        start_request()

    @app.after_request
    def _after_request_metrics(response):
        try:
            data = finish_request(status_code=response.status_code)
            if data:
                response.headers['X-Request-Time-ms'] = str(round(data.get('total_ms') or 0, 2))
                app.logger.info(
                    f"{request.method} {request.path} -> {response.status_code} | total={data['total_ms']:.1f}ms "
                    f"db={data['db_count']}/{data['db_ms']:.1f}ms ai={data['ai_count']}/{data['ai_ms']:.1f}ms"
                )
        except Exception:
            pass
        return response

    # Context processors
    @app.context_processor
    def inject_now():
        return {'now': now_utc()}

    @app.context_processor
    def inject_config():
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
            code = app.config.get('DEFAULT_CURRENCY')
        supported = currency_service.supported_currencies
        return {
            'currency_code': code,
            'currency_symbol': currency_service.get_currency_symbol(code),
            'supported_currencies': supported,
            'currency_symbols': {c: currency_service.get_currency_symbol(c) for c in supported},
        }

    @app.context_processor
    def inject_perf_metrics():
        try:
            return {'perf_metrics': metrics_summary()}
        except Exception:
            return {}

    @app.context_processor
    def inject_tx_categories():
        from models.transaction import TRANSACTION_CATEGORIES
        return {'tx_categories': TRANSACTION_CATEGORIES}

    # Login loader
    @login_manager.user_loader
    def load_user(user_id):
        try:
            user_data = mongo.db.users.find_one({'_id': ObjectId(user_id)})
        except Exception:
            return None
        if not user_data:
            return None
        return User(user_data, mongo.db)

    # Simple auth routes kept here for convenience
    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if current_user.is_authenticated:
            return redirect(url_for('dashboard.index'))
        if request.method == 'POST':
            email = request.form.get('email')
            password = request.form.get('password')

            if not is_allowed_email(email, app.config.get('ONLY_ALLOWED_EMAILS'), app.config.get('ONLY_ALLOWED_EMAIL_DOMAINS')):
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

            if not is_allowed_email(email, app.config.get('ONLY_ALLOWED_EMAILS'), app.config.get('ONLY_ALLOWED_EMAIL_DOMAINS')):
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
                'default_currency': app.config.get('DEFAULT_CURRENCY'),
                'monthly_income_currency': app.config.get('DEFAULT_CURRENCY')
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

    # Example API endpoints that rely on services
    @app.route('/api/goals/prioritized')
    @login_required
    def get_prioritized_goals():
        if mongo.db is None:
            return jsonify({'error': 'Database connection error.'}), 500
        goals = Goal.get_prioritized(current_user.id, mongo.db)
        return jsonify(goals)

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

    # Central error handler
    from werkzeug.exceptions import HTTPException

    def _wants_json_response():
        best = request.accept_mimetypes.best_match(['application/json', 'text/html'])
        return best == 'application/json' and request.accept_mimetypes[best] > request.accept_mimetypes['text/html']

    @app.errorhandler(Exception)
    def handle_any_exception(err):
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

    # Blueprint registration helper
    def register_blueprints():
        from routes.transactions import init_transactions_blueprint
        from routes.goals import init_goals_blueprint
        from routes.profile import init_profile_blueprint
        from routes.dashboard import init_dashboard_blueprint
        from routes.analysis import init_analysis_blueprint
        from routes.loans import init_loans_blueprint
        from routes.ai_features import init_ai_blueprint
        from routes.todos import init_todos_blueprint
        from routes.diary import init_diary_blueprint
        from routes.prefs import init_prefs_blueprint

        if 'dashboard' not in app.blueprints:
            app.register_blueprint(init_dashboard_blueprint(mongo))
        if 'transactions_routes' not in app.blueprints:
            app.register_blueprint(init_transactions_blueprint(mongo))
        if 'goals_bp' not in app.blueprints:
            app.register_blueprint(init_goals_blueprint(mongo, app.ai_engine, pastebin_client))
        if 'profile_bp' not in app.blueprints:
            app.register_blueprint(init_profile_blueprint(mongo))
        if 'analysis_bp' not in app.blueprints:
            app.register_blueprint(init_analysis_blueprint(mongo, app.ai_engine))
        if 'loans_bp' not in app.blueprints:
            app.register_blueprint(init_loans_blueprint(mongo))
        if 'ai_bp' not in app.blueprints:
            app.register_blueprint(init_ai_blueprint(mongo, app.spending_advisor, pastebin_client))
        if 'todos_bp' not in app.blueprints:
            app.register_blueprint(init_todos_blueprint(mongo))
        if 'diary_bp' not in app.blueprints:
            app.register_blueprint(init_diary_blueprint(mongo))
        if 'prefs_bp' not in app.blueprints:
            app.register_blueprint(init_prefs_blueprint(mongo))

    register_blueprints()

    return app


if __name__ == '__main__':
    app = create_app()
    try:
        run_local_startup(app.mongo, app.pastebin_client)
    except Exception:
        pass
    app.run(debug=True, host='0.0.0.0', port=5000)
