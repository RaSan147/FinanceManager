"""Custom exception types for service layer.

Services raise these; route handlers translate them via json_error / flashes.
"""
from __future__ import annotations


class ServiceError(Exception):
    """Base service layer exception."""


class ValidationError(ServiceError):
    """Input validation failed."""


class NotFoundError(ServiceError):
    """Entity not found."""


class ConflictError(ServiceError):
    """Conflict (duplicate / invariant violation)."""


__all__ = [
    "ServiceError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
]
