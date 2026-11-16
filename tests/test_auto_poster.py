import asyncio
import os
import json
import pytest
from unittest.mock import AsyncMock, patch
import database
import publishers
import auto_poster

def test_auto_post_single_clip(tmp_path, monkeypatch):
    async def _run():
        test_db = str(tmp_path / "test_autopost.db")
        monkeypatch.setenv("DB_PATH", test_db)
        database._RESOLVED_DB_PATH = None
        database.init_db()

        # Create dummy output directory and metadata
        out_dir = str(tmp_path / "output")
        monkeypatch.setenv("OUTPUT_DIR", out_dir)
        job_id = "test_job_autopost_1"
        job_dir = os.path.join(out_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)

        clip_file = os.path.join(job_dir, "test_job_autopost_1_clip_1.mp4")
        with open(clip_file, "wb") as f:
            f.write(b"\x00" * 1024)

        meta = {
            "job_id": job_id,
            "video_title": "Epic Streamer Gaming",
            "shorts": [
                {
                    "index": 0,
                    "title": "Crazy Headshot",
                    "video_title_for_youtube_short": "Crazy Headshot #Shorts",
                    "video_description_for_instagram": "Unbelievable shot in game!",
                    "video_url": f"/videos/{job_id}/test_job_autopost_1_clip_1.mp4",
                }
            ]
        }
        meta_path = os.path.join(job_dir, "test_job_autopost_1_metadata.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)

        # Save target accounts in DB
        yt_id = database.save_social_account(
            platform="youtube",
            account_id="UC_YT_1",
            account_name="My YT Gaming",
            access_token="yt_tok",
        )
        ig_id = database.save_social_account(
            platform="instagram",
            account_id="IG_123",
            account_name="my_ig_gaming",
            access_token="ig_tok",
        )

        # Mock publishers.upload_youtube_shorts and upload_instagram_reels
        mock_yt = AsyncMock(return_value={
            "video_id": "yt_vid_123",
            "remote_url": "https://youtube.com/shorts/yt_vid_123",
            "title": "Crazy Headshot #Shorts",
            "status": "published",
            "account_id": yt_id,
            "account_name": "My YT Gaming",
        })
        mock_ig = AsyncMock(return_value={
            "media_id": "ig_media_456",
            "remote_url": "https://www.instagram.com/reel/ig_media_456",
            "status": "published",
            "account_id": ig_id,
            "account_name": "my_ig_gaming",
        })

        with patch.object(publishers, "upload_youtube_shorts", mock_yt), \
             patch.object(publishers, "upload_instagram_reels", mock_ig):

            results = await auto_poster.post_clip_to_accounts(
                job_id=job_id,
                clip_index=0,
                youtube_account_id=yt_id,
                instagram_account_id=ig_id,
            )

            assert len(results) == 2
            assert mock_yt.await_count == 1
            assert mock_ig.await_count == 1

            # Check that metadata file was updated with published_posts
            with open(meta_path, "r", encoding="utf-8") as f:
                updated_meta = json.load(f)

            clip0 = updated_meta["shorts"][0]
            assert "published_posts" in clip0
            posts = clip0["published_posts"]
            assert len(posts) == 2

            yt_post = next(p for p in posts if p["platform"] == "youtube")
            assert yt_post["url"] == "https://youtube.com/shorts/yt_vid_123"
            assert yt_post["account_name"] == "My YT Gaming"
            assert yt_post["status"] == "success"

            ig_post = next(p for p in posts if p["platform"] == "instagram")
            assert ig_post["url"] == "https://www.instagram.com/reel/ig_media_456"
            assert ig_post["account_name"] == "my_ig_gaming"
            assert ig_post["status"] == "success"

            # Check publish_logs
            logs = database.get_publish_logs(job_id=job_id)
            assert len(logs) == 2

    asyncio.run(_run())
