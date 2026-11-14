"""
Video Translation Module (ElevenLabs dubbing stripped).
"""
import time
from typing import Callable, Optional

# Supported languages (empty as ElevenLabs dubbing is removed)
SUPPORTED_LANGUAGES = {}

_TRANSIENT_STATUS = {429, 500, 502, 503, 504}


class _TransientHTTPError(Exception):
    """Raised for retryable HTTP responses (5xx / 429)."""


def _with_retry(operation: Callable, description: str, max_attempts: int = 3, base_delay: float = 2.0):
    """Run operation with exponential backoff on transient errors."""
    for attempt in range(1, max_attempts + 1):
        try:
            return operation()
        except (_TransientHTTPError,) as e:
            if attempt >= max_attempts:
                raise Exception(f"{description} failed after {max_attempts} attempts: {e}")
            delay = base_delay * (2 ** (attempt - 1))
            time.sleep(delay)


def get_supported_languages() -> dict:
    return SUPPORTED_LANGUAGES
