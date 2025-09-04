import asyncio
import json
import os
import time
import traceback
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from google import genai
from .request_metrics import record_ai_call


# --- Configuration -----------------------------------------------------------
DEFAULT_MODEL_CANDIDATES: list[str] = [
    "gemini-2.5-flash-lite",  # frequent, light queries
    "gemini-2.5-flash",       # reasoning-heavy queries
    "gemini-2.0-flash",       # big data imports
    "gemini-2.5-pro",         # rare deep reasoning
    "gemini-2.0-flash-lite",  # last-resort fallback
]

# --- Core Engine -------------------------------------------------------------
@dataclass
class _RetryPolicy:
    max_retries: int = 3
    base_delay_s: float = 1.0  # exponential backoff base


class FinancialBrain:
    """Thin, centralized wrapper around Gemini client with:
    - lazy model validation/selection with env override (GEMINI_MODEL)
    - unified sync/async request helpers
    - consistent markdown fence stripping
    - JSON-safe helpers with robust fallbacks
    """

    def __init__(self, api_key: Optional[str] = None,
                 model_candidates: Optional[Iterable[str]] = None,
                 retry: _RetryPolicy = _RetryPolicy()):
        api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.client = genai.Client(api_key=api_key) if api_key else None

        override = os.getenv("GEMINI_MODEL")
        base_candidates = list(model_candidates) if model_candidates else list(DEFAULT_MODEL_CANDIDATES)
        self.model_candidates: list[str] = ([override] if override else []) + base_candidates
        # de-dup while keeping order
        seen = set()
        self.model_candidates = [m for m in self.model_candidates if not (m in seen or seen.add(m))]

        self._validated_model: Optional[str] = None
        self.retry = retry

    # ----------------- Utility helpers -----------------
    @staticmethod
    def strip_fences(text: str, md_type: str = "json") -> str:
        if not isinstance(text, str):
            return text
        start = f"```{md_type}\n"
        end = "```"
        if text.startswith(start):
            text = text[len(start):]
        if text.endswith(end):
            text = text[: -len(end)]
        return text.strip()

    # ----------------- Model selection -----------------
    def _ensure_model(self) -> str:
        if self._validated_model:
            return self._validated_model
        if not self.client:
            # No API key -> operate in degraded mode; callers should handle this
            self._validated_model = "(no-client)"
            return self._validated_model

        last_err: Exception | None = None
        for name in self.model_candidates:
            try:
                resp = self.client.models.generate_content(model=name, contents="ping")
                if getattr(resp, "text", None) is not None:
                    self._validated_model = name
                    return name
            except Exception as e:  # continue through candidates
                last_err = e
                continue
        # If nothing works, record a reason and keep symbolic name to prevent None usage
        self._validated_model = f"(unavailable:{last_err})"
        return self._validated_model

    # ----------------- Low-level request helpers -----------------
    def _call(self, prompt: str) -> str:
        model = self._ensure_model()
        returning = None
        t0 = time.perf_counter()

        if model.startswith("(no-client)"):
            raw = "AI analysis unavailable (missing GEMINI_API_KEY)."
            dt = (time.perf_counter() - t0) * 1000.0
            try:
                record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(raw))
            except Exception:
                pass
            return raw
        if model.startswith("(unavailable:"):
            raw = f"AI analysis unavailable {model}."
            dt = (time.perf_counter() - t0) * 1000.0
            try:
                record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(raw))
            except Exception:
                pass
            return raw

        delay = self.retry.base_delay_s
        for attempt in range(self.retry.max_retries):
            try:
                resp = self.client.models.generate_content(model=model, contents=prompt)
                returning = (str(getattr(resp, "text", "")).strip() or "(empty AI response)")
                break

            except Exception as e:
                traceback.print_exc()
                if attempt == self.retry.max_retries - 1:
                    returning = f"AI analysis unavailable (error: {e})"
                    break
                time.sleep(delay)
                delay *= 2

        # with open("PROMPT_HISTORY.pug", 'a') as f:
        #     f.write(f"PROMPT:\n{prompt}\n\n")
        #     f.write("=> " * 40 + "\n")
        #     f.write(f"RESPONSE:\n{returning}\n\n\n")
        #     f.write("== " * 40 + "\n\n")

        if returning is not None:
            dt = (time.perf_counter() - t0) * 1000.0
            try:
                record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(str(returning)))
            except Exception:
                pass
            return returning

        raw = "(unreachable)"  # should not reach here
        dt = (time.perf_counter() - t0) * 1000.0
        try:
            record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(raw))
        except Exception:
            pass
        return raw

    async def _acall(self, prompt: str) -> str:
        model = self._ensure_model()
        returning = None
        t0 = time.perf_counter()
        if model.startswith("(no-client)"):
            raw = "AI analysis unavailable (missing GEMINI_API_KEY)."
            dt = (time.perf_counter() - t0) * 1000.0
            try:
                record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(raw))
            except Exception:
                pass
            return raw
        if model.startswith("(unavailable:"):
            raw = f"AI analysis unavailable {model}."
            dt = (time.perf_counter() - t0) * 1000.0
            try:
                record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(raw))
            except Exception:
                pass
            return raw

        delay = self.retry.base_delay_s
        for attempt in range(self.retry.max_retries):
            try:
                resp = self.client.models.generate_content(model=model, contents=prompt)
                returning = (str(getattr(resp, "text", "")).strip() or "(empty AI response)")
                break

            except Exception as e:
                traceback.print_exc()
                if attempt == self.retry.max_retries - 1:
                    returning = f"AI analysis unavailable (error: {e})"
                    break
                await asyncio.sleep(delay)
                delay *= 2

        # with open("PROMPT_HISTORY.pug", 'a') as f:
        #     f.write(f"PROMPT:\n{prompt}\n\n")
        #     f.write("=> " * 40 + "\n")
        #     f.write(f"RESPONSE:\n{returning}\n\n\n")
        #     f.write("== " * 40 + "\n\n")

        if returning is not None:
            dt = (time.perf_counter() - t0) * 1000.0
            try:
                record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(str(returning)))
            except Exception:
                pass
            return returning

        raw = "(unreachable)"  # should not reach here
        dt = (time.perf_counter() - t0) * 1000.0
        try:
            record_ai_call(model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(raw))
        except Exception:
            pass
        return raw

    # ----------------- Public high-level helpers -----------------
    def get_text(self, prompt: str) -> str:
        return self._call(prompt)

    async def aget_text(self, prompt: str) -> str:
        return await self._acall(prompt)

    def get_json(self, prompt: str, fallback: Optional[dict] = None, fence: str = "json") -> dict:
        raw = self._call(prompt)
        clean = self.strip_fences(raw, fence)
        try:
            data = json.loads(clean)
            if isinstance(data, dict):
                return data
            raise ValueError("JSON root is not an object")
        except Exception:
            traceback.print_exc()
            return fallback or {"error": "parse_failure", "raw": clean[:4000]}

    async def aget_json(self, prompt: str, fallback: Optional[dict] = None, fence: str = "json") -> dict:
        raw = await self._acall(prompt)
        clean = self.strip_fences(raw, fence)
        try:
            data = json.loads(clean)
            if isinstance(data, dict):
                return data
            raise ValueError("JSON root is not an object")
        except Exception:
            traceback.print_exc()
            with open("ai_error.log", "a") as f:
                f.write(f"Error parsing JSON from AI PROMPT:\n{prompt}\nRESPONSE:\n{clean}\n\n\n")
                f.write("=" * 40 + "\n")
            return fallback or {"error": "parse_failure", "raw": clean[:4000]}