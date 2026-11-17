"""Tests for YouTube download mobile client rescue and environment cookie propagation."""
import os
import pytest
import yt_clients
import yt_account
import app as app_module
import database


@pytest.fixture(autouse=True)
def clean_cookies():
    yield
    database.set_setting("youtube_cookies", "")
    database.set_setting("youtube_cookies_2", "")


def test_hd_clients_standard_openshorts():
    """Ensure HD_CLIENTS follows OpenShorts proven upstream client selection (default, mweb)."""
    assert "default" in yt_clients.HD_CLIENTS
    assert "mweb" in yt_clients.HD_CLIENTS
    # Ensure android and ios are not in HD_CLIENTS as they reject Netscape browser cookies
    assert "android" not in yt_clients.HD_CLIENTS
    assert "ios" not in yt_clients.HD_CLIENTS


def test_find_cookies_path(tmp_path, monkeypatch):
    """Ensure find_cookies_path discovers candidate cookie files."""
    cookie_file = tmp_path / "cookies.txt"
    cookie_file.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tfile_test\n")
    monkeypatch.setenv("YOUTUBE_COOKIES_FILE", str(cookie_file))
    assert yt_account.find_cookies_path() == str(cookie_file)


def test_child_env_propagates_db_youtube_cookies(monkeypatch):
    """Ensure child_env() propagates DB-configured YouTube cookies into subprocess environment."""
    test_cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\trescue_test\n"
    monkeypatch.delenv("YOUTUBE_COOKIES", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    database.set_setting("youtube_cookies", test_cookies)

    env = app_module.child_env()
    assert "YOUTUBE_COOKIES" in env
    assert "rescue_test" in env["YOUTUBE_COOKIES"]


def test_accounts_env_fallback_to_db(monkeypatch):
    """Ensure accounts(env) falls back to database when env dictionary contains no cookies."""
    test_cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tdb_fallback_test\n"
    database.set_setting("youtube_cookies", test_cookies)

    empty_env = {"PATH": "/usr/bin"}
    accs = yt_account.accounts(env=empty_env)
    assert len(accs) >= 1
    assert "db_fallback_test" in accs[0]
