"""Text-only LLM backend for the moment picker: any OpenAI-compatible server.

Ollama, LM Studio, vLLM, llama.cpp's server, LocalAI and OpenRouter all speak
``POST {base}/chat/completions``. When ``LLM_BASE_URL`` is set (or
``LLM_PROVIDER=openai``), the transcript scoring and detail passes in
``main.get_viral_clips`` go here instead of Gemini, so a self-hosted install
can run the whole pipeline without a Google key.

What stays on Gemini, because it needs a model that can look at frames or a
video file: the layout picker (``layout_picker.py``), the on-screen content
detector (``screencast_layout.py``) and the silent-video path
(``main.get_visual_clips``). Without a Gemini key those degrade the way they
already did: the first two return "none", the third fails the job with a clear
message. When LLM provider is "openai", AUTO_LAYOUT is automatically disabled
so the pipeline uses local MediaPipe/OpenCV face-tracking (crop.py) and never
calls google.genai vision APIs.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple, Type

import httpx
from pydantic import BaseModel

import database

DEFAULT_MODEL = "llama3.1:8b"
DEFAULT_TIMEOUT = 600.0  # local models on CPU are slow; a scoring batch can take minutes


def provider() -> str:
    """``"openai"`` when configured or default, else ``"gemini"``."""
    db_val = database.get_setting("llm_provider")
    explicit = (db_val or os.environ.get("LLM_PROVIDER") or "").strip().lower()
    if explicit in ("openai", "ollama", "local", "openai-compatible"):
        return "openai"
    if explicit == "gemini":
        return "gemini"
    # Default to openai if base_url is present or default to openai
    if base_url():
        return "openai"
    if explicit == "":
        return "openai"
    return "openai"


def base_url() -> str:
    db_val = database.get_setting("llm_base_url")
    return (db_val if db_val is not None else os.environ.get("LLM_BASE_URL") or "").strip().rstrip("/")


def api_key() -> str:
    db_val = database.get_setting("llm_api_key")
    return (db_val if db_val is not None else os.environ.get("LLM_API_KEY") or "").strip()


def model_name() -> str:
    db_val = database.get_setting("llm_model")
    val = (db_val if db_val is not None else os.environ.get("LLM_MODEL") or "").strip()
    return val or DEFAULT_MODEL


def active() -> bool:
    """True when the moment picker should call the OpenAI-compatible server."""
    is_openai = provider() == "openai"
    if is_openai:
        # Enforce AUTO_LAYOUT=0 automatically when openai provider is active
        os.environ["AUTO_LAYOUT"] = "0"
        try:
            import layout_picker
            layout_picker.ENABLED = False
            layout_picker.SHADOW = False
        except Exception:
            pass
    return is_openai and bool(base_url())


def describe() -> Optional[dict]:
    """What ``/api/config`` tells the dashboard, or ``None`` when inactive."""
    if not active():
        return None
    return {"provider": "openai", "model": model_name(), "baseUrl": base_url()}


def _timeout() -> float:
    try:
        return float(os.environ.get("LLM_TIMEOUT") or DEFAULT_TIMEOUT)
    except ValueError:
        return DEFAULT_TIMEOUT


def _headers() -> dict:
    key = api_key() or "ollama"
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _client(**kwargs) -> httpx.Client:
    """Factory so tests can swap in ``httpx.MockTransport``."""
    return httpx.Client(timeout=_timeout(), **kwargs)


async def fetch_models(base_url: str, api_key: Optional[str] = None, timeout: float = 15.0) -> List[str]:
    """Discover models from an OpenAI-compatible /v1/models endpoint."""
    cleaned_url = base_url.strip().rstrip("/")
    if not cleaned_url:
        raise ValueError("API Base URL is required")
    
    # Try {base_url}/models (handles both https://api.../v1 and https://api... roots)
    target_url = f"{cleaned_url}/models"
    headers = {"Content-Type": "application/json"}
    if api_key and api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.get(target_url, headers=headers)
        except httpx.TimeoutException:
            raise RuntimeError(f"Connection timed out while fetching models from {target_url}")
        except httpx.RequestError as exc:
            raise RuntimeError(f"Failed to connect to {target_url}: {exc}")

        if resp.status_code == 401:
            raise RuntimeError("Authentication failed (401 Unauthorized). Please check your API key.")
        if resp.status_code == 404:
            # Try appending /v1/models if /models returned 404
            if not cleaned_url.endswith("/v1"):
                v1_url = f"{cleaned_url}/v1/models"
                try:
                    resp_v1 = await client.get(v1_url, headers=headers)
                    if resp_v1.status_code == 200:
                        resp = resp_v1
                    else:
                        raise RuntimeError(f"Endpoint returned 404 Not Found at both {target_url} and {v1_url}")
                except Exception as e:
                    raise RuntimeError(f"Endpoint returned 404 at {target_url}: {e}")
            else:
                raise RuntimeError(f"Endpoint returned 404 Not Found at {target_url}")

        if resp.status_code >= 400:
            raise RuntimeError(f"LLM server returned error HTTP {resp.status_code}: {resp.text[:200]}")

        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f"Invalid JSON returned from {target_url}")

    models: List[str] = []
    # Standard OpenAI format: { "data": [{ "id": "..." }] }
    if isinstance(data, dict):
        raw_list = data.get("data")
        if isinstance(raw_list, list):
            for item in raw_list:
                if isinstance(item, dict) and "id" in item:
                    models.append(str(item["id"]))
                elif isinstance(item, str):
                    models.append(item)
        # Ollama /api/tags format: { "models": [{ "name": "..." }] }
        elif isinstance(data.get("models"), list):
            for item in data["models"]:
                if isinstance(item, dict) and "name" in item:
                    models.append(str(item["name"]))
                elif isinstance(item, str):
                    models.append(item)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and "id" in item:
                models.append(str(item["id"]))
            elif isinstance(item, str):
                models.append(item)

    models = sorted(list(set(m for m in models if m)))
    return models


def _response_formats(schema: Type[BaseModel]):
    name = getattr(schema, "__name__", "response").lower()
    yield {"type": "json_schema",
           "json_schema": {"name": name, "schema": schema.model_json_schema()}}
    yield {"type": "json_object"}
    yield None


def _is_format_rejection(resp: httpx.Response) -> bool:
    if resp.status_code not in (400, 422):
        return False
    body = resp.text.lower()
    return "response_format" in body or "json_schema" in body or "json_object" in body \
        or "format" in body


def generate_json(prompt: str, schema: Type[BaseModel], model: Optional[str] = None,
                  ) -> Tuple[dict, Optional[dict]]:
    """One chat completion that must come back as JSON matching ``schema``.

    Returns ``(parsed_dict, cost_analysis)`` in the exact shape
    ``main._run_gemini_stage`` returns, so the caller does not branch on the
    provider. Raises on HTTP errors, empty bodies and schema violations; the
    retry policy lives in the caller, same as for Gemini.
    """
    import gemini_worker  # local import: keeps this module free of the google SDK

    url = f"{base_url()}/chat/completions"
    model = model or model_name()
    messages = [
        {"role": "system", "content": "You answer with a single JSON object and nothing else."},
        {"role": "user", "content": prompt},
    ]
    last_rejection: Optional[str] = None
    with _client() as client:
        for fmt in _response_formats(schema):
            body = {"model": model, "messages": messages, "temperature": 0.2, "stream": False}
            if fmt is not None:
                body["response_format"] = fmt
            resp = client.post(url, json=body, headers=_headers())
            if fmt is not None and _is_format_rejection(resp):
                # The server does not know this response_format flavour; the
                # next loop iteration asks for a looser one.
                last_rejection = resp.text[:200]
                continue
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"LLM server {resp.status_code} from {url}: {resp.text[:300]}")
            data = resp.json()
            break
        else:
            raise RuntimeError(
                f"LLM server rejected every response_format variant: {last_rejection}")

    choices = data.get("choices") or []
    text = ""
    if choices:
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
        if isinstance(text, list):  # some servers return content parts
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    parsed = gemini_worker._parse_json_response_text(text)
    # Validate against the same schema Gemini enforces server-side, so a
    # local model that drops a field fails here with a readable error
    # (retried by the caller) instead of deep inside the clip pipeline.
    validated = schema.model_validate(parsed).model_dump()

    usage = data.get("usage") or {}
    cost = {
        "input_tokens": int(usage.get("prompt_tokens") or 0),
        "output_tokens": int(usage.get("completion_tokens") or 0),
        "thinking_tokens": 0,
        "input_cost": 0.0,
        "output_cost": 0.0,
        "total_cost": 0.0,
        "model": model,
        "price_estimated": False,
        "local": True,
    }
    return validated, cost
