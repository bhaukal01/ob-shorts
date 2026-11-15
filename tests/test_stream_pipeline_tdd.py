import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import database
import stream_monitor
import main as _main


class TestStreamPipelineTDD(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_stream_pipeline_")
        self.orig_output_dir = os.environ.get("OUTPUT_DIR")
        os.environ["OUTPUT_DIR"] = self.test_dir

    def tearDown(self):
        if self.orig_output_dir is not None:
            os.environ["OUTPUT_DIR"] = self.orig_output_dir
        else:
            os.environ.pop("OUTPUT_DIR", None)
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_get_or_create_stream_project_initializes_and_reuses(self):
        """1 Stream = 1 Project: creates output folder, _project_info.json, metadata.json, and reuses it."""
        mon = {
            "id": 99,
            "channel_name": "TestGamer",
            "channel_url": "https://youtube.com/@TestGamer/live",
            "platform": "youtube",
        }
        live_info = {
            "is_live": True,
            "title": "Epic Minecraft Stream Day 1",
            "video_id": "ABC12345",
            "channel": "TestGamer",
            "url": "https://youtube.com/watch?v=ABC12345",
        }

        # First call: initializes new project
        job_id = stream_monitor.get_or_create_stream_project(mon, live_info)
        self.assertEqual(job_id, "stream_ABC12345")

        job_dir = os.path.join(self.test_dir, job_id)
        self.assertTrue(os.path.isdir(job_dir))

        # Check _project_info.json
        info_file = os.path.join(job_dir, "_project_info.json")
        self.assertTrue(os.path.exists(info_file))
        with open(info_file, "r", encoding="utf-8") as f:
            idata = json.load(f)
        self.assertEqual(idata["title"], "Epic Minecraft Stream Day 1")
        self.assertEqual(idata["status"], "processing")
        self.assertTrue(idata["is_stream"])
        self.assertEqual(idata["channel_url"], "https://youtube.com/@TestGamer/live")

        # Check metadata.json
        meta_file = os.path.join(job_dir, f"{job_id}_metadata.json")
        self.assertTrue(os.path.exists(meta_file))
        with open(meta_file, "r", encoding="utf-8") as f:
            mdata = json.load(f)
        self.assertEqual(mdata["video_title"], "Epic Minecraft Stream Day 1")
        self.assertTrue(mdata["is_stream"])
        self.assertEqual(mdata["shorts"], [])

        # Second call during same stream: returns the EXACT SAME job_id
        job_id2 = stream_monitor.get_or_create_stream_project(mon, live_info)
        self.assertEqual(job_id, job_id2)

    @patch("llm_backend.generate_json")
    def test_analyze_segment_skips_when_not_viral(self, mock_llm):
        """If 10m transcript has no viral highlight, analyze_segment returns None so clipping is skipped."""
        mock_llm.return_value = ({"viral": False, "reason": "Just menu screen and silence"}, {})
        transcript = {
            "segments": [
                {"start": 0.0, "end": 10.0, "text": "let me adjust my settings here"},
                {"start": 10.0, "end": 20.0, "text": "okay wait a minute guys"},
            ]
        }
        res = stream_monitor.analyze_segment_for_viral_moment(transcript, "Test Stream")
        self.assertIsNone(res)

    @patch("llm_backend.generate_json")
    def test_analyze_segment_returns_highlight_when_viral(self, mock_llm):
        """If 10m transcript has a viral moment, analyze_segment returns the start, end, title, and hook."""
        mock_llm.return_value = ({
            "viral": True,
            "start": 45.0,
            "end": 85.0,
            "title": "Insane 1v4 Clutch!",
            "hook": "NO WAY HE DID THIS!"
        }, {})
        transcript = {
            "segments": [
                {"start": 45.0, "end": 85.0, "text": "OMG 1v4 clutch I got them all!"},
            ]
        }
        res = stream_monitor.analyze_segment_for_viral_moment(transcript, "Test Stream")
        self.assertIsNotNone(res)
        self.assertEqual(res["title"], "Insane 1v4 Clutch!")
        self.assertEqual(res["start"], 45.0)
        self.assertEqual(res["end"], 85.0)

    @patch("stream_monitor.subprocess.run")
    @patch("stream_monitor.analyze_segment_for_viral_moment")
    @patch("subtitles.transcribe_audio")
    @patch("reframe_v2.render")
    @patch("subtitles.generate_ass")
    @patch("subtitles.burn_subtitles")
    @patch("s3_uploader.is_s3_enabled", return_value=False)
    def test_process_live_segment_appends_to_same_project(
        self, mock_s3, mock_burn, mock_ass, mock_reframe, mock_transcribe, mock_analyze, mock_subproc
    ):
        """Processing multiple 10m segments appends clips sequentially into the same stream project."""
        job_id = "stream_TEST100"
        job_dir = os.path.join(self.test_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)
        meta_file = os.path.join(job_dir, f"{job_id}_metadata.json")
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "video_title": "Grand Gaming Stream",
                "is_stream": True,
                "shorts": []
            }, f)

        dummy_seg = os.path.join(self.test_dir, "seg_0.mp4")
        with open(dummy_seg, "w") as f:
            f.write("dummy")

        mock_transcribe.return_value = {"segments": [{"start": 0, "end": 60, "text": "Clutch moment!"}]}
        mock_analyze.return_value = {
            "start": 10.0,
            "end": 45.0,
            "title": "Peak Clutch #1",
            "hook": "Watch this shot"
        }
        mock_subproc.return_value = MagicMock(returncode=0)
        mock_reframe.return_value = None

        # Process first segment
        clip1 = stream_monitor.process_live_segment(
            dummy_seg,
            live_title="Grand Gaming Stream",
            job_id=job_id,
            layout="gaming",
            subtitle_script="auto",
        )
        self.assertIsNotNone(clip1)

        # Verify metadata now has 1 clip
        with open(meta_file, "r", encoding="utf-8") as f:
            m1 = json.load(f)
        self.assertEqual(len(m1["shorts"]), 1)
        self.assertEqual(m1["shorts"][0]["title"], "Peak Clutch #1")

        # Process second segment with another clip
        mock_analyze.return_value = {
            "start": 100.0,
            "end": 140.0,
            "title": "Peak Clutch #2",
            "hook": "Second insane play"
        }
        clip2 = stream_monitor.process_live_segment(
            dummy_seg,
            live_title="Grand Gaming Stream",
            job_id=job_id,
            layout="gaming",
            subtitle_script="auto",
        )
        self.assertIsNotNone(clip2)

        # Verify metadata now has 2 clips in the same stream project
        with open(meta_file, "r", encoding="utf-8") as f:
            m2 = json.load(f)
        self.assertEqual(len(m2["shorts"]), 2)
        self.assertEqual(m2["shorts"][0]["title"], "Peak Clutch #1")
        self.assertEqual(m2["shorts"][1]["title"], "Peak Clutch #2")

    def test_list_creator_streams_endpoint(self):
        """GET /api/live/monitors/{id}/streams returns all stream projects for a creator."""
        job_id = "stream_TESTCREATOR_01"
        job_dir = os.path.join(self.test_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)
        with open(os.path.join(job_dir, f"{job_id}_metadata.json"), "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "video_title": "Shroud Valorant Stream #5",
                "is_stream": True,
                "channel_url": "https://twitch.tv/shroud",
                "channel_name": "shroud",
                "shorts": [
                    {"title": "Ace Round", "video_url": f"/videos/{job_id}/clip_1.mp4"}
                ]
            }, f)

        with patch("database.get_live_monitor") as mock_get_mon:
            mock_get_mon.return_value = {
                "id": 42,
                "channel_name": "shroud",
                "channel_url": "https://twitch.tv/shroud",
                "platform": "twitch",
            }
            streams = stream_monitor.get_creator_streams(42)
            self.assertEqual(len(streams), 1)
            self.assertEqual(streams[0]["job_id"], job_id)
            self.assertEqual(streams[0]["title"], "Shroud Valorant Stream #5")
            self.assertEqual(streams[0]["clip_count"], 1)
            self.assertTrue(streams[0]["is_stream"])

    def test_active_stream_job_in_provide_active_jobs_and_restore(self):
        """Active in-flight stream project can be opened in the workspace without disappearing."""
        import app
        from starlette.requests import Request
        job_id = "stream_ACTIVE123"
        stream_monitor._STREAM_ACTIVE_JOBS[job_id] = {
            "job_id": job_id,
            "title": "CarryMinati BGMI Stream",
            "video_title": "CarryMinati BGMI Stream",
            "status": "processing",
            "is_stream": True,
            "submitted_at": 1700000000,
            "logs": ["Recording 10m segment #1..."],
            "result": {"clips": [{"title": "Insane Headshot", "video_url": f"/videos/{job_id}/clip_1.mp4"}]},
            "ready_files": {},
        }

        # 1. Listed in active projects
        active_list = app._provide_active_jobs()
        matched = [a for a in active_list if a["job_id"] == job_id]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["title"], "CarryMinati BGMI Stream")
        self.assertTrue(matched[0]["is_stream"])
        self.assertEqual(matched[0]["status"], "processing")

        # 2. Restored smoothly via restore_project
        scope = {"type": "http", "method": "POST", "path": f"/api/projects/{job_id}/restore"}
        req = Request(scope)
        import asyncio
        restored = asyncio.run(app.restore_project(job_id, req))
        self.assertEqual(restored["job_id"], job_id)
        self.assertEqual(restored["status"], "processing")
        self.assertEqual(restored["title"], "CarryMinati BGMI Stream")
        self.assertEqual(len(restored["result"]["clips"]), 1)

        # Cleanup
        stream_monitor._STREAM_ACTIVE_JOBS.pop(job_id, None)

    def test_projects_endpoint_tags_stream_projects(self):
        """GET /api/projects properly tags stream projects as is_stream: True."""
        job_id = "stream_DISKSTREAM_99"
        job_dir = os.path.join(self.test_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)
        with open(os.path.join(job_dir, f"{job_id}_metadata.json"), "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "video_title": "Mortal Pubg Live #99",
                "is_stream": True,
                "shorts": []
            }, f)

        import asyncio
        res = asyncio.run(_main.get_local_projects())
        matched = [p for p in res.get("projects", []) if p["job_id"] == job_id]
        self.assertEqual(len(matched), 1)
        self.assertTrue(matched[0]["is_stream"])
        self.assertEqual(matched[0]["title"], "Mortal Pubg Live #99")
