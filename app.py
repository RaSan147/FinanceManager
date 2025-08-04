import asyncio
import os
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
from utils.finance_calculator import calculate_monthly_summary, calculate_goal_progress, calculate_total_balance
from config import Config

app = Flask(__name__)
app.config.from_object(Config)

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
    return User(user_data)

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
    # Get recent transactions
    recent_transactions = Transaction.get_recent_transactions(current_user.id, mongo.db)
    
    # Get active goals
    active_goals = Goal.get_active_goals(current_user.id, mongo.db)
    
    # Calculate monthly summary
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    
    # Add progress to each goal
    for goal in active_goals:
        goal['progress'] = calculate_goal_progress(goal, monthly_summary)

    current_balance = calculate_total_balance(current_user.id, mongo.db)
    
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
    days_until_income = None

    if user.get('next_income_date'):
        delta = user['next_income_date'] - datetime.utcnow()
        days_until_income = max(delta.days, 0)

    return render_template(
        'index.html', 
        transactions=recent_transactions,
        goals=active_goals,
        summary=monthly_summary,
        balance=current_balance,
        days_until_income=days_until_income
    )

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        
        user_data = mongo.db.users.find_one({'email': email})
        if user_data and bcrypt.check_password_hash(user_data['password'], password):
            user = User(user_data)
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

# New API Endpoints
@app.route('/api/ai/purchase-advice', methods=['POST'])
@login_required
def get_purchase_advice():
    data = request.json
    advice = asyncio.run(spending_advisor.evaluate_purchase(current_user.id, data))
    return jsonify(advice)

@app.route('/api/goals/prioritized')
@login_required
def get_prioritized_goals():
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
        amount = float(request.form.get('amount'))
        transaction_type = request.form.get('type')
        category = request.form.get('category')
        description = request.form.get('description')
        date_str = request.form.get('date')
        related_person = request.form.get('related_person', '')
        
        try:
            date = datetime.strptime(date_str, '%Y-%m-%d')
        except ValueError:
            date = datetime.utcnow()
        
        transaction_data = {
            'user_id': current_user.id,
            'amount': amount,
            'type': transaction_type,
            'category': category,
            'description': description,
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
    goals = Goal.get_user_goals(current_user.id, mongo.db)
    
    # Calculate monthly summary for progress calculation
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    
    # Add progress to each goal
    for goal in goals:
        goal['progress'] = calculate_goal_progress(goal, monthly_summary)
    
    return render_template('goals.html', goals=goals)

@app.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})

    if request.method == 'POST':
        monthly_income = request.form.get('monthly_income')
        next_income_date = request.form.get('next_income_date')

        update_data = {}
        if monthly_income:
            try:
                update_data['monthly_income'] = float(monthly_income)
            except ValueError:
                flash('Monthly income must be a number.', 'danger')

        if next_income_date:
            try:
                update_data['next_income_date'] = datetime.strptime(next_income_date, '%Y-%m-%d')
            except ValueError:
                flash('Invalid date format.', 'danger')

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
        goal['progress'] = calculate_goal_progress(goal, monthly_summary)

    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})

    # Use cached analysis if available
    ai_analysis = user.get('ai_analysis')

    return render_template('analysis.html',
                           summary=monthly_summary,
                           goals=goals,
                           ai_analysis=ai_analysis)

@app.route('/analysis/run', methods=['POST'])
@login_required
def run_ai_analysis():
    monthly_summary = calculate_monthly_summary(current_user.id, mongo.db)
    goals = Goal.get_active_goals(current_user.id, mongo.db)
    user = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})

    ai_analysis = get_ai_analysis(monthly_summary, goals, user)

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

if __name__ == '__main__':
    app.run(debug=True)