"""Local Whisper worker adapter for transcription fallback."""
from __future__ import annotations

from typing import Any, Dict


def transcribe_audio(audio_path: str, **kwargs: Any) -> Dict[str, Any]:
    """Transcribe audio using local ASR (subtitles / transcribe_backends)."""
    try:
        import subtitles
        return subtitles.transcribe_audio(audio_path)
    except Exception:
        import transcribe_backends
        return transcribe_backends.transcribe_media(audio_path)
