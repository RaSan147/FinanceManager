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
from models.transaction import Transaction
from models.loan import Loan
from models.goal import Goal, GoalCreate, GoalUpdate, GoalInDB
from utils.ai_helper import get_ai_analysis, get_goal_plan
from utils.finance_calculator import calculate_monthly_summary,  calculate_lifetime_transaction_summary
from utils.currency import currency_service
from utils.tools import is_allowed_email
from config import Config
# Added centralized timezone helpers
from utils.timezone_utils import now_utc, ensure_utc

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

mongo = PyMongo(app)
bcrypt = Bcrypt(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'  # type: ignore[attr-defined]
login_manager.login_message_category = 'warning'

# Configure currency service with Mongo backend and start background refresh
currency_service.re_initialize(db=mongo.db, cache_backend='mongo')
currency_service.refresh_rates()
threading.Thread(target=currency_service.background_initial_refresh, daemon=True).start()

@app.context_processor
def inject_now():
    # Always provide UTC now (aware)
    return {'now': now_utc()}

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
        days_until_income=days_until_income
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
    
    return render_template('login.html', next=request.args.get('next'))

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
    
    return render_template('register.html')

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
    
    return render_template('transactions.html', 
                         transactions=transactions,
                         page=page,
                         per_page=per_page,
                         total_transactions=total_transactions)

@app.route('/transactions/add', methods=['GET', 'POST'])
@login_required
def add_transaction():
    if request.method == 'POST':
        amount_raw = request.form.get('amount')
        input_currency_code = request.form.get('currency')
        try:
            amount = float(amount_raw) if amount_raw is not None else None
        except (TypeError, ValueError):
            amount = None
        if amount is None:
            flash('Invalid amount.', 'danger')
            return redirect(url_for('add_transaction'))

        if amount <= 0:
            flash('Amount must be positive.', 'danger')
            return redirect(url_for('add_transaction'))

        transaction_type = request.form.get('type')
        category = request.form.get('category')
        description = request.form.get('description')
        date_str = request.form.get('date')
        related_person = request.form.get('related_person', '')

        # Require a description
        if not description or len(description.strip()) < 3:
            flash('Please provide a more descriptive description.', 'danger')
            return redirect(url_for('add_transaction'))

        # Ensure date is not in the future (optional) or not in the distant past
        if date_str:
            try:
                date = datetime.strptime(date_str, '%Y-%m-%d')
            except ValueError:
                date = datetime.now(timezone.utc)
        else:
            date = datetime.now(timezone.utc)

        # Determine user's base/default currency
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        user_default_code = (user_doc or {}).get('default_currency', app.config['DEFAULT_CURRENCY'])
        input_code = (input_currency_code or user_default_code).upper()
        # Convert amount to user's default currency for storage/analytics
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
        # Update loan tracker based on loan-related categories
        try:
            Loan.process_transaction(current_user.id, mongo.db, transaction_data, tx_id)
        except Exception as e:
            app.logger.error(f"Loan processing failed for tx {tx_id}: {e}")
        flash('Transaction added successfully.', 'success')
        return redirect(url_for('transactions'))

    return render_template('add_transaction.html')


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

    return render_template('goals.html', goals=goals_with_progress, page=page, total_pages=total_pages)

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

        update_data = {}
        if monthly_income:
            try:
                mi_val = float(monthly_income)
                # Determine target default currency
                dc = (default_currency or user.get('default_currency')).upper()
                mic = (monthly_income_currency or dc).upper()
                # Always store monthly income in the user's default/base currency (dc)
                update_data['monthly_income'] = currency_service.convert_amount(mi_val, mic, dc)
                # Track the currency of the stored monthly_income, not the input source
                update_data['monthly_income_currency'] = dc
            except ValueError:
                flash('Monthly income must be a number.', 'danger')

        if usual_income_date:
            try:
                day = int(usual_income_date)
                if 1 <= day <= 31:
                    update_data['usual_income_date'] = day
                else:
                    flash('Usual income date must be between 1 and 31.', 'danger')
            except ValueError:
                flash('Usual income date must be a number between 1 and 31.', 'danger')

        if occupation is not None:
            update_data['occupation'] = occupation.strip()

        if default_currency:
            new_dc = default_currency.upper()
            old_dc = (user.get('default_currency') or app.config['DEFAULT_CURRENCY']).upper()
            update_data['default_currency'] = new_dc
            # If currency actually changes, migrate existing amounts
            if new_dc != old_dc:
                # Convert stored monthly_income if not explicitly provided above
                if 'monthly_income' not in update_data and user.get('monthly_income') is not None:
                    try:
                        update_data['monthly_income'] = currency_service.convert_amount(float(user['monthly_income']), old_dc, new_dc)
                        update_data['monthly_income_currency'] = new_dc
                    except Exception:
                        pass
                # Migrate all transactions to new base currency
                try:
                    cursor = mongo.db.transactions.find({'user_id': current_user.id})
                    for tx in cursor:
                        amt = float(tx.get('amount', 0))
                        tx_base = (tx.get('base_currency') or old_dc).upper()
                        new_amt = currency_service.convert_amount(amt, tx_base, new_dc)
                        mongo.db.transactions.update_one(
                            {'_id': tx['_id']},
                            {'$set': {'amount': new_amt, 'base_currency': new_dc}}
                        )
                except Exception:
                    # Non-fatal; user can refresh to retry
                    pass

        if update_data:
            mongo.db.users.update_one(
                {'_id': ObjectId(current_user.id)},
                {'$set': update_data}
            )
            flash('Profile updated successfully.', 'success')
            return redirect(url_for('profile'))

    return render_template('profile.html', user=user)


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
                           ai_analysis=ai_analysis)

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
    return render_template('purchase_advisor.html')

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
        show_details=show_details
    ), status_code

# ---------------------- LOANS ROUTES ----------------------
@app.route('/loans')
@login_required
def loans():
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('index'))
    items = Loan.list_user_loans(current_user.id, mongo.db, include_closed=True)
    return render_template('loans.html', loans=items)


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