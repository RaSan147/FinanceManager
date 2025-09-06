"""Business logic layer for transactions (initial create slice).

Over time, move edit/delete/list logic here. For now focuses on create flow.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Tuple, Any
from bson import ObjectId

from schemas.transaction import TransactionCreate, TransactionPatch, TransactionRecord
from core.errors import ValidationError, NotFoundError
from repositories.transaction_repo import TransactionRepository
from utils.currency import currency_service
from utils.timezone_utils import now_utc
from utils.finance_calculator import calculate_monthly_summary, calculate_lifetime_transaction_summary
from models.transaction import TRANSACTION_CATEGORIES
from models.loan import Loan


class TransactionService:
    """Transaction domain operations (create, patch, delete).

    Keeps all business rules and side-effects (loans, summaries) centralized.
    """

    def __init__(self, db):
        self.repo = TransactionRepository(db)
        self._db = db

    # ---- Helpers ----
    def _user_currencies(self, user_id: str) -> tuple[str, str]:
        doc = self._db.users.find_one({'_id': ObjectId(user_id)}) or {}
        base = (doc.get('default_currency') or 'USD').upper()
        return base, base

    def _validate_category(self, tx_type: str, category: str):
        if category.lower() not in TRANSACTION_CATEGORIES.get(tx_type, {}):
            raise ValidationError("Invalid category for type")

    # ---- Public API ----
    def create(self, user_id: str, payload: TransactionCreate) -> Tuple[dict, dict, dict]:
        self._validate_category(payload.type, payload.category)
        base_currency, _ = self._user_currencies(user_id)
        input_currency = (payload.currency or base_currency).upper()
        converted = currency_service.convert_amount(payload.amount, input_currency, base_currency)
        # Parse date (payload.date_input may be YYYY-MM-DD) else now
        if payload.date_input:
            try:
                dt = datetime.strptime(payload.date_input, '%Y-%m-%d')
                date_val = dt.replace(tzinfo=timezone.utc)
            except Exception:
                date_val = now_utc()
        else:
            date_val = now_utc()
        record = TransactionRecord(
            user_id=user_id,
            amount=converted,
            amount_original=payload.amount,
            currency=input_currency,
            base_currency=base_currency,
            type=payload.type,
            category=payload.category,
            description=payload.description,
            date=date_val,
            related_person=payload.related_person or '',
            created_at=now_utc()
        )
        doc = record.model_dump(by_alias=True, exclude_none=True)
        tx_id = self.repo.insert(doc)
        try:
            Loan.process_transaction(user_id, self._db, doc, tx_id)
        except Exception:
            pass
        record.id = str(tx_id)  # type: ignore[attr-defined]
        return record.model_dump(by_alias=True), self._monthly(user_id), self._lifetime(user_id)

    def patch(self, user_id: str, tx_id: ObjectId, payload: TransactionPatch) -> Tuple[dict, dict, dict]:
        existing = self.repo.get_by_id(user_id, tx_id)
        if not existing:
            raise NotFoundError("Transaction not found")
        update: dict[str, any] = {}
        # Scalar fields
        if payload.description is not None:
            update['description'] = payload.description.strip()
        if payload.related_person is not None:
            update['related_person'] = payload.related_person
        if payload.type is not None:
            if payload.type not in {'income', 'expense'}:
                raise ValidationError("Invalid type")
            update['type'] = payload.type
        if payload.category is not None:
            eff_type_raw = update.get('type', existing.get('type'))
            eff_type = str(eff_type_raw) if eff_type_raw else ''
            self._validate_category(eff_type, payload.category)
            update['category'] = payload.category.lower()
        # Amount / currency
        amount_original = payload.amount if payload.amount is not None else existing.get('amount_original')  # type: ignore[assignment]
        currency_code_raw = payload.currency or existing.get('currency') or existing.get('base_currency') or 'USD'
        currency_code = str(currency_code_raw).upper()
        base_currency_raw = existing.get('base_currency') or currency_code
        base_currency = str(base_currency_raw).upper()
        if payload.amount is not None or payload.currency is not None:
            try:
                amt_float = float(amount_original)  # type: ignore[arg-type]
            except Exception:
                raise ValidationError("Invalid amount")
            converted = currency_service.convert_amount(amt_float, currency_code, base_currency)
            update['amount_original'] = amt_float
            update['currency'] = currency_code
            update['amount'] = converted
        # Date
        if payload.date is not None:
            update['date'] = datetime(payload.date.year, payload.date.month, payload.date.day, tzinfo=timezone.utc)
        if not update:
            return existing, self._monthly(user_id), self._lifetime(user_id)
        updated = self.repo.update_fields(user_id, tx_id, update) or existing
        # Loan recompute if category/related_person loan-impacting
        try:
            cat_eff = update.get('category', existing.get('category', '')).lower()
            rp_eff = update.get('related_person') or existing.get('related_person')
            if cat_eff in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'} and rp_eff:
                Loan.recompute_counterparty(user_id, self._db, rp_eff)
        except Exception:
            pass
        updated['_id'] = str(updated['_id'])
        return updated, self._monthly(user_id), self._lifetime(user_id)

    def delete(self, user_id: str, tx_id: ObjectId) -> Tuple[dict | None, dict, dict]:
        existing = self.repo.get_by_id(user_id, tx_id)
        if not existing:
            raise NotFoundError("Transaction not found")
        self.repo.delete(user_id, tx_id)
        try:
            cat = (existing.get('category') or '').lower()
            if cat in {'lent out', 'borrowed', 'repaid by me', 'repaid to me'}:
                cp = existing.get('related_person')
                if cp:
                    Loan.recompute_counterparty(user_id, self._db, cp)
        except Exception:
            pass
        return None, self._monthly(user_id), self._lifetime(user_id)

    # ---- Summary helpers ----
    def _monthly(self, user_id: str) -> dict:
        return calculate_monthly_summary(user_id, self._db)

    def _lifetime(self, user_id: str) -> dict:
        return calculate_lifetime_transaction_summary(user_id, self._db)


__all__ = ["TransactionService"]
