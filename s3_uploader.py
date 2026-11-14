import os
from dotenv import load_dotenv
load_dotenv()
import boto3
from botocore.exceptions import ClientError
from botocore.config import Config
import logging
import json
import time as time_module

# Configure silent logging for boto3 and botocore
logging.getLogger('boto3').setLevel(logging.CRITICAL)
logging.getLogger('botocore').setLevel(logging.CRITICAL)
logging.getLogger('s3transfer').setLevel(logging.CRITICAL)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def get_s3_config() -> dict:
    """Retrieve S3 storage configuration from SQLite database with env fallback."""
    cfg = {
        "enabled": False,
        "endpoint_url": "",
        "bucket_name": "",
        "access_key": "",
        "secret_key": "",
        "region": "auto",
    }
    try:
        import database
        cfg["enabled"] = str(database.get_setting("s3_enabled") or "0").strip() in ("1", "true", "yes")
        cfg["endpoint_url"] = (database.get_setting("s3_endpoint_url") or "").strip()
        cfg["bucket_name"] = (database.get_setting("s3_bucket_name") or "").strip()
        cfg["access_key"] = (database.get_setting("s3_access_key") or "").strip()
        cfg["secret_key"] = (database.get_setting("s3_secret_key") or "").strip()
        cfg["region"] = (database.get_setting("s3_region") or "auto").strip()
    except Exception:
        pass

    if not cfg["bucket_name"]:
        cfg["bucket_name"] = os.environ.get("S3_BUCKET_NAME") or os.environ.get("AWS_S3_BUCKET") or ""
    if not cfg["access_key"]:
        cfg["access_key"] = os.environ.get("S3_ACCESS_KEY") or os.environ.get("AWS_ACCESS_KEY_ID") or ""
    if not cfg["secret_key"]:
        cfg["secret_key"] = os.environ.get("S3_SECRET_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY") or ""
    if not cfg["endpoint_url"]:
        cfg["endpoint_url"] = os.environ.get("S3_ENDPOINT_URL") or ""
    if cfg["region"] == "auto" and os.environ.get("AWS_REGION"):
        cfg["region"] = os.environ.get("AWS_REGION")
    if not cfg["enabled"]:
        cfg["enabled"] = os.environ.get("S3_ENABLED", "0").strip() in ("1", "true", "yes") or bool(cfg["bucket_name"] and cfg["access_key"])

    return cfg


def is_s3_enabled() -> bool:
    """Check whether S3 storage is enabled and validly configured."""
    cfg = get_s3_config()
    return bool(cfg["enabled"] and cfg["bucket_name"] and cfg["access_key"] and cfg["secret_key"])


def get_s3_bucket() -> str:
    """Return the configured S3 bucket name."""
    return get_s3_config()["bucket_name"]


def get_s3_client(cfg=None):
    """Returns an authenticated S3 / S3-compatible client with signature v4."""
    if cfg is None:
        cfg = get_s3_config()

    if not cfg.get("access_key") or not cfg.get("secret_key"):
        return None

    region = cfg.get("region") or "auto"
    if region == "auto":
        region = "us-east-1"  # boto3 requires a region name string even for custom endpoints

    kwargs = {
        "service_name": "s3",
        "aws_access_key_id": cfg["access_key"],
        "aws_secret_access_key": cfg["secret_key"],
        "region_name": region,
        "config": Config(signature_version="s3v4", s3={"addressing_style": "path" if cfg.get("endpoint_url") else "auto"}),
    }
    if cfg.get("endpoint_url"):
        kwargs["endpoint_url"] = cfg["endpoint_url"].rstrip("/")

    return boto3.client(**kwargs)


def test_s3_connection(endpoint_url=None, bucket_name=None, access_key=None, secret_key=None, region=None):
    """Test connection to the S3 bucket."""
    cfg = get_s3_config()
    if endpoint_url is not None:
        cfg["endpoint_url"] = endpoint_url.strip()
    if bucket_name is not None:
        cfg["bucket_name"] = bucket_name.strip()
    if access_key is not None:
        cfg["access_key"] = access_key.strip()
    if secret_key is not None:
        cfg["secret_key"] = secret_key.strip()
    if region is not None:
        cfg["region"] = region.strip()

    if not cfg["bucket_name"]:
        raise ValueError("Bucket name is required")
    if not cfg["access_key"] or not cfg["secret_key"]:
        raise ValueError("Access Key ID and Secret Access Key are required")

    client = get_s3_client(cfg)
    if not client:
        raise ValueError("Failed to create S3 client")

    # List up to 1 object to verify bucket access & permissions
    client.list_objects_v2(Bucket=cfg["bucket_name"], MaxKeys=1)
    return True


def upload_file_to_s3(file_path, bucket_name=None, s3_key=None):
    """Upload a file to the S3 bucket silently."""
    if not bucket_name:
        bucket_name = get_s3_bucket()
    if not s3_key:
        s3_key = os.path.basename(file_path)

    s3_client = get_s3_client()
    if not s3_client or not bucket_name:
        return False

    extra_args = {}
    if file_path.endswith(".mp4"):
        extra_args["ContentType"] = "video/mp4"
    elif file_path.endswith(".zip"):
        extra_args["ContentType"] = "application/zip"
    elif file_path.endswith(".json"):
        extra_args["ContentType"] = "application/json"

    try:
        s3_client.upload_file(file_path, bucket_name, s3_key, ExtraArgs=extra_args if extra_args else None)
        return True
    except Exception as e:
        logger.error(f"S3 upload error for {file_path}: {e}")
        return False


_presigned_cache = {}


def get_presigned_download_url_for_clip(job_id, filename, expiration=86400):
    """Generate a direct presigned download URL for a clip from S3."""
    if not is_s3_enabled():
        return None
    cache_key = (job_id, filename, "download")
    now = time_module.time()
    if cache_key in _presigned_cache:
        url, exp = _presigned_cache[cache_key]
        if now < exp - 300:
            return url

    cfg = get_s3_config()
    s3_client = get_s3_client(cfg)
    if not s3_client:
        return None

    s3_key = f"{job_id}/{filename}"
    try:
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': cfg['bucket_name'],
                'Key': s3_key,
                'ResponseContentDisposition': f'attachment; filename="{filename}"'
            },
            ExpiresIn=expiration
        )
        if url:
            _presigned_cache[cache_key] = (url, now + expiration)
        return url
    except Exception as e:
        logger.error(f"Failed to generate presigned URL for {s3_key}: {e}")
        return None


def get_presigned_stream_url_for_clip(job_id, filename, expiration=86400):
    """Generate a direct presigned playback/streaming URL for a clip from S3 with video/mp4 MIME."""
    if not is_s3_enabled():
        return None
    cache_key = (job_id, filename, "stream")
    now = time_module.time()
    if cache_key in _presigned_cache:
        url, exp = _presigned_cache[cache_key]
        if now < exp - 300:
            return url

    cfg = get_s3_config()
    s3_client = get_s3_client(cfg)
    if not s3_client:
        return None

    s3_key = f"{job_id}/{filename}"
    try:
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': cfg['bucket_name'],
                'Key': s3_key,
                'ResponseContentType': 'video/mp4',
            },
            ExpiresIn=expiration
        )
        if url:
            _presigned_cache[cache_key] = (url, now + expiration)
        return url
    except Exception as e:
        logger.error(f"Failed to generate presigned stream URL for {s3_key}: {e}")
        return None


def generate_presigned_url(bucket_name, object_key, expiration=3600):
    """Generate a presigned URL to share an S3 object."""
    s3_client = get_s3_client()
    if not s3_client:
        return None
    try:
        response = s3_client.generate_presigned_url('get_object',
                                                    Params={'Bucket': bucket_name,
                                                            'Key': object_key},
                                                    ExpiresIn=expiration)
        return response
    except ClientError as e:
        logger.error(e)
        return None

def list_all_clips(bucket_name=None, limit=50, force_refresh=False):
    """
    List recent clips from the S3 bucket by finding metadata files.
    Returns a list of dicts containing clip info and signed URLs.
    
    Args:
        bucket_name: S3 bucket name (defaults to AWS_S3_BUCKET env var)
        limit: Maximum number of clips to return (default 50 for speed)
        force_refresh: If True, bypass cache
    """
    global _clips_cache
    
    # Check cache first
    now = time_module.time()
    if not force_refresh and _clips_cache["data"] is not None:
        if now - _clips_cache["timestamp"] < CACHE_TTL_SECONDS:
            cached = _clips_cache["data"]
            return cached[:limit] if limit else cached
    
    if not bucket_name:
        bucket_name = os.environ.get('AWS_S3_BUCKET', 'my-clips-bucket')

    s3_client = get_s3_client()
    if not s3_client:
        return []

    all_clips = []
    
    try:
        # List all objects in bucket
        # Note: For very large buckets, pagination is needed. 
        # Assuming reasonable size for now, but adding continuation token support is best practice.
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=bucket_name)

        metadata_files = []
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    if obj['Key'].endswith('_metadata.json'):
                         metadata_files.append(obj)
        
        # Sort metadata by LastModified (newest first)
        metadata_files.sort(key=lambda x: x['LastModified'], reverse=True)

        for meta_obj in metadata_files:
            key = meta_obj['Key']
            # key format: {job_id}/..._metadata.json
            
            # Read metadata content
            try:
                obj_resp = s3_client.get_object(Bucket=bucket_name, Key=key)
                content = obj_resp['Body'].read().decode('utf-8')
                data = json.loads(content)
                
                parts = key.split('/')
                job_id = parts[0] if len(parts) > 1 else "unknown"
                # Filename base for clips in same folder
                # Meta key: "job_id/filename_metadata.json"
                # Base name in metadata usually matches filename without ext
                meta_filename = os.path.basename(key) 
                base_name = meta_filename.replace('_metadata.json', '')
                
                clips_data = data.get('shorts', [])
                
                for i, clip in enumerate(clips_data):
                    clip_filename = f"{base_name}_clip_{i+1}.mp4"
                    clip_key = f"{job_id}/{clip_filename}"
                    
                    # Generate signed URL
                    signed_url = generate_presigned_url(bucket_name, clip_key, expiration=7200) # 2 hours
                    
                    if signed_url:
                        all_clips.append({
                            "job_id": job_id,
                            "index": i,
                            "url": signed_url,
                            "title": clip.get('video_title_for_youtube_short', 'Untitled Clip'),
                            "tiktok_desc": clip.get('video_description_for_tiktok', ''),
                            "insta_desc": clip.get('video_description_for_instagram', ''),
                            "created_at": meta_obj['LastModified'].isoformat(),
                            "duration": clip.get('end', 0) - clip.get('start', 0)
                        })
                        
                        # Early exit if we have enough clips
                        if limit and len(all_clips) >= limit:
                            break
                
                # Early exit if we have enough clips
                if limit and len(all_clips) >= limit:
                    break

            except Exception as e:
                logger.error(f"Error processing metadata {key}: {e}")
                continue

    except Exception as e:
        logger.error(f"Error listing bucket: {e}")
        return []
    
    # Update cache with full results (keep for pagination later)
    _clips_cache["data"] = all_clips
    _clips_cache["timestamp"] = now

    return all_clips[:limit] if limit else all_clips

# Actors generated for a signed-in user are theirs: the prompt that made them
# names the product they are holding. They live under a prefix the public
# gallery never lists, with a random key, and are handed out as presigned
# URLs (SigV4 caps those at 7 days). The shared ``avatars/`` gallery keeps the
# images that were published there before, minus the product half of their
# description.
PRIVATE_ACTOR_PREFIX = "private/actors/"
ACTOR_URL_TTL_SECONDS = int(os.environ.get("ACTOR_URL_TTL_SECONDS", str(7 * 24 * 3600)))

import re as _re
_HOLDING_RE = _re.compile(r"\s*\(holding .*\)\s*$", _re.DOTALL)


def public_actor_description(description):
    """The gallery caption without the "(holding <product>)" part."""
    return _HOLDING_RE.sub("", description or "").strip()


def _presign(s3_client, bucket_name, key, ttl=None):
    return s3_client.generate_presigned_url(
        'get_object', Params={'Bucket': bucket_name, 'Key': key},
        ExpiresIn=int(ttl or ACTOR_URL_TTL_SECONDS))


def upload_actor_to_s3(file_path, description="", owner_tag=None):
    """
    Upload an actor image. With ``owner_tag`` (cloud: an opaque per-user tag)
    it goes to the owner's private prefix and the return is a presigned URL;
    without one (self-host) to the public gallery, as before.
    Returns the URL or None on failure.
    """
    bucket_name = os.environ.get('AWS_S3_PUBLIC_BUCKET', 'my-public-bucket')
    region = os.environ.get('AWS_REGION', 'eu-west-3')

    s3_client = get_s3_client()
    if not s3_client:
        return None

    import uuid
    filename = os.path.basename(file_path)
    name, ext = os.path.splitext(filename)
    if owner_tag:
        s3_key = f"{PRIVATE_ACTOR_PREFIX}{owner_tag}/{uuid.uuid4().hex}{ext}"
    else:
        s3_key = f"avatars/{name}_{str(uuid.uuid4())[:8]}{ext}"

    try:
        # Skip broken/tiny files
        if os.path.getsize(file_path) < 1000:
            logger.warning(f"Skipping tiny file ({os.path.getsize(file_path)} bytes): {file_path}")
            return None

        s3_client.upload_file(
            file_path, bucket_name, s3_key,
            ExtraArgs={'ContentType': 'image/png'},
        )
        if owner_tag:
            url = _presign(s3_client, bucket_name, s3_key)
        else:
            url = f"https://{bucket_name}.s3.{region}.amazonaws.com/{s3_key}"

        # Save metadata JSON alongside the image
        if description:
            import datetime
            meta_key = s3_key.rsplit('.', 1)[0] + '.json'
            meta = {
                "description": description,
                "created_at": datetime.datetime.utcnow().isoformat() + "Z",
            }
            if not owner_tag:
                meta["url"] = url
            s3_client.put_object(
                Bucket=bucket_name, Key=meta_key,
                Body=json.dumps(meta, ensure_ascii=False).encode('utf-8'),
                ContentType='application/json',
            )

        logger.info(f"Uploaded actor to S3: {s3_key}")
        return url
    except Exception as e:
        logger.error(f"Failed to upload actor to S3: {e}")
        return None


def _list_actor_prefix(s3_client, bucket_name, prefix):
    """{base_key: {'image': obj, 'meta_key': key}} under one prefix."""
    paginator = s3_client.get_paginator('list_objects_v2')
    all_objects = {}
    for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
        for obj in page.get('Contents', []):
            key = obj['Key']
            base = key.rsplit('.', 1)[0]
            entry = all_objects.setdefault(base, {})
            if key.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                entry['image'] = obj
            elif key.endswith('.json'):
                entry['meta_key'] = key
    return all_objects


def _read_description(s3_client, bucket_name, meta_key):
    try:
        meta_resp = s3_client.get_object(Bucket=bucket_name, Key=meta_key)
        return json.loads(meta_resp['Body'].read().decode('utf-8')).get('description', '')
    except Exception:
        return ''


def list_actor_gallery(owner_tag=None):
    """
    The shared actor gallery (public images, product stripped from their
    captions) plus, with ``owner_tag``, the caller's own private actors as
    presigned URLs (full caption: it is their own prompt). Newest first, the
    caller's own ahead of the shared ones.
    """
    bucket_name = os.environ.get('AWS_S3_PUBLIC_BUCKET', 'my-public-bucket')
    region = os.environ.get('AWS_REGION', 'eu-west-3')

    s3_client = get_s3_client()
    if not s3_client:
        return []

    try:
        own = []
        if owner_tag:
            for base, data in _list_actor_prefix(
                    s3_client, bucket_name, f"{PRIVATE_ACTOR_PREFIX}{owner_tag}/").items():
                if 'image' not in data:
                    continue
                obj = data['image']
                own.append({
                    "url": _presign(s3_client, bucket_name, obj['Key']),
                    "key": obj['Key'].rsplit('/', 1)[-1],
                    "created_at": obj['LastModified'].isoformat(),
                    "description": (_read_description(s3_client, bucket_name, data['meta_key'])
                                    if 'meta_key' in data else ""),
                    "mine": True,
                })
        shared = []
        for base, data in _list_actor_prefix(s3_client, bucket_name, 'avatars/').items():
            if 'image' not in data:
                continue
            obj = data['image']
            key = obj['Key']
            shared.append({
                "url": f"https://{bucket_name}.s3.{region}.amazonaws.com/{key}",
                "key": key,
                "created_at": obj['LastModified'].isoformat(),
                "description": (public_actor_description(
                    _read_description(s3_client, bucket_name, data['meta_key']))
                    if 'meta_key' in data else ""),
            })
        own.sort(key=lambda x: x['created_at'], reverse=True)
        shared.sort(key=lambda x: x['created_at'], reverse=True)
        return own + shared

    except Exception as e:
        logger.error(f"Failed to list actor gallery: {e}")
        return []


# ── SaaS Video Gallery (public S3) ──────────────────────────────────

_video_gallery_cache = {
    "data": None,
    "timestamp": 0,
}

def upload_video_to_gallery(video_path, actor_image_path, metadata, video_id=None):
    """
    Upload a generated UGC video + actor + metadata to the public S3 bucket.
    Returns dict with public URLs or None on failure.
    """
    import uuid
    bucket_name = os.environ.get('AWS_S3_PUBLIC_BUCKET', 'my-public-bucket')
    region = os.environ.get('AWS_REGION', 'eu-west-3')

    s3_client = get_s3_client()
    if not s3_client:
        return None

    if not video_id:
        video_id = str(uuid.uuid4())[:8]

    base_url = f"https://{bucket_name}.s3.{region}.amazonaws.com"
    results = {}

    try:
        # Upload video
        if os.path.exists(video_path):
            s3_key = f"videos/{video_id}/video.mp4"
            s3_client.upload_file(video_path, bucket_name, s3_key,
                                 ExtraArgs={'ContentType': 'video/mp4'})
            results["video_url"] = f"{base_url}/{s3_key}"

        # Upload actor image
        if actor_image_path and os.path.exists(actor_image_path):
            s3_key = f"videos/{video_id}/actor.png"
            s3_client.upload_file(actor_image_path, bucket_name, s3_key,
                                 ExtraArgs={'ContentType': 'image/png'})
            results["actor_url"] = f"{base_url}/{s3_key}"

        # Build and upload metadata
        import datetime
        metadata["video_id"] = video_id
        metadata["video_url"] = results.get("video_url", "")
        metadata["actor_url"] = results.get("actor_url", "")
        metadata["created_at"] = datetime.datetime.utcnow().isoformat() + "Z"

        meta_json = json.dumps(metadata, ensure_ascii=False, indent=2)
        s3_key = f"videos/{video_id}/metadata.json"
        s3_client.put_object(
            Bucket=bucket_name, Key=s3_key,
            Body=meta_json.encode('utf-8'),
            ContentType='application/json',
        )
        results["metadata_url"] = f"{base_url}/{s3_key}"
        results["video_id"] = video_id

        logger.info(f"Uploaded video gallery: {video_id}")

        # Invalidate cache
        _video_gallery_cache["data"] = None

        return results

    except Exception as e:
        logger.error(f"Failed to upload video to gallery: {e}")
        return None


def list_video_gallery(limit=50, force_refresh=False):
    """
    List all UGC videos from the public S3 bucket.
    Returns list of metadata dicts, newest first.
    """
    global _video_gallery_cache

    now = time_module.time()
    if not force_refresh and _video_gallery_cache["data"] is not None:
        if now - _video_gallery_cache["timestamp"] < CACHE_TTL_SECONDS:
            cached = _video_gallery_cache["data"]
            return cached[:limit] if limit else cached

    bucket_name = os.environ.get('AWS_S3_PUBLIC_BUCKET', 'my-public-bucket')

    s3_client = get_s3_client()
    if not s3_client:
        return []

    videos = []

    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=bucket_name, Prefix='videos/')

        meta_files = []
        for page in pages:
            for obj in page.get('Contents', []):
                if obj['Key'].endswith('/metadata.json'):
                    meta_files.append(obj)

        # Newest first
        meta_files.sort(key=lambda x: x['LastModified'], reverse=True)

        for meta_obj in meta_files:
            try:
                obj_resp = s3_client.get_object(Bucket=bucket_name, Key=meta_obj['Key'])
                content = obj_resp['Body'].read().decode('utf-8')
                data = json.loads(content)
                videos.append(data)
                if limit and len(videos) >= limit:
                    break
            except Exception as e:
                logger.error(f"Error reading metadata {meta_obj['Key']}: {e}")
                continue

    except Exception as e:
        logger.error(f"Failed to list video gallery: {e}")
        return []

    _video_gallery_cache["data"] = videos
    _video_gallery_cache["timestamp"] = now

    return videos[:limit] if limit else videos


def upload_job_artifacts(directory, job_id):
    """
    Upload all generated clips and metadata for a job to S3.
    """
    bucket_name = os.environ.get('AWS_S3_BUCKET', 'my-clips-bucket')
    
    if not os.path.exists(directory):
        return

    for filename in os.listdir(directory):
        # Upload .mp4 clips and the metadata JSON
        if (filename.endswith(".mp4") or filename.endswith(".json")) and not filename.startswith("temp_"):
            file_path = os.path.join(directory, filename)
            s3_key = f"{job_id}/{filename}"
            upload_file_to_s3(file_path, bucket_name, s3_key)


