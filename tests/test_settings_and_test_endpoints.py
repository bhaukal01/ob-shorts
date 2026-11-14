import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import main
import database


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(main.router)
    return TestClient(app, raise_server_exceptions=False)


def test_llm_test_endpoint_success(client, monkeypatch):
    class DummyResponse:
        status_code = 200
        text = '{"choices": [{"message": {"content": "ok"}}]}'
        def json(self):
            return {"choices": [{"message": {"content": "ok"}}]}

    class DummyAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass
        async def post(self, url, headers=None, json=None):
            return DummyResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", DummyAsyncClient)

    res = client.post("/api/llm/test", json={
        "base_url": "https://api.onebyt.live/v1",
        "api_key": "test_key",
        "model": "gpt-4o-mini",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "successfully connected" in data["message"].lower()

    # Verify persistent status in DB
    assert database.get_setting("llm_connection_status") == "connected"


def test_llm_test_endpoint_failure(client, monkeypatch):
    class DummyResponse:
        status_code = 401
        text = "Unauthorized key"
        def json(self):
            return {"error": "unauthorized"}

    class DummyAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass
        async def post(self, url, headers=None, json=None):
            return DummyResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", DummyAsyncClient)

    res = client.post("/api/llm/test", json={
        "base_url": "https://api.onebyt.live/v1",
        "api_key": "bad_key",
        "model": "gpt-4o-mini",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["status"] == "failed"

    # Verify persistent status in DB
    assert database.get_setting("llm_connection_status") == "failed"


def test_transcription_test_endpoint_success(client, monkeypatch):
    class DummyResponse:
        status_code = 200
        text = '{"data": [{"id": "whisper-large-v3"}]}'
        def json(self):
            return {"data": [{"id": "whisper-large-v3"}]}

    class DummyAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass
        async def get(self, url, headers=None):
            return DummyResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", DummyAsyncClient)

    res = client.post("/api/transcription/test", json={
        "provider": "groq",
        "api_key": "gsk_valid_key",
        "model": "whisper-large-v3",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "successfully connected to groq" in data["message"].lower()

    # Verify persistent status in DB
    assert database.get_setting("groq_connection_status") == "connected"


def test_transcription_test_endpoint_failure(client, monkeypatch):
    class DummyResponse:
        status_code = 401
        text = "Invalid API Key"
        def json(self):
            return {"error": "Invalid API Key"}

    class DummyAsyncClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass
        async def get(self, url, headers=None):
            return DummyResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", DummyAsyncClient)

    res = client.post("/api/transcription/test", json={
        "provider": "groq",
        "api_key": "gsk_invalid_key",
        "model": "whisper-large-v3",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["status"] == "failed"

    # Verify persistent status in DB
    assert database.get_setting("groq_connection_status") == "failed"


def test_settings_get_and_put(client):
    # PUT settings
    put_res = client.put("/api/settings", json={
        "settings": {
            "transcription_provider": "groq",
            "groq_api_key": "gsk_live_123",
            "groq_whisper_model": "whisper-large-v3",
            "llm_provider": "openai",
            "llm_base_url": "https://api.onebyt.live/v1",
            "llm_model": "gpt-4o-mini",
        }
    })
    assert put_res.status_code == 200

    # GET settings
    get_res = client.get("/api/settings")
    assert get_res.status_code == 200
    data = get_res.json()
    settings = data.get("settings", data)
    assert settings["transcription_provider"] == "groq"
    assert settings["groq_api_key"] == "gsk_live_123"
    assert settings["groq_whisper_model"] == "whisper-large-v3"


def test_s3_test_endpoint_success(client, monkeypatch):
    import s3_uploader
    monkeypatch.setattr(s3_uploader, "test_s3_connection", lambda **kwargs: (True, "S3 connection successful. Bucket accessible."))

    res = client.post("/api/s3/test", json={
        "endpoint_url": "https://fake.r2.cloudflarestorage.com",
        "bucket_name": "test-bucket",
        "access_key": "fake_key",
        "secret_key": "fake_secret",
        "region": "auto",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "successful" in data["message"].lower()
    assert database.get_setting("s3_connection_status") == "connected"


def test_s3_test_endpoint_failure(client, monkeypatch):
    import s3_uploader
    def fail(**kwargs):
        raise ValueError("Invalid S3 credentials")
    monkeypatch.setattr(s3_uploader, "test_s3_connection", fail)

    res = client.post("/api/s3/test", json={
        "endpoint_url": "https://fake.r2.cloudflarestorage.com",
        "bucket_name": "test-bucket",
        "access_key": "bad_key",
        "secret_key": "bad_secret",
        "region": "auto",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert database.get_setting("s3_connection_status") == "failed"

