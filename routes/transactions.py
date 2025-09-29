from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify
from flask_login import login_required, current_user
from bson import ObjectId
from datetime import datetime, timedelta, timezone
from models.transaction import Transaction, TRANSACTION_CATEGORIES
from models.loan import Loan
from utils.currency import currency_service
from services.transaction_service import TransactionService
from schemas.transaction import TransactionCreate, TransactionPatch
from core.errors import ValidationError, NotFoundError
from pydantic import ValidationError as PydValidationError
from core.response import json_success, json_error
from utils.finance_calculator import calculate_monthly_summary
from utils.timezone_utils import now_utc
from flask import current_app as app


def init_transactions_blueprint(mongo):
    bp = Blueprint('transactions_routes', __name__)

    @bp.route('/transactions')
    @login_required
    def transactions():
        page = request.args.get('page', 1, type=int)
        per_page = 10
        txs = Transaction.get_user_transactions(current_user.id, mongo.db, page, per_page)
        total_transactions = Transaction.count_user_transactions(current_user.id, mongo.db)
        user_doc = mongo.db.users.find_one({'_id': ObjectId(current_user.id)})
        from utils.request_metrics import summary as metrics_summary
        return render_template('transactions.html',
                               transactions=txs,
                               page=page,
                               per_page=per_page,
                               total_transactions=total_transactions,
                               tx_categories=TRANSACTION_CATEGORIES,
                               user_language=(user_doc or {}).get('language','en'),
                               perf_metrics=metrics_summary())

    @bp.route('/transactions/add', methods=['POST'])
    @login_required
    def add_transaction():
        amount_raw = request.form.get('amount')
        input_currency_code = request.form.get('currency')
        try:
            amount = float(amount_raw) if amount_raw is not None else None
        except (TypeError, ValueError):
            amount = None
        if amount is None:
            flash('Invalid amount.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        if amount <= 0:
            flash('Amount must be positive.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        transaction_type = (request.form.get('type') or '').lower().strip()
        if transaction_type not in {'income', 'expense'}:
            flash('Invalid transaction type.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        category = (request.form.get('category') or '').lower().strip()
        if not Transaction.is_valid_category(transaction_type, category):
            flash('Invalid category for selected type.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        description = request.form.get('description')
        date_str = request.form.get('date')
        related_person = request.form.get('related_person', '')
        if not description or len(description.strip()) < 3:
            flash('Please provide a more descriptive description.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
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
            return redirect(url_for('transactions_routes.transactions'))
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
        return redirect(url_for('transactions_routes.transactions'))

    @bp.route('/transactions/<transaction_id>/edit', methods=['POST'])
    @login_required
    def edit_transaction(transaction_id):
        try:
            oid = ObjectId(transaction_id)
        except Exception:
            flash('Invalid transaction id.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        tx = Transaction.get_transaction(current_user.id, oid, mongo.db)
        if not tx:
            flash('Transaction not found.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        amount_raw = request.form.get('amount')
        try:
            amount_val = float(amount_raw) if amount_raw is not None else None
        except (TypeError, ValueError):
            amount_val = None
        if amount_val is None or amount_val <= 0:
            flash('Invalid amount.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        currency_code = (request.form.get('currency') or tx.get('currency') or '').upper() or app.config['DEFAULT_CURRENCY']
        t_type = (request.form.get('type') or tx.get('type') or '').lower()
        if t_type not in {'income', 'expense'}:
            flash('Invalid type.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        category = request.form.get('category') or tx.get('category') or ''
        description = (request.form.get('description') or tx.get('description') or '').strip()
        if len(description) < 3:
            flash('Description too short.', 'danger')
            return redirect(url_for('transactions_routes.transactions'))
        date_str = request.form.get('date')
        if date_str and len(date_str) == 10:
            try:
                date_val = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            except ValueError:
                date_val = tx.get('date')
        else:
            date_val = tx.get('date')
        related_person = request.form.get('related_person', tx.get('related_person', ''))
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
        try:
            if (category or '').lower() in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'} and related_person:
                Loan.recompute_counterparty(current_user.id, mongo.db, related_person)
        except Exception as e:
            app.logger.error(f"Loan recompute failed after edit {transaction_id}: {e}")
        flash('Transaction saved', 'success')
        return redirect(url_for('transactions_routes.transactions'))

    @bp.route('/transactions/<transaction_id>/delete', methods=['POST'])
    @login_required
    def delete_transaction(transaction_id):
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
        return redirect(url_for('transactions_routes.transactions'))

    # JSON / API endpoints
    @bp.route('/api/transactions', methods=['GET'])
    @login_required
    def api_transactions():
        # Return a lightweight transaction representation for API consumers.
        proj = {
            'amount': 1,
            'amount_original': 1,
            'currency': 1,
            'base_currency': 1,
            'type': 1,
            'category': 1,
            'description': 1,
            'date': 1,
            'related_person': 1,
            'created_at': 1,
        }
        txs = list(mongo.db.transactions.find({'user_id': current_user.id}, proj).sort('date', -1))
        # Convert ObjectId to string for JSON serialization
        out = []
        for t in txs:
            t = dict(t)
            if '_id' in t:
                t['_id'] = str(t['_1d'] if '_1d' in t else t['_id'])
            out.append(t)
        return jsonify(out)

    @bp.route('/api/transactions/list', methods=['GET'])
    @login_required
    def api_transactions_list():
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 10, type=int)
        if per_page > 100:
            per_page = 100
        # Use a lightweight projection to avoid transferring heavy fields
        proj = {
            'amount': 1,
            'amount_original': 1,
            'currency': 1,
            'base_currency': 1,
            'type': 1,
            'category': 1,
            'description': 1,
            'date': 1,
            'related_person': 1,
            'created_at': 1,
        }
        skip = (page - 1) * per_page
        cursor = mongo.db.transactions.find({'user_id': current_user.id}, proj).sort([('date', -1), ('created_at', -1)]).skip(skip).limit(per_page)
        txs = list(cursor)
        total = Transaction.count_user_transactions(current_user.id, mongo.db)
        items = []
        for t in txs:
            t = dict(t)
            if '_id' in t:
                t['_id'] = str(t['_id'])
            items.append(t)
        return jsonify({'items': items,'total': total,'page': page,'per_page': per_page})

    @bp.route('/api/transactions', methods=['POST'])
    @login_required
    def api_create_transaction():
        data = request.get_json(force=True, silent=True) or {}
        try:
            payload = TransactionCreate(**data)
        except PydValidationError as ve:
            errs = [{'field': '.'.join(str(x) for x in e['loc']), 'msg': e['msg'], 'type': e.get('type')} for e in ve.errors()]
            app.logger.info(f"Transaction create validation failed payload={data} errors={errs}")
            return json_error("Validation failed", details=errs, status=400)
        service = TransactionService(mongo.db)
        try:
            tx_doc, monthly_summary, lifetime = service.create(current_user.id, payload)
        except ValidationError as ve:
            return json_error(str(ve), status=400)
        except Exception as e:
            app.logger.error(f"Transaction create failed: {e}")
            return json_error("Internal error", code="internal_error", status=500)
        payload_resp = {'item': tx_doc,'monthly_summary': monthly_summary,'lifetime': lifetime}
        return json_success(payload_resp)

    @bp.route('/api/transactions/<transaction_id>', methods=['PATCH'])
    @login_required
    def api_update_transaction(transaction_id):
        try:
            oid = ObjectId(transaction_id)
        except Exception:
            return json_error("Invalid id", status=400)
        data = request.get_json(silent=True) or {}
        if '_id' in data:
            data.pop('_id', None)
        dval = data.get('date')
        if isinstance(dval, str) and len(dval) == 10:
            data['date'] = dval.strip()
        elif dval in {'', None}:
            data['date'] = None
        try:
            patch_payload = TransactionPatch(**data)
        except Exception as e:
            return json_error("Validation failed", details=str(e), status=400)
        svc = TransactionService(mongo.db)
        try:
            updated, monthly_summary, lifetime = svc.patch(current_user.id, oid, patch_payload)
        except NotFoundError:
            return json_error("Not found", status=404)
        except ValidationError as ve:
            return json_error(str(ve), status=400)
        except Exception as e:
            app.logger.error(f"Transaction patch failed: {e}")
            return json_error("Internal error", code="internal_error", status=500)
        return json_success({'item': updated, 'monthly_summary': monthly_summary, 'lifetime': lifetime})

    @bp.route('/api/transactions/<transaction_id>', methods=['DELETE'])
    @login_required
    def api_delete_transaction(transaction_id):
        try:
            oid = ObjectId(transaction_id)
        except Exception:
            return json_error("Invalid id", status=400)
        svc = TransactionService(mongo.db)
        try:
            _, monthly_summary, lifetime = svc.delete(current_user.id, oid)
        except NotFoundError:
            return json_error("Not found", status=404)
        except Exception as e:
            app.logger.error(f"Transaction delete failed: {e}")
            return json_error("Internal error", code="internal_error", status=500)
        return json_success({'success': True, 'monthly_summary': monthly_summary, 'lifetime': lifetime})

    @bp.route('/api/summary', methods=['GET'])
    @login_required
    def api_summary():
        summary = calculate_monthly_summary(current_user.id, mongo.db)
        return jsonify(summary)

    return bp
