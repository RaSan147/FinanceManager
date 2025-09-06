import asyncio
import json
import os
import time
import traceback
import random
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
    """Retry configuration.

    max_retries: attempts per model before falling back to the next one.
    base_delay_s: initial delay used for exponential backoff (with jitter).
    """
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

        # Last *successful* model (sticky preference for future calls)
        self._validated_model: Optional[str] = None
        # Per-model next allowed attempt timestamp after quota/backoff events
        self._model_cooldown: dict[str, float] = {}
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
        """Return last known good model or placeholder.

        We no longer perform an upfront 'ping' that consumes quota. Instead
        model validation is implicit during actual generation attempts.
        """
        if self._validated_model:
            return self._validated_model
        if not self.client:
            self._validated_model = "(no-client)"
            return self._validated_model
        # Return the first candidate optimistically; real selection happens in _generate_any.
        return self.model_candidates[0] if self.model_candidates else "(unavailable:no-candidates)"

    # ----------------- Internal retry helpers -----------------
    @staticmethod
    def _extract_retry_delay_seconds(err: Exception) -> Optional[float]:
        """Attempt to parse a server suggested retry delay (e.g. from 429 RetryInfo)."""
        # google.genai errors often include a dict inside args or have .response / .details
        possibles: list[Any] = []
        for part in getattr(err, 'args', []) or []:
            possibles.append(part)
        for attr in ("response", "details", "error", "errors"):
            val = getattr(err, attr, None)
            if val:
                possibles.append(val)
        try:
            for obj in possibles:
                if isinstance(obj, dict):
                    # Look for retryDelay in RPC RetryInfo structure
                    details = obj.get("error", {}).get("details") or obj.get("details")
                    if isinstance(details, list):
                        for d in details:
                            if isinstance(d, dict) and d.get("@type", "").endswith("RetryInfo"):
                                retry_delay = d.get("retryDelay")  # e.g. '18s'
                                if isinstance(retry_delay, str) and retry_delay.endswith('s'):
                                    return float(retry_delay[:-1])
                                if isinstance(retry_delay, (int, float)):
                                    return float(retry_delay)
        except Exception:
            pass
        # Fallback: search string
        s = str(err)
        # pattern like "retryDelay': '18s'"
        import re
        m = re.search(r"retryDelay['\"]?:\s*'?([0-9]+)s" , s)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                return None
        return None

    @staticmethod
    def _is_quota_or_rate_limit(err: Exception) -> bool:
        txt = str(err).upper()
        return "RESOURCE_EXHAUSTED" in txt or "429" in txt or "RATE" in txt

    @staticmethod
    def _is_transient(err: Exception) -> bool:
        txt = str(err).upper()
        # Generic heuristics for retry-worthy errors
        return any(k in txt for k in ["TIMEOUT", "TEMPORARY", "UNAVAILABLE", "INTERNAL", "DEADLINE", "CONNECTION", "RESET"])

    def _log_error(self, model: str, err: Exception, attempt: int, attempt_of_model: int):
        try:
            with open("ai_error.log", "a", encoding="utf-8") as f:
                f.write(f"[AI ERROR] model={model} attempt={attempt} perModelAttempt={attempt_of_model} time={time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"{type(err).__name__}: {err}\n")
                f.write("-" * 60 + "\n")
        except Exception:
            pass

    def _eligible_models(self) -> list[str]:
        now = time.time()
        return [m for m in self.model_candidates if self._model_cooldown.get(m, 0) <= now]

    def _set_cooldown(self, model: str, delay_s: float):
        self._model_cooldown[model] = time.time() + delay_s

    def _generate_any(self, prompt: str, is_async: bool = False) -> str:
        """Attempt generation across models with per-model retries & cooldowns."""
        if not self.client:
            return "AI analysis unavailable (missing GEMINI_API_KEY)."

        models_to_try = self._eligible_models() or self.model_candidates
        last_err: Exception | None = None
        overall_attempt = 0
        for model in models_to_try:
            per_model_delay = self.retry.base_delay_s
            for per_attempt in range(1, self.retry.max_retries + 1):
                overall_attempt += 1
                try:
                    if is_async:
                        resp = self.client.models.generate_content(model=model, contents=prompt)  # underlying client may not be async
                    else:
                        resp = self.client.models.generate_content(model=model, contents=prompt)
                    text = (str(getattr(resp, "text", "")).strip() or "(empty AI response)")
                    self._validated_model = model  # mark success preference
                    return text
                except Exception as e:
                    last_err = e
                    self._log_error(model, e, overall_attempt, per_attempt)
                    retry_delay_server = self._extract_retry_delay_seconds(e) if (self._is_quota_or_rate_limit(e)) else None
                    transient = self._is_quota_or_rate_limit(e) or self._is_transient(e)
                    if not transient or per_attempt == self.retry.max_retries:
                        # Move to next model; if quota error, set a cooldown to avoid hammering
                        if self._is_quota_or_rate_limit(e):
                            self._set_cooldown(model, (retry_delay_server or per_model_delay) + 1.0)
                        break
                    # Compute backoff (prefer server hint)
                    wait_s = retry_delay_server or per_model_delay
                    # Add small jitter
                    wait_s = wait_s * (0.85 + random.random() * 0.3)
                    if self._is_quota_or_rate_limit(e) and per_attempt == 1:
                        # If first attempt already quota-limited, try rotating sooner by breaking out
                        # unless server mandates a long delay (>5s). Short delays we honor inline.
                        if (retry_delay_server or 0) > 5:
                            self._set_cooldown(model, float(retry_delay_server or per_model_delay))
                            break
                    if is_async:
                        try:
                            # Sleep without blocking event loop (best-effort)
                            loop = asyncio.get_event_loop()
                            # If called inside sync context with no running loop this might fail—guard it.
                            if loop.is_running():
                                # schedule an actual sleep
                                # (can't use await here because function signature expects sync path sometimes)
                                # Instead, do a blocking sleep for simplicity if not awaited.
                                time.sleep(wait_s)
                            else:
                                time.sleep(wait_s)
                        except Exception:
                            time.sleep(wait_s)
                    else:
                        time.sleep(wait_s)
                    per_model_delay *= 2
                    continue
        return f"AI analysis unavailable (error: {last_err})" if last_err else "AI analysis unavailable (unknown error)"

    # ----------------- Low-level request helpers -----------------
    def _call(self, prompt: str) -> str:
        model_hint = self._ensure_model()  # may set placeholder / starting point
        t0 = time.perf_counter()
        text = self._generate_any(prompt, is_async=False)
        dt = (time.perf_counter() - t0) * 1000.0
        try:
            final_model = self._validated_model or model_hint
            record_ai_call(final_model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(str(text)))
        except Exception:
            pass
        return text

    async def _acall(self, prompt: str) -> str:
        model_hint = self._ensure_model()
        t0 = time.perf_counter()
        text = self._generate_any(prompt, is_async=True)
        dt = (time.perf_counter() - t0) * 1000.0
        try:
            final_model = self._validated_model or model_hint
            record_ai_call(final_model, duration_ms=dt, prompt_chars=len(str(prompt)), response_chars=len(str(text)))
        except Exception:
            pass
        return text

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