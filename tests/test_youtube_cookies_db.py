import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import main
import database
import yt_account

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(main.router)
    return TestClient(app, raise_server_exceptions=False)

NETSCAPE_SAMPLE = """# Netscape HTTP Cookie File
# http://curl.haxx.se/rfc/cookie_spec.html
.youtube.com\tTRUE\t/\tTRUE\t1750000000\tSID\tsid_token_12345
.youtube.com\tTRUE\t/\tTRUE\t1750000000\tHSID\thsid_token_12345
.youtube.com\tTRUE\t/\tTRUE\t1750000000\tLOGIN_INFO\tlogin_info_abcdef
"""

NETSCAPE_NON_AUTH = """# Netscape HTTP Cookie File
.youtube.com\tTRUE\t/\tTRUE\t1750000000\tPREF\tf1=50000000
.youtube.com\tTRUE\t/\tTRUE\t1750000000\tYSC\tysc_val_123
"""


def test_youtube_cookies_db_storage_and_account_loading(monkeypatch):
    monkeypatch.delenv("YOUTUBE_COOKIES", raising=False)
    monkeypatch.delenv("YOUTUBE_COOKIES_2", raising=False)

    database.set_setting("youtube_cookies", NETSCAPE_SAMPLE)
    accs = yt_account.accounts()
    assert len(accs) >= 1
    assert "SID\tsid_token_12345" in accs[0]


def test_youtube_cookies_settings_endpoint_put_and_get(client):
    put_res = client.put("/api/settings", json={
        "settings": {
            "youtube_cookies": NETSCAPE_SAMPLE,
        }
    })
    assert put_res.status_code == 200
    data = put_res.json()
    assert data["settings"]["youtube_cookies"] == NETSCAPE_SAMPLE

    get_res = client.get("/api/settings")
    assert get_res.status_code == 200
    assert get_res.json()["settings"]["youtube_cookies"] == NETSCAPE_SAMPLE


def test_test_youtube_cookies_endpoint_authenticated(client):
    res = client.post("/api/youtube/cookies/test", json={
        "cookies": NETSCAPE_SAMPLE
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["valid"] is True
    assert data["cookie_count"] == 3
    assert data["has_auth"] is True
    assert ".youtube.com" in data["domains"]


def test_test_youtube_cookies_endpoint_non_auth(client):
    res = client.post("/api/youtube/cookies/test", json={
        "cookies": NETSCAPE_NON_AUTH
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["valid"] is True
    assert data["cookie_count"] == 2
    assert data["has_auth"] is False


def test_test_youtube_cookies_endpoint_empty(client):
    database.set_setting("youtube_cookies", "")
    res = client.post("/api/youtube/cookies/test", json={
        "cookies": ""
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "No cookies" in data["message"]
