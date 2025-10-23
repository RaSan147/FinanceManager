"""Pydantic models & enums for Transaction domain (initial slice).

NOTE: Legacy dict-based handling still exists; this schema only covers create
and patch flows for the refactored /api/transactions POST endpoint.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional, Literal
from pydantic import BaseModel, Field, field_validator


class TransactionCreate(BaseModel):
    """Incoming create payload.

    date: optional date-only (YYYY-MM-DD) from client; converted to UTC midnight.
    """
    amount: float = Field(..., gt=0)
    currency: str | None = None
    type: Literal["income", "expense"]
    # Category (enum from predefined list) but enforce upper length safety (120 chars)
    category: str = Field(..., min_length=1, max_length=120)
    description: str = Field(..., min_length=3, max_length=512)
    # Accept raw date string (YYYY-MM-DD) via alias 'date'; parsed in service.
    date_input: Optional[str] = Field(default=None, alias='date')
    related_person: Optional[str] = Field(default=None, max_length=120)

    # Coerce case / trim
    @field_validator('type')
    @classmethod
    def _norm_type(cls, v):
        if isinstance(v, str):
            v = v.lower().strip()
        return v

    @field_validator('category')
    @classmethod
    def _norm_category(cls, v):
        if isinstance(v, str):
            v = v.strip()
        return v

    @field_validator('description')
    @classmethod
    def _trim_desc(cls, v):
        return v.strip()

    model_config = {'extra': 'ignore', 'populate_by_name': True}

    @field_validator("currency")
    @classmethod
    def _upper(cls, v):  # noqa: D401
        return v.upper() if isinstance(v, str) else v


class TransactionOut(BaseModel):
    id: str = Field(..., alias="_id")
    user_id: str
    amount: float
    amount_original: float
    currency: str
    base_currency: str
    type: str
    category: str
    description: str
    date: datetime
    related_person: str | None = None
    created_at: datetime

    class Config:
        populate_by_name = True


class TransactionPatch(BaseModel):
    """Partial update payload (PATCH).

    All fields optional; validation applied only if provided.
    date is date-only (YYYY-MM-DD) if sent.
    """
    amount: Optional[float] = Field(default=None, gt=0)
    currency: Optional[str] = None
    type: Optional[Literal["income", "expense"]] = None
    category: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, min_length=3, max_length=512)
    # Accept date, datetime, or ISO date string; normalize to date
    date: Optional[date | datetime | str] = None
    related_person: Optional[str] = Field(default=None, max_length=120)

    # Allow string date (YYYY-MM-DD) in patch payloads
    @field_validator('date', mode='before')
    @classmethod
    def _parse_date(cls, v):
        from datetime import datetime as _dt, date as _date
        if v is None or v == '':
            return None
        if isinstance(v, _date) and not isinstance(v, datetime):
            return v
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            # Try YYYY-MM-DD first
            try:
                if len(s) == 10:
                    return _dt.strptime(s, '%Y-%m-%d').date()
                # Fallback: full ISO datetime
                return _dt.fromisoformat(s).date()
            except Exception:
                return None
        return None

    @field_validator("currency")
    @classmethod
    def _upper(cls, v):
        return v.upper() if isinstance(v, str) else v

    model_config = {'extra': 'ignore'}


class TransactionRecord(BaseModel):
    """Internal canonical transaction representation stored in Mongo.

    Used for persistence and returned to clients (after adding _id).
    """
    id: Optional[str] = Field(default=None, alias="_id")
    user_id: str
    amount: float
    amount_original: float
    currency: str
    base_currency: str
    type: Literal["income", "expense"]
    category: str
    description: str
    date: datetime
    related_person: str = ''
    created_at: datetime

    @field_validator('currency', 'base_currency')
    @classmethod
    def _upper_codes(cls, v):
        return v.upper()

    @field_validator('category')
    @classmethod
    def _lower_cat(cls, v):
        return v.lower()

    @field_validator('description')
    @classmethod
    def _trim_desc(cls, v):
        return v.strip()

    @field_validator('related_person')
    @classmethod
    def _limit_related(cls, v):
        if not isinstance(v, str):
            return v
        v2 = v.strip()
        return v2[:120]

    class Config:
        populate_by_name = True


__all__ = [
    "TransactionCreate",
    "TransactionOut",
    "TransactionPatch",
    "TransactionRecord",
]
