// Tiny in-memory/storage job-pool helpers.
(function () {
  const root = globalThis.JobCopilotCore = globalThis.JobCopilotCore || {};

  function clean(value) {
    return root.clean ? root.clean(value) : (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  }

  function keyPart(value) {
    return clean(value).replace(/\s+/g, '').toLowerCase();
  }

  function dedupeKey(job) {
    job = root.normalizeJob ? root.normalizeJob(job, job && job.platform) : (job || {});
    const platform = job.platform || 'boss';
    if (job.jobId) return platform + '|jobId|' + keyPart(job.jobId);
    if (job.url) return platform + '|url|' + keyPart(job.url);
    const fallback = [job.title || job.name, job.company, job.salary, job.location || job.city].map(keyPart).join('|');
    return platform + '|fallback|' + fallback;
  }

  function mergeTextList(a, b) {
    const seen = {};
    const out = [];
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(item => {
      const text = clean(item);
      const key = keyPart(text);
      if (text && !seen[key]) {
        seen[key] = true;
        out.push(text);
      }
    });
    return out;
  }

  function mergeKeyword(a, b) {
    return mergeTextList(clean(a).split(/[，,]/), clean(b).split(/[，,]/)).join('，');
  }

  function mergeJob(prev, next) {
    prev = root.normalizeJob ? root.normalizeJob(prev, prev && prev.platform) : (prev || {});
    next = root.normalizeJob ? root.normalizeJob(next, next && next.platform) : (next || {});
    const merged = Object.assign({}, prev, next);
    merged.createdAt = prev.createdAt || next.createdAt || new Date().toISOString();
    merged.sourceKeyword = mergeKeyword(prev.sourceKeyword, next.sourceKeyword);
    merged.tags = mergeTextList(prev.tags, next.tags);
    merged.riskFlags = mergeTextList(prev.riskFlags || prev.risks, next.riskFlags || next.risks);
    merged.risks = merged.riskFlags;
    if (!next.jd && prev.jd) merged.jd = prev.jd;
    if (!next.rawText && prev.rawText) merged.rawText = prev.rawText;
    if (next.score == null && prev.score != null) merged.score = prev.score;
    if (!next.matchReason && prev.matchReason) merged.matchReason = prev.matchReason;
    if (typeof next.match !== 'boolean' && typeof prev.match === 'boolean') merged.match = prev.match;
    if ((next.status === 'discovered' || !next.status) && prev.status && prev.status !== 'discovered') merged.status = prev.status;
    merged.reason = merged.matchReason || merged.reason || '';
    merged.poolId = merged.platform + ':' + merged.jobId;
    return merged;
  }

  function mergeJobs(existing, incoming) {
    const map = new Map();
    (existing || []).forEach(job => {
      const n = root.normalizeJob ? root.normalizeJob(job, job && job.platform) : job;
      map.set(dedupeKey(n), n);
    });
    (incoming || []).forEach(job => {
      const n = root.normalizeJob ? root.normalizeJob(job, job && job.platform) : job;
      const key = dedupeKey(n);
      map.set(key, map.has(key) ? mergeJob(map.get(key), n) : n);
    });
    return Array.from(map.values());
  }

  function findByPoolId(jobs, id) {
    const target = clean(id);
    return (jobs || []).find(job => job && (job.poolId === target || job.id === target || job.jobId === target)) || null;
  }

  root.jobPool = {
    dedupeKey,
    mergeJob,
    mergeJobs,
    findByPoolId
  };
})();
