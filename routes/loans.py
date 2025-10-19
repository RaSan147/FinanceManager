from flask import Blueprint, render_template, jsonify, flash, redirect, url_for
from flask_login import login_required, current_user
from bson import ObjectId
from models.loan import Loan
from utils.request_metrics import summary as metrics_summary

def init_loans_blueprint(mongo):
    bp = Blueprint('loans_bp', __name__)

    @bp.route('/loans', endpoint='loans')
    @login_required
    def loans():
        if mongo.db is None:
            flash('Database connection error.', 'danger')
            return redirect(url_for('dashboard.index'))
        items = Loan.list_user_loans(current_user.id, mongo.db, include_closed=True)
        return render_template('loans.html', loans=items, perf_metrics=metrics_summary())

    @bp.route('/api/loans/list')
    @login_required
    def api_loans_list():
        from flask import request
        include_closed = request.args.get('include_closed', 'true').lower() != 'false'
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 10, type=int)
        if per_page > 100:
            per_page = 100
        # Calculate skip/limit and total count
        skip = (page - 1) * per_page
        total = mongo.db.loans.count_documents({'user_id': current_user.id})
        if not include_closed:
            total = mongo.db.loans.count_documents({'user_id': current_user.id, 'status': 'open'})

        loans = Loan.list_user_loans(current_user.id, mongo.db, include_closed=include_closed)
        # Apply server-side pagination on the returned cursor/list
        # Loan.list_user_loans currently returns a list; slice accordingly
        paged = loans[skip: skip + per_page]
        out = []
        for l in paged:
            d = dict(l)
            if d.get('_id'):
                d['_id'] = str(d['_id'])
            out.append(d)
        return jsonify({'items': out, 'total': total, 'page': page, 'per_page': per_page})

    @bp.route('/api/loans/counterparties')
    @login_required
    def api_loan_counterparties():
        from flask import request
        kind = request.args.get('kind')
        # Prefer ranking by outstanding amount so the most relevant names appear first
        names = Loan.list_open_counterparties_ranked(current_user.id, mongo.db, kind=kind)
        return jsonify({'items': names})

    @bp.route('/api/loans/<loan_id>/close', methods=['POST'])
    @login_required
    def api_close_loan(loan_id):
        from flask import request
        payload = request.get_json(silent=True) or {}
        note = request.form.get('note') or payload.get('note')
        ok = Loan.close_loan(ObjectId(loan_id), current_user.id, mongo.db, note=note)
        if not ok:
            return jsonify({'success': False}), 400
        return jsonify({'success': True})

    return bp
