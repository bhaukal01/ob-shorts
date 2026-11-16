import os
import pytest
import database

def test_multi_account_database_crud(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_multi_account.db")
    monkeypatch.setenv("DB_PATH", test_db)
    database._RESOLVED_DB_PATH = None
    database.init_db()

    # 1. Add first YouTube account
    yt1_id = database.save_social_account(
        platform="youtube",
        client_id="cid_1",
        client_secret="csec_1",
        account_id="UC_CHANNEL_1",
        account_name="Channel One",
        access_token="tok_1",
        refresh_token="ref_1",
        token_expiry=12345678,
    )
    assert yt1_id > 0

    # 2. Add second YouTube account
    yt2_id = database.save_social_account(
        platform="youtube",
        client_id="cid_1",
        client_secret="csec_1",
        account_id="UC_CHANNEL_2",
        account_name="Channel Two",
        access_token="tok_2",
        refresh_token="ref_2",
        token_expiry=12345679,
    )
    assert yt2_id > 0
    assert yt2_id != yt1_id

    # 3. Add Instagram account
    ig1_id = database.save_social_account(
        platform="instagram",
        account_id="IG_12345",
        account_name="insta_user_1",
        access_token="ig_tok_1",
    )
    assert ig1_id > 0

    # 4. List accounts
    all_accounts = database.list_social_accounts()
    assert len(all_accounts) == 3

    yt_accounts = database.list_social_accounts(platform="youtube")
    assert len(yt_accounts) == 2
    assert {a["account_name"] for a in yt_accounts} == {"Channel One", "Channel Two"}

    ig_accounts = database.list_social_accounts(platform="instagram")
    assert len(ig_accounts) == 1
    assert ig_accounts[0]["account_name"] == "insta_user_1"

    # 5. Fetch by ID
    acc1 = database.get_social_account_by_id(yt1_id)
    assert acc1 is not None
    assert acc1["account_name"] == "Channel One"
    assert acc1["account_id"] == "UC_CHANNEL_1"

    # 6. Delete account
    ok = database.delete_social_account(yt1_id)
    assert ok is True
    assert database.get_social_account_by_id(yt1_id) is None
    assert len(database.list_social_accounts(platform="youtube")) == 1


def test_live_monitors_extended_fields(tmp_path, monkeypatch):
    test_db = str(tmp_path / "test_monitors_ext.db")
    monkeypatch.setenv("DB_PATH", test_db)
    database._RESOLVED_DB_PATH = None
    database.init_db()

    # Add monitor with monitor_mode="both" and linked target accounts
    mid = database.add_live_monitor(
        channel_url="https://youtube.com/@techcreator",
        platform="youtube",
        channel_name="Tech Creator",
        layout="gaming",
        auto_clip=1,
        subtitle_script="hinglish",
        monitor_mode="both",
        target_youtube_account_id=10,
        target_instagram_account_id=20,
        auto_post=1,
    )
    assert mid > 0

    mon = database.get_live_monitor(mid)
    assert mon is not None
    assert mon["channel_name"] == "Tech Creator"
    assert mon["monitor_mode"] == "both"
    assert mon["target_youtube_account_id"] == 10
    assert mon["target_instagram_account_id"] == 20
    assert mon["auto_post"] == 1
    assert mon["seen_video_ids"] == "[]"

    # Update seen_video_ids and monitor_mode
    import json
    new_seen = json.dumps(["vid_001", "vid_002"])
    database.update_live_monitor(mid, monitor_mode="video", seen_video_ids=new_seen, auto_post=0)

    mon2 = database.get_live_monitor(mid)
    assert mon2["monitor_mode"] == "video"
    assert mon2["seen_video_ids"] == new_seen
    assert mon2["auto_post"] == 0
