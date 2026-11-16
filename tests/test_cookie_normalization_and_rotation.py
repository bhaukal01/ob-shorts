"""Tests for cookie text normalization, invalid cookie detection, and session rotation."""
import os
import pytest
import yt_account

NETSCAPE_HEADER = "# Netscape HTTP Cookie File"

def test_normalize_cookie_text_adds_missing_header():
    raw = ".youtube.com\tTRUE\t/\tTRUE\t1750000000\tSID\txxx"
    normalized = yt_account.normalize_cookie_text(raw)
    assert normalized.startswith(NETSCAPE_HEADER)
    assert ".youtube.com\tTRUE\t/\tTRUE\t1750000000\tSID\txxx" in normalized


def test_normalize_cookie_text_converts_spaces_to_tabs():
    raw = ".youtube.com TRUE / TRUE 1750000000 SID my_token_value"
    normalized = yt_account.normalize_cookie_text(raw)
    assert normalized.startswith(NETSCAPE_HEADER)
    assert ".youtube.com\tTRUE\t/\tTRUE\t1750000000\tSID\tmy_token_value" in normalized


def test_normalize_cookie_text_handles_crlf_and_escapes():
    raw = "# Netscape HTTP Cookie File\r\n.youtube.com\\tTRUE\\t/\\tTRUE\\t1750000000\\tSID\\txxx\r\n"
    normalized = yt_account.normalize_cookie_text(raw)
    assert "\r" not in normalized
    assert ".youtube.com\tTRUE\t/\tTRUE\t1750000000\tSID\txxx" in normalized


def test_is_cookie_invalid_detection():
    assert yt_account.is_cookie_invalid("WARNING: [youtube] The provided YouTube account cookies are no longer valid.")
    assert yt_account.is_cookie_invalid("ERROR: [youtube] abc: Sign in to confirm you’re not a bot.")
    assert yt_account.is_cookie_invalid("ERROR: [youtube] abc: Sign in to confirm you're not a bot.")
    assert yt_account.is_cookie_invalid("playability status: LOGIN_REQUIRED")
    assert not yt_account.is_cookie_invalid("Download completed successfully")
    assert not yt_account.is_cookie_invalid("HTTP Error 404: Not Found")


def test_session_mark_invalid_rotates_or_clears(monkeypatch, tmp_path):
    monkeypatch.setenv("YT_ACCOUNT_STATE_DIR", str(tmp_path))
    c1 = f"{NETSCAPE_HEADER}\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\taccount1\n"
    c2 = f"{NETSCAPE_HEADER}\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\taccount2\n"
    monkeypatch.setenv("YOUTUBE_COOKIES", c1)
    monkeypatch.setenv("YOUTUBE_COOKIES_2", c2)

    s = yt_account.Session()
    try:
        assert s.path is not None
        assert s.account == 0

        # Mark invalid rotates to second account
        rotated = s.mark_invalid()
        assert rotated is True
        assert s.account == 1
        assert s.path is not None

        # Mark invalid again when no more accounts exist clears path
        rotated_again = s.mark_invalid()
        assert rotated_again is False
        assert s.path is None
    finally:
        s.close()
