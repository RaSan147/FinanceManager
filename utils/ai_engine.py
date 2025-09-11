import asyncio
import json
import os
import time
import traceback
import random
from dataclasses import dataclass
from typing import Any, Iterable, Optional
import threading

from google import genai
from .request_metrics import record_ai_call


# --- Configuration -----------------------------------------------------------
DEFAULT_MODEL_CANDIDATES: list[str] = [
    "gemini-2.5-flash",       # reasoning-heavy queries
    "gemini-2.5-pro",         # rare deep reasoning
    "gemini-2.5-flash-lite",  # frequent, light queries
    "gemini-2.0-flash",       # big data imports
    "gemini-2.0-flash-lite",  # last-resort fallback
]


# --- Retry Policy ------------------------------------------------------------
@dataclass
class _RetryPolicy:
    max_retries: int = 3
    base_delay_s: float = 1.0
    max_rounds: int = 2  # allow loop-back passes
    max_total_attempts: Optional[int] = None  # optional global cap


# --- FinancialBrain ----------------------------------------------------------
class FinancialBrain:
    """Central wrapper around Gemini client with:
    - model fallback & retry with loop-back
    - sync + async helpers
    - JSON fence stripping
    - logging & error tracking
    """

    def __init__(self, api_key: Optional[str] = None,
                 model_candidates: Optional[Iterable[str]] = None,
                 retry: _RetryPolicy = _RetryPolicy()):
        api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.client = genai.Client(api_key=api_key) if api_key else None

        override = os.getenv("GEMINI_MODEL")
        base_candidates = list(model_candidates) if model_candidates else list(DEFAULT_MODEL_CANDIDATES)
        self.model_candidates: list[str] = ([override] if override else []) + base_candidates

        # de-dup while preserving order
        seen = set()
        self.model_candidates = [m for m in self.model_candidates if not (m in seen or seen.add(m))]

        self._validated_model: Optional[str] = None
        self._model_cooldown: dict[str, float] = {}
        self.retry = retry

        self.loop = asyncio.new_event_loop()
        t = threading.Thread(target=self.loop.run_forever, daemon=True)
        t.start()

    # ----------------- Utility -----------------
    @staticmethod
    def strip_fences(text: str, md_type: str = "json") -> str:
        if not isinstance(text, str):
            return text
        start, end = f"```{md_type}\n", "```"
        if text.startswith(start):
            text = text[len(start):]
        if text.endswith(end):
            text = text[: -len(end)]
        return text.strip()

    # ----------------- Error classification -----------------
    @staticmethod
    def _extract_retry_delay_seconds(err: Exception) -> Optional[float]:
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
                    details = obj.get("error", {}).get("details") or obj.get("details")
                    if isinstance(details, list):
                        for d in details:
                            if isinstance(d, dict) and d.get("@type", "").endswith("RetryInfo"):
                                retry_delay = d.get("retryDelay")
                                if isinstance(retry_delay, str) and retry_delay.endswith('s'):
                                    return float(retry_delay[:-1])
                                if isinstance(retry_delay, (int, float)):
                                    return float(retry_delay)
        except Exception:
            pass
        import re
        m = re.search(r"retryDelay['\"]?:\s*'?([0-9]+)s", str(err))
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
        return any(k in txt for k in [
            "TIMEOUT", "TEMPORARY", "UNAVAILABLE",
            "INTERNAL", "DEADLINE", "CONNECTION", "RESET"
        ])

    # ----------------- Logging -----------------
    def _log(self, msg: str):
        os.makedirs("LOG", exist_ok=True)
        with open("ai_run.log", "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")

    def _log_error(self, model: str, err: Exception, attempt: int, per_model: int):
        self._log(f"ERROR model={model} attempt={attempt} perModel={per_model} err={type(err).__name__}: {err}")

    def _log_success(self, model: str, attempt: int, elapsed: float):
        self._log(f"SUCCESS model={model} attempt={attempt} time={elapsed:.2f}ms")

    def _log_retry(self, model: str, delay: float):
        self._log(f"RETRY model={model} sleeping={delay:.2f}s")

    def _log_cooldown(self, model: str, delay: float):
        self._log(f"COOLDOWN model={model} for {delay:.2f}s")

    # ----------------- Core generation -----------------
    async def _generate_any(self, prompt: str) -> str:
        if not self.client:
            return "AI unavailable (no GEMINI_API_KEY)"

        models = list(self.model_candidates)
        if not models:
            return "AI unavailable (no candidates)"

        model_attempts = {m: 0 for m in models}
        backoffs = {m: self.retry.base_delay_s for m in models}
        last_err: Exception | None = None
        overall_attempt = 0

        max_rounds = self.retry.max_rounds
        max_total = self.retry.max_total_attempts or (len(models) * self.retry.max_retries * max_rounds)

        for round_idx in range(max_rounds):
            now = time.time()
            candidates = [m for m in models
                          if model_attempts[m] < self.retry.max_retries
                          and self._model_cooldown.get(m, 0) <= now]

            if not candidates:
                break

            for model in candidates:
                while model_attempts[model] < self.retry.max_retries and overall_attempt < max_total:
                    overall_attempt += 1
                    model_attempts[model] += 1
                    t0 = time.perf_counter()

                    try:
                        resp = self.client.models.generate_content(model=model, contents=prompt)
                        text = (str(getattr(resp, "text", "")).strip() or "(empty AI response)")
                        self._validated_model = model
                        elapsed = (time.perf_counter() - t0) * 1000
                        self._log_success(model, overall_attempt, elapsed)

                        # dump prompt/response
                        safe_model = model.replace("/", "_")
                        with open(f"LOG/{time.time():.02f}_{safe_model}.txt", "w", encoding="utf-8") as f:
                            f.write(f"PROMPT:\n{prompt}\n\n{'*'*50}\n\nRESPONSE:\n{text}\n")

                        return text

                    except Exception as e:
                        last_err = e
                        self._log_error(model, e, overall_attempt, model_attempts[model])
                        retry_delay = self._extract_retry_delay_seconds(e) if self._is_quota_or_rate_limit(e) else None
                        transient = self._is_quota_or_rate_limit(e) or self._is_transient(e)

                        if self._is_quota_or_rate_limit(e):
                            cooldown = float(retry_delay or backoffs[model]) + 1.0
                            self._set_cooldown(model, cooldown)
                            self._log_cooldown(model, cooldown)

                        if not transient or model_attempts[model] >= self.retry.max_retries:
                            break

                        wait_s = retry_delay or backoffs[model]
                        wait_s *= (0.85 + random.random() * 0.3)
                        self._log_retry(model, wait_s)

                        await asyncio.sleep(wait_s)
                        backoffs[model] *= 2

        return f"AI unavailable (error: {last_err})" if last_err else "AI unavailable (unknown error)"

    # ----------------- Helpers -----------------
    def _set_cooldown(self, model: str, delay: float):
        self._model_cooldown[model] = time.time() + delay

    def _ensure_model(self) -> str:
        if self._validated_model:
            return self._validated_model
        if not self.client:
            self._validated_model = "(no-client)"
            return self._validated_model
        return self.model_candidates[0] if self.model_candidates else "(no-candidates)"

    # ----------------- Public API -----------------
    def get_text(self, prompt: str) -> str:
        future = asyncio.run_coroutine_threadsafe(self._generate_any(prompt), self.loop)
        return future.result()  # blocks until done (still safe in sync Flask)

    async def aget_text(self, prompt: str) -> str:
        return await self._generate_any(prompt)

    def get_json(self, prompt: str, fallback: Optional[dict] = None, fence: str = "json") -> dict:
        raw = self.get_text(prompt)
        clean = self.strip_fences(raw, fence)
        try:
            data = json.loads(clean)
            if isinstance(data, dict):
                return data
            raise ValueError("JSON root not an object")
        except Exception:
            traceback.print_exc()
            return fallback or {"error": "parse_failure", "raw": clean[:4000]}

    async def aget_json(self, prompt: str, fallback: Optional[dict] = None, fence: str = "json") -> dict:
        raw = await self.aget_text(prompt)
        clean = self.strip_fences(raw, fence)
        try:
            data = json.loads(clean)
            if isinstance(data, dict):
                return data
            raise ValueError("JSON root not an object")
        except Exception:
            traceback.print_exc()
            self._log(f"JSON parse failure. PROMPT:\n{prompt}\nRESPONSE:\n{clean[:4000]}")
            return fallback or {"error": "parse_failure", "raw": clean[:4000]}
