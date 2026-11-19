"""Unit tests for marathon VOD ingestion module (long_vod_ingest.py)."""
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import long_vod_ingest


class TestLongVodIngest(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_long_vod_")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # -------------------------------------------------------------------------
    # 1. is_marathon_vod tests
    # -------------------------------------------------------------------------
    def test_is_marathon_vod_durations(self):
        # Numeric durations (> 2700s is marathon)
        self.assertTrue(long_vod_ingest.is_marathon_vod(2701))
        self.assertTrue(long_vod_ingest.is_marathon_vod(3600.0))
        self.assertTrue(long_vod_ingest.is_marathon_vod(40000))
        self.assertTrue(long_vod_ingest.is_marathon_vod("3600"))

        self.assertFalse(long_vod_ingest.is_marathon_vod(2700))
        self.assertFalse(long_vod_ingest.is_marathon_vod(1200))
        self.assertFalse(long_vod_ingest.is_marathon_vod(0))
        self.assertFalse(long_vod_ingest.is_marathon_vod("1800"))

    def test_is_marathon_vod_urls(self):
        # Kick VODs
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://kick.com/video/553b-4890-a123-abcdef"))
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://www.kick.com/video/998877"))
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://kick.com/rachitroo_1/videos/01a1ed90-d798-7a66-8a05-15e6f8b61d5c"))

        # Twitch VODs
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://twitch.tv/videos/123456789"))
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://www.twitch.tv/videos/987654321"))

        # YouTube stream archives
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://youtube.com/live/LiveStreamId123"))
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://www.youtube.com/live/AbCdEf123"))
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://youtu.be/live/AbCdEf123"))
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://example.com/stream_archive/vod1"))

        # Standard YouTube video without marathon duration
        self.assertFalse(long_vod_ingest.is_marathon_vod("https://www.youtube.com/watch?v=short_video_id"))

        # Standard YouTube video with duration parameter
        self.assertTrue(long_vod_ingest.is_marathon_vod("https://www.youtube.com/watch?v=long_video_id", duration=3600))
        self.assertFalse(long_vod_ingest.is_marathon_vod("https://www.youtube.com/watch?v=short_video_id", duration=1200))

    # -------------------------------------------------------------------------
    # 2. resolve_manifest_url tests
    # -------------------------------------------------------------------------
    @patch("subprocess.run")
    def test_resolve_manifest_url_success(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="https://stream.kick.com/channel/audio.m3u8\nhttps://stream.kick.com/channel/master.m3u8\n",
            stderr="",
        )

        url = long_vod_ingest.resolve_manifest_url("https://kick.com/video/123")
        self.assertIn(".m3u8", url)
        self.assertEqual(url, "https://stream.kick.com/channel/audio.m3u8")

        # Verify yt-dlp -g was in command
        cmd_called = mock_run.call_args[0][0]
        self.assertIn("yt-dlp", cmd_called[0])
        self.assertIn("-g", cmd_called)

    @patch("youtube_cookie.get_active_cookie_file")
    @patch("subprocess.run")
    def test_resolve_manifest_url_with_cookies(self, mock_run, mock_cookie):
        cookie_file = os.path.join(self.test_dir, "test_cookies.txt")
        with open(cookie_file, "w") as f:
            f.write("# Netscape HTTP Cookie File\n")
        mock_cookie.return_value = cookie_file

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="https://stream.kick.com/channel/master.m3u8\n",
            stderr="",
        )

        url = long_vod_ingest.resolve_manifest_url("https://www.youtube.com/watch?v=abcdef")
        self.assertEqual(url, "https://stream.kick.com/channel/master.m3u8")

        cmd_called = mock_run.call_args[0][0]
        self.assertIn("--cookies", cmd_called)
        self.assertIn(cookie_file, cmd_called)

    @patch("subprocess.run")
    def test_resolve_manifest_url_error(self, mock_run):
        mock_run.side_effect = subprocess.CalledProcessError(1, ["yt-dlp"], stderr="Private video")
        with self.assertRaises(RuntimeError) as ctx:
            long_vod_ingest.resolve_manifest_url("https://kick.com/video/invalid")
        self.assertIn("Failed to resolve manifest URL", str(ctx.exception))

    # -------------------------------------------------------------------------
    # 3. stream_and_chunk_audio tests
    # -------------------------------------------------------------------------
    @patch("subprocess.run")
    def test_stream_and_chunk_audio(self, mock_run):
        def fake_ffmpeg(cmd, **kwargs):
            # Simulate FFmpeg creating chunk files in output_dir
            for i in range(3):
                p = os.path.join(self.test_dir, f"chunk_{i:02d}.mp3")
                with open(p, "wb") as f:
                    f.write(b"fake audio data")
            return MagicMock(returncode=0, stdout="", stderr="")

        mock_run.side_effect = fake_ffmpeg

        chunks = long_vod_ingest.stream_and_chunk_audio(
            "https://stream.kick.com/master.m3u8",
            self.test_dir,
            chunk_duration=3600,
        )

        self.assertEqual(len(chunks), 3)
        self.assertTrue(chunks[0].endswith("chunk_00.mp3"))
        self.assertTrue(chunks[1].endswith("chunk_01.mp3"))
        self.assertTrue(chunks[2].endswith("chunk_02.mp3"))

        # Verify FFmpeg command flags
        cmd_called = mock_run.call_args[0][0]
        self.assertEqual(cmd_called[0], "ffmpeg")
        self.assertIn("-vn", cmd_called)
        self.assertIn("-b:a", cmd_called)
        self.assertIn("32k", cmd_called)
        self.assertIn("-segment_time", cmd_called)
        self.assertIn("3600", cmd_called)

    # -------------------------------------------------------------------------
    # 4. transcribe_audio_chunks & timestamp offset correction tests
    # -------------------------------------------------------------------------
    @patch("long_vod_ingest._transcribe_chunk_local")
    def test_transcribe_audio_chunks_offset_correction(self, mock_local_transcribe):
        # Chunk 0: timestamps 10.0 -> 20.0
        # Chunk 1: timestamps 5.0 -> 15.0
        def side_effect(chunk_path, **kwargs):
            if "chunk_00" in chunk_path:
                return {
                    "text": "first chunk speech",
                    "language": "en",
                    "segments": [
                        {
                            "start": 10.0,
                            "end": 20.0,
                            "text": "first chunk speech",
                            "words": [
                                {"word": "first", "start": 10.0, "end": 14.0},
                                {"word": "chunk", "start": 14.0, "end": 17.0},
                                {"word": "speech", "start": 17.0, "end": 20.0},
                            ],
                        }
                    ],
                }
            else:
                return {
                    "text": "second chunk speech",
                    "language": "en",
                    "segments": [
                        {
                            "start": 5.0,
                            "end": 15.0,
                            "text": "second chunk speech",
                            "words": [
                                {"word": "second", "start": 5.0, "end": 8.0},
                                {"word": "chunk", "start": 8.0, "end": 11.0},
                                {"word": "speech", "start": 11.0, "end": 15.0},
                            ],
                        }
                    ],
                }

        mock_local_transcribe.side_effect = side_effect

        chunk_paths = [
            os.path.join(self.test_dir, "chunk_00.mp3"),
            os.path.join(self.test_dir, "chunk_01.mp3"),
        ]

        # Use chunk_duration=3600
        merged = long_vod_ingest.transcribe_audio_chunks(
            chunk_paths,
            groq_api_key=None,
            chunk_duration=3600.0,
        )

        self.assertEqual(len(merged["segments"]), 2)
        self.assertEqual(len(merged["words"]), 6)

        # Chunk 0 offset is 0
        seg0 = merged["segments"][0]
        self.assertEqual(seg0["start"], 10.0)
        self.assertEqual(seg0["end"], 20.0)
        self.assertEqual(seg0["words"][0]["start"], 10.0)

        # Chunk 1 offset is 1 * 3600 = 3600
        seg1 = merged["segments"][1]
        self.assertEqual(seg1["start"], 3605.0)
        self.assertEqual(seg1["end"], 3615.0)
        self.assertEqual(seg1["words"][0]["word"], "second")
        self.assertEqual(seg1["words"][0]["start"], 3605.0)
        self.assertEqual(seg1["words"][0]["end"], 3608.0)
        self.assertEqual(seg1["words"][2]["start"], 3611.0)
        self.assertEqual(seg1["words"][2]["end"], 3615.0)

        # Top level words offset verification
        self.assertEqual(merged["words"][3]["word"], "second")
        self.assertEqual(merged["words"][3]["start"], 3605.0)

    @patch("requests.post")
    def test_transcribe_chunk_groq_api_payload(self, mock_post):
        mock_resp = MagicMock(status_code=200)
        mock_resp.json.return_value = {
            "text": "test audio text",
            "language": "english",
            "segments": [{"start": 1.0, "end": 3.0, "text": "test audio text"}],
            "words": [{"word": "test", "start": 1.0, "end": 1.5}],
        }
        mock_post.return_value = mock_resp

        chunk_file = os.path.join(self.test_dir, "chunk_00.mp3")
        with open(chunk_file, "wb") as f:
            f.write(b"fake audio")

        res = long_vod_ingest._transcribe_chunk_groq(chunk_file, api_key="gsk_test123", model="whisper-large-v3")
        self.assertEqual(res["text"], "test audio text")

        # Verify API call endpoint and parameters
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], "https://api.groq.com/openai/v1/audio/transcriptions")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer gsk_test123")
        data = kwargs["data"]
        self.assertIn(("model", "whisper-large-v3"), data)
        self.assertIn(("response_format", "verbose_json"), data)
        self.assertIn(("timestamp_granularities[]", "word"), data)
        self.assertIn(("timestamp_granularities[]", "segment"), data)

    @patch("long_vod_ingest._transcribe_chunk_groq")
    @patch("long_vod_ingest._transcribe_chunk_local")
    def test_transcribe_audio_chunks_groq_fallback(self, mock_local, mock_groq):
        # Groq fails, should fall back to local
        mock_groq.side_effect = RuntimeError("Groq 429 Rate Limit")
        mock_local.return_value = {
            "text": "local fallback",
            "segments": [{"start": 1.0, "end": 2.0, "text": "local fallback", "words": []}],
        }

        chunk_paths = [os.path.join(self.test_dir, "chunk_00.mp3")]
        res = long_vod_ingest.transcribe_audio_chunks(
            chunk_paths,
            groq_api_key="mock_groq_key",
            chunk_duration=3600.0,
        )

        self.assertEqual(len(res["segments"]), 1)
        self.assertEqual(res["segments"][0]["text"], "local fallback")
        mock_groq.assert_called_once()
        mock_local.assert_called_once()

    # -------------------------------------------------------------------------
    # 5. score_sliding_windows tests
    # -------------------------------------------------------------------------
    def test_score_sliding_windows_skips_low_word_count(self):
        # Transcript with < 30 words in window
        sparse_transcript = {
            "segments": [
                {"start": 10.0, "end": 15.0, "text": "only a few words here"},
            ],
            "words": [
                {"word": "only", "start": 10.0, "end": 11.0},
                {"word": "a", "start": 11.0, "end": 12.0},
                {"word": "few", "start": 12.0, "end": 13.0},
                {"word": "words", "start": 13.0, "end": 14.0},
                {"word": "here", "start": 14.0, "end": 15.0},
            ],
        }

        moments = long_vod_ingest.score_sliding_windows(sparse_transcript)
        # Should be empty because word count < 30
        self.assertEqual(moments, [])

    @patch("long_vod_ingest._heuristic_viral_moment")
    def test_score_sliding_windows_dense_transcript(self, mock_heuristic):
        # Transcript with >= 30 words
        words = []
        for i in range(50):
            words.append({"word": f"word{i}", "start": 100.0 + i, "end": 100.5 + i})

        dense_transcript = {
            "segments": [
                {"start": 100.0, "end": 150.0, "text": " ".join(f"word{i}" for i in range(50))},
            ],
            "words": words,
        }

        mock_heuristic.return_value = {
            "viral": True,
            "start": 110.0,
            "end": 145.0,
            "title": "Insane Play",
            "hook": "You won't believe this!",
            "score": 9.0,
        }

        moments = long_vod_ingest.score_sliding_windows(
            dense_transcript,
            window_duration=1200.0,
            overlap=120.0,
            target_clips=3,
        )

        self.assertEqual(len(moments), 1)
        self.assertEqual(moments[0]["start"], 110.0)
        self.assertEqual(moments[0]["end"], 145.0)
        self.assertEqual(moments[0]["title"], "Insane Play")
        self.assertEqual(moments[0]["score"], 9.0)

    @patch("llm_backend.active", return_value=True)
    @patch("llm_backend.generate_json")
    def test_score_sliding_windows_relative_timestamp_adjustment(self, mock_llm_json, mock_active):
        # Words start at 2400.0s. Window 0 (0-1200) and 1 (1080-2280) skipped (<30 words).
        # Window 2 starts at win_start=2160.0s (2160-3360).
        # LLM mistakenly returns relative start=15.0, end=55.0 instead of global >2160.
        words = [{"word": f"word{i}", "start": 2400.0 + i, "end": 2400.5 + i} for i in range(40)]
        transcript = {
            "segments": [{"start": 2400.0, "end": 2440.0, "text": "lots of words here"}],
            "words": words,
        }

        mock_llm_json.return_value = ({
            "viral": True,
            "start": 15.0,
            "end": 55.0,
            "title": "Relative Timing Clip",
            "hook": "Relative Hook",
            "score": 8.5,
        }, {})

        moments = long_vod_ingest.score_sliding_windows(
            transcript,
            window_duration=1200.0,
            overlap=120.0,
            target_clips=1,
        )

        self.assertEqual(len(moments), 1)
        # Should have adjusted by adding win_start (2160.0) -> 2175.0
        self.assertEqual(moments[0]["start"], 2175.0)
        self.assertEqual(moments[0]["end"], 2215.0)

    @patch("llm_backend.active", return_value=True)
    @patch("llm_backend.generate_json")
    def test_score_sliding_windows_deduplication(self, mock_llm_json, mock_active):
        # Create transcript spanning two windows
        words1 = [{"word": f"w{i}", "start": 100.0 + i, "end": 100.5 + i} for i in range(40)]
        words2 = [{"word": f"w{i}", "start": 1150.0 + i, "end": 1150.5 + i} for i in range(40)]
        transcript = {
            "segments": [
                {"start": 100.0, "end": 140.0, "text": "window 0 words"},
                {"start": 1150.0, "end": 1190.0, "text": "window 1 words"},
            ],
            "words": words1 + words2,
        }

        # Window 0 returns [1150, 1190] with score 8.0
        # Window 1 (starts at 1080) returns [1160, 1195] with score 9.0
        # Because they overlap, only the higher scoring one (score 9.0) should be kept
        call_count = [0]
        def mock_llm_side_effect(prompt, schema):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"viral": True, "start": 1150.0, "end": 1190.0, "title": "Clip A", "score": 8.0}, {})
            else:
                return ({"viral": True, "start": 1160.0, "end": 1195.0, "title": "Clip B", "score": 9.0}, {})

        mock_llm_json.side_effect = mock_llm_side_effect

        moments = long_vod_ingest.score_sliding_windows(
            transcript,
            window_duration=1200.0,
            overlap=120.0,
            target_clips=3,
        )

        # Both candidate moments overlap ([1150, 1190] and [1160, 1195])
        # Higher score (9.0) should be picked and lower score skipped
        self.assertEqual(len(moments), 1)
        self.assertEqual(moments[0]["title"], "Clip B")
        self.assertEqual(moments[0]["score"], 9.0)

    # -------------------------------------------------------------------------
    # 6. download_sectional_video tests
    # -------------------------------------------------------------------------
    @patch("subprocess.run")
    def test_download_sectional_video_stream_copy(self, mock_run):
        output_path = os.path.join(self.test_dir, "clip_1.mp4")

        def fake_ffmpeg(cmd, **kwargs):
            # Write dummy mp4 > 1024 bytes
            with open(output_path, "wb") as f:
                f.write(b"0" * 2048)
            return MagicMock(returncode=0, stdout="", stderr="")

        mock_run.side_effect = fake_ffmpeg

        res_path = long_vod_ingest.download_sectional_video(
            "https://stream.kick.com/master.m3u8",
            start_time=120.0,
            end_time=165.0,
            output_path=output_path,
        )

        self.assertEqual(res_path, output_path)
        cmd_called = mock_run.call_args[0][0]
        self.assertIn("-c", cmd_called)
        self.assertIn("copy", cmd_called)
        self.assertIn("-avoid_negative_ts", cmd_called)

    @patch("subprocess.run")
    def test_download_sectional_video_fallback_reencode(self, mock_run):
        output_path = os.path.join(self.test_dir, "clip_fallback.mp4")

        # First call (-c copy) fails, second call (re-encode) succeeds
        def fake_ffmpeg(cmd, **kwargs):
            if "copy" in cmd:
                return MagicMock(returncode=1, stdout="", stderr="Keyframe seek error")
            else:
                with open(output_path, "wb") as f:
                    f.write(b"0" * 2048)
                return MagicMock(returncode=0, stdout="", stderr="")

        mock_run.side_effect = fake_ffmpeg

        res_path = long_vod_ingest.download_sectional_video(
            "https://stream.kick.com/master.m3u8",
            start_time=120.0,
            end_time=165.0,
            output_path=output_path,
        )

        self.assertEqual(res_path, output_path)
        self.assertEqual(mock_run.call_count, 2)
        second_cmd = mock_run.call_args_list[1][0][0]
        self.assertIn("libx264", second_cmd)
        self.assertIn("veryfast", second_cmd)

    # -------------------------------------------------------------------------
    # 7. process_marathon_vod orchestration tests
    # -------------------------------------------------------------------------
    @patch("long_vod_ingest.download_sectional_video")
    @patch("long_vod_ingest.score_sliding_windows")
    @patch("long_vod_ingest.transcribe_audio_chunks")
    @patch("long_vod_ingest.stream_and_chunk_audio")
    @patch("long_vod_ingest.resolve_manifest_url")
    def test_process_marathon_vod_mocked(
        self,
        mock_resolve,
        mock_stream,
        mock_transcribe,
        mock_score,
        mock_download,
    ):
        mock_resolve.return_value = "https://stream.kick.com/master.m3u8"
        mock_stream.return_value = [
            os.path.join(self.test_dir, "chunk_00.mp3"),
            os.path.join(self.test_dir, "chunk_01.mp3"),
        ]
        mock_transcribe.return_value = {
            "text": "full transcript",
            "segments": [{"start": 100.0, "end": 160.0, "text": "viral play"}],
            "words": [{"word": "viral", "start": 100.0, "end": 105.0}],
        }
        mock_score.return_value = [
            {
                "start": 100.0,
                "end": 145.0,
                "title": "Clutch Highlight",
                "hook": "Look at this move!",
                "reason": "Intense gaming clutch",
                "score": 9.5,
            }
        ]
        mock_download.return_value = os.path.join(self.test_dir, "clip_1_raw.mp4")

        progress_calls = []

        def on_progress(stage, pct):
            progress_calls.append((stage, pct))

        result = long_vod_ingest.process_marathon_vod(
            video_url="https://kick.com/video/stream-12345",
            output_dir=self.test_dir,
            groq_api_key="mock_key",
            progress_callback=on_progress,
        )

        self.assertEqual(result["manifest_url"], "https://stream.kick.com/master.m3u8")
        self.assertEqual(len(result["clips"]), 1)
        self.assertEqual(result["clips"][0]["title"], "Clutch Highlight")
        self.assertEqual(len(result["clip_paths"]), 1)
        self.assertTrue(result["clip_paths"][0].endswith("clip_1_raw.mp4"))

        # Check progress callback was invoked across stages
        self.assertTrue(len(progress_calls) >= 5)
        self.assertEqual(progress_calls[-1][1], 1.0)


if __name__ == "__main__":
    unittest.main()
