import json
import os
import shutil
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import stream_monitor
import s3_uploader
import app


class TestStreamRenderQueue(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_stream_queue_")
        self.orig_sm_out = stream_monitor.OUTPUT_DIR if hasattr(stream_monitor, "OUTPUT_DIR") else None
        stream_monitor.OUTPUT_DIR = self.test_dir
        self.orig_app_out = app.OUTPUT_DIR
        app.OUTPUT_DIR = self.test_dir
        self.orig_env_out = os.environ.get("OUTPUT_DIR")
        os.environ["OUTPUT_DIR"] = self.test_dir

        # Clear any state in queue & trackers
        while not stream_monitor._STREAM_CLIP_RENDER_QUEUE.empty():
            try:
                stream_monitor._STREAM_CLIP_RENDER_QUEUE.get_nowait()
                stream_monitor._STREAM_CLIP_RENDER_QUEUE.task_done()
            except Exception:
                pass
        stream_monitor._JOB_PENDING_TASKS.clear()
        stream_monitor._JOB_CAPTURE_FINISHED.clear()

    def tearDown(self):
        app.OUTPUT_DIR = self.orig_app_out
        if self.orig_env_out is not None:
            os.environ["OUTPUT_DIR"] = self.orig_env_out
        else:
            os.environ.pop("OUTPUT_DIR", None)
        shutil.rmtree(self.test_dir, ignore_errors=True)

    @patch("stream_monitor.subprocess.run")
    @patch("reframe_v2.render", return_value=None)
    @patch("subtitles.generate_ass", return_value=True)
    @patch("subtitles.burn_subtitles", return_value=True)
    @patch("s3_uploader.is_s3_enabled", return_value=False)
    def test_sequential_render_queue_processes_tasks_one_by_one(
        self, mock_s3, mock_burn, mock_ass, mock_reframe, mock_subproc
    ):
        """Render queue processes clips sequentially across multiple streams."""
        mock_subproc.return_value = MagicMock(returncode=0)

        job_ids = ["stream_JOB_A", "stream_JOB_B"]
        for jid in job_ids:
            jdir = os.path.join(self.test_dir, jid)
            os.makedirs(jdir, exist_ok=True)
            meta_path = os.path.join(jdir, f"{jid}_metadata.json")
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump({
                    "job_id": jid,
                    "title": f"Stream {jid}",
                    "is_stream": True,
                    "shorts": []
                }, f)

        # Enqueue 2 render tasks
        seg_a = os.path.join(self.test_dir, "seg_a.mp4")
        with open(seg_a, "w") as f:
            f.write("dummy a")

        seg_b = os.path.join(self.test_dir, "seg_b.mp4")
        with open(seg_b, "w") as f:
            f.write("dummy b")

        stream_monitor._JOB_PENDING_TASKS["stream_JOB_A"] = 1
        stream_monitor._JOB_PENDING_TASKS["stream_JOB_B"] = 1

        stream_monitor._STREAM_CLIP_RENDER_QUEUE.put({
            "job_id": "stream_JOB_A",
            "seg_file": seg_a,
            "seg_num": 1,
            "live_title": "Stream stream_JOB_A",
            "layout": "gaming",
            "subtitle_script": "auto",
            "moment": {"start": 0.0, "end": 10.0, "title": "Moment A", "hook": "Hook A"},
            "transcript": {"segments": []},
        })

        stream_monitor._STREAM_CLIP_RENDER_QUEUE.put({
            "job_id": "stream_JOB_B",
            "seg_file": seg_b,
            "seg_num": 1,
            "live_title": "Stream stream_JOB_B",
            "layout": "gaming",
            "subtitle_script": "auto",
            "moment": {"start": 5.0, "end": 15.0, "title": "Moment B", "hook": "Hook B"},
            "transcript": {"segments": []},
        })

        # Ensure worker is started and wait for queue to drain
        stream_monitor._ensure_render_worker_running()
        stream_monitor.drain_render_queue()

        # Both jobs should now have their shorts recorded in metadata
        with open(os.path.join(self.test_dir, "stream_JOB_A", "stream_JOB_A_metadata.json")) as f:
            meta_a = json.load(f)
        self.assertEqual(len(meta_a["shorts"]), 1)
        self.assertEqual(meta_a["shorts"][0]["title"], "Moment A")

        with open(os.path.join(self.test_dir, "stream_JOB_B", "stream_JOB_B_metadata.json")) as f:
            meta_b = json.load(f)
        self.assertEqual(len(meta_b["shorts"]), 1)
        self.assertEqual(meta_b["shorts"][0]["title"], "Moment B")

    def test_project_completion_gated_until_queue_empty_and_segments_cleaned(self):
        """A stream project is finalized only when capture has stopped and all pending tasks finish, wiping raw segments."""
        job_id = "stream_GATE_01"
        job_dir = os.path.join(self.test_dir, job_id)
        seg_dir = os.path.join(job_dir, "segments")
        os.makedirs(seg_dir, exist_ok=True)

        raw_seg = os.path.join(seg_dir, "raw_sample.mp4")
        with open(raw_seg, "w") as f:
            f.write("segment content")

        info_path = os.path.join(job_dir, "_project_info.json")
        with open(info_path, "w", encoding="utf-8") as f:
            json.dump({"job_id": job_id, "status": "processing"}, f)

        meta_path = os.path.join(job_dir, f"{job_id}_metadata.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"job_id": job_id, "status": "processing", "shorts": []}, f)

        stream_monitor._STREAM_ACTIVE_JOBS[job_id] = {
            "job_id": job_id,
            "status": "processing",
            "logs": [],
            "result": {"clips": []},
        }

        # 1. Stream capture finishes, but 1 task is still pending in queue
        stream_monitor._JOB_PENDING_TASKS[job_id] = 1
        stream_monitor._JOB_CAPTURE_FINISHED.add(job_id)

        stream_monitor._check_and_finalize_stream(job_id)
        # Should NOT be completed yet
        self.assertEqual(stream_monitor._STREAM_ACTIVE_JOBS[job_id]["status"], "processing")
        self.assertTrue(os.path.exists(seg_dir))

        # 2. Now the pending task completes (pending count drops to 0)
        stream_monitor._JOB_PENDING_TASKS[job_id] = 0
        stream_monitor._check_and_finalize_stream(job_id)

        # Should now be completed
        self.assertEqual(stream_monitor._STREAM_ACTIVE_JOBS[job_id]["status"], "completed")
        with open(info_path) as f:
            info = json.load(f)
        self.assertEqual(info["status"], "completed")

        # Segments directory should be deleted completely
        self.assertFalse(os.path.exists(seg_dir))

    @patch("s3_uploader.is_s3_enabled", return_value=True)
    @patch("s3_uploader.get_s3_client")
    def test_sync_clip_to_s3_replaces_old_version(self, mock_get_client, mock_s3_enabled):
        """sync_clip_to_s3 uploads new edited clip and deletes old S3 object."""
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client
        mock_client.generate_presigned_url.return_value = "https://s3.example.com/stream_1/subtitled_new.mp4?sig=123"

        clip_path = os.path.join(self.test_dir, "subtitled_new.mp4")
        with open(clip_path, "w") as f:
            f.write("video data")

        job_id = "test_job_edit_s3"
        url = s3_uploader.sync_clip_to_s3(
            job_id=job_id,
            new_filepath=clip_path,
            old_filename="clip_old.mp4"
        )

        self.assertIsNotNone(url)
        # Upload called for new file
        self.assertTrue(mock_client.upload_file.called)
        upload_key = mock_client.upload_file.call_args[0][2]
        self.assertEqual(upload_key, f"{job_id}/subtitled_new.mp4")

        # Delete called for old file
        self.assertTrue(mock_client.delete_object.called)
        delete_key = mock_client.delete_object.call_args[1]["Key"]
        self.assertEqual(delete_key, f"{job_id}/clip_old.mp4")
