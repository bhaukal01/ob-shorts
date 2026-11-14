import os
import time
import json
import pytest
from fastapi.testclient import TestClient

import app as app_module
import main as main_module

@pytest.fixture
def test_env(tmp_path, monkeypatch):
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(out))
    monkeypatch.setenv("OUTPUT_DIR", str(out))
    monkeypatch.setattr(app_module, "jobs", {})
    monkeypatch.setattr(app_module, "JOB_RETENTION_SECONDS", 0)
    return out

def test_active_jobs_and_deletion(test_env):
    client = TestClient(app_module.app)

    # 1. Simulate an active queued/processing job
    job_id = "test-active-1234"
    app_module.jobs[job_id] = {
        "status": "processing",
        "title": "My Awesome Viral Video",
        "logs": ["Step 1: Downloading video...", "Step 2: Detecting faces..."],
        "submitted_at": time.time(),
        "ready_files": {},
    }

    # Verify GET /api/projects returns the active job
    res = client.get("/api/projects")
    assert res.status_code == 200
    data = res.json()
    projects = data.get("projects", [])
    assert len(projects) == 1
    assert projects[0]["job_id"] == job_id
    assert projects[0]["status"] == "processing"
    assert projects[0]["is_active"] is True
    assert projects[0]["title"] == "My Awesome Viral Video"
    assert "Step 2" in projects[0]["latest_log"]

    # 2. Simulate a completed project on disk
    comp_id = "test-completed-5678"
    comp_dir = test_env / comp_id
    comp_dir.mkdir()
    meta_file = comp_dir / f"{comp_id}_metadata.json"
    meta_file.write_text(json.dumps({
        "video_title": "Completed Video Title",
        "shorts": [{"title": "Short 1"}, {"title": "Short 2"}]
    }))

    res = client.get("/api/projects")
    assert res.status_code == 200
    data = res.json()
    projs = data.get("projects", [])
    assert len(projs) == 2
    comp_proj = next(p for p in projs if p["job_id"] == comp_id)
    assert comp_proj["status"] == "completed"
    assert comp_proj["is_active"] is False
    assert comp_proj["clip_count"] == 2

    # 3. Manually delete the completed project
    del_res = client.delete(f"/api/projects/{comp_id}")
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "deleted"

    # .deleted marker must exist on disk
    assert (comp_dir / ".deleted").exists()

    # The project must be immediately gone from /api/projects listing
    res2 = client.get("/api/projects")
    projs2 = res2.json().get("projects", [])
    assert not any(p["job_id"] == comp_id for p in projs2)

    # 4. Retention test: with JOB_RETENTION_SECONDS = 0, undeleted jobs stay indefinitely
    now = time.time()
    # Age undeleted active job dir
    active_dir = test_env / job_id
    active_dir.mkdir(exist_ok=True)
    os.utime(active_dir, (now - 1000000, now - 1000000))
    app_module._sweep_expired_job_dirs(now)
    assert active_dir.exists()

    # 5. 24-hour grace period for deleted project:
    # If .deleted is fresh (< 24h), directory is NOT purged yet
    app_module._sweep_expired_job_dirs(now)
    assert comp_dir.exists()

    # If .deleted is >= 24h old (86400s), directory is purged from disk
    del_marker = comp_dir / ".deleted"
    old_time = now - 90000
    os.utime(del_marker, (old_time, old_time))
    app_module._sweep_expired_job_dirs(now)
    assert not comp_dir.exists()
