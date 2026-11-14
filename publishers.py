"""
Native Direct Publishing engine for YouTube Shorts and Instagram Reels.

Manages OAuth authentication, token refreshing, media signing, and direct
publishing using the YouTube Data API v3 and Instagram Graph API (v21.0).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import httpx

import database

# Signing secret for public temporary media URLs
SIGNING_SECRET = (
    os.environ.get("MEDIA_SIGNING_SECRET")
    or os.environ.get("SECRET_KEY")
    or "openshorts_default_media_signing_secret_key"
)


# --- Temporary Signed Media URLs ---

def generate_signed_media_url(
    job_id: str,
    filename: str,
    base_url: str,
    expires_seconds: int = 1800,
) -> str:
    """Generate a HMAC-SHA256 signed public media URL valid for 30 minutes."""
    expiry = int(time.time()) + expires_seconds
    clean_base = base_url.rstrip("/")
    # Signature input: {job_id}/{filename}:{expiry}
    msg = f"{job_id}/{filename}:{expiry}"
    sig = hmac.new(SIGNING_SECRET.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()
    encoded_filename = urllib.parse.quote(filename)
    return f"{clean_base}/api/public-media/{sig}/{job_id}/{encoded_filename}?expires={expiry}"


def verify_signed_media(sig: str, job_id: str, filename: str, expires: int) -> bool:
    """Validate signature and expiration timestamp for signed media access."""
    if time.time() > expires:
        return False
    msg = f"{job_id}/{filename}:{expires}"
    expected = hmac.new(SIGNING_SECRET.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


# --- Base URL Resolution ---

def resolve_public_base_url(request_host_url: Optional[str] = None) -> str:
    """Resolve public URL from database setting, env var, or incoming request."""
    db_url = database.get_setting("public_api_url")
    env_url = os.environ.get("PUBLIC_API_URL")
    url = (db_url or env_url or request_host_url or "http://localhost:8000").strip().rstrip("/")
    return url


# --- YouTube Direct Publishing (YouTube Data API v3) ---

YOUTUBE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
YOUTUBE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"


def get_youtube_redirect_uri(request_base_url: Optional[str] = None) -> str:
    base = resolve_public_base_url(request_base_url)
    return f"{base}/api/publish/youtube/callback"


def get_youtube_auth_url(request_base_url: Optional[str] = None) -> str:
    account = database.get_social_account("youtube")
    client_id = (account.get("client_id") if account else None) or os.environ.get("YOUTUBE_CLIENT_ID", "")
    if not client_id:
        raise ValueError("YouTube OAuth Client ID is not configured. Please save credentials in Settings.")

    redirect_uri = get_youtube_redirect_uri(request_base_url)
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": YOUTUBE_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
    }
    return f"{YOUTUBE_OAUTH_AUTH_URL}?{urllib.parse.urlencode(params)}"


async def exchange_youtube_code(code: str, request_base_url: Optional[str] = None) -> Dict[str, Any]:
    """Exchange authorization code for access_token and refresh_token, then save."""
    account = database.get_social_account("youtube") or {}
    client_id = account.get("client_id") or os.environ.get("YOUTUBE_CLIENT_ID", "")
    client_secret = account.get("client_secret") or os.environ.get("YOUTUBE_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise ValueError("YouTube OAuth credentials (client_id/client_secret) not found.")

    redirect_uri = get_youtube_redirect_uri(request_base_url)
    data = {
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(YOUTUBE_OAUTH_TOKEN_URL, data=data)
        if resp.status_code >= 400:
            raise RuntimeError(f"Failed to exchange YouTube OAuth code: {resp.text}")
        tokens = resp.json()

    access_token = tokens.get("access_token", "")
    refresh_token = tokens.get("refresh_token") or account.get("refresh_token", "")
    expires_in = int(tokens.get("expires_in") or 3600)
    token_expiry = int(time.time()) + expires_in

    # Fetch channel name for display
    channel_title = ""
    channel_id = ""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            ch_resp = await client.get(
                "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if ch_resp.status_code == 200:
                ch_data = ch_resp.json()
                items = ch_data.get("items") or []
                if items:
                    channel_id = items[0].get("id", "")
                    channel_title = items[0].get("snippet", {}).get("title", "")
    except Exception as e:
        print(f"[YouTube] Warning: failed to fetch channel details: {e}")

    database.save_social_account(
        platform="youtube",
        client_id=client_id,
        client_secret=client_secret,
        account_id=channel_id,
        account_name=channel_title or account.get("account_name", ""),
        access_token=access_token,
        refresh_token=refresh_token,
        token_expiry=token_expiry,
    )
    return {
        "channel_id": channel_id,
        "channel_title": channel_title,
        "token_expiry": token_expiry,
    }


async def get_valid_youtube_access_token() -> str:
    """Return a valid YouTube access token, automatically refreshing if expired."""
    account = database.get_social_account("youtube")
    if not account:
        raise ValueError("YouTube account is not connected.")

    client_id = account.get("client_id") or os.environ.get("YOUTUBE_CLIENT_ID", "")
    client_secret = account.get("client_secret") or os.environ.get("YOUTUBE_CLIENT_SECRET", "")
    access_token = account.get("access_token", "")
    refresh_token = account.get("refresh_token", "")
    token_expiry = int(account.get("token_expiry") or 0)

    # Refresh if within 2 minutes of expiration or missing access token
    if (time.time() > token_expiry - 120 or not access_token) and refresh_token:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                YOUTUBE_OAUTH_TOKEN_URL,
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"Failed to refresh YouTube access token: {resp.text}")
            tokens = resp.json()
            access_token = tokens.get("access_token", "")
            expires_in = int(tokens.get("expires_in") or 3600)
            token_expiry = int(time.time()) + expires_in
            database.save_social_account(
                platform="youtube",
                access_token=access_token,
                token_expiry=token_expiry,
            )

    if not access_token:
        raise RuntimeError("No valid YouTube access token available. Please reconnect your YouTube account.")
    return access_token


async def upload_youtube_shorts(
    file_path: str,
    title: str,
    description: str = "",
    tags: Optional[List[str]] = None,
    privacy_status: str = "public",
) -> Dict[str, Any]:
    """Upload an MP4 video to YouTube Shorts using Resumable Upload protocol."""
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Video file not found at {file_path}")

    file_size = os.path.getsize(file_path)
    if file_size == 0:
        raise ValueError("Video file is empty (0 bytes)")

    access_token = await get_valid_youtube_access_token()

    # Ensure #Shorts is present in title or description
    desc = description or ""
    if "#shorts" not in desc.lower() and "#shorts" not in title.lower():
        desc = f"{desc}\n\n#Shorts".strip()

    metadata = {
        "snippet": {
            "title": title[:100],  # YouTube title limit
            "description": desc[:5000],
            "tags": tags or ["Shorts", "OpenShorts"],
            "categoryId": "22",  # People & Blogs
        },
        "status": {
            "privacyStatus": privacy_status if privacy_status in ("public", "unlisted", "private") else "public",
            "selfDeclaredMadeForKids": False,
        },
    }

    init_url = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": str(file_size),
        "X-Upload-Content-Type": "video/mp4",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Step 1: Initiate resumable upload session
        init_resp = await client.post(init_url, headers=headers, json=metadata)
        if init_resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to initiate YouTube upload: HTTP {init_resp.status_code} - {init_resp.text}")

        upload_url = init_resp.headers.get("Location")
        if not upload_url:
            raise RuntimeError("YouTube API did not return an upload session Location header.")

    # Step 2: Upload file bytes
    # Read and stream chunk/file
    async with httpx.AsyncClient(timeout=300.0) as client:
        with open(file_path, "rb") as f:
            upload_headers = {
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "video/mp4",
                "Content-Length": str(file_size),
            }
            upload_resp = await client.put(upload_url, headers=upload_headers, content=f.read())

        if upload_resp.status_code not in (200, 201):
            raise RuntimeError(f"YouTube upload transfer failed: HTTP {upload_resp.status_code} - {upload_resp.text}")

        result_data = upload_resp.json()

    video_id = result_data.get("id", "")
    shorts_url = f"https://youtube.com/shorts/{video_id}" if video_id else ""
    return {
        "video_id": video_id,
        "remote_url": shorts_url,
        "title": title,
        "status": "published",
        "raw": result_data,
    }


# --- Instagram Direct Publishing (Instagram Graph API for Reels) ---

IG_GRAPH_BASE = "https://graph.facebook.com/v21.0"


async def verify_and_save_instagram_credentials(ig_user_id: str, access_token: str) -> Dict[str, Any]:
    """Verify Instagram Business/Creator Account ID and Long-Lived Token against Graph API."""
    clean_id = ig_user_id.strip()
    clean_token = access_token.strip()
    if not clean_id or not clean_token:
        raise ValueError("Instagram User ID and Access Token are required.")

    url = f"{IG_GRAPH_BASE}/{clean_id}"
    params = {"fields": "id,username,name", "access_token": clean_token}

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, params=params)
        if resp.status_code >= 400:
            raise RuntimeError(f"Instagram verification failed: HTTP {resp.status_code} - {resp.text}")
        data = resp.json()

    username = data.get("username") or clean_id
    database.save_social_account(
        platform="instagram",
        account_id=clean_id,
        account_name=username,
        access_token=clean_token,
    )
    return {"account_id": clean_id, "username": username}


async def upload_instagram_reels(
    signed_video_url: str,
    caption: str = "",
) -> Dict[str, Any]:
    """Publish a Reel to Instagram Graph API using container creation, polling, and publish."""
    account = database.get_social_account("instagram")
    if not account or not account.get("access_token") or not account.get("account_id"):
        raise ValueError("Instagram credentials not configured. Please save your IG Account ID and Token in Settings.")

    ig_user_id = account["account_id"]
    access_token = account["access_token"]

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1: Create Reel Container
        media_url = f"{IG_GRAPH_BASE}/{ig_user_id}/media"
        post_data = {
            "media_type": "REELS",
            "video_url": signed_video_url,
            "caption": caption,
            "access_token": access_token,
        }
        create_resp = await client.post(media_url, data=post_data)
        if create_resp.status_code >= 400:
            raise RuntimeError(f"Instagram container creation failed: HTTP {create_resp.status_code} - {create_resp.text}")
        
        container_data = create_resp.json()
        creation_id = container_data.get("id")
        if not creation_id:
            raise RuntimeError(f"Instagram did not return a creation_id: {container_data}")

    # Step 2: Poll container status until FINISHED (up to 3 minutes)
    max_wait_seconds = 180
    start_time = time.time()
    status_url = f"{IG_GRAPH_BASE}/{creation_id}"
    params = {"fields": "status_code,status", "access_token": access_token}

    async with httpx.AsyncClient(timeout=15.0) as client:
        while True:
            await asyncio.sleep(5)
            poll_resp = await client.get(status_url, params=params)
            if poll_resp.status_code == 200:
                p_data = poll_resp.json()
                code = p_data.get("status_code")
                if code == "FINISHED":
                    break
                elif code == "ERROR":
                    err_msg = p_data.get("status", "Unknown processing error")
                    raise RuntimeError(f"Instagram Reel processing error: {err_msg}")
            
            if time.time() - start_time > max_wait_seconds:
                raise TimeoutError("Timed out waiting for Instagram to process the video (exceeded 3 minutes)")

    # Step 3: Publish container
    async with httpx.AsyncClient(timeout=30.0) as client:
        pub_url = f"{IG_GRAPH_BASE}/{ig_user_id}/media_publish"
        pub_resp = await client.post(pub_url, data={"creation_id": creation_id, "access_token": access_token})
        if pub_resp.status_code >= 400:
            raise RuntimeError(f"Instagram media_publish failed: HTTP {pub_resp.status_code} - {pub_resp.text}")
        pub_data = pub_resp.json()
        media_id = pub_data.get("id", "")

        # Step 4: Fetch permalink
        permalink = ""
        if media_id:
            try:
                perma_resp = await client.get(
                    f"{IG_GRAPH_BASE}/{media_id}",
                    params={"fields": "permalink", "access_token": access_token},
                )
                if perma_resp.status_code == 200:
                    permalink = perma_resp.json().get("permalink", "")
            except Exception as e:
                print(f"[Instagram] Warning: could not fetch permalink: {e}")

    return {
        "media_id": media_id,
        "remote_url": permalink or f"https://www.instagram.com/reel/{media_id}",
        "status": "published",
        "creation_id": creation_id,
    }

