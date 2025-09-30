"""
Minimal ImageKit uploader with logging.

API:
    upload_image(data: bytes | str, *, name: str = "upload") -> str

Requires environment variables:
    IMAGEKIT_PRIVATE_KEY
    IMAGEKIT_PUBLIC_KEY
    IMAGEKIT_URL_ENDPOINT

Supports input:
    * Raw bytes
    * Base64 string
    * Data URL (data:image/png;base64,...)
    * Local file path

Raises RuntimeError on failure.
"""
from __future__ import annotations

import json
import tempfile
import os, base64, logging
from typing import Union
from imagekitio import ImageKit
from imagekitio.models.UploadFileRequestOptions import UploadFileRequestOptions
from config import Config

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)  # set to INFO/ERROR in production

_client: ImageKit | None = None


def _get_client() -> ImageKit:
    global _client
    if _client:
        return _client

    pk = Config.IMAGEKIT_PRIVATE_KEY
    pub = Config.IMAGEKIT_PUBLIC_KEY
    endpoint = Config.IMAGEKIT_URL_ENDPOINT

    if not (pk and pub and endpoint):
        logger.error("Missing IMAGEKIT_* environment variables")
        raise RuntimeError("Missing IMAGEKIT_* environment variables")

    logger.debug("Initializing ImageKit client with endpoint=%s", endpoint)
    _client = ImageKit(private_key=pk, public_key=pub, url_endpoint=endpoint)
    return _client


def _to_bytes(data: Union[bytes, str]) -> bytes:
    """Normalize input into raw bytes."""
    if isinstance(data, bytes):
        logger.debug("Input is raw bytes (len=%d)", len(data))
        return data

    s = str(data).strip()

    if os.path.isfile(s):
        logger.debug("Input is file path: %s", s)
        with open(s, "rb") as f:
            return f.read()

    if s.startswith("data:image") and ";base64," in s:
        logger.debug("Input is data URL")
        return base64.b64decode(s.split(";base64,", 1)[1], validate=True)

    try:
        logger.debug("Attempting to decode input as base64 string")
        return base64.b64decode(s, validate=True)
    except Exception as e:
        logger.error("Unsupported image format: %s", e, exc_info=True)
        raise RuntimeError("Unsupported image format") from e


def upload_image(data: bytes | str, *, name: str = "upload") -> str:
    client = _get_client()
    file_bytes = _to_bytes(data)

    # need a local path here
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name
        print(f"Temporary file created: {tmp_path}")

        size_mb = len(file_bytes) / (1024 * 1024)
        logger.debug("Prepared image (%.2f MB)", size_mb)

        if len(file_bytes) > 16 * 1024 * 1024:
            logger.error("Image too large: %.2f MB (max 16MB)", size_mb)
            raise RuntimeError("Image too large (max 16MB)")

        try:
            print(f"Uploading image to ImageKit (name={name}, size={size_mb:.2f} MB)")
            with open(tmp_path, "rb") as tmp_file:
                result = client.upload_file(
                    file=tmp_file,
                    file_name=name,
                    options=UploadFileRequestOptions(
                        use_unique_file_name=True,
                        is_private_file=False,
                    )
                )
            logger.info("Upload complete (file_id=%s)", getattr(result, "file_id", None))
        except Exception as e:
            logger.error("Upload failed: %s", e, exc_info=True)
            raise RuntimeError(f"Upload failed: {e}") from e

    url = getattr(result, "url", None) or (result.get("url") if isinstance(result, dict) else None)
    from pprint import pprint
    pprint(vars(result))
    if not url:
        logger.error("Upload succeeded but no URL returned (result=%s)", result)
        raise RuntimeError("Upload succeeded but no URL returned")

    logger.debug("Final URL: %s", url)
    return str(url)
