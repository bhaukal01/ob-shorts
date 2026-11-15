import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from starlette.requests import Request
import app
import stream_monitor
import hindi_transliterator


class TestHinglishPipeline(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_hinglish_")
        self.orig_app_output_dir = app.OUTPUT_DIR
        app.OUTPUT_DIR = self.test_dir
        self.orig_sm_output_dir = getattr(stream_monitor, "OUTPUT_DIR", None)
        stream_monitor.OUTPUT_DIR = self.test_dir
        self.orig_output_dir = os.environ.get("OUTPUT_DIR")
        os.environ["OUTPUT_DIR"] = self.test_dir

    def tearDown(self):
        app.OUTPUT_DIR = self.orig_app_output_dir
        if self.orig_sm_output_dir is not None:
            stream_monitor.OUTPUT_DIR = self.orig_sm_output_dir
        if self.orig_output_dir is not None:
            os.environ["OUTPUT_DIR"] = self.orig_output_dir
        else:
            os.environ.pop("OUTPUT_DIR", None)
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_get_clip_transcript_converts_to_hinglish(self):
        """GET /api/clip/{job_id}/{clip_index}/transcript returns Romanized Hinglish captions when script is hinglish."""
        job_id = "test_hinglish_job_1"
        job_dir = os.path.join(self.test_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)

        meta_file = os.path.join(job_dir, f"{job_id}_metadata.json")
        hindi_transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 3.0,
                    "text": "पर छोड़ो कोई",
                    "words": [
                        {"word": "पर", "start": 0.0, "end": 1.0},
                        {"word": "छोड़ो", "start": 1.0, "end": 2.0},
                        {"word": "कोई", "start": 2.0, "end": 3.0},
                    ],
                }
            ]
        }
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "video_title": "Hindi Video",
                "subtitle_script": "hinglish",
                "shorts": [
                    {
                        "start": 0.0,
                        "end": 3.0,
                        "title": "Clip 1",
                        "subtitle_script": "hinglish",
                        "video_url": f"/videos/{job_id}/clip_1.mp4",
                    }
                ],
                "transcript": hindi_transcript,
            }, f)

        app.jobs[job_id] = {
            "status": "completed",
            "output_dir": job_dir,
            "result": {"clips": [{"video_url": f"/videos/{job_id}/clip_1.mp4"}]},
        }

        # Request clip transcript
        scope = {
            "type": "http",
            "method": "GET",
            "path": f"/api/clip/{job_id}/0/transcript",
            "query_string": b"script=hinglish",
            "headers": [],
        }
        req = Request(scope)

        import asyncio
        res = asyncio.run(app.get_clip_transcript(job_id, 0, req))

        captions = res.get("captions", [])
        self.assertEqual(len(captions), 3)
        words = [c["text"].lower() for c in captions]
        # Should be Romanized Hinglish, NOT Hindi Devanagari!
        self.assertIn("par", words)
        self.assertIn("chhoro", words)
        self.assertIn("koee", words)
        for w in words:
            self.assertFalse(any('\u0900' <= ch <= '\u097f' for ch in w), f"Found Devanagari in caption: {w}")

        app.jobs.pop(job_id, None)

    @patch("app._burn_caption_style", return_value=True)
    @patch("app.require_managed_entitlement", return_value=None)
    @patch("app._assert_job_owner", return_value=None)
    @patch("app._strip_burned_captions", side_effect=lambda out_dir, fn: fn)
    def test_add_subtitles_transliterates_to_hinglish(
        self, mock_strip, mock_assert, mock_entitle, mock_burn
    ):
        """POST /api/subtitle transliterates sub_transcript and words when subtitle_script is hinglish."""
        job_id = "test_hinglish_job_2"
        job_dir = os.path.join(self.test_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)

        # Create dummy video file
        clip_path = os.path.join(job_dir, "clip_1.mp4")
        with open(clip_path, "w") as f:
            f.write("dummy")

        meta_file = os.path.join(job_dir, f"{job_id}_metadata.json")
        hindi_transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 3.0,
                    "text": "शानदार खेल",
                    "words": [
                        {"word": "शानदार", "start": 0.0, "end": 1.5},
                        {"word": "खेल", "start": 1.5, "end": 3.0},
                    ],
                }
            ]
        }
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "video_title": "Hindi Video",
                "subtitle_script": "hinglish",
                "shorts": [
                    {
                        "start": 0.0,
                        "end": 3.0,
                        "title": "Clip 1",
                        "subtitle_script": "hinglish",
                        "video_url": f"/videos/{job_id}/clip_1.mp4",
                    }
                ],
                "transcript": hindi_transcript,
            }, f)

        app.jobs[job_id] = {
            "status": "completed",
            "output_dir": job_dir,
            "result": {"clips": [{"video_url": f"/videos/{job_id}/clip_1.mp4"}]},
        }

        from app import SubtitleRequest, CaptionWordIn
        req_obj = SubtitleRequest(
            job_id=job_id,
            clip_index=0,
            subtitle_script="hinglish",
            words=[
                CaptionWordIn(text="शानदार", startMs=0, endMs=1500),
                CaptionWordIn(text="खेल", startMs=1500, endMs=3000),
            ]
        )

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/subtitle",
            "headers": [],
        }
        raw_req = Request(scope)

        import asyncio
        res = asyncio.run(app.add_subtitles(req_obj, raw_req))
        self.assertIn("new_video_url", res)

        # Check call args of mock_burn: (input_path, output_path, srt_path, sub_transcript, sub_start, sub_end, caption_style, seam_ranges)
        self.assertTrue(mock_burn.called)
        called_transcript = mock_burn.call_args[0][3]
        words_text = " ".join([w["word"] for seg in called_transcript.get("segments", []) for w in seg.get("words", [])])
        self.assertFalse(any('\u0900' <= ch <= '\u097f' for ch in words_text), f"Found Devanagari in burned transcript: {words_text}")
        self.assertIn("shaanadaar", words_text.lower())
        self.assertIn("khel", words_text.lower())

        app.jobs.pop(job_id, None)

    @patch("stream_monitor.subprocess.run")
    @patch("stream_monitor.analyze_segment_for_viral_moment")
    @patch("subtitles.transcribe_audio")
    @patch("reframe_v2.render")
    @patch("subtitles.generate_ass")
    @patch("subtitles.burn_subtitles")
    @patch("s3_uploader.is_s3_enabled", return_value=False)
    def test_stream_monitor_transliterates_transcript_after_viral_moment(
        self, mock_s3, mock_burn, mock_ass, mock_reframe, mock_transcribe, mock_analyze, mock_subproc
    ):
        """In stream_monitor, transcript is transliterated to Hinglish right after viral moment is found and saved to metadata."""
        job_id = "stream_HINGLISH_01"
        job_dir = os.path.join(self.test_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)

        meta_file = os.path.join(job_dir, f"{job_id}_metadata.json")
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "video_title": "Live Hindi Stream",
                "is_stream": True,
                "shorts": [],
            }, f)

        dummy_seg = os.path.join(self.test_dir, "seg_h.mp4")
        with open(dummy_seg, "w") as f:
            f.write("dummy")

        mock_transcribe.return_value = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.0,
                    "text": "कमाल का गेमप्ले",
                    "words": [
                        {"word": "कमाल", "start": 0.0, "end": 1.0},
                        {"word": "का", "start": 1.0, "end": 1.5},
                        {"word": "गेमप्ले", "start": 1.5, "end": 2.0},
                    ],
                }
            ]
        }
        mock_analyze.return_value = {
            "start": 0.0,
            "end": 2.0,
            "title": "Kamaal Gameplay",
            "hook": "Dekho ye shot",
        }
        mock_subproc.return_value = MagicMock(returncode=0)
        mock_reframe.return_value = None

        stream_monitor.process_live_segment(
            dummy_seg,
            live_title="Live Hindi Stream",
            job_id=job_id,
            layout="gaming",
            subtitle_script="hinglish",
        )

        with open(meta_file, "r", encoding="utf-8") as f:
            saved_meta = json.load(f)

        # Stored transcript must be in Hinglish
        stored_tx = saved_meta.get("transcript")
        self.assertIsNotNone(stored_tx)
        seg_text = stored_tx["segments"][0]["text"].lower()
        self.assertIn("kamaal", seg_text)
        self.assertFalse(any('\u0900' <= ch <= '\u097f' for ch in seg_text), "Stored transcript still contains Devanagari")
