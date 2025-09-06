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

# Routes
@app.route('/')
@login_required
def index():
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('logout'))
    # Get recent transactions
    recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db)
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    # Get active goals

    user_obj = User(user, mongo.db)
    user_default_code = (user or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    # Backfill missing goal currency to current default to freeze existing goals
    try:
        mongo.db.goals.update_many(
            {'user_id': current_user.id, 'currency': {'$exists': False}},
            {'$set': {'currency': user_default_code}}
        )
    except Exception:
        pass
    active_goal_models = Goal.get_active_goals(current_user.id, mongo.db)
    
    # Calculate current month summary (calendar-aware) via helper
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)

    # Calculate complete financial picture
    full_balance = user_obj.get_lifetime_transaction_summary()

    # Compute simple lifetime-based allocations across active goals
    allocations = Goal.compute_allocations(current_user.id, mongo.db)
    # Convert models to dicts with progress for template compatibility
    active_goals = []
    for gm in active_goal_models:
        alloc_amt = allocations.get(gm.id, None)
        progress = Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)
        gd = gm.model_dump(by_alias=True)
        gd['progress'] = progress
        if alloc_amt is not None:
            gd['allocated_amount'] = alloc_amt
        active_goals.append(gd)

    days_until_income = None
    # Calculate days until usual income date (if set)
    if user.get('usual_income_date'):
        today = now_utc().day
        income_day = int(user['usual_income_date'])
        if today <= income_day:
            days_until_income = income_day - today
        else:
            # Next month
            from calendar import monthrange
            now = now_utc()
            last_day = monthrange(now.year, now.month)[1]
            days_until_income = (last_day - today) + income_day

    # print(active_goals)

    return render_template(
        'index.html', 
        transactions=recent_transactions,
        goals=active_goals,
        summary=monthly_summary,
        balance=full_balance,  # Now passing the complete balance object
    days_until_income=days_until_income,
    tx_categories=TRANSACTION_CATEGORIES,
    user_language=(user or {}).get('language','en'),
    perf_metrics=metrics_summary()
    )



@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
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
            return redirect(next_page or url_for('index'))
        else:
            flash('Login failed. Check your email and password.', 'danger')
    
    return render_template('login.html', next=request.args.get('next'), perf_metrics=metrics_summary())

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
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

@app.route('/goals/add', methods=['POST'])
@login_required
def add_goal():
    goal_type = request.form.get('goal_type') or ''
    target_amount_raw = request.form.get('target_amount')
    target_currency = request.form.get('target_currency')
    description_val = request.form.get('description') or ''
    target_date_str = request.form.get('target_date')

    # Basic validation prior to Pydantic model
    try:
        target_amount_val = float(target_amount_raw) if target_amount_raw is not None else None
    except ValueError:
        target_amount_val = None

    if not goal_type or target_amount_val is None or not description_val or not target_date_str:
        flash('All goal fields are required and must be valid.', 'danger')
        return redirect(url_for('goals'))

    try:
        parsed_date = ensure_utc(datetime.strptime(target_date_str, '%Y-%m-%d'))
    except Exception:
        flash('Invalid target date format.', 'danger')
        return redirect(url_for('goals'))

    # Ensure valid goal type
    if goal_type not in ('savings', 'purchase'):
        flash('Invalid goal type.', 'danger')
        return redirect(url_for('goals'))

    # Keep goal amount in the input currency; store currency alongside
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    input_code = (target_currency or user_default_code).upper()

    # parsed_date guaranteed not None due to earlier try/except
    goal_data = GoalCreate(
        user_id=current_user.id,
        type=goal_type,
        target_amount=target_amount_val,  # type: ignore[arg-type]
        currency=input_code,
        description=description_val,
        target_date=parsed_date  # type: ignore[arg-type]
    )

    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('goals'))

    goal = Goal.create(goal_data, mongo.db)
    # Launch background AI enhancement
    Goal.enhance_goal_background(goal, mongo.db, ai_engine)
    flash('Goal created with AI optimization', 'success')
    return redirect(url_for('goals'))


# Transactions routes
@app.route('/transactions')
@login_required
def transactions():
    page = request.args.get('page', 1, type=int)
    per_page = 10
    
    transactions = Transaction.get_user_transactions(current_user.id, mongo.db, page, per_page)
    total_transactions = Transaction.count_user_transactions(current_user.id, mongo.db)
    
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    return render_template('transactions.html', 
                         transactions=transactions,
                         page=page,
                         per_page=per_page,
                         total_transactions=total_transactions,
                         tx_categories=TRANSACTION_CATEGORIES,
                         user_language=(user_doc or {}).get('language','en'),
                         perf_metrics=metrics_summary())

@app.route('/transactions/add', methods=['POST'])
@login_required
def add_transaction():
    """Legacy POST endpoint retained for backwards compatibility.

    New UI uses /api/transactions via AJAX modal. This route simply mirrors
    the old POST handling and redirects back to /transactions with flashes.
    """
    amount_raw = request.form.get('amount')
    input_currency_code = request.form.get('currency')
    try:
        amount = float(amount_raw) if amount_raw is not None else None
    except (TypeError, ValueError):
        amount = None
    if amount is None:
        flash('Invalid amount.', 'danger')
        return redirect(url_for('transactions'))

    if amount <= 0:
        flash('Amount must be positive.', 'danger')
        return redirect(url_for('transactions'))

    transaction_type = (request.form.get('type') or '').lower().strip()
    if transaction_type not in {'income', 'expense'}:
        flash('Invalid transaction type.', 'danger')
        return redirect(url_for('transactions'))

    category = (request.form.get('category') or '').lower().strip()
    if not Transaction.is_valid_category(transaction_type, category):
        flash('Invalid category for selected type.', 'danger')
        return redirect(url_for('transactions'))

    description = request.form.get('description')
    date_str = request.form.get('date')
    related_person = request.form.get('related_person', '')

    if not description or len(description.strip()) < 3:
        flash('Please provide a more descriptive description.', 'danger')
        return redirect(url_for('transactions'))

    if date_str and len(date_str) == 10:
        try:
            parsed = datetime.strptime(date_str, '%Y-%m-%d')
            date = parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            date = datetime.now(timezone.utc)
    else:
        date = datetime.now(timezone.utc)
    now_ = datetime.now(timezone.utc)
    if date > now_ + timedelta(seconds=5):
        flash('Date cannot be in the future.', 'danger')
        return redirect(url_for('transactions'))

    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    input_code = (input_currency_code or user_default_code).upper()
    converted_amount = currency_service.convert_amount(amount, input_code, user_default_code)

    transaction_data = {
        'user_id': current_user.id,
        'amount': converted_amount,
        'amount_original': amount,
        'currency': input_code,
        'base_currency': user_default_code,
        'type': transaction_type,
        'category': category,
        'description': description.strip(),
        'date': date,
        'related_person': related_person,
        'created_at': datetime.now(timezone.utc)
    }

    tx_id = Transaction.create_transaction(transaction_data, mongo.db)
    try:
        Loan.process_transaction(current_user.id, mongo.db, transaction_data, tx_id)
    except Exception as e:
        app.logger.error(f"Loan processing failed for tx {tx_id}: {e}")
    flash('Transaction saved (legacy form)', 'success')
    return redirect(url_for('transactions'))

@app.route('/transactions/<transaction_id>/edit', methods=['POST'])
@login_required
def edit_transaction(transaction_id):
    """Edit a transaction via form submission (modal). Redirect back to /transactions.

    Form fields: amount, currency, type, category, description, date (YYYY-MM-DD), related_person
    """
    try:
        from bson import ObjectId
        oid = ObjectId(transaction_id)
    except Exception:
        flash('Invalid transaction id.', 'danger')
        return redirect(url_for('transactions'))
    tx = Transaction.get_transaction(current_user.id, oid, mongo.db)
    if not tx:
        flash('Transaction not found.', 'danger')
        return redirect(url_for('transactions'))

    amount_raw = request.form.get('amount')
    try:
        amount_val = float(amount_raw) if amount_raw is not None else None
    except (TypeError, ValueError):
        amount_val = None
    if amount_val is None or amount_val <= 0:
        flash('Invalid amount.', 'danger')
        return redirect(url_for('transactions'))
    currency_code = (request.form.get('currency') or tx.get('currency') or '').upper() or app.config['DEFAULT_CURRENCY']
    t_type = (request.form.get('type') or tx.get('type') or '').lower()
    if t_type not in {'income', 'expense'}:
        flash('Invalid type.', 'danger')
        return redirect(url_for('transactions'))
    category = request.form.get('category') or tx.get('category') or ''
    description = (request.form.get('description') or tx.get('description') or '').strip()
    if len(description) < 3:
        flash('Description too short.', 'danger')
        return redirect(url_for('transactions'))
    date_str = request.form.get('date')
    # Client supplies local date portion; treat as date-only -> midnight UTC
    from datetime import datetime as _dt, timezone as _tz
    if date_str and len(date_str) == 10:
        try:
            date_val = _dt.strptime(date_str, '%Y-%m-%d').replace(tzinfo=_tz.utc)
        except ValueError:
            date_val = tx.get('date')
    else:
        date_val = tx.get('date')
    related_person = request.form.get('related_person', tx.get('related_person', ''))

    # Recompute base currency amount if currency or amount changed
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    converted_amount = currency_service.convert_amount(amount_val, currency_code, user_default_code)
    update_fields = {
        'amount': converted_amount,
        'amount_original': amount_val,
        'currency': currency_code,
        'base_currency': user_default_code,
        'type': t_type,
        'category': category,
        'description': description,
        'date': date_val,
        'related_person': related_person,
    }
    Transaction.update_transaction(current_user.id, oid, update_fields, mongo.db)
    # For loan related categories, recompute counterparty loans safely
    try:
        if (category or '').lower() in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'} and related_person:
            Loan.recompute_counterparty(current_user.id, mongo.db, related_person)
    except Exception as e:
        app.logger.error(f"Loan recompute failed after edit {transaction_id}: {e}")
    flash('Transaction saved', 'success')
    return redirect(url_for('transactions'))

@app.route('/api/transactions/<transaction_id>', methods=['PATCH'])
@login_required
def api_update_transaction(transaction_id):
    """JSON edit endpoint mirroring form edit; returns updated item + summaries."""
    try:
        from bson import ObjectId
        oid = ObjectId(transaction_id)
    except Exception:
        return jsonify({'error': 'Invalid id'}), 400
    tx = Transaction.get_transaction(current_user.id, oid, mongo.db)
    if not tx:
        return jsonify({'error': 'Not found'}), 404
    data = request.get_json(silent=True) or {}
    updates = {}
    raw_amount = data.get('amount')
    if raw_amount is not None:
        try:
            amt = float(raw_amount)
            if amt <= 0: raise ValueError
            updates['amount_original'] = amt
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid amount'}), 400
    if 'currency' in data and data['currency']:
        updates['currency'] = str(data['currency']).upper()
    if 'type' in data:
        t_type = (data.get('type') or '').lower()
        if t_type not in {'income', 'expense'}:
            return jsonify({'error': 'Invalid type'}), 400
        updates['type'] = t_type
    if 'category' in data:
        updates['category'] = data.get('category') or ''
    if 'description' in data:
        desc = (data.get('description') or '').strip()
        if len(desc) < 3:
            return jsonify({'error': 'Description too short'}), 400
        updates['description'] = desc
    if 'date' in data:
        dstr = data.get('date')
        from datetime import datetime as _dt, timezone as _tz
        try:
            if dstr and len(dstr) == 10:
                updates['date'] = _dt.strptime(dstr, '%Y-%m-%d').replace(tzinfo=_tz.utc)
        except ValueError:
            return jsonify({'error': 'Invalid date'}), 400
    if 'related_person' in data:
        updates['related_person'] = data.get('related_person') or ''

    # Currency conversion update
    if 'amount_original' in updates or 'currency' in updates:
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
        amt_orig = updates.get('amount_original', tx.get('amount_original'))
        try:
            amt_float = float(amt_orig)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid amount'}), 400
        cur_code = (updates.get('currency') or tx.get('currency') or user_default_code).upper()
        updates['base_currency'] = user_default_code
        updates['amount'] = currency_service.convert_amount(amt_float, cur_code, user_default_code)
        updates['currency'] = cur_code

    updated = Transaction.update_transaction(current_user.id, oid, updates, mongo.db)
    try:
        cat_eff = (updates.get('category') or tx.get('category') or '').lower()
        rp_eff = updates.get('related_person') or tx.get('related_person')
        if cat_eff in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'} and rp_eff:
            Loan.recompute_counterparty(current_user.id, mongo.db, rp_eff)
    except Exception as e:
        app.logger.error(f"Loan recompute failed after api edit {transaction_id}: {e}")

    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    lifetime = calculate_lifetime_transaction_summary(current_user.id, mongo.db)
    if updated and '_id' in updated:
        updated['_id'] = str(updated['_id'])
    return jsonify({'item': updated, 'monthly_summary': monthly_summary, 'lifetime': lifetime})


@app.route('/transactions/<transaction_id>/delete', methods=['POST'])
@login_required
def delete_transaction(transaction_id):
    # Fetch transaction first to know if it affects loans
    tx = mongo.db.transactions.find_one({'_id': ObjectId(transaction_id), 'user_id': current_user.id})
    Transaction.delete_transaction(current_user.id, ObjectId(transaction_id), mongo.db)
    try:
        if tx and (tx.get('category') or '').lower() in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'}:
            cp = tx.get('related_person')
            if cp:
                Loan.recompute_counterparty(current_user.id, mongo.db, cp)
    except Exception as e:
        app.logger.error(f"Failed to recompute loans after tx delete: {e}")
    flash('Transaction deleted successfully.', 'success')
    return redirect(url_for('transactions'))

@app.route('/goals')
@login_required
def goals():
    page = int(request.args.get('page', 1))
    per_page = 5
    skip = (page - 1) * per_page
    total_goals = mongo.db.goals.count_documents({'user_id': current_user.id})
    goal_models = Goal.get_user_goals(current_user.id, mongo.db, skip, per_page)
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = user_doc['default_currency']

    allocations = Goal.compute_allocations(current_user.id, mongo.db)

    # Build list of (GoalInDB model, progress_dict) tuples for template
    goals_with_progress = []
    for gm in goal_models:
        alloc_amt = allocations.get(gm.id, None)
        goals_with_progress.append((gm, Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)))

    total_pages = (total_goals + per_page - 1) // per_page

    return render_template('goals.html', goals=goals_with_progress, page=page, total_pages=total_pages, perf_metrics=metrics_summary())

@app.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})

    if request.method == 'POST':
        monthly_income = request.form.get('monthly_income')
        usual_income_date = request.form.get('usual_income_date')
        occupation = request.form.get('occupation')
        default_currency = request.form.get('default_currency')
        monthly_income_currency = request.form.get('monthly_income_currency')
        language = request.form.get('language')

        update_data = {}

        # Monthly income handling
        if monthly_income:
            try:
                mi_val = float(monthly_income)
                dc = (default_currency or user.get('default_currency')).upper()
                mic = (monthly_income_currency or dc).upper()
                update_data['monthly_income'] = currency_service.convert_amount(mi_val, mic, dc)
                update_data['monthly_income_currency'] = dc
            except ValueError:
                flash('Monthly income must be a number.', 'danger')

        # Usual income date validation
        if usual_income_date:
            try:
                day = int(usual_income_date)
                if 1 <= day <= 31:
                    update_data['usual_income_date'] = day
                else:
                    flash('Usual income date must be between 1 and 31.', 'danger')
            except ValueError:
                flash('Usual income date must be a number between 1 and 31.', 'danger')

        # Occupation
        if occupation is not None:
            update_data['occupation'] = occupation.strip()

        # Default currency migration
        if default_currency:
            new_dc = default_currency.upper()
            old_dc = (user.get('default_currency') or app.config['DEFAULT_CURRENCY']).upper()
            update_data['default_currency'] = new_dc
            if new_dc != old_dc:
                if 'monthly_income' not in update_data and user.get('monthly_income') is not None:
                    try:
                        update_data['monthly_income'] = currency_service.convert_amount(float(user['monthly_income']), old_dc, new_dc)
                        update_data['monthly_income_currency'] = new_dc
                    except Exception:
                        pass
                try:
                    cursor = mongo.db.transactions.find({'user_id': current_user.id})
                    for tx in cursor:
                        amt = float(tx.get('amount', 0))
                        tx_base = (tx.get('base_currency') or old_dc).upper()
                        new_amt = currency_service.convert_amount(amt, tx_base, new_dc)
                        mongo.db.transactions.update_one({'_id': tx['_id']}, {'$set': {'amount': new_amt, 'base_currency': new_dc}})
                except Exception:
                    pass

        # Language
        if language:
            update_data['language'] = (language or 'en').lower()

        if update_data:
            mongo.db.users.update_one({'_id': ObjectId(current_user.id)}, {'$set': update_data})
            flash('Profile updated successfully.', 'success')
            return redirect(url_for('profile'))

    return render_template('profile.html', user=user, perf_metrics=metrics_summary())


@app.route('/goals/<goal_id>/complete', methods=['POST'])
@login_required
def complete_goal(goal_id):
    update_data = GoalUpdate(
        is_completed=True,
        completed_date=now_utc()
    )
    goal = Goal.update(goal_id, current_user.id, update_data, mongo.db)
    if goal:
        flash('Goal marked as completed.', 'success')
    else:
        flash('Goal not found.', 'danger')
    return redirect(url_for('goals'))

@app.route('/goals/<goal_id>/delete', methods=['POST'])
@login_required
def delete_goal(goal_id):
    deleted = Goal.delete(goal_id, current_user.id, mongo.db)
    if deleted:
        flash('Goal deleted successfully.', 'success')
    else:
        flash('Goal not found.', 'danger')
    return redirect(url_for('goals'))

# Analysis routes
@app.route('/analysis')
@login_required
def analysis():
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    goal_models = Goal.get_active_goals(current_user.id, mongo.db)
    allocations = Goal.compute_allocations(current_user.id, mongo.db)
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    goals = []
    for gm in goal_models:
        alloc_amt = allocations.get(gm.id, None)
        progress = Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)
        gd = gm.model_dump(by_alias=True)
        gd['progress'] = progress
        if alloc_amt is not None:
            gd['allocated_amount'] = alloc_amt
        goals.append(gd)

    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})

    # print(goals)

    # Use cached analysis if available
    ai_analysis = user.get('ai_analysis')

    return render_template('analysis.html',
                           summary=monthly_summary,
                           goals=goals,
                           ai_analysis=ai_analysis,
                           perf_metrics=metrics_summary())

@app.route('/analysis/run', methods=['POST'])
@login_required
def run_ai_analysis():
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('analysis'))

    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_obj = User(user, db=mongo.db)
    ai_analysis = get_ai_analysis(user_obj)

    mongo.db.users.update_one(
        {'_id': ObjectId(current_user.id)},
        {'$set': {'ai_analysis': ai_analysis}}
    )

    flash('AI analysis updated.', 'success')
    return redirect(url_for('analysis'))


# API routes
@app.route('/api/transactions', methods=['GET'])
@login_required
def api_transactions():
    transactions = list(mongo.db.transactions.find({'user_id': current_user.id}).sort('date', -1))
    return jsonify(transactions)

@app.route('/api/transactions/list', methods=['GET'])
@login_required
def api_transactions_list():
    """Paginated transactions list for dynamic fetch UI.

    Query params: page (1-based), per_page. Returns items + total + page info.
    """
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 10, type=int)
    if per_page > 100:
        per_page = 100  # safety cap
    tx = Transaction.get_user_transactions(current_user.id, mongo.db, page, per_page)
    total = Transaction.count_user_transactions(current_user.id, mongo.db)
    # Convert ObjectId and datetimes (JSONEncoder handles datetimes)
    items = []
    for t in tx:
        t = dict(t)
        if '_id' in t:
            t['_id'] = str(t['_id'])
        items.append(t)
    return jsonify({
        'items': items,
        'total': total,
        'page': page,
        'per_page': per_page
    })

@app.route('/api/transactions', methods=['POST'])
@login_required
def api_create_transaction():
    """Create a transaction via JSON. Mirrors logic of form POST but returns JSON.

    Body JSON: amount, currency, type, category, description, date (YYYY-MM-DD), related_person
    """
    data = request.get_json(silent=True) or {}
    errors = []
    raw_amount = data.get('amount')
    amount = None
    if raw_amount is None:
        errors.append('Invalid amount.')
    try:
        amount = float(raw_amount)  # type: ignore[arg-type]
        if amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        amount = None
        errors.append('Invalid amount.')

    t_type = (data.get('type') or '').lower()
    if t_type not in {'income', 'expense'}:
        errors.append('Invalid type.')
    category = data.get('category') or ''
    description = (data.get('description') or '').strip()
    if len(description) < 3:
        errors.append('Description too short.')
    date_str = data.get('date')
    from datetime import timezone as _tz
    if date_str:
        try:
            date_val = datetime.strptime(date_str, '%Y-%m-%d')
        except ValueError:
            date_val = datetime.now(_tz.utc)
    else:
        date_val = datetime.now(_tz.utc)
    related_person = data.get('related_person', '')
    if errors:
        return jsonify({'errors': errors}), 400
    # Currency handling
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    input_code = (data.get('currency') or user_default_code).upper()
    # At this point amount is validated (not None)
    converted_amount = currency_service.convert_amount(amount, input_code, user_default_code)  # type: ignore[arg-type]
    tx_doc = {
        'user_id': current_user.id,
        'amount': converted_amount,
        'amount_original': amount,
        'currency': input_code,
        'base_currency': user_default_code,
        'type': t_type,
        'category': category,
        'description': description,
        'date': date_val,
        'related_person': related_person,
        'created_at': now_utc()
    }
    tx_id = Transaction.create_transaction(tx_doc, mongo.db)
    try:
        Loan.process_transaction(current_user.id, mongo.db, tx_doc, tx_id)
    except Exception as e:
        app.logger.error(f"Loan processing failed for tx {tx_id}: {e}")
    tx_doc['_id'] = str(tx_id)
    # Return updated lightweight summaries (monthly + lifetime) for live UI refresh
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    lifetime = calculate_lifetime_transaction_summary(current_user.id, mongo.db)
    return jsonify({'item': tx_doc, 'monthly_summary': monthly_summary, 'lifetime': lifetime})

@app.route('/api/transactions/<transaction_id>', methods=['DELETE'])
@login_required
def api_delete_transaction(transaction_id):
    try:
        oid = ObjectId(transaction_id)
    except Exception:
        return jsonify({'error': 'Invalid id'}), 400
    tx = mongo.db.transactions.find_one({'_id': oid, 'user_id': current_user.id})
    if not tx:
        return jsonify({'error': 'Not found'}), 404
    Transaction.delete_transaction(current_user.id, oid, mongo.db)
    try:
        if tx and (tx.get('category') or '').lower() in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'}:
            cp = tx.get('related_person')
            if cp:
                Loan.recompute_counterparty(current_user.id, mongo.db, cp)
    except Exception as e:
        app.logger.error(f"Loan recompute failed after delete {transaction_id}: {e}")
    # Provide updated summary counts for UI to refresh
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    lifetime = calculate_lifetime_transaction_summary(current_user.id, mongo.db)
    return jsonify({'success': True, 'monthly_summary': monthly_summary, 'lifetime': lifetime})

@app.route('/api/dashboard', methods=['GET'])
@login_required
def api_dashboard():
    """Aggregate dashboard data for fetch-based dynamic refresh."""
    if mongo.db is None:
        return jsonify({'error': 'Database connection error'}), 500
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    if not user:
        return jsonify({'error': 'User not found'}), 404
    recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db)
    # Convert ObjectIds
    rtx = []
    for t in recent_transactions:
        t = dict(t)
        if '_id' in t:
            t['_id'] = str(t['_id'])
        rtx.append(t)
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    full_balance = User(user, mongo.db).get_lifetime_transaction_summary()
    # Goals (active)
    active_goal_models = Goal.get_active_goals(current_user.id, mongo.db)
    allocations = Goal.compute_allocations(current_user.id, mongo.db)
    user_default_code = (user or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    goals = []
    for gm in active_goal_models:
        alloc_amt = allocations.get(gm.id, None)
        progress = Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)
        gd = gm.model_dump(by_alias=True)
        td = gd.get('target_date')
        if isinstance(td, datetime):
            gd['target_date'] = td.isoformat()
        gd['progress'] = progress
        if alloc_amt is not None:
            gd['allocated_amount'] = alloc_amt
        if '_id' in gd:
            gd['_id'] = str(gd['_id'])
        goals.append(gd)
    # Days until income
    days_until_income = None
    if user.get('usual_income_date'):
        today = now_utc().day
        income_day = int(user['usual_income_date'])
        if today <= income_day:
            days_until_income = income_day - today
        else:
            from calendar import monthrange
            now = now_utc()
            last_day = monthrange(now.year, now.month)[1]
            days_until_income = (last_day - today) + income_day
    return jsonify({
        'monthly_summary': monthly_summary,
        'lifetime': full_balance,
        'recent_transactions': rtx,
        'goals': goals,
        'days_until_income': days_until_income,
        'currency': {
            'code': user_default_code,
            'symbol': currency_service.get_currency_symbol(user_default_code)
        }
    })

# ---------------- GOALS JSON API -----------------
@app.route('/api/goals/list')
@login_required
def api_goals_list():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 5, type=int)
    per_page =  min(per_page, 50)
    skip = (page - 1) * per_page
    total = mongo.db.goals.count_documents({'user_id': current_user.id})
    goal_models = Goal.get_user_goals(current_user.id, mongo.db, skip, per_page)
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    allocations = Goal.compute_allocations(current_user.id, mongo.db)
    items = []
    for gm in goal_models:
        alloc_amt = allocations.get(gm.id, None)
        progress = Goal.calculate_goal_progress(gm, monthly_summary, override_current_amount=alloc_amt, base_currency_code=user_default_code)
        gdict = gm.model_dump(by_alias=True)
        td = gdict.get('target_date')
        if isinstance(td, datetime):
            gdict['target_date'] = td.isoformat()
        gdict['progress'] = progress
        items.append(gdict)
    return jsonify({'items': items, 'total': total, 'page': page, 'per_page': per_page})

@app.route('/api/goals', methods=['POST'])
@login_required
def api_goal_create():
    data = request.get_json(silent=True) or {}
    required_fields = ['goal_type', 'target_amount', 'description', 'target_date']
    missing = [f for f in required_fields if not data.get(f)]
    if missing:
        return jsonify({'errors': [f'Missing: {", ".join(missing)}']}), 400
    raw_ta = data.get('target_amount')
    if raw_ta is None:
        return jsonify({'errors': ['Invalid target_amount']}), 400
    try:
        target_amount = float(raw_ta)  # type: ignore[arg-type]
        if target_amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({'errors': ['Invalid target_amount']}), 400
    goal_type = data.get('goal_type')
    if goal_type not in ('savings', 'purchase'):
        return jsonify({'errors': ['Invalid goal_type']}), 400
    td_str = data.get('target_date')
    try:
        parsed_date = ensure_utc(datetime.strptime(td_str, '%Y-%m-%d')) if td_str else None
    except Exception:
        return jsonify({'errors': ['Invalid target_date']}), 400
    if parsed_date is None:
        return jsonify({'errors': ['Invalid target_date']}), 400
    user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
    input_code = (data.get('target_currency') or user_default_code).upper()
    goal_data = GoalCreate(
        user_id=current_user.id,
        type=goal_type,
        target_amount=target_amount,
        currency=input_code,
        description=data.get('description', '').strip(),
        target_date=parsed_date
    )
    goal = Goal.create(goal_data, mongo.db)
    Goal.enhance_goal_background(goal, mongo.db, ai_engine)
    return jsonify({'item': goal.model_dump(by_alias=True)})

@app.route('/api/goals/<goal_id>', methods=['PATCH'])
@login_required
def api_goal_update(goal_id):
    payload = request.get_json(silent=True) or {}
    update = GoalUpdate(
        target_amount=payload.get('target_amount'),
        description=payload.get('description'),
        target_date=ensure_utc(datetime.strptime(payload['target_date'], '%Y-%m-%d')) if payload.get('target_date') else None,
        current_amount=payload.get('current_amount'),
        is_completed=payload.get('is_completed'),
    )
    goal = Goal.update(goal_id, current_user.id, update, mongo.db)
    if not goal:
        return jsonify({'error': 'Not found or no changes'}), 404
    return jsonify({'item': goal.model_dump(by_alias=True)})

@app.route('/api/goals/<goal_id>/complete', methods=['POST'])
@login_required
def api_goal_complete(goal_id):
    upd = GoalUpdate(is_completed=True, completed_date=now_utc())
    goal = Goal.update(goal_id, current_user.id, upd, mongo.db)
    if not goal:
        return jsonify({'error': 'Not found'}), 404
    return jsonify({'item': goal.model_dump(by_alias=True)})

@app.route('/api/goals/<goal_id>', methods=['DELETE'])
@login_required
def api_goal_delete(goal_id):
    ok = Goal.delete(goal_id, current_user.id, mongo.db)
    if not ok:
        return jsonify({'error': 'Not found'}), 404
    return jsonify({'success': True})

@app.route('/api/goals/<goal_id>/revalidate', methods=['POST'])
@login_required
def api_goal_revalidate(goal_id):
    goal = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
    if not goal:
        return jsonify({'error': 'Not found'}), 404
    thread = threading.Thread(
        target=lambda: asyncio.run(
            Goal._ai_enhance_goal(ObjectId(goal_id), goal, mongo.db, ai_engine)
        ),
        daemon=True
    )
    thread.start()
    return jsonify({'success': True, 'message': 'Revalidation started'})

# ---------------- PROFILE JSON API -----------------
def _sanitize_user(doc: dict) -> dict:
    if not doc: return {}
    safe = {k: v for k, v in doc.items() if k not in {'password'}}
    if '_id' in safe:
        safe['_id'] = str(safe['_id'])
    return safe

@app.route('/api/profile', methods=['GET'])
@login_required
def api_profile_get():
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    if not user:
        return jsonify({'error': 'User not found'}), 404
    return jsonify({'user': _sanitize_user(user)})

@app.route('/api/profile', methods=['PATCH'])
@login_required
def api_profile_update():
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    if not user:
        return jsonify({'error': 'User not found'}), 404
    data = request.get_json(silent=True) or {}
    update_data: dict[str, Any] = {}
    # Reuse logic from HTML route (simplified for API)
    if 'monthly_income' in data and data['monthly_income'] is not None:
        try:
            mi_val = float(data['monthly_income'])
            dc = (data.get('default_currency') or user.get('default_currency') or app.config['DEFAULT_CURRENCY']).upper()
            mic = (data.get('monthly_income_currency') or dc).upper()
            update_data['monthly_income'] = currency_service.convert_amount(mi_val, mic, dc)
            update_data['monthly_income_currency'] = dc
        except ValueError:
            return jsonify({'error': 'monthly_income must be a number'}), 400
    if 'usual_income_date' in data and data['usual_income_date'] is not None:
        try:
            day = int(data['usual_income_date'])
            if 1 <= day <= 31:
                update_data['usual_income_date'] = day
            else:
                return jsonify({'error': 'usual_income_date must be 1-31'}), 400
        except ValueError:
            return jsonify({'error': 'usual_income_date must be int'}), 400
    if 'occupation' in data:
        update_data['occupation'] = (data.get('occupation') or '').strip()
    if 'default_currency' in data and data['default_currency']:
        new_dc = data['default_currency'].upper()
        old_dc = (user.get('default_currency') or app.config['DEFAULT_CURRENCY']).upper()
        update_data['default_currency'] = new_dc
        if new_dc != old_dc:
            if 'monthly_income' not in update_data and user.get('monthly_income') is not None:
                try:
                    update_data['monthly_income'] = currency_service.convert_amount(float(user['monthly_income']), old_dc, new_dc)
                    update_data['monthly_income_currency'] = new_dc
                except Exception:
                    pass
            try:
                cursor = mongo.db.transactions.find({'user_id': current_user.id})
                for tx in cursor:
                    amt = float(tx.get('amount', 0))
                    tx_base = (tx.get('base_currency') or old_dc).upper()
                    new_amt = currency_service.convert_amount(amt, tx_base, new_dc)
                    mongo.db.transactions.update_one({'_id': tx['_id']}, {'$set': {'amount': new_amt, 'base_currency': new_dc}})
            except Exception:
                pass
    if update_data:
        if 'language' in data and data['language']:
            update_data['language'] = (data['language'] or 'en').lower()
        mongo.db.users.update_one({'_id': ObjectId(current_user.id)}, {'$set': update_data})
        user.update(update_data)
    return jsonify({'user': _sanitize_user(user)})

# ---------------- LOANS JSON API -----------------
@app.route('/api/loans/list')
@login_required
def api_loans_list():
    include_closed = request.args.get('include_closed', 'true').lower() != 'false'
    loans = Loan.list_user_loans(current_user.id, mongo.db, include_closed=include_closed)
    # Convert _id
    out = []
    for l in loans:
        d = dict(l)
        if d.get('_id'):
            d['_id'] = str(d['_id'])
        out.append(d)
    return jsonify({'items': out})

@app.route('/api/summary', methods=['GET'])
@login_required
def api_summary():
    summary = calculate_monthly_summary(current_user.id, mongo.db)
    return jsonify(summary)








# Add to imports
from models.advice import PurchaseAdvice
from utils.pastebin_client import PastebinClient

# Initialize Pastebin client (optional)
pastebin_client = PastebinClient(Config.PASTEBIN_API_KEY)


@app.route('/api/ai/advice/<advice_id>', methods=['DELETE'])
@login_required
def delete_advice(advice_id):
    mongo.db.purchase_advice.delete_one({
        '_id': ObjectId(advice_id),
        'user_id': current_user.id
    })
    return jsonify({'success': True})

@app.route('/api/ai/archive-old', methods=['POST'])
@login_required
def archive_old_entries():
    asyncio.run(PurchaseAdvice.archive_old_entries(
        current_user.id, 
        mongo.db,
        pastebin_client
    ))
    return jsonify({'success': True})


@app.route('/api/ai/purchase-advice', methods=['POST'])
@login_required
def get_purchase_advice():
    try:
        data = request.get_json(force=True, silent=True)
        app.logger.info(f"Received purchase advice request: {data}")
        if not data or 'amount' not in data or not data.get('description'):
            app.logger.warning("Missing description or price amount in request data.")
            return jsonify({"error": "Description and price amount are required."}), 400

        try:
            amount = float(data['amount'])
            if amount <= 0:
                raise ValueError
        except (ValueError, TypeError):
            app.logger.warning(f"Invalid price amount value: {data.get('price')}")
            return jsonify({"error": "Price must be a positive number."}), 400

        user_id = getattr(current_user, 'id', None)
        if not user_id:
            app.logger.error("User not authenticated.")
            return jsonify({"error": "User not authenticated."}), 401

        # Determine user's base currency and convert amount
        user_doc = mongo.db.users.find_one({'_id': ObjectId(user_id)})
        user_base_currency = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY']).upper()
        input_currency = (data.get('currency') or user_base_currency).upper()
        converted_amount = currency_service.convert_amount(amount, input_currency, user_base_currency)

        # Prepare data for AI and DB
        item_data = {
            'description': data['description'],
            'amount': converted_amount,  # amount in base currency for AI consistency
            'amount_original': amount,
            'currency': input_currency,
            'base_currency': user_base_currency,
            'category': data.get('category'),
            'tags': data.get('tags', []),
            'urgency': data.get('urgency')
        }

        app.logger.info(f"Calling spending_advisor.evaluate_purchase for user {user_id} with item_data: {item_data}")
        advice = spending_advisor.evaluate_purchase(user_id, item_data)
        # add echo of conversion context for client display
        advice = {
            **advice,
            'amount_converted': converted_amount,
            'base_currency': user_base_currency,
        }
        inserted_id = PurchaseAdvice.save_advice(user_id, item_data, advice, mongo.db)
        app.logger.info(f"Advice saved with id: {inserted_id}")
        return jsonify(advice)
    except Exception as e:
        app.logger.error(f"Error in get_purchase_advice: {e}\n{traceback.format_exc()}")
        return jsonify({"error": "Internal server error."}), 500


# Add these new endpoints
@app.route('/api/ai/visualization-data')
@login_required
def get_visualization_data():
    # Impact data (followed vs ignored advice) - now using user_action field
    impact = {
        'followed_count': mongo.db.purchase_advice.count_documents({
            'user_id': current_user.id,
            'user_action': 'followed',
            'created_at': {'$gte': datetime.now(timezone.utc) - timedelta(days=30)}
        }),
        'ignored_count': mongo.db.purchase_advice.count_documents({
            'user_id': current_user.id,
            'user_action': 'ignored',
            'created_at': {'$gte': datetime.now(timezone.utc) - timedelta(days=30)}
        })
    }

    # Category breakdown
    categories = PurchaseAdvice.get_stats(current_user.id, mongo.db)

    # Trend data (weekly spending)
    trend = []
    for i in range(4):
        week_start = datetime.now(timezone.utc) - timedelta(weeks=(4-i))
        week_end = week_start + timedelta(weeks=1)
        week_data = list(mongo.db.purchase_advice.aggregate([{
            '$match': {
                'user_id': current_user.id,
                'created_at': {'$gte': week_start, '$lt': week_end}
            }},
            {'$group': {
                '_id': None,
                'total': {'$sum': '$amount'}
            }}
        ]))
        trend.append({
            'week': week_start.strftime('%b %d'),
            'amount': week_data[0]['total'] if week_data else 0
        })

    # Goal impact
    goal_impact = PurchaseAdvice.get_impact_on_goals(current_user.id, mongo.db)

    return jsonify({
        'impact': impact,
        'categories': categories,
        'trend': {
            'weeks': [t['week'] for t in trend],
            'amounts': [t['amount'] for t in trend]
        },
        'goal_impact': goal_impact
    })

@app.route('/api/ai/advice-history')
@login_required
def get_advice_history():
    # Get pagination parameters from query string
    try:
        page = int(request.args.get('page', 1))
        page_size = int(request.args.get('page_size', 5))
    except (TypeError, ValueError):
        page = 1
        page_size = 5

    skip = (page - 1) * page_size
    user_id = current_user.id

    total = mongo.db.purchase_advice.count_documents({'user_id': user_id, 'is_archived': False})
    advices = list(
        mongo.db.purchase_advice.find({'user_id': user_id, 'is_archived': False})
        .sort('created_at', -1)
        .skip(skip)
        .limit(page_size)
    )

    # Convert ObjectId and datetime for JSON serialization
    for advice in advices:
        advice['_id'] = str(advice['_id'])
        if 'created_at' in advice:
            advice['created_at'] = advice['created_at'].isoformat()
        if 'request' in advice:
            if 'amount' in advice['request']:
                try:
                    advice['request']['amount'] = float(advice['request']['amount'])
                except Exception:
                    pass
            if 'amount_original' in advice['request']:
                try:
                    advice['request']['amount_original'] = float(advice['request']['amount_original'])
                except Exception:
                    pass

    return jsonify({
        'items': advices,
        'total': total,
        'page': page,
        'page_size': page_size
    })

@app.route('/purchase-advisor')
@login_required
def purchase_advisor():
    return render_template('purchase_advisor.html', perf_metrics=metrics_summary())

@app.route('/api/ai/advice/<advice_id>/action', methods=['POST'])
@login_required
def set_advice_user_action(advice_id):
    data = request.get_json()
    action = data.get('action')
    if action not in ['followed', 'ignored']:
        return jsonify({'error': 'Invalid action'}), 400
    PurchaseAdvice.set_user_action(advice_id, current_user.id, action, mongo.db)
    return jsonify({'success': True})

# Revalidate goal summary and priority
@app.route('/goals/<goal_id>/revalidate', methods=['POST'])
@login_required
def revalidate_goal(goal_id):
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('goals'))

    try:
        goal = mongo.db.goals.find_one({'_id': ObjectId(goal_id), 'user_id': current_user.id})
        if not goal:
            flash('Goal not found.', 'danger')
            return redirect(url_for('goals'))
        
        # Run AI enhancement in background
        thread = threading.Thread(
            target=lambda: asyncio.run(
                Goal._ai_enhance_goal(
                    ObjectId(goal_id),
                    goal,
                    mongo.db,
                    ai_engine
                )
            ),
            daemon=True
        )
        thread.start()
        
        flash('Goal revalidation started. Refresh in a few seconds to see updates.', 'info')
    except Exception as e:
        print(f"Error starting revalidation: {str(e)}")
        flash('Failed to start goal revalidation.', 'danger')
    
    return redirect(url_for('goals'))


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

# ---------------------- LOANS ROUTES ----------------------
@app.route('/loans')
@login_required
def loans():
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('index'))
    items = Loan.list_user_loans(current_user.id, mongo.db, include_closed=True)
    return render_template('loans.html', loans=items, perf_metrics=metrics_summary())


@app.route('/api/loans/counterparties')
@login_required
def api_loan_counterparties():
    kind = request.args.get('kind')  # repaid_by_me | repaid_to_me | None
    names = Loan.list_open_counterparties(current_user.id, mongo.db, kind=kind)
    return jsonify({'items': names})


@app.route('/api/loans/<loan_id>/close', methods=['POST'])
@login_required
def api_close_loan(loan_id):
    payload = request.get_json(silent=True) or {}
    note = request.form.get('note') or payload.get('note')
    ok = Loan.close_loan(ObjectId(loan_id), current_user.id, mongo.db, note=note)
    if not ok:
        return jsonify({'success': False}), 400
    return jsonify({'success': True})

if __name__ == '__main__':
    app.run(debug=True)