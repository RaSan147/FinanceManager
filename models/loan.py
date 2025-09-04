from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from bson import ObjectId


@dataclass
class Loan:
    """Represents a user's loan either given (someone owes me) or taken (I owe someone).

    Direction semantics:
    - 'given' => user lent out money; outstanding_amount is what the counterparty owes the user
    - 'taken' => user borrowed money; outstanding_amount is what the user owes the counterparty
    Amounts are tracked in the user's base currency to align with analytics.
    """

    user_id: str
    direction: str  # 'given' | 'taken'
    counterparty: str
    principal_amount: float
    outstanding_amount: float
    base_currency: str
    status: str  # 'open' | 'closed'
    created_at: datetime
    closed_at: Optional[datetime] = None
    notes: Optional[str] = None
    transactions: Optional[List[ObjectId]] = None

    @staticmethod
    def _normalize_name(name: Optional[str]) -> Optional[str]:
        if name is None:
            return None
        n = name.strip()
        return n if n else None

    @staticmethod
    def _get_open_loan(db, user_id: str, direction: str, counterparty: str) -> Optional[Dict[str, Any]]:
        return db.loans.find_one({
            'user_id': user_id,
            'direction': direction,
            'counterparty': counterparty,
            'status': 'open'
        })

    @staticmethod
    def _create_new(db, *, user_id: str, direction: str, counterparty: str, amount: float, base_currency: str, tx_id: Optional[ObjectId] = None, notes: Optional[str] = None) -> ObjectId:
        doc = {
            'user_id': user_id,
            'direction': direction,
            'counterparty': counterparty,
            'principal_amount': float(amount),
            'outstanding_amount': float(amount),
            'base_currency': base_currency,
            'status': 'open',
            'created_at': datetime.now(timezone.utc),
            'closed_at': None,
            'notes': [notes] if notes else [],
            'transactions': [tx_id] if tx_id else []
        }
        return db.loans.insert_one(doc).inserted_id

    @staticmethod
    def _append_tx(db, loan_id: ObjectId, tx_id: Optional[ObjectId]):
        if tx_id:
            db.loans.update_one({'_id': loan_id}, {'$addToSet': {'transactions': tx_id}})

    @staticmethod
    def list_user_loans(user_id: str, db, include_closed: bool = True) -> List[Dict[str, Any]]:
        query: Dict[str, Any] = {'user_id': user_id}
        if not include_closed:
            query['status'] = 'open'
        return list(db.loans.find(query).sort([('status', 1), ('created_at', -1)]))

    @staticmethod
    def list_open_counterparties(user_id: str, db, *, kind: Optional[str] = None) -> List[str]:
        """Return counterparties names for open loans.

        kind options:
        - 'repaid_by_me' -> names for loans I have taken ('taken') that I can repay
        - 'repaid_to_me' -> names for loans I have given ('given') that can repay me
        - None/other -> all open counterparties
        """
        direction: Optional[str] = None
        if kind == 'repaid_by_me':
            direction = 'taken'
        elif kind == 'repaid_to_me':
            direction = 'given'

        match: Dict[str, Any] = {'user_id': user_id, 'status': 'open'}
        if direction:
            match['direction'] = direction
        names = db.loans.distinct('counterparty', match)
        # Filter out empty/None
        return sorted([n for n in names if isinstance(n, str) and n.strip()])

    @staticmethod
    def close_loan(loan_id: ObjectId, user_id: str, db, *, note: Optional[str] = None) -> bool:
        update_doc: Dict[str, Any] = {
            '$set': {
                'status': 'closed',
                'closed_at': datetime.now(timezone.utc),
                'outstanding_amount': 0.0
            }
        }
        if note:
            update_doc['$push'] = {'notes': note}
        res = db.loans.update_one({
            '_id': ObjectId(loan_id),
            'user_id': user_id,
            'status': 'open'
        }, update_doc)
        return res.modified_count > 0

    # covered toggle removed

    @staticmethod
    def process_transaction(user_id: str, db, tx: Dict[str, Any], tx_id: Optional[ObjectId] = None) -> None:
        """Update or create loan entries based on a transaction.

        Expected transaction fields:
        - category: 'lent out' | 'borrowed' | 'repaid by me' | 'repaid to me'
        - amount (base currency)
        - base_currency
        - related_person (counterparty)
        - type: 'income' | 'expense' (informational)
        """
        category = (tx.get('category') or '').strip().lower()
        counterparty = Loan._normalize_name(tx.get('related_person'))
        amount = float(tx.get('amount') or 0.0)
        base_currency = (tx.get('base_currency') or 'USD').upper()
        if amount <= 0 or not counterparty:
            return  # Cannot map loan without positive amount and counterparty

        if category == 'lent out':
            # I gave a loan -> direction 'given' increases outstanding
            existing = Loan._get_open_loan(db, user_id, 'given', counterparty)
            if existing:
                db.loans.update_one({'_id': existing['_id']}, {
                    '$inc': {
                        'principal_amount': amount,
                        'outstanding_amount': amount
                    }
                })
                Loan._append_tx(db, existing['_id'], tx_id)
            else:
                Loan._create_new(db, user_id=user_id, direction='given', counterparty=counterparty, amount=amount, base_currency=base_currency, tx_id=tx_id)

        elif category == 'borrowed':
            # I took a loan -> direction 'taken' increases outstanding
            existing = Loan._get_open_loan(db, user_id, 'taken', counterparty)
            if existing:
                db.loans.update_one({'_id': existing['_id']}, {
                    '$inc': {
                        'principal_amount': amount,
                        'outstanding_amount': amount
                    }
                })
                Loan._append_tx(db, existing['_id'], tx_id)
            else:
                Loan._create_new(db, user_id=user_id, direction='taken', counterparty=counterparty, amount=amount, base_currency=base_currency, tx_id=tx_id)

        elif category == 'repaid by me':
            # I repay to counterparty -> reduce 'taken' loan
            existing = Loan._get_open_loan(db, user_id, 'taken', counterparty)
            if existing:
                new_out = max(0.0, float(existing.get('outstanding_amount', 0.0)) - amount)
                updates: Dict[str, Any] = {
                    '$set': {'outstanding_amount': new_out}
                }
                if tx_id:
                    updates['$addToSet'] = {'transactions': tx_id}
                db.loans.update_one({'_id': existing['_id']}, updates)
                if new_out <= 0.00001:
                    db.loans.update_one({'_id': existing['_id']}, {
                        '$set': {'status': 'closed', 'closed_at': datetime.now(timezone.utc), 'outstanding_amount': 0.0}
                    })

        elif category == 'repaid to me':
            # Counterparty repays me -> reduce 'given' loan
            existing = Loan._get_open_loan(db, user_id, 'given', counterparty)
            if existing:
                new_out = max(0.0, float(existing.get('outstanding_amount', 0.0)) - amount)
                updates: Dict[str, Any] = {
                    '$set': {'outstanding_amount': new_out}
                }
                if tx_id:
                    updates['$addToSet'] = {'transactions': tx_id}
                db.loans.update_one({'_id': existing['_id']}, updates)
                if new_out <= 0.00001:
                    db.loans.update_one({'_id': existing['_id']}, {
                        '$set': {'status': 'closed', 'closed_at': datetime.now(timezone.utc), 'outstanding_amount': 0.0}
                    })

        # ignore other categories

    @staticmethod
    def recompute_counterparty(user_id: str, db, counterparty: str) -> None:
        """Rebuild loan(s) for a counterparty from remaining transactions.

        Computes two independent directions:
        - given: sum('lent out') - sum('repaid to me')
        - taken: sum('borrowed') - sum('repaid by me')
        Updates or deletes corresponding loan docs accordingly.
        """
        cp = Loan._normalize_name(counterparty)
        if not cp:
            return
        cats = ['lent out', 'borrowed', 'repaid by me', 'repaid to me']
        txs = list(db.transactions.find({'user_id': user_id, 'related_person': cp, 'category': {'$in': cats}}))

        def sum_amount(filter_fn):
            s = 0.0
            for t in txs:
                if filter_fn(t):
                    try:
                        s += float(t.get('amount', 0.0))
                    except Exception:
                        pass
            return s

        base_currency = None
        for t in txs:
            bc = t.get('base_currency')
            if isinstance(bc, str) and bc:
                base_currency = bc.upper()
                break
        if not base_currency:
            base_currency = 'USD'

        # given direction
        given_principal = sum_amount(lambda t: (t.get('category') or '').lower() == 'lent out')
        given_repaid = sum_amount(lambda t: (t.get('category') or '').lower() == 'repaid to me')
        given_out = max(0.0, given_principal - given_repaid)
        given_tx_ids = [t['_id'] for t in txs if (t.get('category') or '').lower() in {'lent out', 'repaid to me'}]

        # taken direction
        taken_principal = sum_amount(lambda t: (t.get('category') or '').lower() == 'borrowed')
        taken_repaid = sum_amount(lambda t: (t.get('category') or '').lower() == 'repaid by me')
        taken_out = max(0.0, taken_principal - taken_repaid)
        taken_tx_ids = [t['_id'] for t in txs if (t.get('category') or '').lower() in {'borrowed', 'repaid by me'}]

        # Upsert helper
        def upsert(direction: str, principal: float, outstanding: float, tx_ids: list[ObjectId]):
            if principal <= 0.0 and outstanding <= 0.0 and not tx_ids:
                # Remove any stale loan docs for this direction
                db.loans.delete_many({'user_id': user_id, 'direction': direction, 'counterparty': cp})
                return
            status = 'closed' if outstanding <= 0.00001 else 'open'
            now = datetime.now(timezone.utc)
            db.loans.update_one(
                {'user_id': user_id, 'direction': direction, 'counterparty': cp},
                {
                    '$set': {
                        'principal_amount': float(principal),
                        'outstanding_amount': float(outstanding),
                        'base_currency': base_currency,
                        'status': status,
                        'closed_at': now if status == 'closed' else None,
                        'transactions': tx_ids
                    },
                    '$setOnInsert': {
                        'created_at': now
                    }
                },
                upsert=True
            )

        upsert('given', given_principal, given_out, given_tx_ids)
        upsert('taken', taken_principal, taken_out, taken_tx_ids)
