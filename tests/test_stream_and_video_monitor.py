import json
import os
import pytest
from unittest.mock import MagicMock, patch
import database
import stream_monitor

def test_check_channel_new_videos_filtering(tmp_path, monkeypatch):
    class DummySubprocess:
        returncode = 0
        stdout = "\n".join([
            json.dumps({"id": "vid_101", "title": "Brand New Upload", "webpage_url": "https://youtube.com/watch?v=vid_101"}),
            json.dumps({"id": "vid_100", "title": "Old Upload 1", "webpage_url": "https://youtube.com/watch?v=vid_100"}),
            json.dumps({"id": "vid_099", "title": "Old Upload 2", "webpage_url": "https://youtube.com/watch?v=vid_099"}),
        ])

    with patch("subprocess.run", return_value=DummySubprocess()):
        seen = ["vid_100", "vid_099"]
        new_vids = stream_monitor.check_channel_new_videos("https://youtube.com/@somecreator", seen)
        assert len(new_vids) == 1
        assert new_vids[0]["id"] == "vid_101"
        assert new_vids[0]["title"] == "Brand New Upload"


def test_monitor_cycle_video_mode(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_monitor_cycle.db")
    monkeypatch.setenv("DB_PATH", test_db)
    database._RESOLVED_DB_PATH = None
    database.init_db()

    mid = database.add_live_monitor(
        channel_url="https://youtube.com/@vidcreator",
        channel_name="Vid Creator",
        monitor_mode="video",
        seen_video_ids=json.dumps(["old_1"]),
        target_youtube_account_id=5,
        target_instagram_account_id=8,
        auto_post=1,
    )

    mock_check_videos = MagicMock(return_value=[
        {"id": "new_2", "title": "Latest Video", "url": "https://youtube.com/watch?v=new_2"}
    ])
    mock_dispatch_job = MagicMock(return_value="video_job_123")

    with patch.object(stream_monitor, "check_channel_new_videos", mock_check_videos), \
         patch.object(stream_monitor, "dispatch_video_upload_job", mock_dispatch_job), \
         patch.object(stream_monitor, "check_stream_live") as mock_check_live:

        stream_monitor.run_monitor_cycle()

        # Should check videos
        assert mock_check_videos.call_count == 1
        # Should NOT check live stream because monitor_mode is "video"
        assert mock_check_live.call_count == 0
        # Should dispatch job
        assert mock_dispatch_job.call_count == 1

        # Check updated seen_video_ids in DB
        mon = database.get_live_monitor(mid)
        seen = json.loads(mon["seen_video_ids"])
        assert "new_2" in seen
        assert "old_1" in seen


def test_monitor_cycle_both_mode(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_monitor_cycle_both.db")
    monkeypatch.setenv("DB_PATH", test_db)
    database._RESOLVED_DB_PATH = None
    database.init_db()

    mid = database.add_live_monitor(
        channel_url="https://youtube.com/@bothcreator",
        channel_name="Both Creator",
        monitor_mode="both",
        seen_video_ids=json.dumps(["old_1"]),
        auto_clip=0, # Don't spawn thread in test
    )

    mock_check_videos = MagicMock(return_value=[])
    mock_check_live = MagicMock(return_value=None)

    with patch.object(stream_monitor, "check_channel_new_videos", mock_check_videos), \
         patch.object(stream_monitor, "check_stream_live", mock_check_live):

        stream_monitor.run_monitor_cycle()

        # Both should be called!
        assert mock_check_videos.call_count == 1
        assert mock_check_live.call_count == 1
