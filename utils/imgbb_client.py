"""Imgbb image upload helper (imgbbpy only).

Public API: ``upload_image(data: bytes | str, *, name='upload', expire: int = 0) -> str``

Supported input forms:
    * Raw bytes
    * Base64 string
    * data URL (``data:image/png;base64,...``)
    * Local file path

Environment / config keys (first non-empty wins):
    * ``Config.IMGBB_API_KEY``
    * ``IMGBB_API_KEY`` (env)

NO HTTP fallback: imgbbpy must be installed; otherwise an ``ImgbbError`` is raised.
"""
from __future__ import annotations

import base64
import io
import os
import inspect
import tempfile
import pathlib
from typing import Union, List

from config import Config

try:  # Required dependency (user requested no fallback)
    import imgbbpy  # type: ignore
except Exception as e:  # pragma: no cover - explicit
    imgbbpy = None  # type: ignore
    _import_error = e


class ImgbbError(Exception):
    """Domain error raised for all upload failures."""
    pass


_client = None  # lazy singleton for imgbbpy.SyncClient


def _get_api_key() -> str:
    return (
        getattr(Config, 'IMGBB_API_KEY', '')
        or os.getenv('IMGBB_API_KEY', '')
    ).strip()


def _ensure_client():
    global _client
    if _client is not None:
        return _client
    if imgbbpy is None:  # pragma: no cover - dependency missing
        raise ImgbbError(f"imgbbpy not installed: {_import_error}")
    key = _get_api_key()
    if not key:
        raise ImgbbError('IMGBB_API_KEY not configured')
    try:
        _client = imgbbpy.SyncClient(key)  # type: ignore[attr-defined]
        return _client
    except Exception as e:  # pragma: no cover - defensive
        raise ImgbbError('Failed to initialize imgbb client') from e


def _is_probable_base64(s: str) -> bool:
    if len(s) < 16:
        return False
    allowed = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=')
    if any(c not in allowed for c in s.strip()):
        return False
    try:
        base64.b64decode(s, validate=True)
        return True
    except Exception:
        return False


def _extract_bytes(raw: Union[bytes, str]) -> bytes:
    if isinstance(raw, bytes):
        return raw
    s: str = str(raw).strip()
    if os.path.exists(s):
        with open(s, 'rb') as f:
            return f.read()
    if s.startswith('data:image') and ';base64,' in s:
        b64 = s.split(';base64,', 1)[1]
        try:
            return base64.b64decode(b64, validate=True)
        except Exception as e:  # pragma: no cover
            raise ImgbbError('Invalid data URL base64') from e
    if _is_probable_base64(s):
        try:
            return base64.b64decode(s, validate=True)
        except Exception as e:  # pragma: no cover
            raise ImgbbError('Invalid base64 data') from e
    raise ImgbbError('Unsupported image data format')


def _upload_via_imgbbpy(data: bytes | str, *, name: str, expire: int) -> str:
    client = _ensure_client()

    # Decide how to feed the library: file path or file-like object
    file_path_used = False
    temp_path: str | None = None
    if isinstance(data, str) and os.path.exists(data):
        file_arg = data  # existing path
        file_path_used = True
        file_size = os.path.getsize(data)
    else:
        b = _extract_bytes(data)
        file_size = len(b)
        # imgbbpy expects a path (per error), so write bytes to a secure temp file
        # Choose extension heuristically from first bytes (very light)
        suffix = '.bin'
        if b.startswith(b'\x89PNG'):
            suffix = '.png'
        elif b[0:3] == b'\xff\xd8\xff':
            suffix = '.jpg'
        elif b.startswith(b'GIF8'):
            suffix = '.gif'
        fd, temp_path = tempfile.mkstemp(prefix='imgbb_', suffix=suffix)
        with os.fdopen(fd, 'wb') as tmpf:
            tmpf.write(b)
        file_arg = temp_path

    # Basic size guard (imgbb limit typically 32MB)
    max_bytes = 16 * 1024 * 1024  # Enforced global limit (match frontend todos.js validation)
    if file_size > max_bytes:
        raise ImgbbError(f'Image too large ({file_size} bytes > {max_bytes} limit)')

    # Introspect supported parameters for upload to avoid unexpected kw errors
    supported: List[str] = []
    try:
        sig = inspect.signature(client.upload)  # type: ignore[attr-defined]
        supported = list(sig.parameters.keys())
    except Exception:
        pass  # graceful fallback

    kwargs = {'file': file_arg}
    if 'name' in supported:
        kwargs['name'] = name  # type: ignore
    if expire and ('expiration' in supported or 'expire' in supported):
        # Prefer 'expiration'
        if 'expiration' in supported:
            kwargs['expiration'] = expire  # type: ignore
        else:
            kwargs['expire'] = expire  # type: ignore

    try:
        img_obj = client.upload(**kwargs)  # type: ignore[arg-type]
        url = getattr(img_obj, 'url', None)
        if not url:
            raise ImgbbError('Upload returned no URL')
        return str(url)
    except ImgbbError:
        raise
    except Exception as e:  # pragma: no cover - defensive
        # Include root cause text (trim to avoid leaking huge payloads)
        root = str(e)
        if len(root) > 280:
            root = root[:277] + '...'
        debug = os.getenv('IMGBB_DEBUG')
        detail = f'Upload failed (imgbbpy)'
        if debug:
            detail += f': {root}'
            if file_path_used:
                detail += ' [path mode]'
            else:
                detail += ' [in-memory mode]'
        raise ImgbbError(detail) from e
    finally:
        # Clean temp file
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass


def upload_image(data: bytes | str, *, name: str = 'upload', expire: int = 0) -> str:
    """Upload image data to imgbb (requires imgbbpy) and return the public URL.

    Set env ``IMGBB_DEBUG=1`` to include underlying exception text in errors.
    """
    return _upload_via_imgbbpy(data, name=name, expire=expire)


__all__ = ['upload_image', 'ImgbbError']
