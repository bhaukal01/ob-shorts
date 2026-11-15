import os
import unittest
from unittest.mock import MagicMock, patch
import stream_monitor
import app


class TestStreamMonitor(unittest.TestCase):
    def test_normalize_channel_url(self):
        plat, url = stream_monitor.normalize_channel_url("https://youtube.com/@GamerFleet")
        self.assertEqual(plat, "youtube")
        self.assertTrue(url.endswith("/live"))

        plat2, url2 = stream_monitor.normalize_channel_url("https://twitch.tv/shroud")
        self.assertEqual(plat2, "twitch")
        self.assertEqual(url2, "https://www.twitch.tv/shroud")

    @patch("stream_monitor.subprocess.run")
    def test_get_live_stream_manifest_urls(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="https://video.m3u8\nhttps://audio.m3u8\n"
        )
        urls = stream_monitor.get_live_stream_manifest_urls("https://youtube.com/@GamerFleet/live")
        self.assertEqual(len(urls), 2)
        self.assertEqual(urls[0], "https://video.m3u8")
        self.assertEqual(urls[1], "https://audio.m3u8")

    @patch("stream_monitor.subprocess.run")
    @patch("stream_monitor.os.path.exists", return_value=True)
    @patch("stream_monitor.os.path.getsize", return_value=500000)
    def test_record_stream_segment_dual_manifest(self, mock_size, mock_exists, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        ok = stream_monitor.record_stream_segment(
            ["https://video.m3u8", "https://audio.m3u8"],
            300,
            "out.mp4"
        )
        self.assertTrue(ok)
        args = mock_run.call_args[0][0]
        self.assertIn("-map", args)
        self.assertIn("0:v:0", args)
        self.assertIn("1:a:0?", args)

    @patch("stream_monitor.subprocess.run")
    @patch("stream_monitor.os.path.exists", return_value=True)
    @patch("stream_monitor.os.path.getsize", return_value=500000)
    def test_record_stream_segment_single_manifest(self, mock_size, mock_exists, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        ok = stream_monitor.record_stream_segment(
            ["https://combined.m3u8"],
            300,
            "out.mp4"
        )
        self.assertTrue(ok)
        args = mock_run.call_args[0][0]
        self.assertNotIn("-map", args)

    @patch("stream_monitor.get_active_stream_jobs")
    def test_provide_active_jobs_includes_recording_monitor(self, mock_stream_jobs):
        mock_stream_jobs.return_value = [{
            "job_id": "stream_GAMER123",
            "title": "🔴 [LIVE] GamerFleet",
            "status": "processing",
            "is_stream": True,
            "submitted_at": 1700000000,
            "logs": ["Recording live stream (10m segment)..."],
            "result": {"clips": []},
        }]
        active_jobs = app._provide_active_jobs()
        matching = [j for j in active_jobs if j.get("job_id") == "stream_GAMER123"]
        self.assertEqual(len(matching), 1)
        self.assertIn("GamerFleet", matching[0]["title"])
        self.assertEqual(matching[0]["status"], "processing")
        self.assertTrue(matching[0]["is_stream"])
