import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, Download, Film, FolderOpen, Trash2, Play, ChevronDown, ChevronUp, X, HardDrive, Check, Clock, AlertCircle } from 'lucide-react';
import { apiJson } from '../lib/api';

// Video Library & Active Projects (Fast & Lightweight)
// 1. Projects listed as clean cards with 2 clear options: Open Project or View Clip List.
// 2. Zero video preloading on page load (instant rendering, no lag).
// 3. Clip list streams video directly from S3 to save VPS bandwidth.
export default function HistoryTab({ onReopenProject }) {
  const [projectsList, setProjectsList] = useState(null);
  const [reopening, setReopening] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [reopenError, setReopenError] = useState('');
  const [error, setError] = useState('');

  // Project whose clips are currently expanded
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [loadingClipsId, setLoadingClipsId] = useState(null);
  const [projectClipsMap, setProjectClipsMap] = useState({});

  // Active clip modal player (only 1 video element ever mounted in the DOM)
  const [activePlayerClip, setActivePlayerClip] = useState(null);

  const loadProjects = () => {
    apiJson('/api/projects')
      .then((d) => setProjectsList(d.projects || []))
      .catch(() => setError('Could not load your library projects.'));
  };

  useEffect(() => {
    loadProjects();
  }, []);

  // Separate ongoing / active jobs from completed ones
  const ongoingProjects = useMemo(() => {
    return (projectsList || []).filter((p) => p.is_active || p.status === 'processing' || p.status === 'queued');
  }, [projectsList]);

  const completedProjects = useMemo(() => {
    return (projectsList || []).filter((p) => !p.is_active && p.status !== 'processing' && p.status !== 'queued');
  }, [projectsList]);

  // Live polling only when any jobs are active
  useEffect(() => {
    if (ongoingProjects.length === 0) return;
    const interval = setInterval(() => {
      apiJson('/api/projects')
        .then((d) => {
          const fresh = d.projects || [];
          setProjectsList(fresh);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [ongoingProjects.length]);

  const handleToggleClips = async (jobId) => {
    if (expandedProjectId === jobId) {
      setExpandedProjectId(null);
      return;
    }
    setExpandedProjectId(jobId);
    if (!projectClipsMap[jobId]) {
      setLoadingClipsId(jobId);
      try {
        const data = await apiJson(`/api/projects/${jobId}/clips`);
        setProjectClipsMap((prev) => ({ ...prev, [jobId]: data.clips || [] }));
      } catch (e) {
        console.error('Failed to load project clips:', e);
      } finally {
        setLoadingClipsId(null);
      }
    }
  };

  const handleReopen = async (jobId, status = 'completed') => {
    if (!onReopenProject || reopening) return;
    setReopening(jobId);
    setReopenError('');
    try {
      await onReopenProject(jobId, status);
    } catch (e) {
      setReopenError('Could not open this project. Please try again.');
      setReopening(null);
    }
  };

  const handleDelete = async (jobId, title = 'this project') => {
    if (deleting) return;
    const confirmed = window.confirm(
      `Delete "${title}"?\n\nIt will be removed immediately from your library and permanently deleted from disk after 24 hours.`
    );
    if (!confirmed) return;

    setDeleting(jobId);
    try {
      await apiJson(`/api/projects/${jobId}`, { method: 'DELETE' });
      setProjectsList((prev) => (prev || []).filter((p) => p.job_id !== jobId));
      if (expandedProjectId === jobId) setExpandedProjectId(null);
    } catch (e) {
      alert('Could not delete project: ' + (e.message || 'Server error'));
    } finally {
      setDeleting(null);
    }
  };

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) : '');

  if (projectsList === null && !error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted gap-3">
        <Loader2 className="animate-spin text-brass" size={24} />
        <span className="text-xs font-mono">Loading library projects…</span>
      </div>
    );
  }

  const hasAnyContent = (projectsList && projectsList.length > 0);

  return (
    <div className="h-full overflow-y-auto p-5 sm:p-8 max-w-5xl mx-auto animate-fade">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-rule">
        <div>
          <p className="eyebrow mb-1 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            03 · LIBRARY / PROJECTS
          </p>
          <h1 className="font-display lowercase text-2xl text-ink">Video Projects &amp; Jobs</h1>
        </div>
        <div className="flex items-center gap-2">
          {projectsList && (
            <span className="tag-uniform tag-green text-[10px]">
              {projectsList.length} Projects Total
            </span>
          )}
          <button
            onClick={loadProjects}
            className="btn-ghost py-1.5 px-3 text-xs flex items-center gap-1.5"
            title="Refresh projects list"
          >
            <Clock size={13} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 mb-4 rounded-input bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {reopenError && (
        <div className="p-3 mb-4 rounded-input bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2">
          <AlertCircle size={14} /> {reopenError}
        </div>
      )}

      {/* SECTION 1: ONGOING & ACTIVE JOBS */}
      {ongoingProjects.length > 0 && (
        <section className="mb-8 rounded-xl p-4 sm:p-5 border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-rule/50">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              <h2 className="text-sm font-semibold text-ink lowercase">
                Ongoing Generation Jobs ({ongoingProjects.length})
              </h2>
            </div>
            <span className="text-[10px] font-mono text-muted uppercase">Live Pipeline</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ongoingProjects.map((proj) => (
              <div
                key={proj.job_id}
                className="card p-3.5 flex flex-col justify-between border-rule bg-surface/90 hover:border-amber-500/40 transition-colors"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-sm font-medium text-ink truncate flex-1" title={proj.title}>
                      {proj.title}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {proj.is_stream && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-red-500/20 text-red-400 font-semibold shrink-0 flex items-center gap-1 animate-pulse">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                          Live Stream
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-500/20 text-amber-300 font-semibold shrink-0 flex items-center gap-1">
                        <Loader2 size={10} className="animate-spin" />
                        {proj.status === 'processing' ? 'Processing' : 'Queued'}
                      </span>
                    </div>
                  </div>

                  {proj.latest_log && (
                    <p className="text-[11px] text-muted font-mono truncate mb-2 px-2 py-0.5 bg-panel rounded border border-rule/50" title={proj.latest_log}>
                      {proj.latest_log}
                    </p>
                  )}

                  <p className="readout text-[11px]">
                    {fmtDate(proj.created_at)}
                    {proj.clip_count > 0 && ` · ${proj.clip_count} clip(s) ready`}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 mt-3 pt-2.5 border-t border-rule/50">
                  <button
                    onClick={() => handleReopen(proj.job_id, proj.status)}
                    disabled={!!reopening}
                    className="btn-green px-3 py-1.5 text-xs flex items-center gap-1.5 font-bold text-white shadow-sm"
                    title="Return to the Generator workspace with live logs and progress"
                  >
                    {reopening === proj.job_id ? (
                      <><Loader2 size={13} className="animate-spin" /> Resuming…</>
                    ) : (
                      <><Play size={13} /> Resume Live View</>
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(proj.job_id, proj.title)}
                    disabled={deleting === proj.job_id}
                    className="btn-ghost text-muted hover:text-danger hover:bg-danger/10 px-2 py-1.5 text-xs flex items-center gap-1 transition-colors"
                    title="Cancel and delete this job"
                  >
                    {deleting === proj.job_id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* SECTION 2: NO CONTENT FALLBACK */}
      {!hasAnyContent && (
        <div className="text-center py-20 text-muted">
          <Film size={36} className="mx-auto mb-3 text-muted/60" />
          <p className="text-sm lowercase">No projects in your library yet. Generate your first shorts to see them here.</p>
        </div>
      )}

      {/* SECTION 3: COMPLETED PROJECTS LIST (PROJECT-CENTRIC) */}
      {completedProjects.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted">
              Completed Projects ({completedProjects.length})
            </h2>
            <span className="text-[11px] text-muted">Click "Clip List" to stream from S3</span>
          </div>

          <div className="grid grid-cols-1 gap-3.5">
            {completedProjects.map((proj) => {
              const isExpanded = expandedProjectId === proj.job_id;
              const clips = projectClipsMap[proj.job_id] || [];
              const isLoadingClips = loadingClipsId === proj.job_id;

              return (
                <div
                  key={proj.job_id}
                  className={`card transition-all overflow-hidden border ${isExpanded ? 'border-brass/40 shadow-sm' : 'border-rule hover:border-rule2'}`}
                >
                  {/* Project Summary Header Row */}
                  <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="text-sm font-semibold text-ink truncate max-w-xl" title={proj.title}>
                          {proj.title}
                        </h3>
                        {proj.is_stream && (
                          <span className="tag-uniform tag-recording text-[10px] py-0.5 px-2 shrink-0">
                            Live Stream
                          </span>
                        )}
                        <span className="tag-uniform tag-connected text-[10px] py-0.5 px-2 shrink-0">
                          {proj.clip_count || clips.length} {proj.clip_count === 1 ? 'Clip' : 'Clips'}
                        </span>
                      </div>
                      <p className="readout text-[11px]">
                        Created {fmtDate(proj.created_at)} · ID: <span className="font-mono">{proj.job_id.slice(0, 8)}…</span>
                      </p>
                    </div>

                    {/* 2 Primary Actions: Open Project & Clip List */}
                    <div className="flex items-center gap-2 shrink-0">
                      {/* ACTION 1: Open Project in Workspace / Live View */}
                      <button
                        onClick={() => handleReopen(proj.job_id, 'completed')}
                        disabled={!!reopening}
                        className="btn-green py-2 px-3.5 text-xs flex items-center gap-1.5 font-bold text-white shadow-xs hover:brightness-105"
                        title="Open full interactive project workspace with live preview, subtitle editing, and recut tools"
                      >
                        {reopening === proj.job_id ? (
                          <><Loader2 size={13} className="animate-spin" /> Opening…</>
                        ) : (
                          <><FolderOpen size={13} /> Open Project</>
                        )}
                      </button>

                      {/* ACTION 2: View Clip List (Streams from S3) */}
                      <button
                        onClick={() => handleToggleClips(proj.job_id)}
                        className={`btn-ghost py-2 px-3 text-xs flex items-center gap-1.5 border border-rule transition-colors ${isExpanded ? 'bg-paper3 text-ink font-medium' : ''}`}
                        title="View and stream generated clips directly from S3"
                      >
                        <Film size={13} className="text-sky-400" />
                        <span>Clip List</span>
                        {isLoadingClips ? (
                          <Loader2 size={12} className="animate-spin ml-0.5" />
                        ) : isExpanded ? (
                          <ChevronUp size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )}
                      </button>

                      {/* Discrete Delete Action */}
                      <button
                        onClick={() => handleDelete(proj.job_id, proj.title)}
                        disabled={deleting === proj.job_id}
                        className="btn-ghost text-muted hover:text-red-400 hover:bg-red-500/10 p-2 text-xs transition-colors rounded-input"
                        title="Delete project from library (with 24h grace period)"
                      >
                        {deleting === proj.job_id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Clip List Drawer (Lazy Loaded & S3 Streaming) */}
                  {isExpanded && (
                    <div className="border-t border-rule bg-paper3/40 p-4 sm:p-5 animate-fade">
                      {isLoadingClips ? (
                        <div className="flex items-center justify-center py-8 text-muted gap-2 text-xs font-mono">
                          <Loader2 size={14} className="animate-spin text-sky-400" />
                          <span>Fetching S3 clip metadata…</span>
                        </div>
                      ) : clips.length === 0 ? (
                        <p className="text-xs text-muted text-center py-4">No clips found for this project.</p>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between text-xs text-muted mb-2 font-mono">
                            <span className="flex items-center gap-1.5 text-sky-400">
                              <HardDrive size={12} /> S3 Direct Playback &amp; Bandwidth Offload Active
                            </span>
                            <span>{clips.length} {clips.length === 1 ? 'short' : 'shorts'}</span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {clips.map((clip) => (
                              <div
                                key={clip.id}
                                className="bg-paper border border-rule rounded-input p-3 hover:border-sky-500/50 transition-all flex flex-col justify-between group"
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-1 mb-1">
                                    <span className="text-[10px] font-mono text-muted uppercase">
                                      Clip #{clip.clip_index + 1}
                                    </span>
                                    {clip.duration && (
                                      <span className="text-[10px] font-mono text-muted bg-paper3 px-1.5 py-0.5 rounded">
                                        {clip.duration}s
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs font-medium text-ink line-clamp-2 mb-2" title={clip.title}>
                                    {clip.title}
                                  </p>
                                </div>

                                <div className="flex items-center justify-between gap-2 pt-2 border-t border-rule/50 mt-1">
                                  {/* Play directly from S3 */}
                                  <button
                                    onClick={() => setActivePlayerClip(clip)}
                                    className="btn-blue py-1 px-2.5 text-[11px] flex items-center gap-1 shrink-0 font-semibold"
                                    title="Play clip stream directly from S3 storage"
                                  >
                                    <Play size={11} /> Play (S3)
                                  </button>

                                  {/* Download directly from S3 */}
                                  <a
                                    href={clip.download_url || clip.stream_url || clip.video_url}
                                    download={clip.filename || 'short.mp4'}
                                    className="text-[11px] text-muted hover:text-red-400 flex items-center gap-1 font-mono transition-colors"
                                    title="Direct presigned S3 download"
                                  >
                                    <Download size={12} /> Download
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* LIGHTWEIGHT SINGLE-INSTANCE VIDEO PLAYER MODAL */}
      {/* Mounted ONLY when user clicks 'Play' on a clip, playing directly from S3 */}
      {activePlayerClip && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade"
          onClick={() => setActivePlayerClip(null)}
        >
          <div
            className="card bg-paper border border-rule max-w-sm w-full p-4 flex flex-col items-center gap-3 relative shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between gap-2 border-b border-rule pb-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-ink truncate" title={activePlayerClip.title}>
                  {activePlayerClip.title}
                </p>
                <p className="text-[10px] font-mono text-muted flex items-center gap-1">
                  <HardDrive size={10} className="text-sky-400" /> Streaming via S3
                </p>
              </div>
              <button
                onClick={() => setActivePlayerClip(null)}
                className="text-muted hover:text-ink p-1 rounded hover:bg-paper3"
                title="Close Player"
              >
                <X size={16} />
              </button>
            </div>

            {/* Video element - only ONE exists in DOM */}
            <div className="aspect-[9/16] w-full max-h-[65vh] bg-black rounded overflow-hidden flex items-center justify-center">
              <video
                src={activePlayerClip.stream_url || activePlayerClip.video_url}
                controls
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
            </div>

            <div className="w-full flex items-center justify-between pt-1">
              <span className="text-[11px] font-mono text-muted">
                Clip #{activePlayerClip.clip_index + 1}
              </span>
              <a
                href={activePlayerClip.download_url || activePlayerClip.stream_url || activePlayerClip.video_url}
                download={activePlayerClip.filename || 'short.mp4'}
                className="btn-red py-1 px-3 text-xs flex items-center gap-1.5 font-bold text-white shadow-xs"
              >
                <Download size={13} /> Download
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
