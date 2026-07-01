// Shared score/risk shaping for review rows.
(function () {
  const root = globalThis.JobCopilotCore = globalThis.JobCopilotCore || {};

  function clean(value) {
    return root.clean ? root.clean(value) : (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  }

  function norm(value) {
    return clean(value).replace(/\s+/g, '').toLowerCase();
  }

  function textFor(job) {
    return norm([
      job.title || job.name,
      job.company,
      job.salary,
      job.city,
      job.location,
      Array.isArray(job.tags) ? job.tags.join(' ') : '',
      job.jd,
      job.rawText
    ].join(' '));
  }

  function displayTextFor(job) {
    return clean([
      job.title || job.name,
      job.company,
      job.salary,
      job.city,
      job.location,
      job.sourceKeyword,
      Array.isArray(job.tags) ? job.tags.join(' ') : '',
      job.jd,
      job.rawText
    ].join(' '));
  }

  function uniqueList(items) {
    const seen = {};
    const out = [];
    (items || []).forEach(item => {
      const text = clean(item);
      const key = norm(text);
      if (text && !seen[key]) {
        seen[key] = true;
        out.push(text);
      }
    });
    return out;
  }

  function overseasFlags(job) {
    return /驻香港|驻外|海外|外派|出海|跨境/.test(displayTextFor(job))
      ? ['含驻外/海外字样，请人工确认']
      : [];
  }

  function scoreByWords(job, priorityWords, excludeWords) {
    const text = textFor(job);
    const evidence = (priorityWords || []).filter(w => text.indexOf(norm(w)) >= 0);
    const risks = (excludeWords || []).filter(w => text.indexOf(norm(w)) >= 0);
    const riskFlags = uniqueList(risks.concat(overseasFlags(job)));
    let score = 40 + evidence.length * 22 - risks.length * 35;
    score = Math.max(0, Math.min(100, score));
    return {
      match: evidence.length > 0 && risks.length === 0 && score >= 60,
      score,
      riskFlags: riskFlags.slice(0, 8),
      evidence: evidence.slice(0, 8),
      matchReason: risks.length
        ? ('风险：' + risks.slice(0, 3).join('、'))
        : evidence.length
          ? ('本地匹配 ' + score + ' 分；命中：' + evidence.slice(0, 4).join('、'))
          : ('本地匹配 ' + score + ' 分；未命中目标词')
    };
  }

  function applyScreenResult(job, result) {
    const score = Number.isFinite(result && result.score) ? result.score : ((result && result.match) ? 78 : 35);
    const resultFlags = Array.isArray(result && result.riskFlags) ? result.riskFlags : (Array.isArray(result && result.risks) ? result.risks : []);
    const existingFlags = Array.isArray(job && job.riskFlags) ? job.riskFlags : (Array.isArray(job && job.risks) ? job.risks : []);
    const riskFlags = uniqueList(existingFlags.concat(resultFlags).concat(overseasFlags(job)));
    const matchReason = clean((result && (result.matchReason || result.reason)) || '');
    const actionStatuses = { viewed: 1, skipped: 1, blocked: 1, applied: 1, delivered: 1, contacted: 1, success: 1, sent: 1, already_contacted: 1, duplicate_in_chat: 1, failed: 1, needs_review: 1 };
    const status = job && actionStatuses[job.status] ? job.status : 'discovered';
    return Object.assign({}, job, {
      match: !!(result && result.match),
      score,
      matchReason,
      reason: matchReason,
      riskFlags: riskFlags.map(clean).filter(Boolean),
      risks: riskFlags.map(clean).filter(Boolean),
      status
    });
  }

  root.scoring = {
    scoreByWords,
    applyScreenResult
  };
})();
