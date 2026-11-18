import json
import os
import unittest
from unittest.mock import MagicMock, patch
import stream_monitor
import yt_account
import main
import database


SAMPLE_RSS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw"/>
  <id>yt:channel:UC_x5XG1OV2P6uZZ5FSM9Ttw</id>
  <title>Google Developers</title>
  <author>
    <name>Google Developers</name>
    <uri>https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw</uri>
  </author>
  <entry>
    <id>yt:video:vid_rss_1</id>
    <yt:videoId>vid_rss_1</yt:videoId>
    <yt:channelId>UC_x5XG1OV2P6uZZ5FSM9Ttw</yt:channelId>
    <title>Building with Gemini</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=vid_rss_1"/>
  </entry>
  <entry>
    <id>yt:video:vid_rss_2</id>
    <yt:videoId>vid_rss_2</yt:videoId>
    <yt:channelId>UC_x5XG1OV2P6uZZ5FSM9Ttw</yt:channelId>
    <title>Multimodal Embeddings</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=vid_rss_2"/>
  </entry>
</feed>
"""

SAMPLE_CHANNEL_HTML = """
<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw">
  <meta property="og:url" content="https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw">
</head>
<body>
  <script>var ytInitialData = {"channelId":"UC_x5XG1OV2P6uZZ5FSM9Ttw"};</script>
</body>
</html>
"""


class TestHybridIngestAndRss(unittest.TestCase):
    def setUp(self):
        stream_monitor._CHANNEL_ID_CACHE.clear()

    def test_resolve_youtube_channel_id_direct(self):
        url = "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw"
        cid = stream_monitor.resolve_youtube_channel_id(url)
        self.assertEqual(cid, "UC_x5XG1OV2P6uZZ5FSM9Ttw")
        self.assertIn("https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw", stream_monitor._CHANNEL_ID_CACHE)

    @patch("urllib.request.urlopen")
    def test_resolve_youtube_channel_id_from_html(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = SAMPLE_CHANNEL_HTML.encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        cid = stream_monitor.resolve_youtube_channel_id("https://www.youtube.com/@GoogleDevelopers")
        self.assertEqual(cid, "UC_x5XG1OV2P6uZZ5FSM9Ttw")

    @patch("urllib.request.urlopen")
    def test_fetch_youtube_rss_videos(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = SAMPLE_RSS_XML.encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        videos = stream_monitor.fetch_youtube_rss_videos("UC_x5XG1OV2P6uZZ5FSM9Ttw")
        self.assertEqual(len(videos), 2)
        self.assertEqual(videos[0]["id"], "vid_rss_1")
        self.assertEqual(videos[0]["title"], "Building with Gemini")
        self.assertEqual(videos[0]["url"], "https://www.youtube.com/watch?v=vid_rss_1")
        self.assertEqual(videos[0]["uploader"], "Google Developers")

    @patch("stream_monitor.fetch_youtube_rss_videos")
    @patch("stream_monitor.resolve_youtube_channel_id")
    def test_check_channel_new_videos_prefers_rss(self, mock_resolve, mock_fetch_rss):
        mock_resolve.return_value = "UC_x5XG1OV2P6uZZ5FSM9Ttw"
        mock_fetch_rss.return_value = [
            {"id": "vid_1", "title": "Vid 1", "url": "https://youtube.com/watch?v=vid_1"},
            {"id": "vid_2", "title": "Vid 2", "url": "https://youtube.com/watch?v=vid_2"},
        ]

        seen = ["vid_2"]
        new_vids = stream_monitor.check_channel_new_videos("https://www.youtube.com/@GoogleDevs", seen)
        self.assertEqual(len(new_vids), 1)
        self.assertEqual(new_vids[0]["id"], "vid_1")
        mock_resolve.assert_called_once()
        mock_fetch_rss.assert_called_once()

    def test_build_stream_ytdlp_cmd_youtube_args(self, monkeypatch=None):
        cmd = stream_monitor._build_stream_ytdlp_cmd(["--no-warnings", "-g"], "https://youtube.com/watch?v=123", "youtube")
        cmd_str = " ".join(cmd)
        self.assertIn("youtube:player_client=android,mweb,default", cmd_str)
        self.assertIn("Mozilla/5.0", cmd_str)
        self.assertEqual(cmd[-1], "https://youtube.com/watch?v=123")

    def test_bot_check_markers_vs_expired_cookies(self):
        bot_err = "ERROR: [youtube] ODR8dCEk4pg: Sign in to confirm you’re not a bot. Use --cookies-from-browser"
        expired_err = "ERROR: [youtube] The provided YouTube account cookies are no longer valid."

        self.assertTrue(yt_account.is_bot_blocked(bot_err))
        self.assertFalse(yt_account.is_cookie_invalid(bot_err))

        self.assertTrue(yt_account.is_cookie_invalid(expired_err))
        self.assertFalse(yt_account.is_bot_blocked(expired_err))

    def test_get_active_cookie_file(self):
        test_netscape = (
            "# Netscape HTTP Cookie File\n"
            ".youtube.com\tTRUE\t/\tTRUE\t1899999999\tSID\tTestSidVal123\n"
        )
        with patch.object(yt_account, "accounts", return_value=[test_netscape]):
            path = yt_account.get_active_cookie_file()
            self.assertIsNotNone(path)
            self.assertTrue(os.path.exists(path))
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("TestSidVal123", content)

    @patch("urllib.request.urlopen")
    def test_download_via_cobalt_success(self, mock_urlopen):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            os.environ["COBALT_API_URL"] = "http://cobalt-test:9000"

            # Mock 1: POST to Cobalt returns JSON with stream url
            mock_meta_resp = MagicMock()
            mock_meta_resp.read.return_value = json.dumps({
                "status": "stream",
                "url": "http://cobalt-test:9000/stream/123",
                "filename": "cobalt_downloaded_video.mp4"
            }).encode("utf-8")
            mock_meta_resp.__enter__.return_value = mock_meta_resp

            # Mock 2: GET stream url returns video bytes
            dummy_video_bytes = b"fake_mp4_header" + (b"\x00" * 150000)
            mock_stream_resp = MagicMock()
            mock_stream_resp.read.side_effect = [dummy_video_bytes, b""]
            mock_stream_resp.__enter__.return_value = mock_stream_resp

            mock_urlopen.side_effect = [mock_meta_resp, mock_stream_resp]

            res = main._download_via_cobalt("https://youtube.com/watch?v=ODR8dCEk4pg", tmp_dir)
            self.assertIsNotNone(res)
            out_file, title = res
            self.assertTrue(os.path.exists(out_file))
            self.assertEqual(title, "cobalt_downloaded_video")
            self.assertGreater(os.path.getsize(out_file), 100000)
