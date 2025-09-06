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
        loans = Loan.list_user_loans(current_user.id, mongo.db, include_closed=include_closed)
        out = []
        for l in loans:
            d = dict(l)
            if d.get('_id'):
                d['_id'] = str(d['_id'])
            out.append(d)
        return jsonify({'items': out})

    @bp.route('/api/loans/counterparties')
    @login_required
    def api_loan_counterparties():
        from flask import request
        kind = request.args.get('kind')
        names = Loan.list_open_counterparties(current_user.id, mongo.db, kind=kind)
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
