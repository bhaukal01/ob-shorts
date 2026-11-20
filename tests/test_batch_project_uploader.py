import asyncio
import os
import json
import time
import pytest
from unittest.mock import AsyncMock, patch
import database
import auto_poster

@pytest.fixture
def test_env(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_batch.db")
    monkeypatch.setenv("DB_PATH", test_db)
    database._RESOLVED_DB_PATH = None
    database.init_db()

    out_dir = str(tmp_path / "output")
    monkeypatch.setenv("OUTPUT_DIR", out_dir)
    return test_db, out_dir


def test_batch_project_upload_sequential_and_rate_limit(test_env, monkeypatch):
    _, out_dir = test_env
    job_id = "test_batch_job_1"
    job_dir = os.path.join(out_dir, job_id)
    os.makedirs(job_dir, exist_ok=True)

    # Create 3 clips
    for i in range(1, 4):
        clip_p = os.path.join(job_dir, f"{job_id}_clip_{i}.mp4")
        with open(clip_p, "wb") as f:
            f.write(b"\x00" * 1024)

    meta = {
        "job_id": job_id,
        "video_title": "Epic Long Marathon",
        "shorts": [
            {"index": 0, "title": "Clip 1", "video_url": f"/videos/{job_id}/{job_id}_clip_1.mp4"},
            {"index": 1, "title": "Clip 2", "video_url": f"/videos/{job_id}/{job_id}_clip_2.mp4"},
            {"index": 2, "title": "Clip 3", "video_url": f"/videos/{job_id}/{job_id}_clip_3.mp4"},
        ]
    }
    with open(os.path.join(job_dir, f"{job_id}_metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)

    uploader = auto_poster.ProjectBatchUploader()

    # Rate limit detection test
    is_rl, reason, backoff = auto_poster.is_rate_limit_error("HTTP 403: quotaExceeded for user")
    assert is_rl is True
    assert "quota" in reason.lower()
    assert backoff == 1800

    is_rl2, _, _ = auto_poster.is_rate_limit_error("HTTP 429 Too Many Requests")
    assert is_rl2 is True

    # Test database CRUD
    batch = database.create_or_update_batch_post(
        job_id=job_id,
        youtube_account_id=1,
        instagram_account_id=2,
        privacy_status="public",
        delay_seconds=2,
        total_clips=3,
    )
    assert batch["status"] == "pending"
    assert batch["total_clips"] == 3
    assert batch["delay_seconds"] == 2

    # Update progress
    up = database.update_batch_post_progress(
        job_id=job_id,
        status="running",
        current_clip_index=1,
        uploaded_clips=1,
        new_log="Test log",
    )
    assert up["status"] == "running"
    assert up["uploaded_clips"] == 1
    assert len(up["logs"]) == 1

    # Active batch list
    active = database.get_all_active_batch_posts()
    assert any(b["job_id"] == job_id for b in active)
