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
from datetime import datetime, timedelta
from bson import ObjectId
import json
from models.user import User
from models.transaction import Transaction
from models.goal import Goal
from utils.ai_helper import get_ai_analysis, get_goal_plan
from utils.finance_calculator import calculate_monthly_summary,  calculate_lifetime_transaction_summary
from utils.tools import is_allowed_email
from config import Config

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
login_manager.login_view = 'login'

@app.context_processor
def inject_now():
    return {'now': datetime.utcnow()}

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
            return o.isoformat()
        return json.JSONEncoder.default(self, o)

app.json_encoder = JSONEncoder

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
    active_goals = Goal.get_active_goals(current_user.id, mongo.db)
    
    # Calculate monthly summary
    monthly_summary = user_obj.get_recent_income_expense(months=1)[0]

    # Calculate complete financial picture
    full_balance = user_obj.get_lifetime_transaction_summary()

    # Add progress to each goal
    for goal in active_goals:
        goal['progress'] = Goal.calculate_goal_progress(goal, monthly_summary)

    days_until_income = None
    # Calculate days until usual income date (if set)
    if user.get('usual_income_date'):
        today = datetime.utcnow().day
        income_day = int(user['usual_income_date'])
        if today <= income_day:
            days_until_income = income_day - today
        else:
            # Next month
            from calendar import monthrange
            now = datetime.utcnow()
            last_day = monthrange(now.year, now.month)[1]
            days_until_income = (last_day - today) + income_day

    print(active_goals)

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
            'created_at': datetime.utcnow()
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
from utils.ai_priority_engine import FinancialBrain
from utils.ai_spending_advisor import SpendingAdvisor

# Initialize AI components
ai_engine = FinancialBrain(app.config["GEMINI_API_KEY"])
spending_advisor = SpendingAdvisor(ai_engine, mongo.db)

@app.route('/api/goals/prioritized')
@login_required
def get_prioritized_goals():
    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return {"error": "Database connection error."}

    goals = Goal.get_prioritized(current_user.id, mongo.db)
    return jsonify(goals)

# Modified Goal Creation
@app.route('/goals/add', methods=['POST'])
@login_required
def add_goal():
    goal_data = {
        'user_id': current_user.id,
        'type': request.form.get('goal_type'),
        'target_amount': float(request.form.get('target_amount')),
        'description': request.form.get('description'),
        'target_date': datetime.strptime(
            request.form.get('target_date'), 
            '%Y-%m-%d'
        ),
        'created_at': datetime.utcnow(),
        'is_completed': False
    }

    if mongo.db is None:
        flash('Database connection error.', 'danger')
        return redirect(url_for('goals'))

    asyncio.run(Goal.create_with_ai(goal_data, mongo.db, ai_engine))
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
        try:
            amount = float(request.form.get('amount'))
        except (TypeError, ValueError):
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
        try:
            date = datetime.strptime(date_str, '%Y-%m-%d')
        except ValueError:
            date = datetime.utcnow()

        transaction_data = {
            'user_id': current_user.id,
            'amount': amount,
            'type': transaction_type,
            'category': category,
            'description': description.strip(),
            'date': date,
            'related_person': related_person,
            'created_at': datetime.utcnow()
        }

        Transaction.create_transaction(transaction_data, mongo.db)
        flash('Transaction added successfully.', 'success')
        return redirect(url_for('transactions'))

    return render_template('add_transaction.html')


@app.route('/transactions/<transaction_id>/delete', methods=['POST'])
@login_required
def delete_transaction(transaction_id):
    Transaction.delete_transaction(current_user.id, ObjectId(transaction_id), mongo.db)
    flash('Transaction deleted successfully.', 'success')
    return redirect(url_for('transactions'))

# Goals routes
@app.route('/goals')
@login_required
def goals():
    page = int(request.args.get('page', 1))
    per_page = 5  # You can adjust this as needed
    skip = (page - 1) * per_page
    total_goals = mongo.db.goals.count_documents({'user_id': current_user.id})
    goals = list(mongo.db.goals.find({'user_id': current_user.id})
                .sort('target_date', 1)
                .skip(skip)
                .limit(per_page))

    # Calculate monthly summary for progress calculation
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)

    # Add progress to each goal
    for goal in goals:
        goal['progress'] = Goal.calculate_goal_progress(goal, monthly_summary)

    total_pages = (total_goals + per_page - 1) // per_page

    return render_template('goals.html', goals=goals, page=page, total_pages=total_pages)

@app.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})


    if request.method == 'POST':
        monthly_income = request.form.get('monthly_income')
        usual_income_date = request.form.get('usual_income_date')
        occupation = request.form.get('occupation')

        update_data = {}
        if monthly_income:
            try:
                update_data['monthly_income'] = float(monthly_income)
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
    Goal.mark_as_completed(current_user.id, ObjectId(goal_id), mongo.db)
    flash('Goal marked as completed.', 'success')
    return redirect(url_for('goals'))

@app.route('/goals/<goal_id>/delete', methods=['POST'])
@login_required
def delete_goal(goal_id):
    Goal.delete_goal(current_user.id, ObjectId(goal_id), mongo.db)
    flash('Goal deleted successfully.', 'success')
    return redirect(url_for('goals'))

# Analysis routes
@app.route('/analysis')
@login_required
def analysis():
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    goals = Goal.get_active_goals(current_user.id, mongo.db)

    for goal in goals:
        goal['progress'] = Goal.calculate_goal_progress(goal, monthly_summary)

    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})

    print(goals)

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

    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    goals = Goal.get_active_goals(current_user.id, mongo.db)
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    user_obj = User(user, db=mongo.db)
    ai_analysis = get_ai_analysis(monthly_summary, goals, user_obj)

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

        # Prepare data for AI and DB
        item_data = {
            'description': data['description'],
            'amount': amount,
            'category': data.get('category'),
            'tags': data.get('tags', []),
            'urgency': data.get('urgency')
        }

        app.logger.info(f"Calling spending_advisor.evaluate_purchase for user {user_id} with item_data: {item_data}")
        advice = spending_advisor.evaluate_purchase(user_id, item_data)
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
            'created_at': {'$gte': datetime.utcnow() - timedelta(days=30)}
        }),
        'ignored_count': mongo.db.purchase_advice.count_documents({
            'user_id': current_user.id,
            'user_action': 'ignored',
            'created_at': {'$gte': datetime.utcnow() - timedelta(days=30)}
        })
    }

    # Category breakdown
    categories = PurchaseAdvice.get_stats(current_user.id, mongo.db)

    # Trend data (weekly spending)
    trend = []
    for i in range(4):
        week_start = datetime.utcnow() - timedelta(weeks=(4-i))
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
        if 'request' in advice and 'amount' in advice['request']:
            try:
                advice['request']['amount'] = float(advice['request']['amount'])
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

if __name__ == '__main__':
    app.run(debug=True)