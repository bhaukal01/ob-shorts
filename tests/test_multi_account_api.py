import json
import os
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch

import main
import database
import publishers

@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_api_multi_account.db")
    monkeypatch.setenv("DB_PATH", test_db)
    database._RESOLVED_DB_PATH = None
    database.init_db()

    app = FastAPI()
    app.include_router(main.router)
    return TestClient(app, raise_server_exceptions=False)


def test_social_accounts_crud_endpoints(client):
    # Seed an account
    acc_id = database.save_social_account(
        platform="youtube",
        account_id="UC_TEST_API_1",
        account_name="API Channel",
        access_token="tok_abc",
    )

    # 1. GET /api/publish/accounts
    res = client.get("/api/publish/accounts")
    assert res.status_code == 200
    accounts = res.json()["accounts"]
    assert len(accounts) >= 1
    assert any(a["id"] == acc_id for a in accounts)

    # 2. DELETE /api/publish/accounts/{id}
    res_del = client.delete(f"/api/publish/accounts/{acc_id}")
    assert res_del.status_code == 200
    assert res_del.json()["status"] == "success"

    res_check = client.get("/api/publish/accounts")
    assert not any(a["id"] == acc_id for a in res_check.json()["accounts"])


def test_live_monitors_api_extended(client):
    res = client.post("/api/live/monitors", json={
        "channel_url": "https://youtube.com/@apimonitor",
        "channel_name": "API Creator",
        "monitor_mode": "both",
        "target_youtube_account_id": 12,
        "target_instagram_account_id": 34,
        "auto_post": 1,
    })
    assert res.status_code == 200
    mid = res.json()["id"]

    mon = database.get_live_monitor(mid)
    assert mon["monitor_mode"] == "both"
    assert mon["target_youtube_account_id"] == 12
    assert mon["target_instagram_account_id"] == 34
    assert mon["auto_post"] == 1

    # Test PUT update
    res_put = client.put(f"/api/live/monitors/{mid}", json={
        "channel_name": "API Creator Updated",
        "monitor_mode": "video",
        "target_youtube_account_id": 99,
        "auto_post": 0,
    })
    assert res_put.status_code == 200
    updated = res_put.json()["monitor"]
    assert updated["channel_name"] == "API Creator Updated"
    assert updated["monitor_mode"] == "video"
    assert updated["target_youtube_account_id"] == 99
    assert updated["auto_post"] == 0


def test_clip_upload_records_published_posts(client, tmp_path, monkeypatch):
    out_dir = str(tmp_path / "output")
    monkeypatch.setenv("OUTPUT_DIR", out_dir)
    job_id = "test_upload_job_pub"
    job_dir = os.path.join(out_dir, job_id)
    os.makedirs(job_dir, exist_ok=True)

    dummy_video = os.path.join(job_dir, "test_upload_job_pub_clip_1.mp4")
    with open(dummy_video, "wb") as f:
        f.write(b"\x00" * 512)

    meta = {
        "job_id": job_id,
        "video_title": "Project with Published Clip",
        "shorts": [
            {
                "index": 0,
                "title": "Clip One",
                "video_url": f"/videos/{job_id}/test_upload_job_pub_clip_1.mp4",
                "published_posts": []
            }
        ]
    }
    with open(os.path.join(job_dir, "video_metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)

    mock_yt = AsyncMock(return_value={
        "video_id": "yt_manual_1",
        "remote_url": "https://youtube.com/shorts/yt_manual_1",
        "account_id": 7,
        "account_name": "My Channel",
    })

    with patch.object(publishers, "upload_youtube_shorts", mock_yt):
        res = client.post("/api/publish/youtube/upload", json={
            "job_id": job_id,
            "clip_index": 0,
            "title": "Clip One Title",
            "account_id": 7,
        })
        assert res.status_code == 200
        assert res.json()["remote_url"] == "https://youtube.com/shorts/yt_manual_1"

    # Now verify GET /api/projects/{job_id}/clips includes the published_posts!
    res_clips = client.get(f"/api/projects/{job_id}/clips")
    assert res_clips.status_code == 200
    c0 = res_clips.json()["clips"][0]
    assert "published_posts" in c0
    assert len(c0["published_posts"]) == 1
    assert c0["published_posts"][0]["platform"] == "youtube"
    assert c0["published_posts"][0]["url"] == "https://youtube.com/shorts/yt_manual_1"
