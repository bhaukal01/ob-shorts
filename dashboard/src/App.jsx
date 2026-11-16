import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Upload, Sparkles, Youtube, Instagram, Share2, ChevronDown, Check, Activity, LayoutDashboard, Settings, Plus, History, X, Terminal, Shield, LayoutGrid, Image, Globe, RotateCcw, Calendar, AlertTriangle, KeyRound, Bot, Users, Smartphone, ExternalLink, Copy, CheckCircle2, Mail, Loader2, Download, Menu, Lock, Rocket, RefreshCw, AlertCircle, Cpu, Server, Eye, EyeOff, Radio, Mic, Zap, HardDrive, Trash2, Sun, Moon, Monitor, Film } from 'lucide-react';
import KeyInput from './components/KeyInput';
import MediaInput from './components/MediaInput';
import McpConnectCard from './components/McpConnectCard';
import ResultCard from './components/ResultCard';
import ProcessingAnimation from './components/ProcessingAnimation';
import SegmentedControl from './components/ui/SegmentedControl';
import { getApiUrl } from './config';
import AdvancedBanner from './components/AdvancedBanner';
import ProfileMenu from './components/ProfileMenu';
import Modal from './components/ui/Modal';
import { useAuth } from './contexts/AuthContext';
import { apiFetch, apiJson, QuotaError, QUOTA_WALL_EVENT } from './lib/api';
import { track } from './lib/analytics';
import { readConnectReturn, stripConnectReturn } from './lib/connectReturn';
import { rememberTabAfterLogin } from './lib/tabAfterLogin';
import { JobPollError, pollFailureAction } from './lib/jobPoll';
import BrandLogo, { BrandIcon } from './components/BrandLogo';
import StatusTag from './components/StatusTag';

// Code-split heavy interactive subcomponents & modals for ultra-fast initial load
const LiveStreamTab = React.lazy(() => import('./components/LiveStreamTab'));
const HistoryTab = React.lazy(() => import('./components/HistoryTab'));
const ClipEditor = React.lazy(() => import('./components/ClipEditor'));
const ReframeEditor = React.lazy(() => import('./components/ReframeEditor'));
const ScheduleWeekModal = React.lazy(() => import('./components/ScheduleWeekModal'));
const LoginModal = React.lazy(() => import('./components/LoginModal'));

// Enhanced "Encryption" using XOR + Base64 with a Salt
const SECRET_KEY = import.meta.env.VITE_ENCRYPTION_KEY || "ClipSnipr-Static-Salt-Change-Me";
const ENCRYPTION_PREFIX = "ENC:";

const encrypt = (text) => {
  if (!text) return '';
  try {
    const xor = text.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length))
    ).join('');
    return ENCRYPTION_PREFIX + btoa(xor);
  } catch (e) {
    console.error("Encryption failed", e);
    return text;
  }
};

const decrypt = (text) => {
  if (!text) return '';
  if (text.startsWith(ENCRYPTION_PREFIX)) {
    try {
      const raw = text.slice(ENCRYPTION_PREFIX.length);
      // Check if it's plain base64 or our custom XOR (simple try)
      const xor = atob(raw);
      const result = xor.split('').map((c, i) =>
        String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length))
      ).join('');
      return result;
    } catch (e) {
      // Fallback if decryption fails (might be old plain text)
      return '';
    }
  }
  // Backward compatibility: If no prefix, assume old plain text (or return empty if you want to force re-login)
  // For migration: Return text as is, so it populates the field, and next save will encrypt it.
  return text;
};

// Simple TikTok icon sine Lucide might not have it or it varies
const TikTokIcon = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743l-.002-.001.002.001a2.895 2.895 0 0 1 3.183-4.51v-3.5a6.329 6.329 0 0 0-5.394 10.692 6.33 6.33 0 0 0 10.857-4.424V8.687a8.182 8.182 0 0 0 4.773 1.526V6.79a4.831 4.831 0 0 1-1.003-.104z" />
  </svg>
);

// Cloud accounts get an auto-generated opaque id (os_<hash>) as username —
// meaningless to the user, so the selector shows connected networks instead.
const isAutoProfileId = (username) => /^os_[0-9a-f]/i.test(username || "");

/* The job a signed-out visitor started, parked until they come back signed in.
 *
 * Pressing "get free clips" without a session used to open the login modal and
 * drop the work on the floor: the magic link lands on a fresh document, so the
 * pasted URL was gone and the highest-intent step in the funnel ended in an
 * empty form. The same is true of the Google round trip.
 *
 * So the request is written down before the redirect and replayed after it.
 * localStorage rather than sessionStorage because the magic link usually opens
 * in a new tab, and a TTL because a request parked last week is not what the
 * user is doing now. File uploads cannot be serialised (a File is not JSON), so
 * those are only resumed within the same document, via the in-memory fallback. */
const PENDING_JOB_KEY = 'os_pending_job';
const PENDING_JOB_TTL_MS = 60 * 60 * 1000;
let pendingJobInMemory = null;

function stashPendingJob(data) {
  const stamp = Date.now();
  const entry = { stamp, data: { ...data, payload: typeof data?.payload === 'string' ? data.payload : null } };
  pendingJobInMemory = { stamp, data };
  try {
    localStorage.setItem(PENDING_JOB_KEY, JSON.stringify(entry));
  } catch (_) { /* private mode: the in-memory copy still covers same-document flows */ }
  return stamp;
}

function peekPendingJob() {
  try {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.data?.payload && Date.now() - (parsed.stamp || 0) < PENDING_JOB_TTL_MS) {
        return parsed;
      }
      localStorage.removeItem(PENDING_JOB_KEY);
    }
  } catch (_) { /* ignore */ }
  // A File cannot survive a reload; this covers a sign-in that did not reload.
  if (pendingJobInMemory && Date.now() - pendingJobInMemory.stamp < PENDING_JOB_TTL_MS) {
    return pendingJobInMemory;
  }
  return null;
}

function clearPendingJob() {
  pendingJobInMemory = null;
  try {
    localStorage.removeItem(PENDING_JOB_KEY);
  } catch (_) { /* ignore */ }
}

const formatRetention = (seconds) => {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? 's' : ''}`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} hour${seconds >= 7200 ? 's' : ''}`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
};

const ProfileNetworkIcons = ({ profile, size = 12 }) => (
  <span className="flex items-center gap-1.5">
    <span className={profile?.connected?.includes('tiktok') ? 'text-ink' : 'text-muted opacity-40'}>
      <TikTokIcon size={size} />
    </span>
    <span className={profile?.connected?.includes('instagram') ? 'text-ink' : 'text-muted opacity-40'}>
      <Instagram size={size} />
    </span>
    <span className={profile?.connected?.includes('youtube') ? 'text-ink' : 'text-muted opacity-40'}>
      <Youtube size={size} />
    </span>
  </span>
);

const UserProfileSelector = ({ profiles, selectedUserId, onSelect, onConnect }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!profiles || profiles.length === 0) return null;

  const selectedProfile = profiles.find(p => p.username === selectedUserId) || profiles[0];
  const autoId = isAutoProfileId(selectedProfile?.username);

  return (
    <div className="relative z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label="social profile"
        /* Phone: avatar + chevron only. A 180px pill next to the menu button,
           the section title and the minutes meter overflowed a 360px header. */
        className="flex items-center justify-between gap-1 bg-paper2 border border-rule2 rounded-input px-2 sm:px-3 py-2 text-sm text-ink2 hover:bg-paper3 transition-colors sm:min-w-[180px]"
      >
        <span className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-paper3 border border-rule flex items-center justify-center font-mono text-micro text-brass shrink-0">
            {autoId ? "S" : (selectedProfile?.username?.substring(0, 1).toUpperCase() || "U")}
          </div>
          {autoId ? (
            <span className="hidden sm:flex"><ProfileNetworkIcons profile={selectedProfile} size={13} /></span>
          ) : (
            <span className="hidden sm:block font-medium text-ink truncate max-w-[100px]">{selectedProfile?.username || "Select User"}</span>
          )}
        </span>
        <ChevronDown size={14} className={`text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full mt-2 right-0 w-64 card overflow-hidden">
          <div className="max-h-60 overflow-y-auto custom-scrollbar">
            {profiles.map((profile) => (
              <button
                key={profile.username}
                onClick={() => {
                  onSelect(profile.username);
                  setIsOpen(false);
                }}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-paper3 transition-colors text-left group border-b border-rule last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-paper3 flex items-center justify-center font-mono text-micro text-ink border border-rule shrink-0">
                    {isAutoProfileId(profile.username) ? "S" : profile.username.substring(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink2 group-hover:text-ink transition-colors truncate">
                      {isAutoProfileId(profile.username)
                        ? `Social profile ${profiles.indexOf(profile) + 1}`
                        : profile.username}
                    </div>
                    <div className="flex gap-2 mt-0.5">
                      {/* Status indicators */}
                      <div className={`flex items-center gap-1 ${profile.connected.includes('tiktok') ? 'text-ink2' : 'text-muted opacity-40'}`}>
                        <TikTokIcon size={10} />
                      </div>
                      <div className={`flex items-center gap-1 ${profile.connected.includes('instagram') ? 'text-ink2' : 'text-muted opacity-40'}`}>
                        <Instagram size={10} />
                      </div>
                      <div className={`flex items-center gap-1 ${profile.connected.includes('youtube') ? 'text-ink2' : 'text-muted opacity-40'}`}>
                        <Youtube size={10} />
                      </div>
                    </div>
                  </div>
                </div>
                {selectedUserId === profile.username && <Check size={14} className="text-brass shrink-0" />}
              </button>
            ))}
          </div>
          {/* For managed users this dropdown otherwise does nothing (one profile,
              nothing to switch) — its real job is being the door to connecting
              the greyed-out networks it displays. */}
          {onConnect && (
            <button
              onClick={() => { setIsOpen(false); onConnect(); }}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-brass hover:bg-paper3 transition-colors text-left border-t border-rule"
            >
              <Share2 size={14} /> Connect / manage accounts
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const SESSION_KEY = 'clipsnipr_session';

// The server's own explanation for a rejected/failed job, readable: FastAPI
// answers {"detail": "..."} or {"detail": {"message": ...}}. Showing the raw
// JSON (or a generic "failed") hid actionable reasons such as "this video is
// only 30s long", and new users in the tutorial saw only "That run failed".
const readableError = (raw) => {
  const text = String(raw || '').trim();
  try {
    const body = JSON.parse(text);
    const d = body?.detail ?? body;
    if (typeof d === 'string' && d) return d.slice(0, 300);
    if (d && typeof d.message === 'string') return d.message.slice(0, 300);
  } catch (_) { /* not JSON */ }
  return text.replace(/^Error:\s*/, '').slice(0, 300) || 'Something went wrong.';
};
// Matches the self-host JOB_RETENTION_SECONDS default. A restore whose job was
// already purged server-side (Cloud keeps it 1 h) gets a 404 from the status
// poll, which clears the saved session (see lib/jobPoll.js).
const SESSION_MAX_AGE = 86400000; // 24 hours

const pollJob = async (jobId) => {
  const res = await apiFetch(`/api/status/${jobId}`);
  if (!res.ok) throw new JobPollError(res.status);
  return res.json();
};

function App() {
  // Cloud auth/billing session (inert when billing is disabled).
  const { billingEnabled, isManaged, isSignedIn, me, plan, refreshMe, jobRetentionSeconds, localLlm, loading: authLoading } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);
  // Free plan: "want the watermark off?" once per job, when the clips land.
  const [showWmNotice, setShowWmNotice] = useState(false);
  const wmNoticedJobRef = useRef(null);
  const [showPlanChoice, setShowPlanChoice] = useState(false);
  const [tutorialPhase, setTutorialPhase] = useState(null); // null | intro | coach | celebrate
  const [showTrialUpgrade, setShowTrialUpgrade] = useState(false);
  const [topUpInfo, setTopUpInfo] = useState({});
  // {processed_minutes, total_minutes} when the running/finished job clips
  // only the first part of the source (the quota wall's free offer).
  const [partialJob, setPartialJob] = useState(null);
  // The free plan's first video, clipped whole past the 20-minute balance.
  const [firstVideoJob, setFirstVideoJob] = useState(false);
  // {position, ahead, eta_seconds} while the job waits in line, else null.
  const [queueInfo, setQueueInfo] = useState(null);
  // A free video far back in a saturated queue: the server says later
  // arrivals can still pass it (eta_is_minimum) and its minimum wait is long.
  // The first seconds of a new video are never this (it enters at the front
  // of a lane that serves its newest first), so nobody is told "hours" for a
  // video that starts in ten minutes.
  const queueSlow = Boolean(billingEnabled && queueInfo && queueInfo.eta_is_minimum
    && queueInfo.ahead > 0 && queueInfo.eta_seconds >= 20 * 60
    && !['starter', 'creator', 'pro'].includes(plan));
  const queueSlowSeenRef = useRef(false);
  useEffect(() => {
    if (!queueInfo) { queueSlowSeenRef.current = false; return; }
    if (queueSlow && !queueSlowSeenRef.current) {
      queueSlowSeenRef.current = true;
      track('QueueSlowSeen', { props: { position: String(queueInfo.position) } });
    }
  }, [queueSlow, queueInfo]);
  // Why the last job could not start or failed, in plain words (or '').
  const [jobError, setJobError] = useState('');
  // Durable R2 URLs (per clip index) for the current job — used as a fallback when
  // the ephemeral local /videos/ files have been cleaned up (e.g. after a reload).
  const [durableClips, setDurableClips] = useState({});

  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_key') || '');
  // Social API State - Load encrypted or plain
  const [uploadPostKey, setUploadPostKey] = useState(() => {
    const stored = localStorage.getItem('uploadPostKey_v3');
    if (stored) return decrypt(stored);
    return '';
  });

  // Tri-Mode Theme Engine: 'system' (default) | 'dark' | 'light'
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('clipsnipr_theme') || 'system';
    } catch (_) {
      return 'system';
    }
  });

  useEffect(() => {
    const applyTheme = (t) => {
      const isDark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.style.colorScheme = 'light';
      }
      try {
        localStorage.setItem('clipsnipr_theme', t);
      } catch (_) {}
    };

    applyTheme(theme);

    if (theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e) => {
        if (e.matches) {
          document.documentElement.classList.add('dark');
          document.documentElement.style.colorScheme = 'dark';
        } else {
          document.documentElement.classList.remove('dark');
          document.documentElement.style.colorScheme = 'light';
        }
      };
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }
  }, [theme]);

  // Persistent Backend Settings from SQLite database (clipsnipr.db)
  const [backendSettings, setBackendSettings] = useState({
    llm_provider: 'openai',
    llm_base_url: 'https://api.onebyt.live/v1',
    llm_api_key: '',
    llm_model: 'gpt-4o-mini',
    gemini_api_key: '',
    upload_post_api_key: '',
    public_api_url: '',
    public_frontend_url: '',
    transcription_provider: 'local',
    groq_api_key: '',
    groq_whisper_model: 'whisper-large-v3',
    llm_connection_status: '',
    groq_connection_status: '',
    s3_enabled: '0',
    s3_endpoint_url: '',
    s3_bucket_name: '',
    s3_access_key: '',
    s3_secret_key: '',
    s3_region: 'auto',
    s3_connection_status: '',
  });
  const [socialStatus, setSocialStatus] = useState({
    youtube: { connected: false, channel_id: '', channel_title: '', has_credentials: false, client_id: '' },
    instagram: { connected: false, account_id: '', username: '' },
  });
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState('');
  const [manualModelInput, setManualModelInput] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestMsg, setLlmTestMsg] = useState(null);
  const [testingGroq, setTestingGroq] = useState(false);
  const [groqTestMsg, setGroqTestMsg] = useState(null);
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [testingS3, setTestingS3] = useState(false);
  const [s3TestMsg, setS3TestMsg] = useState(null);
  const [showS3Secret, setShowS3Secret] = useState(false);

  // YouTube OAuth Credentials
  const [ytClientId, setYtClientId] = useState('');
  const [ytClientSecret, setYtClientSecret] = useState('');
  const [ytSaving, setYtSaving] = useState(false);
  const [ytStatusMsg, setYtStatusMsg] = useState('');

  // Instagram Graph API Credentials
  const [igAccountId, setIgAccountId] = useState('');
  const [igAccessToken, setIgAccessToken] = useState('');
  const [igSaving, setIgSaving] = useState(false);
  const [igStatusMsg, setIgStatusMsg] = useState('');

  // Multi-account social connections
  const [youtubeAccounts, setYoutubeAccounts] = useState([]);
  const [instagramAccounts, setInstagramAccounts] = useState([]);

  const fetchSocialAccounts = async () => {
    try {
      const res = await apiFetch('/api/publish/accounts');
      if (res.ok) {
        const d = await res.json();
        const accs = d.accounts || [];
        setYoutubeAccounts(accs.filter((a) => a.platform === 'youtube'));
        setInstagramAccounts(accs.filter((a) => a.platform === 'instagram'));
      }
    } catch (e) {
      console.error('Failed to fetch social accounts', e);
    }
  };

  const handleDeleteSocialAccount = async (id) => {
    if (!confirm('Disconnect and remove this social account?')) return;
    try {
      const res = await apiFetch(`/api/publish/accounts/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchSocialAccounts();
        await loadBackendSettings();
      }
    } catch (e) {
      console.error('Failed to delete social account', e);
    }
  };

  const [uploadUserId, setUploadUserId] = useState(() => localStorage.getItem('uploadUserId') || '');
  const [userProfiles, setUserProfiles] = useState([]); // List of {username, connected: []}
  // Post-generation social nudge: shown at the results peak until the user
  // either connects a network or dismisses it. Only 2.7% of cloud users who
  // reach the social flow ever connect an account — this is the moment (clips
  // just appeared) with the best odds of moving that number.
  const [socialNudgeDismissed, setSocialNudgeDismissed] = useState(() => {
    try { return localStorage.getItem('os_social_nudge_dismissed') === '1'; } catch (_) { return false; }
  });
  // Autopilot nudge, same results peak, ahead of the social one: the sign-up
  // survey's "autopilot" goal pays about twice the "clips" one, and 95% of
  // users never come back a second day; Autopilot is the one feature that
  // works without them coming back. Gone once clicked or dismissed.
  const [autopilotNudgeDismissed, setAutopilotNudgeDismissed] = useState(() => {
    try { return localStorage.getItem('os_autopilot_nudge_dismissed') === '1'; } catch (_) { return false; }
  });
  const [autopilotOn, setAutopilotOn] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, processing, complete, error
  const [results, setResults] = useState(null);
  // Best clips first. The backend hands them back in transcript order, which
  // buries the strongest one wherever it happens to fall in the video — and
  // the first card is the one people actually watch and publish.
  //
  // The ORIGINAL array position travels with each clip and is what gets passed
  // down as `index`: it is the clip's identity everywhere else (clip_index on
  // /api/subtitle, /api/edit and publishing, the clip-N.mp4 download name, the
  // saved per-clip project state). Sorting the array itself would silently
  // repoint all of that at the wrong clip.
  const rankedClips = useMemo(() => {
    const clips = results?.clips;
    if (!Array.isArray(clips)) return [];
    return clips
      .map((clip, index) => ({ clip, index }))
      .sort((a, b) => {
        const sa = Number.isFinite(a.clip?.predicted_score) ? a.clip.predicted_score : -1;
        const sb = Number.isFinite(b.clip?.predicted_score) ? b.clip.predicted_score : -1;
        // Ties (and clips with no score at all) keep transcript order.
        return sb - sa || a.index - b.index;
      });
  }, [results]);
  // Bulk subtitles: apply one style to every clip of the job (triggered from
  // within a clip's subtitle modal via "apply to all").
  const [bulkSub, setBulkSub] = useState({ running: false, current: 0, total: 0, errors: 0 });
  const [downloadingAll, setDownloadingAll] = useState(false);
  // Pre-flight quality gate: { info: {max_height, min_height, cookies_invalid}, data }
  const [qualityGate, setQualityGate] = useState(null);
  const [logs, setLogs] = useState([]);
  // When each server log line arrived (epoch s, parallel to logs), from /api/status.
  const [logTimes, setLogTimes] = useState([]);
  // Collapsed on phones: the log tail is the least useful thing on a 360px
  // screen and it was pushing the actual clips a full scroll down.
  const [logsVisible, setLogsVisible] = useState(() => {
    try { return window.innerWidth >= 768; } catch { return true; }
  });
  const [processingMedia, setProcessingMedia] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard'); // dashboard, settings
  // Mobile only: the full nav lives in a drawer behind the header's menu button.
  const [navOpen, setNavOpen] = useState(false);
  // Reopened-project state (paid mode): per-clip {index, server_file, active_layers}
  // restored from the backend so ResultCards resume editing where they left off.
  const [projectState, setProjectState] = useState(null);
  // True when the current job was reopened from the library: its source video
  // was never persisted, so the session must not fall back to /api/source.
  const [noSource, setNoSource] = useState(false);

  const [sessionRecovered, setSessionRecovered] = useState(false);
  // The job a restored session was polling is no longer on the server.
  const [jobGone, setJobGone] = useState(false);
  const [showScheduleWeek, setShowScheduleWeek] = useState(false);
  // Clip editor overlay: index of the clip being edited, or null.
  const [editingClip, setEditingClip] = useState(null);
  const [reframingClip, setReframingClip] = useState(null);

  // Silent-success "saved" states for the settings key inputs (design.md: no alert popups)
  const [elevenLabsSaved, setElevenLabsSaved] = useState(false);
  const [falSaved, setFalSaved] = useState(false);

  // Sync state for original video playback
  const [syncedTime, setSyncedTime] = useState(0);
  const [isSyncedPlaying, setIsSyncedPlaying] = useState(false);
  const [syncTrigger, setSyncTrigger] = useState(0);

  const handleClipPlay = (startTime) => {
    // Clip times are relative to the processed stretch; the preview plays the
    // whole source, so a picked range shifts them by its start.
    setSyncedTime(startTime + (Number(partialJob?.start_seconds) || 0));
    setIsSyncedPlaying(true);
    setSyncTrigger(prev => prev + 1);
  };

  const handleClipPause = () => {
    setIsSyncedPlaying(false);
  };

  // --- Project persistence (paid mode) ---
  // Debounced sync of each clip's browser-only edit state (Remotion layers +
  // current server file) to the backend, so a reopened project resumes intact.
  const clipStateSync = useRef({ jobId: null, pending: {}, files: {}, timer: null });
  // Read by in-flight async chases to notice that the user moved on to another job.
  const jobIdRef = useRef(jobId);
  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);

  const flushClipState = () => {
    const s = clipStateSync.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    const entries = Object.entries(s.pending);
    if (!s.jobId || entries.length === 0) return;
    const clips = entries.map(([i, v]) => ({
      index: Number(i),
      active_layers: v.activeLayers,
      server_file: v.serverVideoFile,
    }));
    s.pending = {};
    apiFetch(`/api/projects/${s.jobId}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips }),
    }).catch(() => {});
  };

  // One /api/history read, reduced to this job's clips.
  const fetchDurableMap = async () => {
    const d = await apiJson('/api/history');
    const map = {};
    for (const v of (d.videos || [])) {
      if (v.job_id === jobId && v.clip_index != null) map[v.clip_index] = { url: v.view_url, filename: v.filename };
    }
    return map;
  };

  // A server-side edit rewrites the clip's file while the R2 re-archive behind it
  // is still in flight (_archive_clip_edit_bg is fire-and-forget), so the durable
  // map goes stale and the card falls back to streaming from the API. Re-read the
  // map on a backoff until the archived name matches the clip's new file, then it
  // can play from R2 again. Gives up quietly: staying on /videos is correct, just
  // slower, and is exactly what happens for self-hosted users all the time.
  // opts.source / opts.highlight: which surface opened it (CheckoutStarted
  // source) and which plan the modal puts forward (WatermarkModal: starter).
  // opts.partialJob: the trimmed job on screen, so the modal sells the rest of it.
  const openUpsell = (opts = {}) => {
    setTopUpInfo({ context: 'upsell', source: opts.source, highlight: opts.highlight,
                   partialJob: opts.partialJob || null });
    setShowTopUp(true);
  };

  // Out-of-minutes errors from the thumbnail studio, clip editor and autopilot
  // (lib/api.openQuotaWall) open the same wall as the main clip flow.
  const meStatus = me?.status;
  useEffect(() => {
    if (!isManaged) return undefined;
    const onWall = (ev) => {
      refreshMe();
      if (meStatus === 'trialing') { setShowTrialUpgrade(true); return; }
      const d = ev.detail || {};
      setTopUpInfo({ context: 'wall', required: d.required, remaining: d.remaining, source: d.source });
      setShowTopUp(true);
    };
    window.addEventListener(QUOTA_WALL_EVENT, onWall);
    return () => window.removeEventListener(QUOTA_WALL_EVENT, onWall);
  }, [isManaged, meStatus, refreshMe]);

  // The clips just landed on a free account: ask once, per job, whether they
  // want the mark off. A beat after the grid renders, so the first thing they
  // see is their clips and not a modal over them.
  useEffect(() => {
    if (status !== 'complete' || plan !== 'free' || !isManaged || !jobId) return;
    if (!(results?.clips?.length > 0)) return;
    // Not on top of the tutorial's celebrate step: it shows once that closes.
    if (tutorialPhase === 'coach' || tutorialPhase === 'celebrate') return;
    if (wmNoticedJobRef.current === jobId || watermarkNoticeDismissed(jobId)) return;
    wmNoticedJobRef.current = jobId;
    const t = setTimeout(() => { if (jobIdRef.current === jobId) setShowWmNotice(true); }, 2500);
    return () => clearTimeout(t);
  }, [status, plan, isManaged, jobId, results?.clips?.length, tutorialPhase]);

  // Paying re-points the clips already on screen at their clean twins (the API
  // does it from the Stripe webhook, a few seconds after the plan flips). Chase
  // the job result until no served file carries the wm_ prefix, then refresh
  // the durable map so the players switch to the clean R2 copies too.
  useEffect(() => {
    if (!isManaged || !jobId || !plan || plan === 'free') return;
    const isMarked = (c) => /\/wm_[^/]*$/.test(c?.video_url || '');
    if (!(results?.clips || []).some(isMarked)) return;
    let cancelled = false;
    (async () => {
      for (const delay of [1500, 3000, 6000, 12000, 20000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (cancelled || jobIdRef.current !== jobId) return;
        let data;
        try { data = await pollJob(jobId); } catch { continue; }
        if (cancelled || jobIdRef.current !== jobId) return;
        if (data?.result) setResults(data.result);
        if (!(data?.result?.clips || []).some(isMarked)) {
          fetchDurableMap().then((m) => { if (!cancelled) setDurableClips(m); }).catch(() => {});
          return;
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, isManaged, jobId]);

  const chaseDurableFile = async (index, expectedFile) => {
    const forJob = jobId;
    for (const delay of [2500, 6000, 15000, 30000]) {
      await new Promise((r) => setTimeout(r, delay));
      if (jobIdRef.current !== forJob) return;
      let map;
      try { map = await fetchDurableMap(); } catch { return; }
      // A new job started mid-chase: this map describes the old one, so dropping
      // it here keeps it from overwriting the new job's URLs.
      if (jobIdRef.current !== forJob) return;
      setDurableClips(map);
      if (map[index]?.filename === expectedFile) return;
    }
  };

  const handleClipStateChange = (index, state) => {
    if (!isManaged || !jobId) return;
    const s = clipStateSync.current;
    if (s.jobId !== jobId) { s.pending = {}; s.files = {}; s.jobId = jobId; }
    s.pending[index] = state;
    // Cards report on mount too, so only an actual change of server file means an
    // edit just landed. The first report per clip is the mount, never a chase.
    const files = s.files || (s.files = {});
    const file = state?.serverVideoFile;
    if (file && files[index] !== file) {
      const isMount = files[index] === undefined;
      files[index] = file;
      if (!isMount) chaseDurableFile(index, file);
    }
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(flushClipState, 2000);
  };

  // A recut replaced the clip's server file with a fresh render (burned layers
  // reset), so update the results, the reopened-project state and the synced
  // per-clip edit state, and let the ResultCard remount from the new file.
  const handleClipRerendered = (index, data) => {
    const newFile = (data.new_video_url || '').split('/').pop();
    setResults((prev) => {
      if (!prev?.clips?.[index]) return prev;
      const clips = prev.clips.slice();
      clips[index] = {
        ...clips[index],
        video_url: data.new_video_url,
        start: data.start,
        end: data.end,
        recipe: data.recipe,
      };
      return { ...prev, clips };
    });
    setProjectState((prev) => {
      if (!prev?.clips) return prev;
      return {
        ...prev,
        clips: prev.clips.map((c) => (c.index === index
          ? { ...c, server_file: newFile, active_layers: null }
          : c)),
      };
    });
    // The old durable R2 object is deleted when the recut is archived, so the
    // stale URL would 404 as a fallback; drop it until the next refresh.
    setDurableClips((prev) => {
      if (!(index in prev)) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
    handleClipStateChange(index, { activeLayers: null, serverVideoFile: newFile });
  };

  // Reopen an archived project or ongoing job from the History tab.
  const restoreProject = async (projectJobId, projectStatus = 'completed') => {
    let data;
    try {
      data = await apiJson(`/api/projects/${projectJobId}/restore`, { method: 'POST' });
    } catch (e) {
      // Fallback to /api/status if restore endpoint failed
      data = await apiJson(`/api/status/${projectJobId}`);
    }
    flushClipState();
    setProjectState(data.project_state || null);
    setNoSource(true);
    setJobId(data.job_id || projectJobId);
    setResults(data.result || null);
    setProcessingMedia(null);
    setQualityGate(null);

    const isLive = (data.status === 'processing' || data.status === 'queued' || projectStatus === 'processing' || projectStatus === 'queued');
    if (isLive) {
      setStatus('processing');
      setLogs(data.logs?.length ? data.logs : ['⚡ Resuming live view of ongoing project…']);
      setLogTimes(data.log_times?.length ? data.log_times : [Date.now() / 1000]);
    } else {
      setStatus('complete');
      setLogs(data.logs?.length ? data.logs : ['♻️ Project restored from your library.']);
      setLogTimes([Date.now() / 1000]);
    }
    setActiveTab('dashboard');
  };

  // Apply one subtitle style to every clip of the job, sequentially.
  const handleBulkSubtitles = async (options) => {
    const clips = results?.clips || [];
    const total = clips.length;
    if (!total) return;
    setBulkSub({ running: true, current: 0, total, errors: 0 });
    let errors = 0;
    for (let i = 0; i < total; i++) {
      setBulkSub({ running: true, current: i + 1, total, errors });
      try {
        const res = await apiFetch('/api/subtitle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id: jobId,
            clip_index: i,
            position: options.position,
            font_size: options.fontSize,
            font_name: options.fontName,
            font_color: options.fontColor,
            border_color: options.borderColor,
            border_width: options.borderWidth,
            bg_color: options.bgColor,
            bg_opacity: options.bgOpacity,
            style: options.style || 'pill',
            highlight_color: options.highlightColor || '#FFD700',
            effect: options.effect || 'none',
            base_opacity: options.baseOpacity ?? 1.0,
            uppercase: options.uppercase || false,
            reveal: options.reveal || false,
            shadow: options.shadow || 0,
            max_chars: options.maxChars ?? null,
            max_duration: options.maxDuration ?? null,
            // Chain from the clip's current server file (its video_url basename).
            input_filename: (clips[i].video_url || '').split('/').pop(),
          }),
        });
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
    }
    setBulkSub({ running: false, current: total, total, errors });
    refreshMe();
    // Refresh results so each ResultCard picks up its new subtitled video_url.
    try {
      const data = await pollJob(jobId);
      if (data.result) setResults(data.result);
    } catch { /* keep current results */ }
  };

  const handleDownloadAll = async () => {
    if (!jobId) return;
    setDownloadingAll(true);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/download-all`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clipsnipr_clips_${(jobId || '').slice(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    } finally {
      setDownloadingAll(false);
    }
  };

  // Session Recovery: Restore on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const session = JSON.parse(saved);
      if (Date.now() - session.timestamp > SESSION_MAX_AGE) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      if (session.jobId && session.status && session.status !== 'idle') {
        setJobId(session.jobId);
        setResults(session.results || null);
        // Restore the source preview. Older sessions (or uploads) saved no
        // media, so fall back to the backend-served source for this job —
        // except for reopened projects, whose source was never persisted.
        if (session.processingMedia) setProcessingMedia(session.processingMedia);
        else if (!session.noSource) setProcessingMedia({ type: 'server', payload: `/api/source/${session.jobId}` });
        if (session.noSource) setNoSource(true);
        if (session.projectState) setProjectState(session.projectState);
        if (session.activeTab) setActiveTab(session.activeTab);
        // If was processing, resume polling; if complete/error, just show results
        setStatus(session.status === 'processing' ? 'processing' : session.status);
        setSessionRecovered(true);
        setTimeout(() => setSessionRecovered(false), 5000);
      }
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  // Session Recovery: Save state changes
  useEffect(() => {
    if (status === 'idle') {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    try {
      // URL (YouTube) media serializes as-is. Uploaded 'file' media is a blob
      // that can't be persisted, so point the recovered preview at the source
      // served by the backend instead of dropping it.
      let persistMedia = null;
      if (processingMedia?.type === 'url') persistMedia = processingMedia;
      else if (processingMedia && jobId) persistMedia = { type: 'server', payload: `/api/source/${jobId}` };
      const sessionData = {
        jobId,
        status,
        results,
        processingMedia: persistMedia,
        activeTab,
        noSource,
        projectState,
        timestamp: Date.now()
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    } catch (e) {
      // localStorage full or serialization error - ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status, results, activeTab, noSource, projectState]);

  useEffect(() => {
    // Encrypt Gemini Key too for consistency if desired, but user asked specifically about Social integration not saving well.
    // For now keeping gemini plain for compatibility unless requested.
    if (apiKey) localStorage.setItem('gemini_key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (uploadPostKey) {
      localStorage.setItem('uploadPostKey_v3', encrypt(uploadPostKey));
    }
    if (uploadUserId) {
      localStorage.setItem('uploadUserId', uploadUserId);
    }
  }, [uploadPostKey, uploadUserId]);

  // Settings persistence handlers for SQLite backend
  const loadBackendSettings = async () => {
    try {
      const res = await apiFetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setBackendSettings((prev) => ({
            ...prev,
            ...data.settings,
            llm_provider: data.settings.llm_provider || 'openai',
          }));
          if (data.settings.gemini_api_key) setApiKey(data.settings.gemini_api_key);
          if (data.settings.upload_post_api_key) setUploadPostKey(data.settings.upload_post_api_key);
        }
        if (data.social) {
          setSocialStatus(data.social);
          if (data.social.youtube?.client_id) setYtClientId(data.social.youtube.client_id);
          if (data.social.instagram?.account_id) setIgAccountId(data.social.instagram.account_id);
        }
        if (data.youtube_accounts) setYoutubeAccounts(data.youtube_accounts);
        if (data.instagram_accounts) setInstagramAccounts(data.instagram_accounts);
      }
    } catch (err) {
      console.error('Failed to load settings from SQLite:', err);
    }
  };

  const saveBackendSettings = async (overrides) => {
    setSettingsLoading(true);
    try {
      const toSave = overrides || backendSettings;
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: toSave }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setBackendSettings((prev) => ({ ...prev, ...data.settings }));
        }
        setSettingsSaved(true);
        setTimeout(() => setSettingsSaved(false), 2500);
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleFetchModels = async () => {
    if (!backendSettings.llm_base_url) {
      setFetchModelsError('Please enter an API Base URL first.');
      return;
    }
    setFetchingModels(true);
    setFetchModelsError('');
    try {
      const res = await apiFetch('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: backendSettings.llm_base_url,
          api_key: backendSettings.llm_api_key || null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.models && data.models.length > 0) {
          setAvailableModels(data.models);
          if (!backendSettings.llm_model || !data.models.includes(backendSettings.llm_model)) {
            const nextModel = data.models[0];
            const updated = { ...backendSettings, llm_model: nextModel };
            setBackendSettings(updated);
            saveBackendSettings(updated);
          }
        } else {
          setFetchModelsError('No models returned from provider.');
        }
      } else {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        setFetchModelsError(err.detail || 'Failed to fetch models');
      }
    } catch (err) {
      setFetchModelsError(err.message || 'Network error fetching models');
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTestLlmConnection = async () => {
    if (!backendSettings.llm_base_url || !backendSettings.llm_model) {
      setLlmTestMsg({ ok: false, message: 'Please enter API Base URL and Model first.' });
      return;
    }
    setTestingLlm(true);
    setLlmTestMsg(null);
    try {
      const res = await apiFetch('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: backendSettings.llm_base_url,
          api_key: backendSettings.llm_api_key || null,
          model: backendSettings.llm_model,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setLlmTestMsg({ ok: true, message: data.message });
        const updated = { ...backendSettings, llm_connection_status: 'connected' };
        setBackendSettings(updated);
        saveBackendSettings(updated);
      } else {
        setLlmTestMsg({ ok: false, message: data.message || data.detail || 'Connection test failed.' });
        const updated = { ...backendSettings, llm_connection_status: 'failed' };
        setBackendSettings(updated);
        saveBackendSettings(updated);
      }
    } catch (err) {
      setLlmTestMsg({ ok: false, message: err.message || 'Network error testing connection.' });
      const updated = { ...backendSettings, llm_connection_status: 'failed' };
      setBackendSettings(updated);
      saveBackendSettings(updated);
    } finally {
      setTestingLlm(false);
    }
  };

  const handleTestGroqConnection = async () => {
    if (!backendSettings.groq_api_key) {
      setGroqTestMsg({ ok: false, message: 'Please enter a Groq API Key first.' });
      return;
    }
    setTestingGroq(true);
    setGroqTestMsg(null);
    try {
      const res = await apiFetch('/api/transcription/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'groq',
          api_key: backendSettings.groq_api_key,
          model: backendSettings.groq_whisper_model || 'whisper-large-v3',
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setGroqTestMsg({ ok: true, message: data.message });
        const updated = { ...backendSettings, groq_connection_status: 'connected' };
        setBackendSettings(updated);
        saveBackendSettings(updated);
      } else {
        setGroqTestMsg({ ok: false, message: data.message || data.detail || 'Groq connection failed.' });
        const updated = { ...backendSettings, groq_connection_status: 'failed' };
        setBackendSettings(updated);
        saveBackendSettings(updated);
      }
    } catch (err) {
      setGroqTestMsg({ ok: false, message: err.message || 'Network error connecting to Groq.' });
      const updated = { ...backendSettings, groq_connection_status: 'failed' };
      setBackendSettings(updated);
      saveBackendSettings(updated);
    } finally {
      setTestingGroq(false);
    }
  };

  const handleTestS3Connection = async () => {
    if (!backendSettings.s3_bucket_name || !backendSettings.s3_access_key || !backendSettings.s3_secret_key) {
      setS3TestMsg({ ok: false, message: 'Please enter Bucket Name, Access Key, and Secret Key first.' });
      return;
    }
    setTestingS3(true);
    setS3TestMsg(null);
    try {
      const res = await apiFetch('/api/s3/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint_url: backendSettings.s3_endpoint_url || null,
          bucket_name: backendSettings.s3_bucket_name,
          access_key: backendSettings.s3_access_key,
          secret_key: backendSettings.s3_secret_key,
          region: backendSettings.s3_region || 'auto',
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setS3TestMsg({ ok: true, message: data.message });
        const updated = { ...backendSettings, s3_connection_status: 'connected', s3_enabled: '1' };
        setBackendSettings(updated);
        saveBackendSettings(updated);
      } else {
        setS3TestMsg({ ok: false, message: data.message || data.detail || 'S3 connection test failed.' });
        const updated = { ...backendSettings, s3_connection_status: 'failed' };
        setBackendSettings(updated);
        saveBackendSettings(updated);
      }
    } catch (err) {
      setS3TestMsg({ ok: false, message: err.message || 'Network error testing S3 connection.' });
      const updated = { ...backendSettings, s3_connection_status: 'failed' };
      setBackendSettings(updated);
      saveBackendSettings(updated);
    } finally {
      setTestingS3(false);
    }
  };

  const handleSaveYouTubeCreds = async () => {
    if (!ytClientId || !ytClientSecret) {
      setYtStatusMsg('Please enter both Client ID and Client Secret.');
      return;
    }
    setYtSaving(true);
    setYtStatusMsg('');
    try {
      const res = await apiFetch('/api/publish/youtube/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: ytClientId, client_secret: ytClientSecret }),
      });
      if (res.ok) {
        setYtStatusMsg('Credentials saved! You can now click "Connect YouTube Account".');
        loadBackendSettings();
      } else {
        const err = await res.json().catch(() => ({ detail: 'Failed to save credentials' }));
        setYtStatusMsg(`Error: ${err.detail || 'Failed to save'}`);
      }
    } catch (err) {
      setYtStatusMsg(`Error: ${err.message}`);
    } finally {
      setYtSaving(false);
    }
  };

  const handleConnectYouTube = async () => {
    try {
      const res = await apiFetch('/api/publish/youtube/auth-url');
      if (res.ok) {
        const data = await res.json();
        if (data.auth_url) {
          window.location.href = data.auth_url;
        }
      } else {
        const err = await res.json().catch(() => ({ detail: 'Failed to get auth URL' }));
        alert(err.detail || 'Please save valid YouTube OAuth credentials first.');
      }
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleSaveInstagramCreds = async () => {
    if (!igAccountId || !igAccessToken) {
      setIgStatusMsg('Please enter both Instagram Account ID and Access Token.');
      return;
    }
    setIgSaving(true);
    setIgStatusMsg('');
    try {
      const res = await apiFetch('/api/publish/instagram/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: igAccountId, access_token: igAccessToken }),
      });
      if (res.ok) {
        const data = await res.json();
        setIgStatusMsg(`Verified & Connected as @${data.username}!`);
        loadBackendSettings();
        fetchSocialAccounts();
        setIgAccountId('');
        setIgAccessToken('');
      } else {
        const err = await res.json().catch(() => ({ detail: 'Verification failed' }));
        setIgStatusMsg(`Error: ${err.detail || 'Verification failed. Check token & ID.'}`);
      }
    } catch (err) {
      setIgStatusMsg(`Error: ${err.message}`);
    } finally {
      setIgSaving(false);
    }
  };

  // Sync settings and check OAuth redirect outcomes
  useEffect(() => {
    loadBackendSettings();
    fetchSocialAccounts();
    try {
      const url = new URL(window.location.href);
      const ytParam = url.searchParams.get('youtube') || (url.hash.includes('youtube=') ? new URLSearchParams(url.hash.split('?')[1] || '').get('youtube') : null);
      if (ytParam === 'connected') {
        setActiveTab('settings');
        setYtStatusMsg('YouTube account successfully connected!');
        fetchSocialAccounts();
      } else if (ytParam === 'error') {
        setActiveTab('settings');
        setYtStatusMsg('Failed to connect YouTube account.');
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if ((uploadPostKey || isManaged) && userProfiles.length === 0) {
      fetchUserProfiles({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadPostKey, isManaged]);

  // For managed users, fetch the durable R2 URLs of the current job's clips. The
  // preview player prefers them (free egress, edge-served, and not competing with
  // the renders for the API process), and falls back to /videos when the local
  // file is newer than the archived one or the signed link fails.
  // Kept fresh by chaseDurableFile after each edit and by the completion chase
  // below; until either lands, the card just streams from /videos.
  useEffect(() => {
    if (!isManaged || !jobId || !(results?.clips?.length)) { setDurableClips({}); return; }
    let cancelled = false;
    fetchDurableMap()
      .then((map) => { if (!cancelled) setDurableClips(map); })
      .catch(() => {});
    return () => { cancelled = true; };
    // Keyed on the clip COUNT, not on results: the status poll hands back a new
    // results object every couple of seconds while the job runs, and this used to
    // re-read the history on every one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManaged, jobId, results?.clips?.length]);

  // A job is marked complete BEFORE _archive_managed_job has finished uploading
  // (app.py:878), so the read above can land while R2 still has nothing for it and
  // every card would stream from the API for the rest of the session. Chase until
  // all clips have a durable copy.
  useEffect(() => {
    const count = results?.clips?.length || 0;
    if (!isManaged || !jobId || status !== 'complete' || !count) return;
    let cancelled = false;
    (async () => {
      for (const delay of [0, 3000, 8000, 20000, 40000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        let map;
        try { map = await fetchDurableMap(); } catch { return; }
        if (cancelled) return;
        setDurableClips(map);
        if (Object.keys(map).length >= count) return;
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManaged, jobId, status, results?.clips?.length]);

  // Read at failure time: the poll effect must not restart when auth settles.
  const historyAvailableRef = useRef(false);
  historyAvailableRef.current = billingEnabled && isSignedIn;
  const handleResetRef = useRef(null);

  useEffect(() => {
    let interval;
    let failures = 0;
    if ((status === 'processing' || status === 'completed') && jobId) {
      interval = setInterval(async () => {
        try {
          const data = await pollJob(jobId);
          failures = 0;
          console.log("Job status:", data);

          // Update results if available (real-time)
          if (data.result) {
            setResults(data.result);
          }

          if (data.partial) setPartialJob(data.partial);
          setQueueInfo(data.status === 'queued' && data.queue ? data.queue : null);

          if (data.status === 'completed') {
            setQueueInfo(null);
            setStatus('complete');
            clearInterval(interval);
            refreshMe();
          } else if (data.status === 'failed') {
            setStatus('error');
            const errorMsg = data.error || (data.logs && data.logs.length > 0 ? data.logs[data.logs.length - 1] : "Process failed");
            setJobError(readableError(errorMsg));
            setLogs(prev => [...prev, "Error: " + errorMsg]);
            clearInterval(interval);
            refreshMe();
          } else {
            // Update logs if available
            if (data.logs) {
              setLogs(data.logs);
              setLogTimes(data.log_times || []);
            }
          }
        } catch (e) {
          console.error("Polling error", e);
          failures += 1;
          if (pollFailureAction(e, failures) === 'gone') {
            clearInterval(interval);
            // Back to idle (which drops the saved session) and on to History,
            // where a finished job's clips are kept.
            handleResetRef.current();
            setSessionRecovered(false);
            setJobGone(true);
            if (historyAvailableRef.current) setActiveTab('history');
          }
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [status, jobId, refreshMe]);


  // silent: background auto-fetch — never alert(), just log. Managed users need
  // no local key (the server resolves its own); BYOK sends the header.
  const fetchUserProfiles = async ({ silent = false } = {}) => {
    if (!uploadPostKey && !isManaged) return;
    try {
      const res = await apiFetch('/api/social/user', {
        headers: uploadPostKey ? { 'X-Upload-Post-Key': uploadPostKey } : {}
      });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.profiles && data.profiles.length > 0) {
        setUserProfiles(data.profiles);
        // Auto select first if none selected
        if (!uploadUserId) {
          setUploadUserId(data.profiles[0].username);
        }
      } else if (!silent) {
        alert("No profiles found for this API Key.");
      }
    } catch (e) {
      if (!silent) alert("Error fetching User Profiles. Please check key.");
      console.error(e);
    }
  };

  // Hosted is paid-only (no BYOK core). Self-host uses BYOK keys.
  // `keysMissing` now means "self-host BYOK keys missing" — it never fires on hosted.
  // A self-hosted server running the moment picker on a local LLM
  // (LLM_BASE_URL) does not need a Gemini key for the core pipeline.
  const isOpenAiConfigured = (backendSettings?.llm_provider === 'openai' || !backendSettings?.llm_provider) && Boolean(backendSettings?.llm_base_url && backendSettings?.llm_model);
  const isGeminiConfigured = backendSettings?.llm_provider === 'gemini' && Boolean(backendSettings?.gemini_api_key || apiKey);
  const keysMissing = !billingEnabled && !isOpenAiConfigured && !isGeminiConfigured && !localLlm && !apiKey;
  const needsPlan = billingEnabled && !isManaged;

  // Fresh sign-up: Clip Generator tutorial (AuthContext set os_show_clip_tutorial
  // after the auth redirect). QA: #app?tutorial=1. Resume coach if they refreshed
  // mid-job. Runs once on mount so a later isSignedIn flip cannot reset intro→coach.
  useEffect(() => {
    let showTutorial = false;
    let resumeCoach = false;
    try {
      const q = new URLSearchParams((window.location.hash.split('?')[1] || ''));
      const qa = q.get('tutorial');
      if (qa === '1') showTutorial = true;
      if (qa === 'coach') resumeCoach = true;
      if (qa === 'celebrate') { setTutorialPhase('celebrate'); return; }
      if (localStorage.getItem('os_show_clip_tutorial') === '1') showTutorial = true;
      if (localStorage.getItem('os_clip_tutorial') === 'coach') resumeCoach = true;
      // A request parked before the sign-in redirect is about to resume on its
      // own: opening the intro ("paste a link and generate") on top of a job
      // that is already starting contradicts itself. Skip it for this signup.
      if (showTutorial && peekPendingJob()) {
        showTutorial = false;
        localStorage.removeItem('os_show_clip_tutorial');
      }
    } catch (_) { /* ignore */ }
    if (showTutorial) {
      setTutorialPhase('intro');
      setActiveTab('dashboard');
    } else if (resumeCoach) {
      setTutorialPhase('coach');
      setActiveTab('dashboard');
    }
  }, []);

  // Legacy: an older build may still have set os_show_plan_choice. Don't open it
  // on top of the tutorial.
  useEffect(() => {
    if (tutorialPhase) return;
    if (!(billingEnabled && isSignedIn)) return;
    let showPlans = false;
    try { showPlans = localStorage.getItem('os_show_plan_choice') === '1'; } catch (_) { /* ignore */ }
    if (showPlans) {
      setShowPlanChoice(true);
      try { localStorage.removeItem('os_show_plan_choice'); } catch (_) { /* ignore */ }
    }
  }, [billingEnabled, isSignedIn, tutorialPhase]);

  const tutorialLock = false;

  // Sign-up survey (cloud/onboarding.py): before the tutorial intro, never
  // during the coach phase or the celebration. It may open while a job runs or
  // once it is done: a link pasted on the landing resumes straight into
  // processing after sign-in, and gating on 'idle' left ~half of all sign-ups
  // (the landing-paste flow, 98% of whom never come back) unasked.
  const [surveyDone, setSurveyDone] = useState(false);
  const showSurvey = billingEnabled && !!me?.onboarding_survey_pending && !surveyDone
    && (tutorialPhase === null || tutorialPhase === 'intro') && status !== 'error';

  useEffect(() => {
    if (tutorialLock && activeTab !== 'dashboard') setActiveTab('dashboard');
  }, [tutorialLock, activeTab]);

  // Deep links into a tab: #app?tab=autopilot (Autopilot emails, the social
  // connect page's return URL). Read once per hash change, then the query is
  // dropped so a reload does not keep forcing the tab.
  const [autopilotConnected, setAutopilotConnected] = useState(null); // connect outcome, see lib/connectReturn.js
  useEffect(() => {
    const DEEP_LINK_TABS = ['autopilot', 'history', 'settings', 'thumbnails', 'dashboard', 'saasshorts'];
    const apply = () => {
      const hash = window.location.hash || '';
      if (!hash.startsWith('#app?')) return;
      const params = new URLSearchParams(hash.slice(5));
      const tab = params.get('tab');
      if (!tab || !DEEP_LINK_TABS.includes(tab)) return;  // e.g. #app?tutorial=1
      setActiveTab(tab);
      // The connect outcome rides in the query string, not in the hash
      // (lib/connectReturn.js): a cancel also comes back with connected=1.
      if (tab === 'autopilot' && params.get('connected') === '1') {
        setAutopilotConnected(readConnectReturn(window.location.search));
      }
      try {
        window.history.replaceState(null, '', `${window.location.pathname}${stripConnectReturn(window.location.search)}#app`);
      } catch (_) { /* ignore */ }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // Signed out on a tab that needs a session (the clips-ready email links to
  // #app?tab=history): remember it, so the sign-in comes back here instead of
  // to the Clip Generator (lib/tabAfterLogin, read by AuthContext).
  useEffect(() => {
    if (billingEnabled && !authLoading && !isSignedIn) rememberTabAfterLogin(activeTab);
  }, [billingEnabled, authLoading, isSignedIn, activeTab]);

  // #app?checkout=cancel: back from a Stripe checkout opened inside the app
  // (cancel_url in cloud/billing.py), so the user lands on their clips again.
  useEffect(() => {
    const hash = window.location.hash || '';
    if (!hash.startsWith('#app?') || new URLSearchParams(hash.slice(5)).get('checkout') !== 'cancel') return;
    track('CheckoutCanceled', { props: { back_to: 'app' } });
    try { window.history.replaceState(null, '', '#app'); } catch (_) { /* ignore */ }
  }, []);

  // #app?login=1: the "Log in" link of the site nav (seo/nav.js). Opens the
  // sign-in dialog once the session is known (already signed in: just the
  // app), then drops the query so a reload does not reopen it.
  const wantsLogin = () => {
    const hash = window.location.hash || '';
    return hash.startsWith('#app?') && new URLSearchParams(hash.slice(5)).get('login') === '1';
  };
  const [loginRequested, setLoginRequested] = useState(wantsLogin);
  useEffect(() => {
    const onHash = () => { if (wantsLogin()) setLoginRequested(true); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!loginRequested || authLoading) return;
    setLoginRequested(false);
    if (billingEnabled && !isSignedIn) setShowLogin(true);
    try { window.history.replaceState(null, '', '#app'); } catch (_) { /* ignore */ }
  }, [loginRequested, authLoading, billingEnabled, isSignedIn]);

  useEffect(() => {
    if (tutorialPhase === 'coach' && status === 'complete' && (results?.clips?.length > 0)) {
      setTutorialPhase('celebrate');
      track('ClipTutorialCompleted', { props: { clips: results.clips.length } });
    }
  }, [tutorialPhase, status, results]);

  const finishTutorial = () => {
    try { localStorage.setItem('os_clip_tutorial', 'done'); } catch (_) { /* ignore */ }
    try { localStorage.removeItem('os_show_clip_tutorial'); } catch (_) { /* ignore */ }
    setTutorialPhase(null);
  };
  const startTutorial = () => {
    try { localStorage.setItem('os_clip_tutorial', 'coach'); } catch (_) { /* ignore */ }
    try { localStorage.removeItem('os_show_clip_tutorial'); } catch (_) { /* ignore */ }
    track('ClipTutorialStarted');
    setTutorialPhase('coach');
    setActiveTab('dashboard');
  };
  const skipTutorial = () => {
    track('ClipTutorialSkipped', { props: { phase: tutorialPhase } });
    finishTutorial();
  };
  // Included in the plan (fully managed, no keys): Clip Generator + YouTube Studio.
  // Advanced (bring your own fal.ai + ElevenLabs keys): AI Shorts + AI Agent.
  const INCLUDED_TOOL_TABS = ['dashboard', 'thumbnails'];
  const ADVANCED_TOOL_TABS = ['saasshorts', 'ai-agent'];
  const TOOL_NAMES = { dashboard: 'the Clip Generator', thumbnails: 'the YouTube Studio' };
  const gateThisTab = needsPlan && INCLUDED_TOOL_TABS.includes(activeTab);      // included tool, no plan yet
  const advancedThisTab = billingEnabled && ADVANCED_TOOL_TABS.includes(activeTab); // BYOK-notice tools

  // Social nudge visibility: managed users with clips on screen and no network
  // connected yet. userProfiles being empty (not yet fetched / none created)
  // also counts as "not connected" — that is the 97% case.
  const connectedSocials = ((userProfiles.find((p) => p.username === uploadUserId) || userProfiles[0])?.connected) || [];
  const showAutopilotNudge = billingEnabled && isManaged && !autopilotNudgeDismissed && !autopilotOn && !tutorialLock;
  const showSocialNudge = isManaged && !socialNudgeDismissed && connectedSocials.length === 0 && !tutorialLock
    && !showAutopilotNudge;

  // Paid plans may already run Autopilot: ask once, on the first results.
  const autopilotCheckedRef = useRef(false);
  useEffect(() => {
    if (status !== 'complete' || !showAutopilotNudge || plan === 'free' || autopilotCheckedRef.current) return;
    autopilotCheckedRef.current = true;
    apiJson('/api/autopilot')
      .then((d) => { if (d?.settings?.enabled) setAutopilotOn(true); })
      .catch(() => { /* keep the nudge */ });
  }, [status, showAutopilotNudge, plan]);

  const dismissAutopilotNudge = (event) => {
    track(event);
    setAutopilotNudgeDismissed(true);
    try { localStorage.setItem('os_autopilot_nudge_dismissed', '1'); } catch (_) { /* ignore */ }
  };

  const autopilotNudgeSeenRef = useRef(null);
  useEffect(() => {
    if (status === 'complete' && (results?.clips?.length > 0) && showAutopilotNudge && autopilotNudgeSeenRef.current !== jobId) {
      autopilotNudgeSeenRef.current = jobId;
      track('AutopilotNudgeSeen', { props: { plan: plan || 'free' } });
    }
  }, [status, results, showAutopilotNudge, jobId, plan]);

  // One Seen event per job, only when the banner actually rendered.
  const socialNudgeSeenRef = useRef(null);
  useEffect(() => {
    if (status === 'complete' && (results?.clips?.length > 0) && showSocialNudge && socialNudgeSeenRef.current !== jobId) {
      socialNudgeSeenRef.current = jobId;
      track('SocialNudgeSeen', { props: { clips: results.clips.length } });
    }
  }, [status, results, showSocialNudge, jobId]);

  // Managed users connect their socials via Upload-Post's branded hosted page.
  const handleConnectSocials = async () => {
    try {
      const { access_url } = await apiJson('/api/social/connect', { method: 'POST' });
      // Same tab so the connect page's redirectUrl brings the user back into the app.
      if (access_url) window.location.href = access_url;
    } catch (e) {
      alert('Could not open the connection page. Please try again.');
    }
  };

  // Open the Upload-Post white-label page (which includes the scheduling calendar)
  // in a new tab, for consulting/managing scheduled posts from the dashboard.
  const handleOpenCalendar = async () => {
    try {
      const { access_url } = await apiJson('/api/social/connect', { method: 'POST' });
      if (access_url) window.open(access_url, '_blank', 'noopener');
    } catch (e) {
      alert('Could not open the calendar. Please try again.');
    }
  };

  const handleProcess = async (data, forceLowQuality = false) => {
    // Hosted: must be signed in AND on an active plan/trial. Self-host: BYOK keys.
    if (billingEnabled) {
      // The billing gate below is unchanged: signed in, then entitled, then the
      // processing path. The only new thing is the first branch remembering what
      // the visitor asked for before sending them to sign in, so the resume
      // effect can hand the exact same request back to this function and let it
      // fall through the same gates.
      if (!isSignedIn) { stashPendingJob(data); setShowLogin(true); return; }
      if (!isManaged) { window.location.hash = '#/pricing'; return; }
    } else if (keysMissing) {
      setShowKeyModal(true);
      return;
    }
    // Past every gate, so this request is really running: nothing left to resume.
    clearPendingJob();
    setStatus('processing');
    setJobError('');
    setLogs(["Starting process..."]);
    setLogTimes([Date.now() / 1000]);
    setResults(null);
    // Studio handovers have no local media object; the preview switches to the
    // backend-served source once the job id is known.
    setProcessingMedia(data.type === 'thumbnail_session' ? null : data);
    setQualityGate(null);
    setProjectState(null);
    setNoSource(false);
    setPartialJob(null);
    setFirstVideoJob(false);

    try {
      let body;
      // BYOK sends the Gemini header; managed users rely on the bearer token
      // that apiFetch attaches automatically.
      const geminiKey = apiKey || backendSettings?.gemini_api_key;
      const headers = geminiKey ? { 'X-Gemini-Key': geminiKey } : {};

      // Advanced generation controls: only sent when the user set them, so the
      // default request stays byte-identical to the pre-feature one.
      const advanced = {
        target_clips: data.targetClips || null,
        clip_min_seconds: data.clipMinSeconds || null,
        clip_max_seconds: data.clipMaxSeconds || null,
        // Sent explicitly both ways: absent means off for raw API callers,
        // but the dashboard always states the user's choice.
        auto_hook: data.autoHook ? '1' : '0',
        auto_hook_style: data.autoHook ? (data.autoHookStyle || 'pill') : null,
        // 'auto' is the server default, so only a deliberate choice travels.
        layouts: data.layout && data.layout !== 'auto' ? data.layout : null,
        subtitle_script: data.subtitleScript && data.subtitleScript !== 'auto' ? data.subtitleScript : null,
        metadata_script: data.metadataScript && data.metadataScript !== 'auto' ? data.metadataScript : null,
        post_youtube_account_id: data.postYoutubeAccountId ? Number(data.postYoutubeAccountId) : null,
        post_instagram_account_id: data.postInstagramAccountId ? Number(data.postInstagramAccountId) : null,
        auto_post: data.autoPost ? 1 : 0,
        // Set when the user took the quota wall's "clip the first N minutes"
        // offer: the server reserves N minutes and cuts the source to them.
        max_minutes: data.maxMinutes || null,
        // The stretch picked under the cost line (seconds); absent = whole video.
        source_start: data.sourceStart ?? null,
        source_end: data.sourceEnd ?? null,
      };

      if (data.type === 'url') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          url: data.payload,
          acknowledged: !!data.acknowledged,
          output_format: data.outputFormat || 'auto',
          force_low_quality: forceLowQuality,
          ...Object.fromEntries(Object.entries(advanced).filter(([, v]) => v != null)),
        });
      } else if (data.type === 'thumbnail_session') {
        // Handover from Thumbnail Studio (issue #68): the video and transcript
        // already live server-side, keyed by the Studio session.
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          thumbnail_session_id: data.payload,
          acknowledged: !!data.acknowledged,
          output_format: data.outputFormat || 'auto',
          ...Object.fromEntries(Object.entries(advanced).filter(([, v]) => v != null)),
        });
      } else {
        const formData = new FormData();
        formData.append('file', data.payload);
        formData.append('acknowledged', data.acknowledged ? 'true' : 'false');
        formData.append('output_format', data.outputFormat || 'auto');
        for (const [k, v] of Object.entries(advanced)) {
          if (v != null) formData.append(k, v);
        }
        body = formData;
      }

      const res = await apiFetch('/api/process', { method: 'POST', headers, body });

      if (!res.ok) throw new Error(await res.text());
      const resData = await res.json();

      // Quality gate: the source is below the min resolution — ask before burning
      // 20 min on it. On confirm we resend with force_low_quality.
      if (resData.needs_confirmation) {
        setStatus('idle');
        setQualityGate({ info: resData.quality_check, data });
        return;
      }

      setJobId(resData.job_id);
      setPartialJob(resData.partial || null);
      setFirstVideoJob(!!resData.first_video);
      // The server clipped past the balance on its own (no wall): the first
      // video whole, or the first N minutes of a later one.
      if (resData.first_video) track('FirstVideoGrant');
      else if (resData.partial && !resData.partial.chosen && data.maxMinutes == null) {
        track('AutoPartial', { props: { processed: resData.partial.processed_minutes, total: resData.partial.total_minutes } });
      }
      if (data.type === 'thumbnail_session') {
        setProcessingMedia({ type: 'server', payload: `/api/source/${resData.job_id}` });
      }
      // Minutes are reserved at job start, not at complete.
      refreshMe();

    } catch (e) {
      if (e instanceof QuotaError && e.code === 'free_queue_full') {
        // The free queue is full: nothing was reserved or spent. Same plan
        // wall, its own copy and source so the funnel is measured apart.
        setStatus('idle');
        setTopUpInfo({ context: 'queue_full', source: 'queue_full', highlight: 'starter' });
        setShowTopUp(true);
        return;
      }
      if (e instanceof QuotaError) {
        setStatus('idle');
        refreshMe();
        // Trial users hit the trial minute cap → prompt them to activate the plan
        // now (unlocks full minutes). Active users → offer a top-up.
        if (me?.status === 'trialing') {
          setShowTrialUpgrade(true);
        } else {
          // The wall can offer the first N minutes of this same submission on
          // the minutes they have: same data, plus max_minutes.
          const partial = e.partialMinutes || 0;
          setTopUpInfo({
            required: e.minutesRequired,
            remaining: e.minutesRemaining,
            partialMinutes: partial,
            onPartial: partial
              ? () => {
                  track('PartialClipChosen', { props: { required: e.minutesRequired, partial } });
                  setShowTopUp(false);
                  handleProcess({ ...data, maxMinutes: partial }, forceLowQuality);
                }
              : null,
          });
          setShowTopUp(true);
        }
        return;
      }
      const reason = readableError(e.message);
      setJobError(reason);
      setStatus('error');
      setLogs(l => [...l, `Error starting job: ${reason}`]);
    }
  };

  // Resume the job the visitor started before signing in. Runs on the render
  // that first sees isSignedIn true — after a magic link or a Google round trip,
  // i.e. a fresh document — and replays the request through handleProcess, so
  // the entitlement gate still decides whether it actually runs: an unentitled
  // account lands on #/pricing with the request still parked, and pays for it
  // later. `resumedStamp` keeps one parked request from being replayed twice in
  // the same document (the pricing redirect would otherwise loop on it).
  const handleProcessRef = useRef(null);
  const resumedStampRef = useRef(0);
  useEffect(() => {
    handleProcessRef.current = handleProcess;
  });
  useEffect(() => {
    if (!billingEnabled || !isSignedIn) return;
    const pending = peekPendingJob();
    if (!pending || pending.stamp === resumedStampRef.current) return;
    resumedStampRef.current = pending.stamp;
    track('JobResumedAfterSignin', { props: { type: pending.data?.type || 'unknown' } });
    handleProcessRef.current(pending.data);
  }, [billingEnabled, isSignedIn]);

  const handleReset = () => {
    setJobGone(false);
    // Flush any pending edit-state sync before dropping the project: the clips
    // themselves are already archived to R2 as they were edited.
    flushClipState();
    setStatus('idle');
    setJobId(null);
    setResults(null);
    setLogs([]);
    setLogTimes([]);
    setProcessingMedia(null);
    setProjectState(null);
    setNoSource(false);
    setPartialJob(null);
    setFirstVideoJob(false);
    setQueueInfo(null);
    setJobError('');
    localStorage.removeItem(SESSION_KEY);
  };
  useEffect(() => {
    handleResetRef.current = handleReset;
  });

  // --- UI Components ---
  const navItems = [
    { id: 'dashboard', ord: '01', icon: Film, label: 'Clip Studio', short: 'Studio', primary: true },
    { id: 'live', ord: '02', icon: Radio, label: 'Creator Monitors', short: 'Monitors', primary: true },
    { id: 'history', ord: '03', icon: History, label: 'Project Library', short: 'Library', primary: true },
    { id: 'settings', ord: '04', icon: Settings, label: 'Settings & Accounts', short: 'Settings', primary: true },
  ];
  const activeNav = navItems.find((n) => n.id === activeTab);

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const goToTab = (id) => {
    if (tutorialLock && id !== 'dashboard') return;
    setActiveTab(id);
    setNavOpen(false);
  };
  const tabLocked = (id) => tutorialLock && id !== 'dashboard';

  const NavFooterLinks = ({ collapsed = false }) => {
    const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return (
      <div className="flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between">
          <span className={`text-[11px] font-mono text-muted uppercase tracking-wider ${collapsed ? 'hidden lg:block' : ''}`}>Theme</span>
          <button
            type="button"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            className="p-1.5 rounded-lg border border-rule hover:border-rule2 bg-paper3 text-muted hover:text-ink transition-colors flex items-center gap-1.5 text-xs font-mono"
            title={`Toggle Theme (Current: ${theme})`}
          >
            {isDark ? <Sun size={13} className="text-amber-400" /> : <Moon size={13} className="text-brandblue" />}
            <span className={collapsed ? 'hidden lg:inline' : 'inline'}>{isDark ? 'Dark' : 'Light'}</span>
          </button>
        </div>
        <div className="text-[10.5px] font-mono text-muted/70 flex items-center justify-between pt-1 border-t border-rule/50">
          <span className={collapsed ? 'hidden lg:block' : ''}>ClipSnipr v1.0</span>
          <span className="text-emerald-500 flex items-center gap-1 font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse" /> Live
          </span>
        </div>
      </div>
    );
  };

  // Desktop rail
  const Sidebar = () => (
    <div className="hidden md:flex w-20 lg:w-64 bg-paper2 border-r border-rule flex-col h-full shrink-0 transition-all duration-300">
      <a href="#app" onClick={() => goToTab('dashboard')} className="p-5 flex items-center gap-3" title="ClipSnipr Studio">
        <BrandLogo />
      </a>

      <nav className="flex-1 px-3 py-3 space-y-1">
        {navItems.map((item) => {
          const NavIcon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => goToTab(item.id)}
              title={item.label}
              disabled={tabLocked(item.id)}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-brand/10 text-brand font-semibold'
                  : 'text-muted hover:text-ink hover:bg-paper3/60'
              } ${tabLocked(item.id) ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <NavIcon size={18} className={`shrink-0 ${isActive ? 'text-brand' : ''}`} />
              <span className="hidden lg:block flex-1 text-left truncate">{item.label}</span>
              {isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-brand hidden lg:block shrink-0" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-rule">
        <NavFooterLinks collapsed />
      </div>
    </div>
  );

  // Mobile drawer
  const MobileNavDrawer = () => (
    <div
      className="md:hidden fixed inset-0 z-[90] flex"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
    >
      <div
        className="absolute inset-0 bg-black/60 animate-fade"
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />
      <div className="relative w-[17rem] max-w-[82vw] h-full bg-paper2 border-r border-rule flex flex-col animate-slide-in-left">
        <div className="flex items-center justify-between px-5 h-14 border-b border-rule shrink-0">
          <a href="#app" className="flex items-center gap-2.5" onClick={() => goToTab('dashboard')}>
            <BrandLogo />
          </a>
          <button
            onClick={() => setNavOpen(false)}
            aria-label="close navigation"
            className="p-2 -mr-2 text-muted hover:text-ink transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3 space-y-1">
          {navItems.map((item) => {
            const NavIcon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => goToTab(item.id)}
                disabled={tabLocked(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-brand/10 text-brand font-semibold'
                    : 'text-muted active:bg-paper3/60'
                } ${tabLocked(item.id) ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <NavIcon size={18} className={`shrink-0 ${isActive ? 'text-brand' : ''}`} />
                <span className="flex-1 text-left truncate">{item.label}</span>
                {isActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-brand shrink-0" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="px-4 py-3 border-t border-rule safe-bottom shrink-0">
          <NavFooterLinks />
        </div>
      </div>
    </div>
  );

  // Bottom tab bar for mobile
  const MobileTabBar = () => {
    const tabs = navItems.filter((n) => n.primary);
    return (
      <nav className="md:hidden shrink-0 border-t border-rule bg-paper2/95 backdrop-blur-sm safe-bottom">
        <div className="flex items-stretch">
          {tabs.map((item) => {
            const NavIcon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => goToTab(item.id)}
                disabled={tabLocked(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2 min-h-[54px] transition-colors ${
                  isActive ? 'text-brand font-semibold' : 'text-muted active:text-ink'
                } ${tabLocked(item.id) ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <NavIcon size={18} className={isActive ? 'text-brand' : ''} />
                <span className="text-[11px] leading-none truncate max-w-full px-0.5">{item.short}</span>
              </button>
            );
          })}
        </div>
      </nav>
    );
  };

  return (
    /* h-dvh where supported: on mobile Safari/Chrome `100vh` is the tallest the
       viewport ever gets, so a h-screen shell hides its own bottom bar behind
       the browser chrome until the user scrolls. */
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] bg-paper overflow-hidden">
      <Sidebar />
      {navOpen && <MobileNavDrawer />}

      <main className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        {/* Top Header */}
        <header className="h-14 border-b border-rule bg-paper2 flex items-center justify-between gap-3 px-3 sm:px-6 shrink-0 z-10">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setNavOpen(true)}
              aria-label="open navigation"
              className="md:hidden -ml-1 p-2 rounded-lg text-muted active:bg-paper3 transition-colors shrink-0"
            >
              <Menu size={20} />
            </button>
            <div className="md:hidden">
              <BrandLogo />
            </div>
            <div className="hidden md:flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted font-mono">
                {activeNav?.label || 'Clip Studio'}
              </span>
            </div>
            {status !== 'idle' && (
              <button
                onClick={handleReset}
                className="btn-quiet px-3 py-1.5 text-xs shrink-0 flex items-center gap-1.5"
                aria-label="New Project"
              >
                <Plus size={14} />
                <span className="hidden sm:inline">New Project</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
            {/* Quick social connected badges */}
            {socialStatus.youtube?.connected && (
              <span className="badge-ok hidden lg:inline-flex text-[11px]" title={`YouTube: ${socialStatus.youtube.channel_title}`}>
                <Youtube size={12} /> YouTube
              </span>
            )}
            {socialStatus.instagram?.connected && (
              <span className="badge-ok hidden lg:inline-flex text-[11px]" title={`Instagram: @${socialStatus.instagram.username}`}>
                <Instagram size={12} /> Instagram
              </span>
            )}

            {keysMissing && (
              <button
                onClick={() => goToTab('settings')}
                className="badge-warn hover:brightness-110 transition-all hidden sm:inline-flex"
                title="Configure LLM or API keys in Settings"
              >
                <AlertTriangle size={12} />
                <span className="hidden md:inline">API Keys Missing</span>
                <span className="md:hidden">Keys</span>
              </button>
            )}
          </div>
        </header>

        {/* Persistent Missing Keys Banner — visible on every screen */}
        {keysMissing && activeTab !== 'settings' && (
          <div className="mx-3 sm:mx-6 mt-3 px-3.5 sm:px-4 py-3 bg-paper2 border border-rule rounded-card flex flex-wrap items-center justify-between gap-2.5 sm:gap-4 shrink-0 animate-fade">
            <div className="flex items-start sm:items-center gap-2.5 sm:gap-3 text-sm text-ink2 min-w-0 flex-1">
              <KeyRound size={16} className="shrink-0 text-warn mt-0.5 sm:mt-0" />
              <div className="min-w-0">
                <span className="font-medium text-ink">Required API configuration missing.</span>{' '}
                <span className="text-muted text-xs">
                  Configure your LLM provider or Groq API key in Settings to begin clipping.
                </span>
              </div>
            </div>
            <button
              onClick={() => goToTab('settings')}
              className="btn-quiet px-3 py-1.5 text-xs shrink-0 w-full sm:w-auto"
            >
              Go to Settings
            </button>
          </div>
        )}

        {/* Session Recovery Banner */}
        {sessionRecovered && (
          <div className="mx-3 sm:mx-6 mt-2 px-3.5 sm:px-4 py-3 bg-paper2 border border-rule rounded-card flex items-start justify-between gap-3 animate-fade shrink-0">
            <div className="flex items-start sm:items-center gap-2 text-sm text-ink2 flex-wrap min-w-0">
              <RotateCcw size={16} className="text-brass shrink-0 mt-0.5 sm:mt-0" />
              <span className="font-medium">Session recovered</span>
              <span className="text-muted text-xs">Your previous work has been restored.</span>
            </div>
            <button
              onClick={() => setSessionRecovered(false)}
              aria-label="dismiss"
              className="text-muted hover:text-ink transition-colors shrink-0 -m-1 p-1"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* The restored job is no longer on the server (purged or not yours). */}
        {jobGone && (
          <div role="status" className="mx-3 sm:mx-6 mt-2 px-3.5 sm:px-4 py-3 bg-paper2 border border-rule rounded-card flex items-start justify-between gap-3 animate-fade shrink-0">
            <div className="flex items-start sm:items-center gap-2 text-sm text-ink2 flex-wrap min-w-0">
              <History size={16} className="text-brass shrink-0 mt-0.5 sm:mt-0" />
              <span className="font-medium">That project is no longer open</span>
              <span className="text-muted text-xs">
                {billingEnabled && isSignedIn
                  ? 'If it finished, its clips are saved in History.'
                  : 'The server has already cleared it. Start a new project to keep going.'}
              </span>
            </div>
            <button
              onClick={() => setJobGone(false)}
              aria-label="dismiss"
              className="text-muted hover:text-ink transition-colors shrink-0 -m-1 p-1"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Main Workspace */}
        <div className="flex-1 overflow-hidden relative">

          {/* View: Settings */}
          {activeTab === 'settings' && (
            <div className="h-full overflow-y-auto custom-scrollbar p-4 sm:p-8 max-w-4xl mx-auto animate-fade space-y-6">
              {/* Header */}
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-2 border-b border-rule">
                <div>
                  <p className="eyebrow mb-1.5 flex items-center gap-2">
                    <Settings size={12} className="text-brass" /> 03 · SETTINGS &amp; PERSISTENCE
                  </p>
                  <h1 className="font-display lowercase text-2xl sm:text-3xl text-ink">Configuration</h1>
                  <p className="text-xs text-muted mt-1">
                    All settings are persistently stored in SQLite (<code className="text-brass">clipsnipr.db</code>).
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {settingsSaved && (
                    <span className="badge-ok flex items-center gap-1.5 py-1 px-3 text-xs">
                      <Check size={14} /> Saved to Database
                    </span>
                  )}
                  {settingsLoading && (
                    <span className="badge-brass flex items-center gap-1.5 py-1 px-3 text-xs">
                      <Loader2 size={14} className="animate-spin" /> Saving...
                    </span>
                  )}
                </div>
              </div>

              {/* SECTION: Appearance & Theme */}
              <div className="card p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Sun size={18} className="text-brandblue" />
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-ink">Appearance &amp; Theme</h2>
                      <p className="text-xs text-muted">Choose interface display theme: system preference, dark obsidian, or light slate</p>
                    </div>
                  </div>
                  <StatusTag status="active" label={theme === 'system' ? 'System Theme' : theme === 'dark' ? 'Dark Mode' : 'Light Mode'} />
                </div>

                <div className="grid grid-cols-3 gap-3 p-1 bg-paper3 rounded-input border border-rule">
                  <button
                    type="button"
                    onClick={() => setTheme('system')}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${theme === 'system' ? 'bg-paper text-ink shadow-xs font-semibold' : 'text-muted hover:text-ink'}`}
                  >
                    <Monitor size={14} /> System
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme('dark')}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${theme === 'dark' ? 'bg-paper text-ink shadow-xs font-semibold' : 'text-muted hover:text-ink'}`}
                  >
                    <Moon size={14} /> Dark
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme('light')}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${theme === 'light' ? 'bg-paper text-ink shadow-xs font-semibold' : 'text-muted hover:text-ink'}`}
                  >
                    <Sun size={14} /> Light
                  </button>
                </div>
              </div>

              {/* SECTION 1: AI Provider Selector */}
              <div className="card p-5 sm:p-6 space-y-5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Cpu size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">AI Provider &amp; Model</h2>
                      <p className="text-xs text-muted">Select the LLM engine for viral moment picking and transcription analysis</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {backendSettings.llm_provider === 'openai' && backendSettings.llm_connection_status === 'connected' && (
                      <StatusTag status="connected" label="Connected & Verified" />
                    )}
                    <StatusTag status="active" label={backendSettings.llm_provider === 'openai' ? 'OpenAI-Compatible' : 'Google Gemini'} />
                  </div>
                </div>

                {/* Provider Selector Tabs */}
                <div className="grid grid-cols-2 gap-3 p-1 bg-paper3 rounded-input border border-rule">
                  <button
                    type="button"
                    onClick={() => {
                      const updated = { ...backendSettings, llm_provider: 'openai' };
                      setBackendSettings(updated);
                      saveBackendSettings(updated);
                    }}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${backendSettings.llm_provider === 'openai' ? 'bg-paper text-ink shadow-sm' : 'text-muted hover:text-ink2'}`}
                  >
                    <Server size={14} /> OpenAI-Compatible (Custom)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const updated = { ...backendSettings, llm_provider: 'gemini' };
                      setBackendSettings(updated);
                      saveBackendSettings(updated);
                    }}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${backendSettings.llm_provider === 'gemini' ? 'bg-paper text-ink shadow-sm' : 'text-muted hover:text-ink2'}`}
                  >
                    <Sparkles size={14} /> Google Gemini
                  </button>
                </div>

                {/* OpenAI-Compatible Fields */}
                {backendSettings.llm_provider === 'openai' && (
                  <div className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                        API Base URL <span className="text-warn">*</span>
                      </label>
                      <input
                        type="text"
                        value={backendSettings.llm_base_url || ''}
                        onChange={(e) => setBackendSettings({ ...backendSettings, llm_base_url: e.target.value })}
                        placeholder="https://api.onebyt.live/v1 or http://localhost:11434/v1"
                        className="input-field text-sm font-mono w-full"
                      />
                      <p className="text-[11px] text-muted">
                        Endpoint for OpenAI-compatible completions (<code className="text-brass">/chat/completions</code>). Works with OneByt, Groq, Ollama, vLLM, DeepSeek, OpenRouter, and OpenAI.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                        API Key
                      </label>
                      <div className="relative">
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          value={backendSettings.llm_api_key || ''}
                          onChange={(e) => setBackendSettings({ ...backendSettings, llm_api_key: e.target.value })}
                          placeholder="sk-... (optional for local Ollama/vLLM endpoints)"
                          className="input-field text-sm font-mono w-full pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink transition-colors p-1"
                        >
                          {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                          Model Identifier <span className="text-warn">*</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => setManualModelInput(!manualModelInput)}
                          className="text-[11px] text-brass hover:underline flex items-center gap-1"
                        >
                          {manualModelInput ? 'Select from fetched list' : 'Enter custom model name manually'}
                        </button>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-2">
                        {manualModelInput || availableModels.length === 0 ? (
                          <input
                            type="text"
                            value={backendSettings.llm_model || ''}
                            onChange={(e) => setBackendSettings({ ...backendSettings, llm_model: e.target.value })}
                            placeholder="e.g. gpt-4o-mini, qwen2.5-coder:32b, meta-llama/llama-3.1-70b"
                            className="input-field text-sm font-mono flex-1"
                          />
                        ) : (
                          <select
                            value={backendSettings.llm_model || ''}
                            onChange={(e) => setBackendSettings({ ...backendSettings, llm_model: e.target.value })}
                            className="input-field text-sm font-mono flex-1 bg-paper3"
                          >
                            {availableModels.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          onClick={handleFetchModels}
                          disabled={fetchingModels || !backendSettings.llm_base_url}
                          className="btn-quiet py-2 px-3 text-xs flex items-center justify-center gap-1.5 shrink-0"
                          title="Queries {base_url}/models to auto-populate available models"
                        >
                          <RefreshCw size={13} className={fetchingModels ? 'animate-spin text-brass' : ''} />
                          {fetchingModels ? 'Fetching...' : 'Fetch Models'}
                        </button>
                      </div>

                      {fetchModelsError && (
                        <p className="text-xs text-danger flex items-center gap-1.5 mt-1">
                          <AlertCircle size={13} /> {fetchModelsError}
                        </p>
                      )}
                    </div>

                    {/* Local Face-tracking Notice */}
                    <div className="p-3 bg-paper3/60 border border-rule rounded-input text-xs text-muted flex items-start gap-2.5">
                      <Shield size={16} className="text-ok shrink-0 mt-0.5" />
                      <div>
                        <strong className="text-ink font-medium">Local Face Tracking Activated:</strong> When using an OpenAI-compatible provider, ClipSnipr automatically disables Google GenAI layout calls and tracks active speakers using local OpenCV &amp; MediaPipe (<code className="text-brass">crop.py</code>).
                      </div>
                    </div>

                    {/* Test Connection Button & Persistent Status */}
                    <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-rule/50">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={handleTestLlmConnection}
                          disabled={testingLlm || !backendSettings.llm_base_url || !backendSettings.llm_model}
                          className="btn-quiet py-2 px-3 text-xs flex items-center justify-center gap-1.5 shrink-0"
                          title="Sends a test ping to {base_url}/chat/completions to verify credentials"
                        >
                          <Zap size={13} className={testingLlm ? 'animate-spin text-brass' : 'text-brass'} />
                          {testingLlm ? 'Testing Connection...' : 'Test Connection'}
                        </button>
                        {backendSettings.llm_connection_status === 'connected' && (
                          <span className="badge-ok flex items-center gap-1.5 text-xs py-1 px-2.5">
                            <Check size={12} /> Connected &amp; Verified
                          </span>
                        )}
                        {backendSettings.llm_connection_status === 'failed' && (
                          <span className="badge-warn flex items-center gap-1.5 text-xs py-1 px-2.5 text-danger">
                            <AlertCircle size={12} /> Connection Failed
                          </span>
                        )}
                      </div>
                      {llmTestMsg && (
                        <p className={`text-xs flex items-center gap-1.5 ${llmTestMsg.ok ? 'text-ok' : 'text-danger'}`}>
                          {llmTestMsg.ok ? <Check size={13} /> : <AlertCircle size={13} />} {llmTestMsg.message}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Gemini Fields */}
                {backendSettings.llm_provider === 'gemini' && (
                  <div className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                        Google Gemini API Key <span className="text-warn">*</span>
                      </label>
                      <input
                        type="password"
                        value={backendSettings.gemini_api_key || ''}
                        onChange={(e) => {
                          setBackendSettings({ ...backendSettings, gemini_api_key: e.target.value });
                          setApiKey(e.target.value);
                        }}
                        placeholder="AIzaSy..."
                        className="input-field text-sm font-mono w-full"
                      />
                      <p className="text-[11px] text-muted">
                        Requires a Gemini API key from Google AI Studio. Gemini 2.5 Flash is used for multimodal scene analysis.
                      </p>
                    </div>
                  </div>
                )}

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => saveBackendSettings()}
                    disabled={settingsLoading}
                    className="btn-primary py-2 px-5 text-xs flex items-center gap-2"
                  >
                    <Check size={14} /> Save AI Configuration
                  </button>
                </div>
              </div>

              {/* SECTION: Transcription & Speech-to-Text */}
              <div className="card p-5 sm:p-6 space-y-5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Mic size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">Transcription &amp; Speech-to-Text (ASR)</h2>
                      <p className="text-xs text-muted">Speech recognition engine for generating word-level subtitle timing and transcripts</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {backendSettings.transcription_provider === 'groq' && backendSettings.groq_connection_status === 'connected' && (
                      <StatusTag status="connected" label="Connected & Verified" />
                    )}
                    <StatusTag status="active" label={backendSettings.transcription_provider === 'groq' ? 'Groq Cloud Whisper' : 'Local CPU Whisper'} />
                  </div>
                </div>

                {/* Provider Selector Tabs */}
                <div className="grid grid-cols-2 gap-3 p-1 bg-paper3 rounded-input border border-rule">
                  <button
                    type="button"
                    onClick={() => {
                      const updated = { ...backendSettings, transcription_provider: 'groq' };
                      setBackendSettings(updated);
                      saveBackendSettings(updated);
                    }}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${backendSettings.transcription_provider === 'groq' ? 'bg-paper text-ink shadow-sm' : 'text-muted hover:text-ink2'}`}
                  >
                    <Zap size={14} className="text-brass" /> Groq Cloud Whisper (Recommended)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const updated = { ...backendSettings, transcription_provider: 'local' };
                      setBackendSettings(updated);
                      saveBackendSettings(updated);
                    }}
                    className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-input transition-all flex items-center justify-center gap-2 ${backendSettings.transcription_provider === 'local' ? 'bg-paper text-ink shadow-sm' : 'text-muted hover:text-ink2'}`}
                  >
                    <Cpu size={14} /> Local CPU Whisper (Offline)
                  </button>
                </div>

                {/* Groq Cloud Whisper Fields */}
                {backendSettings.transcription_provider === 'groq' && (
                  <div className="space-y-4 pt-2">
                    <div className="p-3 bg-paper3/60 border border-rule rounded-input text-xs text-muted flex items-start gap-2.5">
                      <Zap size={16} className="text-brass shrink-0 mt-0.5" />
                      <div>
                        <strong className="text-ink font-medium">Ultra-Fast Whisper Large V3:</strong> Groq provides ~200x real-time transcription with precise word timestamps. High-accuracy transcription for Hindi slang, mixed Hinglish, and fast speech with zero CPU overhead on your server.
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                        Groq API Key <span className="text-warn">*</span>
                      </label>
                      <div className="relative">
                        <input
                          type={showGroqKey ? 'text' : 'password'}
                          value={backendSettings.groq_api_key || ''}
                          onChange={(e) => setBackendSettings({ ...backendSettings, groq_api_key: e.target.value })}
                          placeholder="gsk_..."
                          className="input-field text-sm font-mono w-full pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowGroqKey(!showGroqKey)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink transition-colors p-1"
                        >
                          {showGroqKey ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                      <p className="text-[11px] text-muted">
                        Get your API key from <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-brass underline">console.groq.com</a>. Configured directly in settings with no need for server .env edits.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                        Whisper Model
                      </label>
                      <select
                        value={backendSettings.groq_whisper_model || 'whisper-large-v3'}
                        onChange={(e) => setBackendSettings({ ...backendSettings, groq_whisper_model: e.target.value })}
                        className="input-field text-sm font-mono w-full bg-paper3"
                      >
                        <option value="whisper-large-v3">whisper-large-v3 (Default — Highest multilingual &amp; Hindi accuracy)</option>
                        <option value="whisper-large-v3-turbo">whisper-large-v3-turbo (Turbo — Ultra-fast latency)</option>
                      </select>
                      <p className="text-[11px] text-muted">
                        Both models return word-level timestamps used for animated subtitles and clip cutting.
                      </p>
                    </div>

                    {/* Test Groq Connection Button & Persistent Status */}
                    <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-rule/50">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={handleTestGroqConnection}
                          disabled={testingGroq || !backendSettings.groq_api_key}
                          className="btn-quiet py-2 px-3 text-xs flex items-center justify-center gap-1.5 shrink-0"
                          title="Queries Groq API to verify your API key"
                        >
                          <Zap size={13} className={testingGroq ? 'animate-spin text-brass' : 'text-brass'} />
                          {testingGroq ? 'Testing Groq Connection...' : 'Test Connection'}
                        </button>
                        {backendSettings.groq_connection_status === 'connected' && (
                          <span className="badge-ok flex items-center gap-1.5 text-xs py-1 px-2.5">
                            <Check size={12} /> Connected &amp; Verified
                          </span>
                        )}
                        {backendSettings.groq_connection_status === 'failed' && (
                          <span className="badge-warn flex items-center gap-1.5 text-xs py-1 px-2.5 text-danger">
                            <AlertCircle size={12} /> Connection Failed
                          </span>
                        )}
                      </div>
                      {groqTestMsg && (
                        <p className={`text-xs flex items-center gap-1.5 ${groqTestMsg.ok ? 'text-ok' : 'text-danger'}`}>
                          {groqTestMsg.ok ? <Check size={13} /> : <AlertCircle size={13} />} {groqTestMsg.message}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Local CPU Whisper Info */}
                {backendSettings.transcription_provider === 'local' && (
                  <div className="space-y-3 pt-2">
                    <div className="p-3 bg-paper3/60 border border-rule rounded-input text-xs text-muted flex items-start gap-2.5">
                      <Cpu size={16} className="text-ink2 shrink-0 mt-0.5" />
                      <div>
                        <strong className="text-ink font-medium">Local CPU Whisper (faster-whisper):</strong> Runs directly on your Docker host using CPU quantization (<code className="text-brass">int8</code>). No external API key required, but uses server CPU and takes longer for long videos.
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => saveBackendSettings()}
                    disabled={settingsLoading}
                    className="btn-primary py-2 px-5 text-xs flex items-center gap-2"
                  >
                    <Check size={14} /> Save Transcription Configuration
                  </button>
                </div>
              </div>

              {/* SECTION: S3-Compatible Storage */}
              <div className="card p-5 sm:p-6 space-y-5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <HardDrive size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">S3-Compatible Cloud Storage</h2>
                      <p className="text-xs text-muted">Cloudflare R2, AWS S3, MinIO, Wasabi, Backblaze B2, or any S3 provider</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {backendSettings.s3_connection_status === 'connected' ? (
                      <StatusTag status="connected" label={`Connected: ${backendSettings.s3_bucket_name || 'S3 Bucket'}`} />
                    ) : backendSettings.s3_connection_status === 'failed' ? (
                      <StatusTag status="error" label="Connection Error" />
                    ) : (
                      <StatusTag status={backendSettings.s3_enabled === '1' ? 'active' : 'inactive'} label={backendSettings.s3_enabled === '1' ? 'Configured' : 'Disabled'} />
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted leading-relaxed">
                  Offload final generated shorts, clips, and download ZIPs directly to an S3 bucket. Downloads stream via direct presigned URLs without consuming your VPS bandwidth. All configuration is stored directly in settings without editing <code className="text-brass">.env</code>.
                </p>

                {/* Enable S3 Toggle */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="s3_enabled_checkbox"
                    checked={backendSettings.s3_enabled === '1'}
                    onChange={(e) => setBackendSettings({ ...backendSettings, s3_enabled: e.target.checked ? '1' : '0' })}
                    className="w-4 h-4 accent-brass rounded"
                  />
                  <label htmlFor="s3_enabled_checkbox" className="text-sm font-medium text-ink cursor-pointer">
                    Enable S3-Compatible Storage for video exports &amp; direct downloads
                  </label>
                </div>

                {backendSettings.s3_enabled === '1' && (
                  <div className="space-y-4 pt-2 border-t border-rule/50">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                        Endpoint URL <span className="text-muted lowercase font-normal">(Leave blank for standard AWS S3)</span>
                      </label>
                      <input
                        type="text"
                        value={backendSettings.s3_endpoint_url || ''}
                        onChange={(e) => setBackendSettings({ ...backendSettings, s3_endpoint_url: e.target.value })}
                        placeholder="https://<account_id>.r2.cloudflarestorage.com or https://s3.wasabisys.com"
                        className="input-field text-sm font-mono w-full"
                      />
                      <p className="text-[11px] text-muted">
                        For Cloudflare R2: <code className="text-brass">https://&lt;ACCOUNT_ID&gt;.r2.cloudflarestorage.com</code>. For MinIO: <code className="text-brass">http://your-minio:9000</code>.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                          Bucket Name
                        </label>
                        <input
                          type="text"
                          value={backendSettings.s3_bucket_name || ''}
                          onChange={(e) => setBackendSettings({ ...backendSettings, s3_bucket_name: e.target.value })}
                          placeholder="clipsnipr-videos"
                          className="input-field text-sm font-mono w-full"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                          Region
                        </label>
                        <input
                          type="text"
                          value={backendSettings.s3_region || 'auto'}
                          onChange={(e) => setBackendSettings({ ...backendSettings, s3_region: e.target.value })}
                          placeholder="auto (or us-east-1, ap-south-1)"
                          className="input-field text-sm font-mono w-full"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                          Access Key ID
                        </label>
                        <input
                          type="text"
                          value={backendSettings.s3_access_key || ''}
                          onChange={(e) => setBackendSettings({ ...backendSettings, s3_access_key: e.target.value })}
                          placeholder="e.g. AKIAIOSFODNN7EXAMPLE"
                          className="input-field text-sm font-mono w-full"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                          Secret Access Key
                        </label>
                        <div className="relative">
                          <input
                            type={showS3Secret ? 'text' : 'password'}
                            value={backendSettings.s3_secret_key || ''}
                            onChange={(e) => setBackendSettings({ ...backendSettings, s3_secret_key: e.target.value })}
                            placeholder="e.g. wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                            className="input-field text-sm font-mono w-full pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowS3Secret(!showS3Secret)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink p-1"
                            title={showS3Secret ? 'Hide secret key' : 'Show secret key'}
                          >
                            {showS3Secret ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Test Connection Button & Persistent Status */}
                    <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-rule/50">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={handleTestS3Connection}
                          disabled={testingS3 || !backendSettings.s3_bucket_name || !backendSettings.s3_access_key || !backendSettings.s3_secret_key}
                          className="btn-quiet py-2 px-3 text-xs flex items-center justify-center gap-1.5 shrink-0"
                          title="Tests S3 credentials and checks bucket accessibility"
                        >
                          <Zap size={13} className={testingS3 ? 'animate-spin text-brass' : 'text-brass'} />
                          {testingS3 ? 'Testing S3 Connection...' : 'Test S3 Connection'}
                        </button>
                        {backendSettings.s3_connection_status === 'connected' && (
                          <span className="badge-ok flex items-center gap-1.5 text-xs py-1 px-2.5">
                            <Check size={12} /> Connected &amp; Verified
                          </span>
                        )}
                        {backendSettings.s3_connection_status === 'failed' && (
                          <span className="badge-warn flex items-center gap-1.5 text-xs py-1 px-2.5 text-danger">
                            <AlertCircle size={12} /> Connection Failed
                          </span>
                        )}
                      </div>
                      {s3TestMsg && (
                        <p className={`text-xs flex items-center gap-1.5 ${s3TestMsg.ok ? 'text-ok' : 'text-danger'}`}>
                          {s3TestMsg.ok ? <Check size={13} /> : <AlertCircle size={13} />} {s3TestMsg.message}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => saveBackendSettings()}
                    disabled={settingsLoading}
                    className="btn-primary py-2 px-5 text-xs flex items-center gap-2"
                  >
                    <Check size={14} /> Save S3 Configuration
                  </button>
                </div>
              </div>

              {/* SECTION 2: Direct YouTube Shorts Publishing */}
              <div className="card p-5 sm:p-6 space-y-5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Youtube size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">Direct YouTube Shorts (Inbuilt)</h2>
                      <p className="text-xs text-muted">Native YouTube Data API v3 integration with OAuth 2.0 resumable uploads</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {youtubeAccounts.length > 0 ? (
                      <StatusTag status="connected" label={`${youtubeAccounts.length} Channel${youtubeAccounts.length > 1 ? 's' : ''} Connected`} />
                    ) : socialStatus.youtube?.connected ? (
                      <StatusTag status="connected" label={`Connected: ${socialStatus.youtube.channel_title || 'YouTube'}`} />
                    ) : (
                      <StatusTag status="inactive" label="Not Connected" />
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted leading-relaxed">
                  Connect your YouTube channel using your own Google Cloud OAuth 2.0 Client credentials. Uploads automatically enforce the <code className="text-brass">#Shorts</code> tag and support public, unlisted, and private visibility.
                </p>

                {youtubeAccounts.length > 0 && (
                  <div className="space-y-2 border border-rule rounded-input p-3 bg-paper3/40">
                    <label className="text-[11px] font-mono uppercase text-muted block">Connected YouTube Channels ({youtubeAccounts.length})</label>
                    <div className="divide-y divide-rule/60">
                      {youtubeAccounts.map((acc) => (
                        <div key={acc.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <Youtube size={14} className="text-red-500 shrink-0" />
                            <span className="font-semibold text-ink truncate">{acc.account_name || 'YouTube Channel'}</span>
                            {acc.account_id && <span className="text-[11px] font-mono text-muted">({acc.account_id})</span>}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDeleteSocialAccount(acc.id)}
                            className="p-1 text-muted hover:text-red-400 rounded transition-colors"
                            title="Disconnect channel"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Redirect URI Display */}
                <div className="p-3 bg-paper3 border border-rule rounded-input space-y-1.5">
                  <div className="text-[11px] font-medium text-ink2 uppercase tracking-wider flex items-center justify-between">
                    <span>Authorized Redirect URI (Google Cloud Console)</span>
                    <button
                      type="button"
                      onClick={() => {
                        const redirectUri = `${backendSettings.public_api_url || window.location.origin}/api/publish/youtube/callback`;
                        navigator.clipboard.writeText(redirectUri);
                        setYtStatusMsg('Redirect URI copied to clipboard!');
                      }}
                      className="text-brass hover:underline flex items-center gap-1 font-mono normal-case"
                    >
                      <Copy size={11} /> Copy
                    </button>
                  </div>
                  <div className="font-mono text-xs text-ink select-all break-all bg-paper p-2 rounded border border-rule">
                    {`${backendSettings.public_api_url || window.location.origin}/api/publish/youtube/callback`}
                  </div>
                  <p className="text-[10.5px] text-muted">
                    Paste this exact URL into your Google Cloud Console OAuth 2.0 Client credentials under <strong>Authorized redirect URIs</strong>.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink2 uppercase tracking-wider">Client ID</label>
                    <input
                      type="text"
                      value={ytClientId}
                      onChange={(e) => setYtClientId(e.target.value)}
                      placeholder="...apps.googleusercontent.com"
                      className="input-field text-xs font-mono w-full"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink2 uppercase tracking-wider">Client Secret</label>
                    <input
                      type="password"
                      value={ytClientSecret}
                      onChange={(e) => setYtClientSecret(e.target.value)}
                      placeholder="GOCSPX-..."
                      className="input-field text-xs font-mono w-full"
                    />
                  </div>
                </div>

                {ytStatusMsg && (
                  <div className="text-xs p-2.5 bg-paper3 rounded border border-rule text-ink2 flex items-center gap-2">
                    <Activity size={14} className="text-brass" /> {ytStatusMsg}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveYouTubeCreds}
                    disabled={ytSaving || !ytClientId || !ytClientSecret}
                    className="btn-quiet py-2 px-4 text-xs flex items-center gap-1.5"
                  >
                    {ytSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save Credentials
                  </button>
                  <button
                    type="button"
                    onClick={handleConnectYouTube}
                    className="btn-primary py-2 px-4 text-xs flex items-center gap-1.5"
                  >
                    <Youtube size={14} /> Connect YouTube Account
                  </button>
                </div>
              </div>

              {/* SECTION 3: Direct Instagram Reels Publishing */}
              <div className="card p-5 sm:p-6 space-y-5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Instagram size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">Direct Instagram Reels (Inbuilt)</h2>
                      <p className="text-xs text-muted">Instagram Graph API v21.0 integration with HMAC-signed media delivery</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {instagramAccounts.length > 0 ? (
                      <StatusTag status="connected" label={`${instagramAccounts.length} Account${instagramAccounts.length > 1 ? 's' : ''} Connected`} />
                    ) : socialStatus.instagram?.connected ? (
                      <StatusTag status="connected" label={`Connected: @${socialStatus.instagram.username || 'Instagram'}`} />
                    ) : (
                      <StatusTag status="inactive" label="Not Connected" />
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted leading-relaxed">
                  Publish Reels directly using your Meta for Developers App credentials. Requires an Instagram Business/Creator account connected to a Facebook page and a long-lived access token.
                </p>

                {instagramAccounts.length > 0 && (
                  <div className="space-y-2 border border-rule rounded-input p-3 bg-paper3/40">
                    <label className="text-[11px] font-mono uppercase text-muted block">Connected Instagram Accounts ({instagramAccounts.length})</label>
                    <div className="divide-y divide-rule/60">
                      {instagramAccounts.map((acc) => (
                        <div key={acc.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <Instagram size={14} className="text-pink-500 shrink-0" />
                            <span className="font-semibold text-ink truncate">@{acc.account_name || 'Instagram'}</span>
                            {acc.account_id && <span className="text-[11px] font-mono text-muted">({acc.account_id})</span>}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDeleteSocialAccount(acc.id)}
                            className="p-1 text-muted hover:text-red-400 rounded transition-colors"
                            title="Disconnect account"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink2 uppercase tracking-wider">Instagram Business Account ID</label>
                    <input
                      type="text"
                      value={igAccountId}
                      onChange={(e) => setIgAccountId(e.target.value)}
                      placeholder="178414..."
                      className="input-field text-xs font-mono w-full"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink2 uppercase tracking-wider">Long-Lived Access Token</label>
                    <input
                      type="password"
                      value={igAccessToken}
                      onChange={(e) => setIgAccessToken(e.target.value)}
                      placeholder="EAA..."
                      className="input-field text-xs font-mono w-full"
                    />
                  </div>
                </div>

                {igStatusMsg && (
                  <div className="text-xs p-2.5 bg-paper3 rounded border border-rule text-ink2 flex items-center gap-2">
                    <Activity size={14} className="text-brass" /> {igStatusMsg}
                  </div>
                )}

                <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
                  <span className="text-[11px] text-muted">
                    Clips are served securely via signed 30-min public URLs (<code className="text-brass">/api/public-media/...</code>).
                  </span>
                  <button
                    type="button"
                    onClick={handleSaveInstagramCreds}
                    disabled={igSaving || !igAccountId || !igAccessToken}
                    className="btn-primary py-2 px-4 text-xs flex items-center gap-1.5"
                  >
                    {igSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Verify &amp; Save
                  </button>
                </div>
              </div>

              {/* SECTION 4: Upload-Post Integration (Optional Alternative) */}
              <div className="card p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Share2 size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">Upload-Post (Optional Alternative)</h2>
                      <p className="text-xs text-muted">Alternative third-party multi-platform social publisher</p>
                    </div>
                  </div>
                  <span className="badge-quiet text-xs">Optional</span>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-ink2 uppercase tracking-wider">
                    Upload-Post API Key
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="password"
                      value={backendSettings.upload_post_api_key || ''}
                      onChange={(e) => setBackendSettings({ ...backendSettings, upload_post_api_key: e.target.value })}
                      placeholder="ey..."
                      className="input-field text-xs font-mono flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        saveBackendSettings();
                        if (backendSettings.upload_post_api_key) {
                          setUploadPostKey(backendSettings.upload_post_api_key);
                        }
                      }}
                      className="btn-quiet py-2 px-4 text-xs shrink-0"
                    >
                      Save Key
                    </button>
                  </div>
                </div>
              </div>

              {/* SECTION 5: Public Host Configuration (Advanced) */}
              <div className="card p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
                      <Globe size={18} className="text-brass" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-ink lowercase">Public Endpoints (Advanced)</h2>
                      <p className="text-xs text-muted">Domain configurations for reverse proxies (Dokploy, Traefik, Caddy)</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink2 uppercase tracking-wider">Public Backend API URL</label>
                    <input
                      type="text"
                      value={backendSettings.public_api_url || ''}
                      onChange={(e) => setBackendSettings({ ...backendSettings, public_api_url: e.target.value })}
                      placeholder="https://api.yourdomain.com"
                      className="input-field text-xs font-mono w-full"
                    />
                    <p className="text-[10px] text-muted">Used by Instagram Graph API to fetch media and YouTube OAuth callbacks.</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink2 uppercase tracking-wider">Public Frontend URL</label>
                    <input
                      type="text"
                      value={backendSettings.public_frontend_url || ''}
                      onChange={(e) => setBackendSettings({ ...backendSettings, public_frontend_url: e.target.value })}
                      placeholder="https://shorts.yourdomain.com"
                      className="input-field text-xs font-mono w-full"
                    />
                    <p className="text-[10px] text-muted">OAuth callbacks redirect back to this frontend destination.</p>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => saveBackendSettings()}
                    className="btn-quiet py-2 px-4 text-xs"
                  >
                    Save URLs
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* View: Live Streams */}
          {activeTab === 'live' && (
            <div className="h-full overflow-y-auto custom-scrollbar animate-fade">
              <div className="max-w-6xl mx-auto p-4 sm:p-6 md:p-8">
                <React.Suspense fallback={<div className="p-12 flex justify-center text-muted"><Loader2 className="animate-spin text-brass" size={20} /></div>}>
                  <LiveStreamTab
                    onReopenProject={(jobId, status) => { setActiveTab('dashboard'); restoreProject(jobId, status); }}
                    youtubeAccounts={youtubeAccounts}
                    instagramAccounts={instagramAccounts}
                  />
                </React.Suspense>
              </div>
            </div>
          )}

          {/* View: History / Library */}
          {activeTab === 'history' && (
            <div className="h-full overflow-y-auto custom-scrollbar animate-fade">
              <div className="max-w-6xl mx-auto p-4 sm:p-6 md:p-8">
                <React.Suspense fallback={<div className="p-12 flex justify-center text-muted"><Loader2 className="animate-spin text-brass" size={20} /></div>}>
                  <HistoryTab onReopenProject={restoreProject} />
                </React.Suspense>
              </div>
            </div>
          )}

          {activeTab === 'dashboard' && status === 'idle' && (
            <div className="h-full overflow-y-auto custom-scrollbar p-4 sm:p-6 lg:p-8 animate-fade">
              <div className="max-w-7xl mx-auto space-y-6">
                {/* STUDIO HEADER */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-rule">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-2 h-2 rounded-full bg-brandblue" />
                      <span className="text-xs font-mono uppercase tracking-wider text-muted font-semibold">
                        Clip Studio · AI Video Engine
                      </span>
                    </div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">
                      Clip Studio
                    </h1>
                    <p className="text-xs sm:text-sm text-muted mt-0.5">
                      Ingest videos or streams, auto-detect viral hooks with LLM, and render high-retention 9:16 vertical shorts.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusTag status="active" label="Engine Ready" />
                    {socialStatus.youtube?.connected && (
                      <span className="tag-uniform tag-connected hidden sm:inline-flex">
                        <Youtube size={12} className="text-red-500" /> YT Auto-Post
                      </span>
                    )}
                    {socialStatus.instagram?.connected && (
                      <span className="tag-uniform tag-connected hidden sm:inline-flex">
                        <Instagram size={12} className="text-pink-500" /> IG Auto-Post
                      </span>
                    )}
                  </div>
                </div>

                {/* TWO-STATION WORKBENCH */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  {/* Left Station: Media Ingest & Directing (7 cols) */}
                  <div className="lg:col-span-7 space-y-6">
                    <MediaInput
                      onProcess={handleProcess}
                      isProcessing={status === 'processing'}
                      youtubeAccounts={youtubeAccounts}
                      instagramAccounts={instagramAccounts}
                    />
                  </div>

                  {/* Right Station: Engine Deck & Live Status (5 cols) */}
                  <div className="lg:col-span-5 space-y-4">
                    {/* Live Pipeline Specs Card */}
                    <div className="card p-5 space-y-4">
                      <div className="flex items-center justify-between border-b border-rule pb-2.5">
                        <span className="text-xs font-mono uppercase font-semibold text-ink flex items-center gap-2">
                          <Cpu size={14} className="text-brandblue" /> Active Engine Pipeline
                        </span>
                        <span className="text-[10px] font-mono text-muted uppercase">v1.0 Stack</span>
                      </div>

                      <div className="space-y-3 text-xs">
                        <div className="flex items-center justify-between py-1 border-b border-rule/50">
                          <span className="text-muted">ASR Transcription</span>
                          <span className="font-semibold text-ink">
                            {backendSettings.transcription_provider === 'groq' ? 'Groq Whisper Large-v3' : 'Local Whisper'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-1 border-b border-rule/50">
                          <span className="text-muted">Moment Picker</span>
                          <span className="font-semibold text-ink">
                            {backendSettings.llm_provider === 'openai' ? (backendSettings.openai_model || 'LLM Engine') : 'Gemini 2.5'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-1 border-b border-rule/50">
                          <span className="text-muted">Framing Engine</span>
                          <span className="font-semibold text-ink">100% Height Facecam + Gameplay</span>
                        </div>
                        <div className="flex items-center justify-between py-1 border-b border-rule/50">
                          <span className="text-muted">Subtitles Delivery</span>
                          <span className="font-semibold text-ink">Hinglish / Hindi Word-by-Word</span>
                        </div>
                        <div className="flex items-center justify-between py-1">
                          <span className="text-muted">Cloud Storage</span>
                          <span className="font-semibold text-ink">
                            {backendSettings.s3_connection_status === 'connected' ? `S3: ${backendSettings.s3_bucket_name}` : 'Local Disk'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Creator Monitors Banner */}
                    <div className="card p-5 space-y-3 border-l-4 border-l-red-500">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono uppercase font-semibold text-ink flex items-center gap-1.5">
                          <Radio size={14} className="text-red-500 animate-pulse" /> Live Stream Tracking
                        </span>
                        <span className="tag-uniform tag-recording text-[10px]">Rolling 10m</span>
                      </div>
                      <p className="text-xs text-muted leading-relaxed">
                        Track creator YouTube and Twitch channels 24/7. When they go live, rolling 10-minute segments are automatically captured, transcribed, and clipped in the background.
                      </p>
                      <button
                        type="button"
                        onClick={() => goToTab('live')}
                        className="btn-ghost w-full py-2 text-xs font-semibold flex items-center justify-center gap-2"
                      >
                        <Radio size={14} className="text-red-500" />
                        <span>Open Creator Monitors</span>
                      </button>
                    </div>

                    {/* Pro Tips Card */}
                    <div className="card p-5 space-y-2.5 bg-paper3/40">
                      <span className="text-xs font-mono uppercase font-semibold text-ink flex items-center gap-1.5">
                        <Sparkles size={14} className="text-sniprorange" /> Tips for 10x Virality
                      </span>
                      <ul className="text-xs text-muted space-y-2 list-disc list-inside leading-relaxed">
                        <li><b>Hinglish Script:</b> Ideal for Hindi gaming streams — transliterates spoken Hindi into high-retention Roman subtitles.</li>
                        <li><b>Gaming Layout:</b> Automatically expands game area to fill 100% height below facecam with equal side-cropping.</li>
                        <li><b>Auto-Posting:</b> Connect YouTube and Instagram accounts in Settings to distribute clips automatically.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View: Processing / Results (Split View) */}
          {activeTab === 'dashboard' && (status === 'processing' || status === 'complete' || status === 'error') && (
            <div className="h-full flex flex-col md:flex-row gap-3 md:gap-4 p-3 md:p-4 overflow-y-auto md:overflow-y-hidden custom-scrollbar animate-fade">

              {/* Left Panel: Preview & Status */}
              <div className={`${status === 'complete' ? 'w-full md:w-[30%] lg:w-[25%]' : 'w-full md:w-[55%] lg:w-[60%]'} md:h-full flex flex-col shrink-0 md:shrink card p-3.5 sm:p-6 md:overflow-y-auto custom-scrollbar transition-all duration-700 ease-in-out`}>
                <div className="mb-4 sm:mb-6 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-ink lowercase flex items-center gap-2">
                    <Activity className={`text-brass ${status === 'processing' ? 'animate-pulse' : ''}`} size={18} />
                    Live Analysis
                  </h2>
                  <span className={status === 'processing' ? 'badge-brass' :
                    status === 'complete' ? 'badge-ok' :
                      'badge-danger'
                    }>
                    {status.toUpperCase()}
                  </span>
                </div>

                {/* Trimmed run: say it while it renders, not only once the
                    clips land, so the shorter result is no surprise. */}
                {status === 'processing' && partialJob && !partialJob.chosen && plan === 'free' && isManaged && (
                  <button
                    onClick={() => openUpsell({ source: 'partial_processing', partialJob })}
                    className="mb-4 w-full text-left rounded-card border border-brass/40 bg-brass/5 px-4 py-3 text-sm hover:border-brass transition-colors"
                  >
                    <span className="text-ink">Clipping the first {partialJob.processed_minutes} of {partialJob.total_minutes} minutes with your free minutes.</span>{' '}
                    <span className="text-brass font-medium">Clip the whole video →</span>
                  </button>
                )}

                {/* Waiting in line: say where and for how long, and that paid
                    plans go first (they do: plan priority in the job queue). */}
                {status === 'processing' && queueInfo && (
                  <div className="mb-4 rounded-card border border-brass/40 bg-brass/5 px-4 py-3 text-sm">
                    <p className="text-ink">
                      {queueInfo.ahead === 0
                        ? 'You are next in line. Starting in a moment…'
                        : <>You are <b>#{queueInfo.position}</b> in line · {queueInfo.eta_is_minimum ? 'at least' : 'about'} <b>{Math.max(1, Math.round(queueInfo.eta_seconds / 60))} min</b></>}
                    </p>
                    {queueSlow ? (
                      /* The free queue is saturated and this video is far
                         back in it: later arrivals can still pass it
                         (eta_is_minimum), so the wait is hours, not minutes.
                         Said here, when it is this user's wait, with the one
                         thing that changes it. All of it is how the queue
                         works: plan priority, and paying re-keys the video
                         already in line. */
                      <>
                        <p className="mt-1 text-muted">
                          High demand right now: free videos wait behind paid ones and this can take hours.
                          We are adding capacity.
                        </p>
                        <button
                          onClick={() => { track('QueueUpsellClick', { props: { position: String(queueInfo.position), slow: '1' } }); if (isManaged) openUpsell({ source: 'queue' }); else setShowPlanChoice(true); }}
                          className="btn-primary mt-3"
                        >
                          Skip the line with a plan
                        </button>
                        <p className="mt-2 text-xs text-muted">
                          Paid videos are usually ready in minutes, and this one moves to the front as soon as you subscribe.
                        </p>
                      </>
                    ) : billingEnabled && !['starter', 'creator', 'pro'].includes(plan) && queueInfo.ahead > 0 && (
                      <button
                        onClick={() => { track('QueueUpsellClick', { props: { position: String(queueInfo.position) } }); if (isManaged) openUpsell({ source: 'queue' }); else setShowPlanChoice(true); }}
                        className="mt-2 text-xs lowercase text-brass hover:underline"
                      >
                        paid plans skip the line →
                      </button>
                    )}
                  </div>
                )}

                {/* Video Preview */}
                {processingMedia && (
                  <ProcessingAnimation
                    media={processingMedia}
                    isComplete={status === 'complete'}
                    syncedTime={syncedTime}
                    isSyncedPlaying={isSyncedPlaying}
                    syncTrigger={syncTrigger}
                  />
                )}

                {/* Phones only. The scan box drops its invented telemetry at
                    this size and the log terminal below starts collapsed, so
                    without this the screen would say nothing about what the job
                    is actually doing. The log tail is the real answer. */}
                {status === 'processing' && (
                  <div className="sm:hidden mb-3 flex items-start gap-2 text-xs text-ink2 min-w-0">
                    <Loader2 size={14} className="animate-spin text-brass shrink-0 mt-px" />
                    <span className="min-w-0 leading-snug break-words">
                      {logs.length ? logs[logs.length - 1] : 'starting up…'}
                    </span>
                  </div>
                )}

                {/* Logs Terminal */}
                <div className={`bg-paper rounded-card border border-rule overflow-hidden flex flex-col transition-all duration-500 ${status === 'complete' ? `min-h-0 opacity-50 hover:opacity-100 ${logsVisible ? 'h-32' : 'h-auto'}` : `flex-1 ${logsVisible ? 'min-h-[160px] sm:min-h-[200px]' : 'min-h-0 flex-none'}`}`}>
                  <button
                    type="button"
                    onClick={() => setLogsVisible(!logsVisible)}
                    aria-expanded={logsVisible}
                    className="w-full px-3.5 sm:px-4 py-2.5 border-b border-rule flex items-center justify-between gap-2 bg-paper2 shrink-0 text-left"
                  >
                    <span className="readout flex items-center gap-2">
                      <Terminal size={12} /> System Logs
                    </span>
                    <span className="flex items-center gap-2 text-muted">
                      {!logsVisible && logs.length > 0 && (
                        <span className="readout normal-case">{logs.length}</span>
                      )}
                      <ChevronDown size={16} className={logsVisible ? '' : 'rotate-180'} />
                    </span>
                  </button>
                  {logsVisible && (
                    <div className="flex-1 p-3.5 sm:p-4 overflow-y-auto font-mono text-[11px] sm:text-xs space-y-1.5 custom-scrollbar text-muted break-words">
                      {logs.length > 250 && (
                        <div className="text-[10px] text-muted italic border-b border-rule pb-1 mb-1">
                          Showing latest 250 logs ({logs.length - 250} older entries hidden for performance)...
                        </div>
                      )}
                      {(logs.length > 250 ? logs.slice(-250) : logs).map((log, sliceIdx) => {
                        const originalIdx = logs.length > 250 ? logs.length - 250 + sliceIdx : sliceIdx;
                        return (
                          <div key={originalIdx} className={`flex gap-2 ${log.toLowerCase().includes('error') ? 'text-danger' : 'text-muted'}`}>
                            <span className="text-muted opacity-50 shrink-0 hidden sm:inline tabular-nums">
                              {logTimes[originalIdx] ? new Date(logTimes[originalIdx] * 1000).toLocaleTimeString() : ''}
                            </span>
                            <span className="min-w-0 break-words">{log}</span>
                          </div>
                        );
                      })}
                      {status === 'processing' && (
                        <div className="animate-pulse text-brass">_</div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Results Grid */}
              <div className={`${status === 'complete' ? 'w-full md:w-[70%] lg:w-[75%]' : 'w-full md:w-[45%] lg:w-[40%]'} md:h-full flex flex-col shrink-0 md:shrink card p-3.5 sm:p-6 transition-all duration-700 ease-in-out`}>
                {/* Title + counters on one row, the two actions on their own row
                    below. Wrapping them all together dropped a lone half-width
                    "schedule week" pill under the title on a phone. */}
                <div className="mb-4 sm:mb-6 shrink-0 space-y-3">
                  <h2 className="font-bold text-lg sm:text-xl text-ink flex flex-wrap items-center gap-2">
                    <span className="mr-auto">Generated Shorts</span>
                    {results?.clips?.length > 0 && (
                      <span className="readout bg-paper3 px-2.5 py-1 rounded-md">
                        {results.clips.length} Clips
                      </span>
                    )}
                  </h2>
                  {results?.clips?.length > 0 && status === 'complete' && (
                    <div className="flex flex-col sm:flex-row sm:justify-end items-stretch sm:items-center gap-2">
                      <button
                        onClick={handleDownloadAll}
                        disabled={downloadingAll}
                        className="btn-ghost px-3 py-2 text-xs"
                        title="Download all clips as a ZIP"
                      >
                        {downloadingAll
                          ? <><Loader2 size={14} className="animate-spin" /> Zipping…</>
                          : <><Download size={14} /> Download All ZIP</>}
                      </button>
                      {results.clips.length > 1 && (
                        <button
                          onClick={() => setShowScheduleWeek(true)}
                          className="btn-primary px-4 py-2 text-xs"
                        >
                          <Calendar size={14} />
                          Schedule Week
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {status === 'complete' && results?.clips?.length > 0 && (
                  <div className="mb-2 space-y-2">
                    {showAutopilotNudge && (
                      <div className="w-full flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 rounded-input bg-paper3 border border-rule text-sm">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <Rocket size={16} className="text-brass shrink-0 mt-0.5" />
                          <div className="min-w-0 leading-relaxed">
                            <span className="text-ink">Want this for every new video, without coming back?</span>{' '}
                            <span className="text-muted">
                              Autopilot watches your YouTube channel and clips each new upload on its own
                              {plan === 'free' ? ', included in every paid plan.' : '.'}
                            </span>
                          </div>
                          <button
                            onClick={() => dismissAutopilotNudge('AutopilotNudgeDismissed')}
                            aria-label="dismiss"
                            className="sm:hidden shrink-0 -m-1 p-1 text-muted hover:text-ink"
                          >
                            <X size={16} />
                          </button>
                        </div>
                        <button
                          onClick={() => { dismissAutopilotNudge('AutopilotNudgeClicked'); setActiveTab('autopilot'); }}
                          className="btn-quiet shrink-0 text-xs py-1.5 px-3 lowercase w-full sm:w-auto"
                        >
                          set up autopilot →
                        </button>
                        <button
                          onClick={() => dismissAutopilotNudge('AutopilotNudgeDismissed')}
                          aria-label="dismiss"
                          className="hidden sm:block shrink-0 p-1 text-muted hover:text-ink"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    {/* Distribution nudge at the same peak: clips on screen,
                        publishing them is one connect away. Hidden once any
                        network is linked or the user dismisses it. */}
                    {showSocialNudge && (
                      <div className="w-full flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 rounded-input bg-paper3 border border-rule text-sm">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="min-w-0 leading-relaxed">
                            <span className="text-ink">Publish these clips straight from here.</span>{' '}
                            <span className="text-muted">Connect your YouTube, TikTok or Instagram once — after that every clip is one click from posted.</span>
                          </div>
                          {/* On a phone the dismiss X rides the copy, so the CTA
                              below can run the full width of the card. */}
                          <button
                            onClick={() => {
                              track('SocialNudgeDismissed');
                              setSocialNudgeDismissed(true);
                              try { localStorage.setItem('os_social_nudge_dismissed', '1'); } catch (_) { /* ignore */ }
                            }}
                            aria-label="dismiss"
                            className="sm:hidden shrink-0 -m-1 p-1 text-muted hover:text-ink"
                          >
                            <X size={16} />
                          </button>
                        </div>
                        <button
                          onClick={() => { track('SocialNudgeConnect'); handleConnectSocials(); }}
                          className="btn-quiet shrink-0 text-xs py-1.5 px-3 lowercase w-full sm:w-auto"
                        >
                          connect socials →
                        </button>
                        <button
                          onClick={() => {
                            track('SocialNudgeDismissed');
                            setSocialNudgeDismissed(true);
                            try { localStorage.setItem('os_social_nudge_dismissed', '1'); } catch (_) { /* ignore */ }
                          }}
                          aria-label="dismiss"
                          className="hidden sm:block shrink-0 p-1 text-muted hover:text-ink"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    {/* Self-host only: cloud archives clips to the video library,
                        here they really are gone once the retention sweep runs. */}
                    {!billingEnabled && jobRetentionSeconds > 0 && (
                      <div className="px-3 py-2.5 rounded-input bg-paper3 border border-paper3 text-sm">
                        <span className="text-ink">Clips are kept for {formatRetention(jobRetentionSeconds)}, then deleted.</span>{' '}
                        <span className="text-muted">Download what you want to keep, or raise JOB_RETENTION_SECONDS in your env.</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
                  {results && results.clips && results.clips.length > 0 ? (
                    <div className={`grid gap-4 pb-10 ${status === 'complete' ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,600px),1fr))]' : 'grid-cols-1'}`}>
                      {rankedClips.map(({ clip, index: i }) => (
                        <ResultCard
                          key={`${jobId}-${i}-${clip.video_url || ''}`}
                          clip={clip}
                          index={i}
                          jobId={jobId}
                          onEditClip={(index) => setEditingClip(index)}
                          onReframeClip={(index) => setReframingClip(index)}
                          onUpgrade={isManaged ? openUpsell : null}
                          initialState={projectState?.clips?.find((c) => c.index === i) || null}
                          onStateChange={handleClipStateChange}
                          durable={durableClips[i]}
                          uploadPostKey={uploadPostKey}
                          uploadUserId={uploadUserId}
                          geminiApiKey={apiKey}
                                                    isManaged={isManaged}
                          connectedPlatforms={(userProfiles.find((p) => p.username === uploadUserId) || userProfiles[0])?.connected ?? null}
                          onConnectSocials={isManaged ? handleConnectSocials : null}
                          onPlay={(time) => handleClipPlay(time)}
                          onPause={handleClipPause}
                          onBulkSubtitle={handleBulkSubtitles}
                          clipCount={results.clips.length}
                          bulkProgress={bulkSub}
                        />
                      ))}
                    </div>
                  ) : (
                    status === 'processing' ? (
                      <div className="h-full min-h-[140px] flex flex-col items-center justify-center text-muted space-y-3 text-center px-4">
                        <Loader2 size={28} className="animate-spin text-brass" />
                        <p className="text-sm lowercase">Waiting for clips...</p>
                        <p className="text-xs text-muted/80 max-w-[26ch] leading-snug">
                          They appear here one by one as each finishes rendering.
                        </p>
                      </div>
                    ) : status === 'error' ? (
                      <div className="h-full min-h-[120px] flex flex-col items-center justify-center text-danger space-y-2">
                        <p>Generation failed.</p>
                      </div>
                    ) : null
                  )}
                </div>
              </div>

            </div>
          )}

        </div>

        {/* Phone navigation. A flex sibling of the scrolling pane, not a fixed
            overlay, so content is never trapped behind it. */}
        <MobileTabBar />

      </main>

      {/* Missing AI Provider Configuration Modal */}
      <Modal
        isOpen={showKeyModal}
        onClose={() => setShowKeyModal(false)}
        eyebrow="CONFIGURATION"
        title="AI Provider Setup Required"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowKeyModal(false)}
              className="btn-ghost flex-1 px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => { setShowKeyModal(false); goToTab('settings'); }}
              className="btn-primary flex-1 px-4 py-2 text-sm"
            >
              Go to Settings
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            ClipSnipr needs an AI provider configured to detect viral moments in your videos.
          </p>

          {/* Gemini block */}
          <div className={`rounded-input p-4 space-y-2 border ${!apiKey ? 'border-rule2' : 'border-rule opacity-70'}`}>
            <p className="text-xs font-medium text-ink flex items-center gap-2">
              {apiKey ? <Check size={12} className="text-ok" /> : <AlertTriangle size={12} className="text-warn" />}
              Gemini API Key {apiKey && <span className="text-ok">— set</span>}
            </p>
            {!apiKey && (
              <>
                <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
                  <li>Go to <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-brass underline">aistudio.google.com/app/apikey</a></li>
                  <li>Sign in with your Google account</li>
                  <li>Click "Create API Key"</li>
                  <li>Copy the key and paste it below</li>
                </ol>
                <input
                  type="text"
                  placeholder="Paste your Gemini API key here..."
                  className="input-field"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      setApiKey(e.target.value.trim());
                    }
                  }}
                />
              </>
            )}
          </div>

          {/* Upload-Post block */}
          <div className={`rounded-input p-4 space-y-2 border ${!uploadPostKey ? 'border-rule2' : 'border-rule opacity-70'}`}>
            <p className="text-xs font-medium text-ink flex items-center gap-2">
              {uploadPostKey ? <Check size={12} className="text-ok" /> : <AlertTriangle size={12} className="text-warn" />}
              Upload-Post API Key {uploadPostKey && <span className="text-ok">— set</span>}
            </p>
            {!uploadPostKey && (
              <>
                <p className="text-xs text-muted">
                  Required to publish your clips to TikTok, Instagram Reels, and YouTube Shorts. Free tier available, no credit card needed.
                </p>
                <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
                  <li>Register at <a href="https://app.upload-post.com/login" target="_blank" rel="noopener noreferrer" className="text-brass underline">app.upload-post.com</a></li>
                  <li>Connect your TikTok, Instagram, or YouTube accounts</li>
                  <li>Go to <a href="https://app.upload-post.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-brass underline">API Keys</a> and generate one</li>
                  <li>Paste it below</li>
                </ol>
                <input
                  type="text"
                  placeholder="Paste your Upload-Post API key here..."
                  className="input-field"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      setUploadPostKey(e.target.value.trim());
                    }
                  }}
                />
              </>
            )}
          </div>
        </div>
      </Modal>

      {/* Pre-flight quality gate */}
      {qualityGate && (
        <Modal isOpen={true} onClose={() => setQualityGate(null)} size="md" eyebrow="HEADS UP" title="low source quality">
          <div className="space-y-4">
            <p className="text-sm text-ink2">
              YouTube only offers <span className="text-brass font-semibold">{qualityGate.info.max_height}p</span> for this video
              (below the {qualityGate.info.min_height}p we recommend). Processing anyway will produce lower-quality clips.
            </p>
            {qualityGate.info.cookies_invalid && (
              <p className="text-xs text-muted">
                Your YouTube cookies look expired — refreshing them (export again from an incognito window) often unlocks HD.
              </p>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setQualityGate(null)} className="btn-ghost">cancel</button>
              <button
                onClick={() => { const d = qualityGate.data; setQualityGate(null); handleProcess(d, true); }}
                className="btn-primary"
              >
                process anyway
              </button>
            </div>
          </div>
        </Modal>
      )}


      <React.Suspense fallback={null}>
        {showScheduleWeek && (
          <ScheduleWeekModal
            isOpen={showScheduleWeek}
            onClose={() => setShowScheduleWeek(false)}
            clips={results?.clips || []}
            jobId={jobId}
            uploadPostKey={uploadPostKey}
            uploadUserId={uploadUserId}
            isManaged={isManaged}
          />
        )}
        {editingClip !== null && results?.clips?.[editingClip] && (
          <ClipEditor
            jobId={jobId}
            clipIndex={editingClip}
            clipTitle={results.clips[editingClip].video_title_for_youtube_short || ''}
            onClose={() => setEditingClip(null)}
            onRerendered={handleClipRerendered}
          />
        )}
        {reframingClip !== null && results?.clips?.[reframingClip] && (
          <ReframeEditor
            jobId={jobId}
            clipIndex={reframingClip}
            clipTitle={results.clips[reframingClip].video_title_for_youtube_short || ''}
            onClose={() => setReframingClip(null)}
            onReframed={handleClipRerendered}
          />
        )}
        {showLogin && <LoginModal onClose={() => setShowLogin(false)} queued={typeof peekPendingJob()?.data?.payload === 'string'} />}
      </React.Suspense>
    </div>
  );
}

export default App;
