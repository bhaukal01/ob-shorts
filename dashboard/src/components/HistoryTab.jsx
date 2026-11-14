import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Download, Film, FolderOpen, Trash2, Play, Sparkles } from 'lucide-react';
import { apiJson } from '../lib/api';

// Video Library & Active Jobs page.
// Displays ongoing/active jobs prominently with a "Resume Live View" action,
// plus completed projects grouped by job with reopen and manual deletion options.
export default function HistoryTab({ onReopenProject }) {
  const [videos, setVideos] = useState(null);
  const [projectsList, setProjectsList] = useState([]);
  const [reopening, setReopening] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [reopenError, setReopenError] = useState('');
  const [error, setError] = useState('');

  const loadData = () => {
    apiJson('/api/history')
      .then((d) => setVideos(d.videos || []))
      .catch(() => setError('Could not load your library.'));
    apiJson('/api/projects')
      .then((d) => setProjectsList(d.projects || []))
      .catch(() => {});
  };

  useEffect(() => {
    loadData();
  }, []);

  // Separate ongoing / active jobs from completed ones
  const ongoingProjects = useMemo(() => {
    return projectsList.filter((p) => p.is_active || p.status === 'processing' || p.status === 'queued');
  }, [projectsList]);

  // Map of completed project metadata by job_id
  const projectsMap = useMemo(() => {
    const map = {};
    for (const p of projectsList) {
      map[p.job_id] = p;
    }
    return map;
  }, [projectsList]);

  // Live poll when any jobs are active/ongoing
  useEffect(() => {
    if (ongoingProjects.length === 0) return;
    const interval = setInterval(() => {
      apiJson('/api/projects')
        .then((d) => {
          const fresh = d.projects || [];
          setProjectsList(fresh);
          const stillActive = fresh.some((p) => p.is_active || p.status === 'processing' || p.status === 'queued');
          if (!stillActive) {
            // Once all jobs finish, refresh video history
            apiJson('/api/history').then((hv) => setVideos(hv.videos || [])).catch(() => {});
          }
        })
        .catch(() => {});
    }, 3500);
    return () => clearInterval(interval);
  }, [ongoingProjects.length]);

  // Group completed videos by job, preserving newest-first order
  const groups = useMemo(() => {
    const byJob = new Map();
    for (const v of videos || []) {
      const key = v.job_id || v.id;
      if (!byJob.has(key)) byJob.set(key, []);
      byJob.get(key).push(v);
    }
    return [...byJob.entries()];
  }, [videos]);

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
      // Remove immediately from active UI state
      setProjectsList((prev) => prev.filter((p) => p.job_id !== jobId));
      setVideos((prev) => (prev ? prev.filter((v) => (v.job_id || v.id) !== jobId) : []));
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

  if (videos === null && projectsList.length === 0 && !error) {
    return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-brass" /></div>;
  }

  const hasAnyContent = ongoingProjects.length > 0 || (videos && videos.length > 0);

  return (
    <div className="h-full overflow-y-auto p-8 max-w-5xl mx-auto animate-fade">
      <p className="eyebrow mb-1.5">02 · LIBRARY / JOBS</p>
      <h1 className="font-display lowercase text-2xl text-ink mb-2">Video Library & Active Jobs</h1>
      <p className="text-muted text-sm mb-8 lowercase">
        Monitor ongoing generation tasks and manage saved shorts. Videos stay saved indefinitely unless deleted manually (with a 24-hour grace period before disk purge).
      </p>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      {reopenError && <p className="text-danger text-sm mb-4">{reopenError}</p>}

      {/* SECTION 1: ONGOING & ACTIVE JOBS */}
      {ongoingProjects.length > 0 && (
        <section className="mb-10 rounded-xl p-5 border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center justify-between mb-4 pb-2 border-b border-rule">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
              </span>
              <h2 className="text-sm font-semibold text-ink lowercase">
                Ongoing Jobs ({ongoingProjects.length})
              </h2>
            </div>
            <span className="text-micro font-mono text-muted uppercase">Live Pipeline</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {ongoingProjects.map((proj) => (
              <div
                key={proj.job_id}
                className="card p-4 flex flex-col justify-between border-rule bg-surface/90 hover:border-amber-500/40 transition-colors"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-sm font-medium text-ink truncate flex-1" title={proj.title}>
                      {proj.title}
                    </p>
                    <span className="px-2 py-0.5 rounded text-micro font-mono uppercase bg-amber-500/20 text-amber-300 font-semibold shrink-0 flex items-center gap-1">
                      <Loader2 size={11} className="animate-spin" />
                      {proj.status === 'processing' ? 'Processing' : 'Queued'}
                    </span>
                  </div>

                  {proj.latest_log && (
                    <p
                      className="text-xs text-muted font-mono truncate mb-2.5 px-2 py-1 bg-panel rounded border border-rule/50"
                      title={proj.latest_log}
                    >
                      {proj.latest_log}
                    </p>
                  )}

                  <p className="readout text-micro">
                    {fmtDate(proj.created_at)}
                    {proj.clip_count > 0 && ` · ${proj.clip_count} clip(s) ready`}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-rule">
                  <button
                    onClick={() => handleReopen(proj.job_id, proj.status)}
                    disabled={!!reopening}
                    className="btn-primary px-3 py-1.5 text-xs flex items-center gap-1.5 shadow-sm"
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
                    className="btn-ghost text-muted hover:text-danger hover:bg-danger/10 px-2.5 py-1.5 text-xs flex items-center gap-1 transition-colors"
                    title="Cancel and delete this job"
                  >
                    {deleting === proj.job_id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    <span>Cancel</span>
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
          <Film size={40} className="mx-auto mb-4 text-muted" />
          <p className="lowercase">No videos or ongoing jobs yet. Start a new short from the Clip Generator.</p>
        </div>
      )}

      {/* SECTION 3: COMPLETED PROJECTS */}
      <div className="space-y-10">
        {groups.map(([jobId, vids]) => {
          const project = projectsMap[jobId];
          const projectTitle = project?.title || vids[0]?.title || 'Project';
          return (
            <section key={jobId} className="border-b border-rule pb-8">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-2 border-b border-rule">
                <div className="min-w-0">
                  <p className="text-sm text-ink font-medium truncate" title={projectTitle}>
                    {projectTitle}
                  </p>
                  <p className="readout mt-0.5">
                    {fmtDate(vids[0]?.created_at)} · {vids.length} clip{vids.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {onReopenProject && (
                    <button
                      onClick={() => handleReopen(jobId, 'completed')}
                      disabled={!!reopening}
                      className="btn-ghost px-3 py-2 text-xs shrink-0"
                      title="Restore this project in the Clip Generator to edit subtitles, hooks, effects and dubbing"
                    >
                      {reopening === jobId ? (
                        <><Loader2 size={14} className="animate-spin" /> reopening…</>
                      ) : (
                        <><FolderOpen size={14} /> reopen project</>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(jobId, projectTitle)}
                    disabled={deleting === jobId}
                    className="btn-ghost text-muted hover:text-danger hover:bg-danger/10 px-2.5 py-2 text-xs shrink-0 transition-colors"
                    title="Delete project from library (removed immediately, deleted from disk after 24 hrs)"
                  >
                    {deleting === jobId ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
                {vids.map((v) => (
                  <div key={v.id} className="card card-hover overflow-hidden group">
                    <div className="aspect-[9/16] bg-black">
                      <video
                        src={v.view_url || v.video_url}
                        controls
                        preload="metadata"
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <div className="p-3">
                      <p className="text-sm text-ink font-medium line-clamp-2 mb-1" title={v.title}>
                        {v.title || 'Short'}
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="readout">{fmtDate(v.created_at)}</span>
                        <a
                          href={v.download_url || v.video_url}
                          className="text-micro font-mono uppercase text-brass hover:text-ink flex items-center gap-1 transition-colors"
                          title="Download"
                        >
                          <Download size={14} /> Download
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
