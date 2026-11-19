"""YouTube cookie resolver helper for yt-dlp authenticated operations."""
from __future__ import annotations

import os
from typing import Optional

try:
    import yt_account
except ImportError:
    yt_account = None


def get_active_cookie_file() -> Optional[str]:
    """Return path to an existing cookie file or create a cached temp file for the session."""
    if yt_account is not None:
        try:
            return yt_account.get_active_cookie_file()
        except Exception:
            pass
    env_file = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if env_file and os.path.isfile(env_file):
        return env_file
    return None


def find_cookies_path() -> Optional[str]:
    """Return candidate cookies path on disk."""
    if yt_account is not None:
        try:
            return yt_account.find_cookies_path()
        except Exception:
            pass
    env_file = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if env_file and os.path.isfile(env_file):
        return env_file
    return None
