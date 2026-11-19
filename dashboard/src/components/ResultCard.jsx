import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Download, Share2, Instagram, Youtube, Video, AlertCircle, Loader2, Copy, Check, Wand2, Type, Calendar, Languages, FileText, Link2, Scissors, Crosshair, TrendingUp, ExternalLink, Sparkles } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiFetch } from '../lib/api';
import { track } from '../lib/analytics';
import SubtitleModal from './SubtitleModal';
import HookModal from './HookModal';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import TikTokDraftNotice from './TikTokDraftNotice';
import { useAuth } from '../contexts/AuthContext';
import { renderInBrowser } from '../lib/renderInBrowser';

const QUIET_BTN = 'group flex flex-col items-center justify-center gap-1 py-2.5 sm:py-2 px-1 rounded-input border border-rule hover:bg-paper3 text-[11px] lowercase text-ink2 whitespace-nowrap transition-colors disabled:opacity-45 disabled:cursor-not-allowed';

// Follow an async post (request_id from /api/social/post) for about a minute.
// Returns {done, failed}: done once every platform finished, failed lists
// "platform: reason" for the ones that did not. Unknown or slow = neither.
const POST_TERMINAL = new Set(['completed', 'failed', 'not_found']);
async function followPost(requestId, tries = 12, everyMs = 5000) {
    for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, everyMs));
        let d;
        try {
            const r = await apiFetch(`/api/social/post-status/${encodeURIComponent(requestId)}`);
            if (!r.ok) continue;
            d = await r.json();
        } catch {
            continue;
        }
        if (d.status === 'unknown') return { done: false, failed: [] };
        if (!POST_TERMINAL.has(d.status)) continue;
        const failed = (d.results || [])
            .filter((x) => x.success === false)
            .map((x) => `${x.platform}${x.message ? `: ${x.message}` : ''}`);
        if (d.status !== 'completed' && !failed.length) failed.push('every platform');
        return { done: d.status === 'completed', failed };
    }
    return { done: false, failed: [] };
}

const PLATFORM_OPTIONS = [
    { value: 'tiktok', label: 'tiktok', icon: <Video size={16} /> },
    { value: 'instagram', label: 'instagram', icon: <Instagram size={16} /> },
    { value: 'youtube', label: 'youtube', icon: <Youtube size={16} /> },
];

function clipDurationSeconds(clip) {
    // A recut clip's start/end are the covering source range (segments may be
    // non-contiguous or reordered); its real duration is the segment sum.
    const segments = clip.recipe?.segments;
    if (segments?.length) {
        return segments.reduce((acc, s) => acc + (s.end - s.start), 0);
    }
    return clip.end && clip.start ? clip.end - clip.start : NaN;
}

function formatDuration(clip) {
    const secs = Math.floor(clipDurationSeconds(clip));
    if (!Number.isFinite(secs) || secs < 0) return null;
    return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

export default function ResultCard({ clip, index, jobId, durable, uploadPostKey, uploadUserId, geminiApiKey, elevenLabsKey, isManaged, onPlay, onPause, onBulkSubtitle, clipCount = 1, bulkProgress, initialState = null, onStateChange, connectedPlatforms = null, onConnectSocials, onEditClip = null, onReframeClip = null, onUpgrade = null }) {
    const [showModal, setShowModal] = useState(false);
    // The "why" line is clamped to two lines so cards in a row stay level;
    // when it overflows, a hover (desktop) or tap (touch) shows the whole
    // sentence in a popover that floats over the card instead of growing it.
    const whyRef = useRef(null);
    const [whyOpen, setWhyOpen] = useState(false);
    const [whyClamped, setWhyClamped] = useState(false);
    useEffect(() => {
        const el = whyRef.current;
        if (!el) return;
        const check = () => setWhyClamped(el.scrollHeight > el.clientHeight + 1);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, [clip.why]);
    const [showDescModal, setShowDescModal] = useState(false);
    const [showSubtitleModal, setShowSubtitleModal] = useState(false);
    const { plan } = useAuth();
    const videoRef = React.useRef(null);
    // Pristine base clip (no burned subtitles/hook), stable regardless of how
    // clip.video_url mutates after server edits. Used as the compositing base
    // for the Remotion preview so it never stacks subtitles over an already-
    // subtitled file (double-subtitle bug).
    const stripBurns = (filename) => {
        let f = filename || '', prev;
        do { prev = f; f = f.replace(/^subtitled_\d+_/, '').replace(/^hooked_\d+_/, '').replace(/^hook_/, ''); } while (f !== prev);
        return f;
    };
    const initialVideoUrl = clip.stream_url || getApiUrl(clip.video_url);
    const originalVideoUrl = clip.stream_url || getApiUrl((clip.video_url || '').replace(/[^/]+$/, stripBurns((clip.video_url || '').split('/').pop())));
    const [currentVideoUrl, setCurrentVideoUrl] = useState(initialVideoUrl);
    // Where the <video> element pulls its bytes from. The clips are archived to
    // R2 anyway, and R2 egress is free and edge-served, while /videos is served
    // by the same single-worker API process that is running the renders. So play
    // from R2 when possible.
    //
    // ONLY when R2 holds exactly the file the server considers current for this
    // clip (durable.filename === serverVideoFile). Every server-side edit sends
    // input_filename: serverVideoFile and rewrites clip.video_url, but the R2
    // re-archive behind it is fire-and-forget, so for a few seconds the durable
    // copy is the PRE-edit clip. Preferring it blindly would silently show the
    // clip without the subtitles/hook the user just burned.
    //
    // This is display-only: currentVideoUrl remains the source of truth for the
    // download button and for every server operation, so no edit can be routed
    // to the wrong file by this.
    const [durableSrc, setDurableSrc] = useState(null);
    const [durableFailed, setDurableFailed] = useState(false);
    // Switching src reloads the element and restarts playback, so the durable copy
    // is only ever adopted before the user has touched this player. After an edit
    // the chase in App.jsx can land while they are watching the result, and losing
    // their position to save a few seconds of buffering is a bad trade.
    const [hasPlayed, setHasPlayed] = useState(false);

    // A delivered clip is tens of MB, and on a slow link the old silent
    // fetch-then-save took minutes with nothing on screen, which reads as a dead
    // button. Stream it instead and report progress.
    const [downloadPct, setDownloadPct] = useState(null);

    const downloadClip = async () => {
        try {
            setDownloadPct(0);
            const targetUrl = currentVideoUrl || clip.stream_url;
            if (!targetUrl) throw new Error('Download failed: No URL');
            const response = await fetch(targetUrl);
            if (!response.ok) throw new Error('Download failed');
            const total = Number(response.headers.get('content-length')) || 0;
            let blob;
            // No body reader (old browser) or no length to measure against: fall
            // back to the plain path rather than lose the download.
            if (!response.body || !total) {
                blob = await response.blob();
            } else {
                const reader = response.body.getReader();
                const chunks = [];
                let received = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    setDownloadPct(Math.min(99, Math.round((received / total) * 100)));
                }
                blob = new Blob(chunks, { type: 'video/mp4' });
            }
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `clip-${index + 1}.mp4`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } catch (err) {
            console.error('Download error:', err);
            const fallback = currentVideoUrl || clip.stream_url;
            if (fallback) window.open(fallback, '_blank');
        } finally {
            setDownloadPct(null);
        }
    };
    // Latest file that exists ON THE SERVER (blob: previews don't count).
    // All server-side operations must chain from this, so burned-in edits
    // (subtitles, hooks, effects) never get silently dropped.
    // A reopened project seeds it from the persisted project state.
    const [serverVideoFile, setServerVideoFile] = useState(initialState?.server_file || (clip.video_url || '').split('/').pop());
    const [videoErrored, setVideoErrored] = useState(false);
    const [resolution, setResolution] = useState(null);

    // Adopt the durable copy only while it matches the current server file, and
    // pin the first signed URL seen for that file: /api/history mints a fresh
    // signature on every call, and swapping src mid-playback restarts the video.
    useEffect(() => {
        if (durable?.url && durable.filename && durable.filename === serverVideoFile && !hasPlayed) {
            setDurableSrc((prev) => prev || durable.url);
        } else {
            setDurableSrc(null);
        }
    }, [durable?.url, durable?.filename, serverVideoFile, hasPlayed]);

    // If the local video failed and a durable R2 URL is (now) available, use it.
    // Handles the race where the video errors before the durable URL has loaded.
    // Deliberately NOT version-gated: reaching here means the local file is gone
    // (retention sweep after a reload), so an older durable copy still beats a
    // broken player.
    useEffect(() => {
        if (videoErrored && durable?.url && currentVideoUrl !== durable.url) {
            setCurrentVideoUrl(durable.url);
            setVideoErrored(false);
        }
    }, [videoErrored, durable, currentVideoUrl]);

    // When an external refresh changes this clip's server file (e.g. bulk
    // subtitles applied from another card), adopt it so the card shows the
    // freshly subtitled video instead of a stale one.
    useEffect(() => {
        const serverUrl = clip.stream_url || getApiUrl(clip.video_url);
        const serverName = (clip.video_url || '').split('/').pop();
        if (serverName && serverName !== serverVideoFile) {
            setServerVideoFile(serverName);
            setCurrentVideoUrl(serverUrl);
            setDurableFailed(false);
            setHasPlayed(false);
            if (videoRef.current) videoRef.current.load();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clip.video_url, clip.stream_url]);

    const [platforms, setPlatforms] = useState({
        tiktok: true,
        instagram: true,
        youtube: true
    });
    const [postTitle, setPostTitle] = useState("");
    const [postDescription, setPostDescription] = useState("");
    const [isScheduling, setIsScheduling] = useState(false);
    const [scheduleDate, setScheduleDate] = useState("");

    const [posting, setPosting] = useState(false);
    const [postResult, setPostResult] = useState(null);
    const [copied, setCopied] = useState(null);

    const handleCopy = async (field, text) => {
        try {
            await navigator.clipboard.writeText(text || '');
            setCopied(field);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            // clipboard unavailable — silent
        }
    };

    const [publishProvider, setPublishProvider] = useState('direct');
    const [directPlatforms, setDirectPlatforms] = useState({ youtube: true, instagram: true });
    const [privacyStatus, setPrivacyStatus] = useState('public');
    const [directPosting, setDirectPosting] = useState(false);
    const [directResult, setDirectResult] = useState(null);
    const [socialSettings, setSocialSettings] = useState({
        youtube_connected: false,
        youtube_account_name: '',
        instagram_connected: false,
        instagram_account_name: '',
        youtube_accounts: [],
        instagram_accounts: [],
    });
    const [selectedYtAccountId, setSelectedYtAccountId] = useState('');
    const [selectedIgAccountId, setSelectedIgAccountId] = useState('');

    const [isEditing, setIsEditing] = useState(false);
    const [isSubtitling, setIsSubtitling] = useState(false);
    const [isHooking, setIsHooking] = useState(false);
    const [showHookModal, setShowHookModal] = useState(false);
    const [editError, setEditError] = useState(null);

    const [clipDuration, setClipDuration] = useState(() => {
        const secs = clipDurationSeconds(clip);
        return Number.isFinite(secs) ? secs : 30;
    });

    // Accumulate Remotion layers across operations. A reopened project restores
    // the layers persisted in its project state, so the next edit composes over
    // them instead of silently dropping previous browser-side work.
    const [activeLayers, setActiveLayers] = useState(initialState?.active_layers || { subtitles: null, hook: null, effects: null });

    // Report edit state upward (debounced sync to the project record). Skip the
    // mount run: only user-driven changes are worth persisting.
    const stateReported = React.useRef(false);
    useEffect(() => {
        if (!stateReported.current) { stateReported.current = true; return; }
        onStateChange?.(index, { activeLayers, serverVideoFile });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeLayers, serverVideoFile]);

    // True when the current server file already carries burned-in content.
    // Browser (Remotion) renders compose over the ORIGINAL clip, so using them
    // here would silently drop those burns — chain via server FFmpeg instead.
    const hasServerBurns = /(^|_)(subtitled|hook|hooked)_/.test(serverVideoFile || '');

    // The hook currently burned into the server file (auto-hook or a manual
    // one). /api/hook REPLACES it; tracked locally so the modal stays honest
    // after edits without refetching the job.
    const [burnedHook, setBurnedHook] = useState(clip.auto_hook?.text || null);

    // Fetch clip duration from transcript endpoint
    useEffect(() => {
        if (!jobId || index === undefined) return;
        apiFetch(`/api/clip/${jobId}/${index}/transcript`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data && data.durationSec) setClipDuration(data.durationSec);
            })
            .catch(() => {});
    }, [jobId, index]);

    // Which platforms the selected profile actually has linked. `null` means
    // unknown (profile list not loaded) — in that case nothing is gated.
    const knownConnections = Array.isArray(connectedPlatforms);
    const noAccountsConnected = knownConnections && connectedPlatforms.length === 0;
    const platformOptions = knownConnections
        ? PLATFORM_OPTIONS.map((o) => (connectedPlatforms.includes(o.value) ? o : { ...o, disabled: true, hint: 'not connected' }))
        : PLATFORM_OPTIONS;

    const handleConnectAccounts = () => {
        setShowModal(false);
        if (onConnectSocials) onConnectSocials();
        else window.open('https://app.upload-post.com', '_blank', 'noopener');
    };

    // Initialize/Reset form when modal opens
    useEffect(() => {
        if (showModal) {
            setPostTitle(clip.video_title_for_youtube_short || "Viral Short");
            setPostDescription(clip.video_description_for_instagram || clip.video_description_for_tiktok || "");
            setIsScheduling(false);
            setScheduleDate("");
            setPostResult(null);
            setDirectResult(null);
            apiFetch('/api/settings')
                .then((r) => r.json())
                .then((d) => {
                    setSocialSettings(d);
                    setDirectPlatforms({
                        youtube: !!d.youtube_connected,
                        instagram: !!d.instagram_connected,
                    });
                    if (d.youtube_accounts?.length) setSelectedYtAccountId(d.youtube_accounts[0].id);
                    if (d.instagram_accounts?.length) setSelectedIgAccountId(d.instagram_accounts[0].id);
                })
                .catch(() => {});
            // Only preselect platforms the profile can actually publish to.
            if (knownConnections) {
                setPlatforms({
                    tiktok: connectedPlatforms.includes('tiktok'),
                    instagram: connectedPlatforms.includes('instagram'),
                    youtube: connectedPlatforms.includes('youtube'),
                });
            }
        }
        // Reset only when the modal opens for a clip; connection changes while
        // it is open must not wipe the user's selection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showModal, clip]);

    const handleAutoEdit = async () => {
        setIsEditing(true);
        setEditError(null);
        try {
            const apiKey = geminiApiKey || localStorage.getItem('gemini_key');
            const geminiHeaders = apiKey ? { 'X-Gemini-Key': apiKey } : {};

            // Try Remotion effects endpoint first
            const effectsRes = hasServerBurns ? null : await apiFetch('/api/effects/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...geminiHeaders
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: serverVideoFile
                })
            });

            if (effectsRes && effectsRes.ok) {
                const data = await effectsRes.json();
                if (data.effects && data.effects.segments) {
                    const newLayers = { ...activeLayers, effects: data.effects };
                    setActiveLayers(newLayers);
                    const blobUrl = await renderInBrowser({
                        videoUrl: originalVideoUrl,
                        durationInSeconds: clipDuration,
                        subtitles: newLayers.subtitles,
                        hook: newLayers.hook,
                        effects: newLayers.effects,
                    });
                    setCurrentVideoUrl(blobUrl);
                    if (videoRef.current) videoRef.current.load();
                    return;
                }
            }

            // Fallback: legacy FFmpeg edit endpoint
            const res = await apiFetch('/api/edit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...geminiHeaders
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: serverVideoFile
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                if (videoRef.current) {
                    videoRef.current.load();
                }
            }

        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsEditing(false);
        }
    };

    // Clips are captioned by default, so "no captions" has to be reachable.
    // Nothing is re-encoded: the server still holds the clean file next to the
    // captioned one and just points this clip back at it.
    const handleRemoveSubtitles = async () => {
        setIsSubtitling(true);
        setEditError(null);
        try {
            const res = await apiFetch('/api/subtitle/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId, clip_index: index, input_filename: serverVideoFile,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                const serverUrl = getApiUrl(data.new_video_url);
                setServerVideoFile(data.new_video_url.split('/').pop());
                const remaining = { ...activeLayers, subtitles: null };
                setActiveLayers(remaining);
                if (remaining.hook || remaining.effects) {
                    setCurrentVideoUrl(await renderInBrowser({
                        videoUrl: serverUrl,
                        durationInSeconds: clipDuration,
                        subtitles: null,
                        hook: remaining.hook,
                        effects: remaining.effects,
                    }));
                } else {
                    setCurrentVideoUrl(serverUrl);
                }
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsSubtitling(false);
        }
    };

    const handleSubtitle = async (options) => {
        setIsSubtitling(true);
        setEditError(null);
        try {
            // Karaoke styles are burned server-side (ASS word-highlight render);
            // the in-browser Remotion path only handles classic styles, and only
            // when the server file has no burned-in content to preserve.
            if (options.remotion && options.style !== 'karaoke' && !hasServerBurns) {
                // Accumulate layer and render all layers together
                const newLayers = { ...activeLayers, subtitles: options.remotion };
                setActiveLayers(newLayers);
                const blobUrl = await renderInBrowser({
                    videoUrl: originalVideoUrl,
                    durationInSeconds: clipDuration,
                    subtitles: newLayers.subtitles,
                    hook: newLayers.hook,
                    effects: newLayers.effects,
                });
                setCurrentVideoUrl(blobUrl);
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
                return;
            }

            // Fallback: legacy FFmpeg
            const res = await apiFetch('/api/subtitle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    position: options.position,
                    font_size: options.fontSize,
                    font_name: options.fontName,
                    font_color: options.fontColor,
                    border_color: options.borderColor,
                    border_width: options.borderWidth,
                    bg_color: options.bgColor,
                    bg_opacity: options.bgOpacity,
                    style: options.style || 'classic',
                    highlight_color: options.highlightColor || '#FFD700',
                    effect: options.effect || 'none',
                    base_opacity: options.baseOpacity ?? 1.0,
                    uppercase: options.uppercase || false,
                    reveal: options.reveal || false,
                    shadow: options.shadow || 0,
                    max_chars: options.maxChars ?? null,
                    max_duration: options.maxDuration ?? null,
                    input_filename: serverVideoFile,
                    subtitle_script: options.subtitle_script || clip?.subtitle_script || 'auto',
                    // Edited caption text (clip-relative ms); null = server
                    // regenerates from the transcript as before.
                    words: options.captions || null
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                const serverUrl = getApiUrl(data.new_video_url);
                setServerVideoFile(data.new_video_url.split('/').pop());
                // Subtitles are burned into the server file now — drop the
                // browser subtitle layer and re-compose any remaining browser
                // layers (hook/effects) over the new file so they aren't lost.
                const remaining = { ...activeLayers, subtitles: null };
                setActiveLayers(remaining);
                if (remaining.hook || remaining.effects) {
                    const blobUrl = await renderInBrowser({
                        videoUrl: serverUrl,
                        durationInSeconds: clipDuration,
                        subtitles: null,
                        hook: remaining.hook,
                        effects: remaining.effects,
                    });
                    setCurrentVideoUrl(blobUrl);
                } else {
                    setCurrentVideoUrl(serverUrl);
                }
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsSubtitling(false);
        }
    };

    const handleHook = async (hookData) => {
        setIsHooking(true);
        setEditError(null);
        try {
            if (hookData.remotion && !hasServerBurns) {
                // Accumulate layer and render all layers together
                const newLayers = { ...activeLayers, hook: hookData.remotion };
                setActiveLayers(newLayers);
                const blobUrl = await renderInBrowser({
                    videoUrl: originalVideoUrl,
                    durationInSeconds: clipDuration,
                    subtitles: newLayers.subtitles,
                    hook: newLayers.hook,
                    effects: newLayers.effects,
                });
                setCurrentVideoUrl(blobUrl);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
                return;
            }

            // Fallback: legacy FFmpeg
            const payload = typeof hookData === 'string'
                ? { text: hookData, position: 'top', size: 'M' }
                : hookData;

            const res = await apiFetch('/api/hook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    text: payload.text,
                    position: payload.position,
                    size: payload.size,
                    style: payload.style || 'pill',
                    font: payload.font || null,
                    duration_seconds: payload.remotion?.displayDurationSec ?? null,
                    input_filename: serverVideoFile
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                setBurnedHook(data.burned_hook?.text ?? payload.text ?? null);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsHooking(false);
        }
    };

    // Strip the burned hook (auto-hook or manual) off the server file.
    const handleRemoveHook = async () => {
        setIsHooking(true);
        setEditError(null);
        try {
            const res = await apiFetch('/api/hook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    remove: true,
                    input_filename: serverVideoFile,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                setBurnedHook(null);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsHooking(false);
        }
    };

    const handleDirectPublish = async () => {
        if (!directPlatforms.youtube && !directPlatforms.instagram) {
            setDirectResult({ success: false, msg: "Please select at least one platform.", links: [] });
            return;
        }
        if (directPlatforms.youtube && !socialSettings.youtube_connected) {
            setDirectResult({ success: false, msg: "YouTube is not connected yet. Please configure in Settings.", links: [] });
            return;
        }
        if (directPlatforms.instagram && !socialSettings.instagram_connected) {
            setDirectResult({ success: false, msg: "Instagram is not connected yet. Please configure in Settings.", links: [] });
            return;
        }

        setDirectPosting(true);
        setDirectResult({ success: null, msg: "Starting upload...", links: [] });

        const links = [];
        const errors = [];

        try {
            if (directPlatforms.youtube) {
                setDirectResult((prev) => ({ ...prev, msg: "Uploading to YouTube Shorts..." }));
                const ytRes = await apiFetch('/api/publish/youtube/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        job_id: jobId,
                        clip_index: index,
                        title: postTitle,
                        description: postDescription,
                        privacy_status: privacyStatus,
                        account_id: selectedYtAccountId ? Number(selectedYtAccountId) : null,
                    }),
                });
                if (!ytRes.ok) {
                    const errData = await ytRes.json().catch(() => ({ detail: ytRes.statusText }));
                    errors.push(`YouTube: ${errData.detail || 'Upload failed'}`);
                } else {
                    const ytData = await ytRes.json();
                    if (ytData.remote_url) links.push({ platform: 'YouTube Shorts', url: ytData.remote_url });
                }
            }

            if (directPlatforms.instagram) {
                setDirectResult((prev) => ({ ...prev, msg: "Uploading to Instagram Reels..." }));
                const igRes = await apiFetch('/api/publish/instagram/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        job_id: jobId,
                        clip_index: index,
                        caption: postDescription,
                        account_id: selectedIgAccountId ? Number(selectedIgAccountId) : null,
                    }),
                });
                if (!igRes.ok) {
                    const errData = await igRes.json().catch(() => ({ detail: igRes.statusText }));
                    errors.push(`Instagram: ${errData.detail || 'Upload failed'}`);
                } else {
                    const igData = await igRes.json();
                    if (igData.remote_url) links.push({ platform: 'Instagram Reels', url: igData.remote_url });
                }
            }

            if (errors.length > 0) {
                setDirectResult({
                    success: links.length > 0 ? true : false,
                    msg: links.length > 0 ? `Partial success. ${errors.join('; ')}` : errors.join('; '),
                    links,
                });
            } else {
                setDirectResult({
                    success: true,
                    msg: "Published successfully!",
                    links,
                });
            }

            if (links.length > 0) {
                clip.published_posts = clip.published_posts || [];
                links.forEach((l) => {
                    const plat = l.platform.toLowerCase().includes('youtube') ? 'youtube' : 'instagram';
                    if (!clip.published_posts.some((p) => p.url === l.url)) {
                        clip.published_posts.push({
                            platform: plat,
                            url: l.url,
                            status: 'success',
                        });
                    }
                });
            }
        } catch (err) {
            setDirectResult({ success: false, msg: err.message || "Publish failed", links: [] });
        } finally {
            setDirectPosting(false);
        }
    };

    // Managed (cloud plan/trial) users post with the server-side key — no BYOK needed
    const canPost = isManaged || (uploadPostKey && uploadUserId);

    const handlePost = async () => {
        if (!canPost) {
            setPostResult({ success: false, msg: "Missing API Key or User ID." });
            return;
        }

        if (noAccountsConnected) {
            setPostResult({ success: false, msg: "Connect a social account first." });
            return;
        }

        const selectedPlatforms = Object.keys(platforms).filter(k => platforms[k]);
        if (selectedPlatforms.length === 0) {
            setPostResult({ success: false, msg: "Select at least one platform." });
            return;
        }

        if (isScheduling && !scheduleDate) {
            setPostResult({ success: false, msg: "Please select a date and time." });
            return;
        }

        setPosting(true);
        setPostResult(null);

        try {
            const payload = {
                job_id: jobId,
                clip_index: index,
                api_key: uploadPostKey,
                user_id: uploadUserId,
                platforms: selectedPlatforms,
                title: postTitle,
                description: postDescription
            };

            if (isScheduling && scheduleDate) {
                // Convert to ISO-8601
                payload.scheduled_date = new Date(scheduleDate).toISOString();
                // Optional: pass timezone if needed, backend defaults to UTC or we can send user's timezone
                payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            }

            const res = await apiFetch('/api/social/post', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                let detail = errText;
                try { detail = JSON.parse(errText).detail || errText; } catch { /* not JSON */ }
                throw new Error(detail);
            }

            const sent = await res.json().catch(() => ({}));
            if (isScheduling || !sent?.request_id) {
                setPostResult({ success: true, msg: isScheduling ? "Scheduled successfully!" : "Sent for publishing." });
                setTimeout(() => {
                    setShowModal(false);
                    setPostResult(null);
                }, 3000);
                return;
            }
            // A 200 only means Upload-Post took the file: follow the post to
            // its real end, so a platform that fails says so here.
            setPostResult({ success: true, msg: "Publishing…" });
            const outcome = await followPost(sent.request_id);
            if (outcome.failed.length) {
                setPostResult({ success: false, msg: `Failed on ${outcome.failed.join('; ')}` });
                track('SocialPostFailed', { props: { platforms: selectedPlatforms.join(',') } });
            } else {
                setPostResult({ success: true, msg: outcome.done ? "Posted successfully!" : "Still publishing: check your accounts in a few minutes." });
                setTimeout(() => {
                    setShowModal(false);
                    setPostResult(null);
                }, 3000);
            }

        } catch (e) {
            setPostResult({ success: false, msg: `Failed: ${e.message}` });
        } finally {
            setPosting(false);
        }
    };

    // Browser-rendered previews (Remotion) live in a blob: URL that exists only
    // in this tab, so they always win over the durable copy.
    const playbackUrl = (durableSrc && !durableFailed && !String(currentVideoUrl || '').startsWith('blob:'))
        ? durableSrc
        : (currentVideoUrl || clip.stream_url);

    const durationReadout = formatDuration(clip);

    const clipHashtags = useMemo(() => {
        if (Array.isArray(clip.tags) && clip.tags.length > 0) {
            return clip.tags.slice(0, 5);
        }
        const text = `${clip.video_description_for_tiktok || ''} ${clip.video_description_for_instagram || ''} ${clip.video_title_for_youtube_short || ''}`;
        const matches = text.match(/#[a-zA-Z0-9_]+/g);
        if (matches && matches.length > 0) {
            return Array.from(new Set(matches)).slice(0, 5);
        }
        return ['#Shorts', '#Viral', '#Trending'];
    }, [clip]);

    return (
        <div className="card overflow-hidden flex flex-col md:flex-row group border border-rule hover:border-rule2 bg-paper transition-all duration-200 animate-fade" style={{ animationDelay: `${index * 0.05}s` }}>
            {/* Left: Video Preview — Strict 9:16 portrait container matching vertical shorts */}
            <div className="w-full max-w-[280px] md:max-w-none mx-auto md:mx-0 md:w-[240px] lg:w-[250px] aspect-[9/16] bg-black relative shrink-0 overflow-hidden self-start rounded-t-card md:rounded-l-card md:rounded-tr-none flex items-center justify-center group/video">
                <video
                    ref={videoRef}
                    src={playbackUrl}
                    controls
                    className="w-full h-full object-contain bg-black"
                    playsInline
                    onLoadedMetadata={(e) => {
                        if (e.target.videoWidth) setResolution(`${e.target.videoWidth}×${e.target.videoHeight}`);
                    }}
                    onError={() => {
                        if (playbackUrl === durableSrc) {
                            setDurableFailed(true);
                            return;
                        }
                        if (clip.stream_url && currentVideoUrl !== clip.stream_url) {
                            setCurrentVideoUrl(clip.stream_url);
                            return;
                        }
                        if (durable?.url && currentVideoUrl !== durable.url) setCurrentVideoUrl(durable.url);
                        else setVideoErrored(true);
                    }}
                    onPlay={() => {
                        setHasPlayed(true);
                        const currentTime = videoRef.current ? videoRef.current.currentTime : 0;
                        onPlay && onPlay(clip.start + currentTime);
                    }}
                    onPause={() => onPause && onPause()}
                    onEnded={() => {
                        if (videoRef.current) {
                            videoRef.current.currentTime = 0;
                            videoRef.current.play();
                        }
                    }}
                />
                
                {/* Modern Floating Badges */}
                <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-1.5 pointer-events-none z-10">
                    <span className="bg-black/80 backdrop-blur-md text-white font-mono text-[11px] font-semibold px-2.5 py-1 rounded-full border border-white/10 shadow-sm flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-brandblue" />
                        <span>Clip {index + 1}</span>
                    </span>

                    {Number.isFinite(clip.predicted_score) && (
                        <span
                            className="bg-black/80 backdrop-blur-md font-mono text-[11px] px-2.5 py-1 rounded-full border border-white/10 shadow-sm flex items-center gap-1.5"
                            title="ClipSnipr viral score prediction (0 to 100)"
                        >
                            <TrendingUp size={11} className={clip.predicted_score >= 80 ? 'text-emerald-400' : 'text-amber-400'} />
                            <span className="text-white/70 text-[10px] uppercase font-bold tracking-wider">Viral</span>
                            <b className={
                                clip.predicted_score >= 80 ? 'text-emerald-400 font-bold'
                                    : clip.predicted_score >= 65 ? 'text-amber-300 font-bold'
                                        : 'text-white font-bold'
                            }>
                                {clip.predicted_score}
                            </b>
                            <span className="text-white/40 text-[10px]">/100</span>
                        </span>
                    )}
                </div>

                {/* Auto Edit Overlay if Processing */}
                {isEditing && (
                    <div className="absolute inset-0 bg-black/75 backdrop-blur-xs flex flex-col items-center justify-center z-10 p-4 text-center">
                        <Loader2 size={28} className="text-brass animate-spin mb-3" />
                        <span className="text-xs text-ink lowercase">ai magic in progress…</span>
                        <span className="readout mt-1.5">APPLYING VIRAL EDITS · ZOOMS</span>
                    </div>
                )}
            </div>

            {/* Right: Content & Details */}
            <div className="flex-1 p-4 md:p-5 flex flex-col overflow-hidden min-w-0 justify-between">
                <div>
                    <div className="mb-3">
                        <h3 className="text-base font-bold text-ink leading-snug line-clamp-2 mb-2 break-words" title={clip.video_title_for_youtube_short}>
                            {clip.video_title_for_youtube_short || "Viral Clip Generated"}
                        </h3>
                        {clip.why && (
                            <div
                                className="relative mb-2.5"
                                onMouseEnter={() => setWhyOpen(true)}
                                onMouseLeave={() => setWhyOpen(false)}
                            >
                                <p
                                    ref={whyRef}
                                    className={`text-xs text-muted leading-relaxed line-clamp-2 break-words ${whyClamped ? 'cursor-pointer hover:text-ink2' : ''}`}
                                    onClick={() => whyClamped && setWhyOpen(v => !v)}
                                    aria-label="why this moment was selected"
                                >
                                    {clip.why}
                                </p>
                                {whyClamped && whyOpen && (
                                    <div
                                        role="tooltip"
                                        className="absolute left-0 right-0 top-full mt-1 z-20 bg-paper border border-rule rounded-input px-3 py-2 text-xs text-ink leading-snug shadow-lg"
                                    >
                                        {clip.why}
                                    </div>
                                )}
                            </div>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5">
                            {durationReadout && <span className="readout bg-paper3 px-2 py-0.5 rounded-full shrink-0 font-medium">{durationReadout}</span>}
                            {resolution && <span className="readout bg-paper3 px-2 py-0.5 rounded-full shrink-0 font-medium">{resolution}</span>}
                            {clipHashtags.map((tag, tIdx) => (
                                <span key={tIdx} className="readout bg-paper3 px-2 py-0.5 rounded-full shrink-0 text-ink2 font-medium">
                                    {tag.startsWith('#') ? tag : `#${tag}`}
                                </span>
                            ))}
                            {clip.published_posts && clip.published_posts.length > 0 && (
                                clip.published_posts.map((post, pIdx) => (
                                    <a
                                        key={pIdx}
                                        href={post.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-mono font-medium rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors shrink-0"
                                        title={`Posted to ${post.platform === 'youtube' ? 'YouTube Shorts' : 'Instagram Reels'}${post.account_name ? ` (${post.account_name})` : ''}`}
                                    >
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                                        <span>Posted ({post.platform === 'youtube' ? 'YouTube' : 'Instagram'})</span>
                                        <ExternalLink size={10} />
                                    </a>
                                ))
                            )}
                        </div>
                    </div>

                    {/* Social Copy Bar (Quick Copy & Full View) */}
                    <div className="bg-paper2/90 rounded-xl p-2.5 border border-rule/80 space-y-2 mb-3">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono uppercase tracking-wider text-muted font-bold flex items-center gap-1.5">
                                <Share2 size={11} className="text-brandblue" />
                                <span>Social Copy & Metadata</span>
                            </span>
                            <button
                                onClick={() => setShowDescModal(true)}
                                className="text-[11px] font-medium text-brandblue hover:text-brandblue/80 flex items-center gap-1 transition-colors"
                                title="View full generated captions and hashtags"
                            >
                                <FileText size={12} />
                                <span>View Full Copy</span>
                            </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => handleCopy('youtube', clip.video_title_for_youtube_short || "Viral Short Video")}
                                className={`flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
                                    copied === 'youtube'
                                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 font-medium'
                                        : 'bg-paper border-rule hover:border-rule2 text-ink2 hover:text-ink'
                                }`}
                                title={clip.video_title_for_youtube_short || "Viral Short Video"}
                            >
                                <span className="flex items-center gap-1.5 truncate min-w-0 text-[11px]">
                                    <Youtube size={13} className="text-red-400 shrink-0" />
                                    <span className="truncate">{copied === 'youtube' ? 'Copied Title!' : 'Copy YT Title'}</span>
                                </span>
                                {copied === 'youtube' ? <Check size={12} className="shrink-0 text-emerald-400" /> : <Copy size={12} className="shrink-0 text-muted" />}
                            </button>

                            <button
                                onClick={() => handleCopy('caption', clip.video_description_for_tiktok || clip.video_description_for_instagram || clip.video_title_for_youtube_short)}
                                className={`flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
                                    copied === 'caption'
                                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 font-medium'
                                        : 'bg-paper border-rule hover:border-rule2 text-ink2 hover:text-ink'
                                }`}
                                title={clip.video_description_for_tiktok || clip.video_description_for_instagram}
                            >
                                <span className="flex items-center gap-1.5 truncate min-w-0 text-[11px]">
                                    <Instagram size={13} className="text-pink-400 shrink-0" />
                                    <span className="truncate">{copied === 'caption' ? 'Copied Caption!' : 'Copy Caption'}</span>
                                </span>
                                {copied === 'caption' ? <Check size={12} className="shrink-0 text-emerald-400" /> : <Copy size={12} className="shrink-0 text-muted" />}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Error Message */}
                {editError && (
                    <div className="mb-3 px-3 py-2 rounded-input text-xs text-danger bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] flex items-center gap-2">
                        <AlertCircle size={14} className="shrink-0" />
                        {editError}
                    </div>
                )}

                {/* Actions Footer */}
                <div className="mt-auto pt-3 border-t border-rule space-y-2">
                    {/* Editor & AI Tools: Clean spacious horizontal toolbar */}
                    <div className="flex flex-wrap items-center gap-2">
                        {onEditClip && (
                            <button
                                onClick={() => onEditClip(index)}
                                className="group flex-1 min-w-[70px] sm:min-w-[80px] flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border border-rule bg-paper hover:bg-paper2 text-xs font-medium text-ink2 hover:text-ink transition-colors shadow-xs"
                                title="Trim, cut or adjust clip segments"
                            >
                                <Scissors size={14} className="text-muted group-hover:text-brandblue transition-colors shrink-0" />
                                <span className="whitespace-nowrap">Edit</span>
                            </button>
                        )}

                        {onReframeClip && (
                            <button
                                onClick={() => onReframeClip(index)}
                                className="group flex-1 min-w-[70px] sm:min-w-[80px] flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border border-rule bg-paper hover:bg-paper2 text-xs font-medium text-ink2 hover:text-ink transition-colors shadow-xs"
                                title="Reframe video focus to 9:16 vertical crop"
                            >
                                <Crosshair size={14} className="text-muted group-hover:text-brandblue transition-colors shrink-0" />
                                <span className="whitespace-nowrap">Reframe</span>
                            </button>
                        )}

                        <button
                            onClick={handleAutoEdit}
                            disabled={isEditing}
                            className="group flex-1 min-w-[80px] sm:min-w-[90px] flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border border-rule bg-paper hover:bg-paper2 text-xs font-medium text-ink2 hover:text-ink transition-colors disabled:opacity-40 shadow-xs"
                            title="Apply AI zooms, jump cuts and visual pacing"
                        >
                            {isEditing ? <Loader2 size={14} className="animate-spin text-brass shrink-0" /> : <Wand2 size={14} className="text-muted group-hover:text-brass transition-colors shrink-0" />}
                            <span className="whitespace-nowrap">{isEditing ? 'Editing…' : 'Auto Edit'}</span>
                        </button>

                        <button
                            onClick={() => setShowSubtitleModal(true)}
                            disabled={isSubtitling}
                            className="group flex-1 min-w-[75px] sm:min-w-[85px] flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border border-rule bg-paper hover:bg-paper2 text-xs font-medium text-ink2 hover:text-ink transition-colors disabled:opacity-40 shadow-xs"
                            title="Customize animated subtitles, colors and fonts"
                        >
                            {isSubtitling ? <Loader2 size={14} className="animate-spin text-brass shrink-0" /> : <Type size={14} className="text-muted group-hover:text-brass transition-colors shrink-0" />}
                            <span className="whitespace-nowrap">{isSubtitling ? 'Adding…' : 'Captions'}</span>
                        </button>

                        <button
                            onClick={() => setShowHookModal(true)}
                            disabled={isHooking}
                            className="group flex-1 min-w-[70px] sm:min-w-[80px] flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg border border-rule bg-paper hover:bg-paper2 text-xs font-medium text-ink2 hover:text-ink transition-colors disabled:opacity-40 shadow-xs"
                            title="Edit opening hook text overlay"
                        >
                            {isHooking ? <Loader2 size={14} className="animate-spin text-brass shrink-0" /> : <Sparkles size={14} className="text-muted group-hover:text-brass transition-colors shrink-0" />}
                            <span className="whitespace-nowrap">{isHooking ? 'Saving…' : 'Hook'}</span>
                        </button>
                    </div>

                    {/* Primary Actions: Download & Publish */}
                    <div className="grid grid-cols-2 gap-3 pt-1">
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                downloadClip();
                            }}
                            disabled={downloadPct !== null}
                            className="btn-ghost flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-xs font-semibold border border-rule text-ink hover:bg-paper3 transition-colors"
                            title="Download MP4 video clip to your device"
                        >
                            {downloadPct !== null ? (
                                <>
                                    <Loader2 size={14} className="animate-spin text-brandblue shrink-0" />
                                    <span>{downloadPct}%</span>
                                </>
                            ) : (
                                <>
                                    <Download size={14} className="shrink-0 text-muted" />
                                    <span>Download Short</span>
                                </>
                            )}
                        </button>

                        <button
                            onClick={() => setShowModal(true)}
                            className="btn-green flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-xs font-bold text-white shadow-xs transition-all hover:brightness-110"
                            title="Publish directly to YouTube Shorts, TikTok or Instagram Reels"
                        >
                            <Share2 size={14} className="shrink-0" />
                            <span>Post to Socials</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Descriptions Modal */}
            <Modal
                isOpen={showDescModal}
                onClose={() => setShowDescModal(false)}
                eyebrow="GENERATED COPY"
                title="descriptions"
                size="md"
            >
                <div className="space-y-4">
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                            <label className="eyebrow">YOUTUBE TITLE</label>
                            <button
                                onClick={() => handleCopy('youtube', clip.video_title_for_youtube_short || "Viral Short Video")}
                                aria-label="copy youtube title"
                                className="p-1 rounded-full text-muted hover:text-brass transition-colors shrink-0"
                            >
                                {copied === 'youtube' ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                            </button>
                        </div>
                        <p className="text-sm text-ink2 select-all break-words bg-paper rounded-input p-3 border border-rule">
                            {clip.video_title_for_youtube_short || "Viral Short Video"}
                        </p>
                    </div>

                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                            <label className="eyebrow">TIKTOK · IG CAPTION</label>
                            <button
                                onClick={() => handleCopy('caption', clip.video_description_for_tiktok || clip.video_description_for_instagram)}
                                aria-label="copy caption"
                                className="p-1 rounded-full text-muted hover:text-brass transition-colors shrink-0"
                            >
                                {copied === 'caption' ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                            </button>
                        </div>
                        <p className="text-sm text-ink2 select-all break-words bg-paper rounded-input p-3 border border-rule whitespace-pre-wrap">
                            {clip.video_description_for_tiktok || clip.video_description_for_instagram}
                        </p>
                    </div>
                </div>
            </Modal>

            {/* Post Modal */}
            <Modal
                isOpen={showModal}
                onClose={() => setShowModal(false)}
                eyebrow="PUBLISH"
                title="publish clip"
                size="md"
                footer={
                    publishProvider === 'direct' ? (
                        <button
                            onClick={handleDirectPublish}
                            disabled={directPosting || (!directPlatforms.youtube && !directPlatforms.instagram)}
                            className="btn-primary w-full"
                        >
                            {directPosting ? <><Loader2 size={16} className="animate-spin" /> publishing…</> : <><Share2 size={16} /> publish now</>}
                        </button>
                    ) : noAccountsConnected ? (
                        <button onClick={handleConnectAccounts} className="btn-primary w-full">
                            <Link2 size={16} /> connect accounts
                        </button>
                    ) : (
                        <button
                            onClick={handlePost}
                            disabled={posting || !canPost}
                            className="btn-primary w-full"
                        >
                            {posting ? <><Loader2 size={16} className="animate-spin" /> {isScheduling ? 'scheduling…' : 'publishing…'}</> : <><Share2 size={16} /> {isScheduling ? 'schedule post' : 'publish now'}</>}
                        </button>
                    )
                }
            >
                <div className="mb-4">
                    <label className="eyebrow block mb-1.5">PUBLISHING ENGINE</label>
                    <SegmentedControl
                        columns={2}
                        options={[
                            { value: 'direct', label: 'Direct Publish (Inbuilt)' },
                            { value: 'upload_post', label: 'Upload-Post' },
                        ]}
                        value={publishProvider}
                        onChange={setPublishProvider}
                    />
                </div>

                {publishProvider === 'direct' ? (
                    <div className="space-y-4 animate-fade">
                        <div>
                            <label className="eyebrow block mb-2">TARGET PLATFORMS</label>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setDirectPlatforms((p) => ({ ...p, youtube: !p.youtube }))}
                                    className={`p-3 rounded-input border text-left transition-all flex flex-col gap-1.5 ${directPlatforms.youtube ? 'border-brass bg-paper3' : 'border-rule bg-paper opacity-70'}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5 text-sm font-medium">
                                            <Youtube size={16} className="text-red-500" />
                                            <span>YouTube Shorts</span>
                                        </div>
                                        <input type="checkbox" checked={directPlatforms.youtube} readOnly className="accent-brass pointer-events-none" />
                                    </div>
                                    <span className="text-[11px] text-muted truncate">
                                        {socialSettings.youtube_connected ? (
                                            <span className="text-ok">✓ Connected ({socialSettings.youtube_account_name || 'Channel'})</span>
                                        ) : (
                                            <span className="text-warn">Not connected in Settings</span>
                                        )}
                                    </span>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setDirectPlatforms((p) => ({ ...p, instagram: !p.instagram }))}
                                    className={`p-3 rounded-input border text-left transition-all flex flex-col gap-1.5 ${directPlatforms.instagram ? 'border-brass bg-paper3' : 'border-rule bg-paper opacity-70'}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5 text-sm font-medium">
                                            <Instagram size={16} className="text-pink-500" />
                                            <span>Instagram Reels</span>
                                        </div>
                                        <input type="checkbox" checked={directPlatforms.instagram} readOnly className="accent-brass pointer-events-none" />
                                    </div>
                                    <span className="text-[11px] text-muted truncate">
                                        {socialSettings.instagram_connected ? (
                                            <span className="text-ok">✓ Connected (@{socialSettings.instagram_account_name})</span>
                                        ) : (
                                            <span className="text-warn">Not connected in Settings</span>
                                        )}
                                    </span>
                                </button>
                            </div>

                            {directPlatforms.youtube && socialSettings.youtube_accounts?.length > 1 && (
                                <div className="mt-2.5">
                                    <label className="text-[10px] font-mono text-muted uppercase block mb-1">Target YouTube Channel</label>
                                    <select
                                        value={selectedYtAccountId}
                                        onChange={(e) => setSelectedYtAccountId(e.target.value)}
                                        className="input-field text-xs select cursor-pointer"
                                    >
                                        {socialSettings.youtube_accounts.map((acc) => (
                                            <option key={acc.id} value={acc.id}>
                                                {acc.account_name || `Account #${acc.id}`} {acc.account_id ? `(${acc.account_id})` : ''}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {directPlatforms.instagram && socialSettings.instagram_accounts?.length > 1 && (
                                <div className="mt-2.5">
                                    <label className="text-[10px] font-mono text-muted uppercase block mb-1">Target Instagram Account</label>
                                    <select
                                        value={selectedIgAccountId}
                                        onChange={(e) => setSelectedIgAccountId(e.target.value)}
                                        className="input-field text-xs select cursor-pointer"
                                    >
                                        {socialSettings.instagram_accounts.map((acc) => (
                                            <option key={acc.id} value={acc.id}>
                                                {acc.account_name ? `@${acc.account_name}` : `Account #${acc.id}`}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="eyebrow block mb-1.5">TITLE</label>
                            <input
                                type="text"
                                value={postTitle}
                                onChange={(e) => setPostTitle(e.target.value)}
                                className="input-field"
                                placeholder="Short video title…"
                            />
                        </div>

                        <div>
                            <label className="eyebrow block mb-1.5">CAPTION / DESCRIPTION</label>
                            <textarea
                                value={postDescription}
                                onChange={(e) => setPostDescription(e.target.value)}
                                rows={3}
                                className="input-field resize-none"
                                placeholder="Write caption (hashtags, description)…"
                            />
                        </div>

                        {directPlatforms.youtube && (
                            <div>
                                <label className="eyebrow block mb-1.5">YOUTUBE PRIVACY STATUS</label>
                                <select
                                    value={privacyStatus}
                                    onChange={(e) => setPrivacyStatus(e.target.value)}
                                    className="input-field select cursor-pointer"
                                >
                                    <option value="public">Public</option>
                                    <option value="unlisted">Unlisted</option>
                                    <option value="private">Private</option>
                                </select>
                            </div>
                        )}

                        {directResult && (
                            <div className="space-y-2">
                                <div className={directResult.success === true ? 'badge-ok' : directResult.success === false ? 'badge-danger' : 'badge-warn'}>
                                    {directResult.success === true ? <Check size={14} className="shrink-0" /> : directResult.success === false ? <AlertCircle size={14} className="shrink-0" /> : <Loader2 size={14} className="animate-spin shrink-0" />}
                                    <span>{directResult.msg}</span>
                                </div>
                                {directResult.links && directResult.links.length > 0 && (
                                    <div className="flex flex-col gap-1.5 pt-1">
                                        {directResult.links.map((link, idx) => (
                                            <a
                                                key={idx}
                                                href={link.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-xs text-brass underline hover:opacity-80 flex items-center gap-1.5"
                                            >
                                                <span>View on {link.platform} →</span>
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4 animate-fade">
                        {!canPost && (
                            <div className="mb-4 px-3 py-2 rounded-input text-xs text-warn bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] flex items-start gap-2">
                                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                <div className="lowercase">configure api key in settings first.</div>
                            </div>
                        )}

                        {noAccountsConnected && (
                            <div className="mb-4 px-3 py-2 rounded-input text-xs text-warn bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] flex items-start gap-2">
                                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                <div className="lowercase">no social accounts connected yet — link tiktok, instagram or youtube to publish this clip.</div>
                            </div>
                        )}

                        {platforms.tiktok && <TikTokDraftNotice />}

                        <div>
                            <label className="eyebrow block mb-1.5">TITLE</label>
                            <input
                                type="text"
                                value={postTitle}
                                onChange={(e) => setPostTitle(e.target.value)}
                                className="input-field"
                                placeholder="enter a catchy title…"
                            />
                        </div>

                        <div>
                            <label className="eyebrow block mb-1.5">CAPTION</label>
                            <textarea
                                value={postDescription}
                                onChange={(e) => setPostDescription(e.target.value)}
                                rows={3}
                                className="input-field resize-none"
                                placeholder="write a caption for your post…"
                            />
                        </div>

                        <div className="p-3 bg-paper rounded-input border border-rule">
                            <label className="flex items-center justify-between cursor-pointer">
                                <span className="flex items-center gap-2 text-sm text-ink2 lowercase">
                                    <Calendar size={16} className={isScheduling ? 'text-brass' : 'text-muted'} /> schedule post
                                </span>
                                <input
                                    type="checkbox"
                                    checked={isScheduling}
                                    onChange={(e) => setIsScheduling(e.target.checked)}
                                    className="w-4 h-4 accent-brass cursor-pointer"
                                />
                            </label>

                            {isScheduling && (
                                <div className="mt-3 animate-fade">
                                    <label className="eyebrow block mb-1.5">DATE · TIME</label>
                                    <input
                                        type="datetime-local"
                                        value={scheduleDate}
                                        onChange={(e) => setScheduleDate(e.target.value)}
                                        className="input-field [color-scheme:dark]"
                                    />
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="eyebrow block mb-2">PLATFORMS</label>
                            <SegmentedControl
                                multi
                                columns={3}
                                options={platformOptions}
                                value={Object.keys(platforms).filter((k) => platforms[k])}
                                onChange={(arr) => setPlatforms({
                                    tiktok: arr.includes('tiktok'),
                                    instagram: arr.includes('instagram'),
                                    youtube: arr.includes('youtube'),
                                })}
                            />
                        </div>

                        {postResult && (
                            <div className={postResult.success ? 'badge-ok' : 'badge-danger'}>
                                {postResult.success ? <Check size={12} className="shrink-0" /> : <AlertCircle size={12} className="shrink-0" />}
                                {postResult.msg}
                            </div>
                        )}
                    </div>
                )}
            </Modal>

            <SubtitleModal
                isOpen={showSubtitleModal}
                onClose={() => setShowSubtitleModal(false)}
                onGenerate={handleSubtitle}
                onApplyAll={onBulkSubtitle ? async (options) => {
                    await onBulkSubtitle(options);
                    setShowSubtitleModal(false);
                } : undefined}
                onRemove={handleRemoveSubtitles}
                bulkCount={clipCount}
                bulkProgress={bulkProgress}
                isProcessing={isSubtitling || (bulkProgress?.running ?? false)}
                videoUrl={originalVideoUrl}
                jobId={jobId}
                clipIndex={index}
                existingHook={activeLayers.hook}
                subtitleScript={clip?.subtitle_script || 'auto'}
            />

            <HookModal
                isOpen={showHookModal}
                onClose={() => setShowHookModal(false)}
                onGenerate={handleHook}
                isProcessing={isHooking}
                videoUrl={originalVideoUrl}
                initialText={clip.viral_hook_text}
                durationInSeconds={clip.end && clip.start ? clip.end - clip.start : 30}
                existingSubtitles={activeLayers.subtitles}
                hasCaptions={!!activeLayers.subtitles || /(^|_)subtitled_/.test(serverVideoFile || '')}
                serverRender={hasServerBurns}
                burnedHook={burnedHook}
                onRemove={burnedHook ? handleRemoveHook : null}
            />

        </div>
    );
}
