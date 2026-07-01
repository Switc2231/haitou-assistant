// Shared job normalization for the multi-platform pool.
(function () {
  const root = globalThis.JobCopilotCore = globalThis.JobCopilotCore || {};

  function clean(value) {
    return (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  }

  function decodePrivateDigits(value) {
    return clean(value).replace(/[\ue000-\ue009\ue030-\ue039\ue100-\ue109]/g, ch => {
      const code = ch.charCodeAt(0);
      if (code >= 0xe000 && code <= 0xe009) return String(code - 0xe000);
      if (code >= 0xe030 && code <= 0xe039) return String(code - 0xe030);
      if (code >= 0xe100 && code <= 0xe109) return String(code - 0xe100);
      return ch;
    });
  }

  function hashText(value) {
    let h = 2166136261;
    const text = clean(value).replace(/\s+/g, '').toLowerCase();
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function inferJobId(platform, url) {
    const href = clean(url);
    if (!href) return '';
    if (platform === 'zhilian') {
      const m = href.match(/\/jobdetail\/([^/?#]+?)(?:\.html?|[?#]|$)/i);
      return m && m[1] ? clean(m[1]).replace(/\.html?$/i, '') : '';
    }
    if (platform === 'boss') {
      const m = href.match(/\/job_detail\/([^.?/#]+)\.html/i);
      return m && m[1] ? clean(m[1]) : '';
    }
    return '';
  }

  function normalizePlatform(value) {
    const p = clean(value).toLowerCase();
    if (p === 'zhilian' || p === 'zhaopin') return 'zhilian';
    return 'boss';
  }

  function normalizeStatus(value) {
    const allowed = {
      discovered: 1, scored: 1, pending: 1, selected: 1, skipped: 1, blocked: 1,
      viewed: 1, applied: 1, delivered: 1, contacted: 1, success: 1,
      sent: 1, already_contacted: 1, duplicate_in_chat: 1,
      failed: 1, needs_review: 1
    };
    const v = clean(value);
    return allowed[v] ? v : 'discovered';
  }

  function inferCity(value) {
    const text = clean(value);
    if (!text) return '';
    const direct = text.match(/^(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州|天津|重庆|长沙|郑州|沈阳|青岛|合肥|厦门|福州|济南|宁波|东莞|无锡|昆明|哈尔滨|长春|大连|石家庄|佛山|惠州|珠海|中山|南宁|南昌|贵阳|海口|太原|兰州|银川|西宁|乌鲁木齐|呼和浩特)(?:[·\-\s]|市|$)/);
    if (direct) return direct[1];
    const anywhere = text.match(/(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州|天津|重庆|长沙|郑州|沈阳|青岛|合肥|厦门|福州|济南|宁波|东莞|无锡|昆明|哈尔滨|长春|大连|石家庄|佛山|惠州|珠海|中山|南宁|南昌|贵阳|海口|太原|兰州|银川|西宁|乌鲁木齐|呼和浩特)/);
    return anywhere ? anywhere[1] : '';
  }

  function inferDistrictFromText(value) {
    const text = clean(value);
    if (!text) return '';
    const compact = text.replace(/\s+/g, '');
    const districts = [
      ['深汕特别合作区', ['深汕特别合作区', '深汕合作区', '深汕']],
      ['大鹏新区', ['大鹏新区', '大鹏']],
      ['南山区', ['南山区', '南山']],
      ['福田区', ['福田区', '福田']],
      ['罗湖区', ['罗湖区', '罗湖']],
      ['宝安区', ['宝安区', '宝安']],
      ['龙岗区', ['龙岗区', '龙岗']],
      ['龙华区', ['龙华区', '龙华']],
      ['光明区', ['光明区', '光明']],
      ['坪山区', ['坪山区', '坪山']],
      ['盐田区', ['盐田区', '盐田']]
    ];
    for (const item of districts) {
      const district = item[0];
      const aliases = item[1];
      if (aliases.some(alias => compact.indexOf(alias) >= 0)) return district;
    }
    return '';
  }

  function normalizeJob(raw, fallbackPlatform) {
    raw = raw || {};
    const platform = normalizePlatform(raw.platform || fallbackPlatform || 'boss');
    const url = clean(raw.url || raw.link || raw.href);
    const inferredId = inferJobId(platform, url);
    const jobId = clean(raw.jobId || raw.id || inferredId || hashText([platform, url, raw.title || raw.name, raw.company].join('|')));
    const title = clean(raw.title || raw.name || raw.jobName || '未知岗位');
    const riskFlags = Array.isArray(raw.riskFlags) ? raw.riskFlags : (Array.isArray(raw.risks) ? raw.risks : []);
    const detailLocation = clean(raw.detailLocation || raw.workAddress || raw.detailAddress || raw.address);
    const rawLocation = clean(detailLocation || raw.location || raw.address || raw.area || raw.jobArea || raw.city);
    const city = clean(raw.city) || inferCity(rawLocation);
    const jdText = clean(raw.jd || raw.rawText || raw.desc);
    const rawText = clean(raw.rawText || raw.jd || raw.desc);
    const district = clean(raw.district) || inferDistrictFromText([
      detailLocation,
      raw.workAddress,
      raw.address,
      rawLocation,
      raw.city,
      raw.title || raw.name || raw.jobName,
      raw.company,
      raw.cardText,
      jdText
    ].join(' '));
    const normalized = {
      platform,
      jobId,
      title,
      company: clean(raw.company),
      salary: decodePrivateDigits(raw.salary),
      city,
      district,
      location: rawLocation,
      detailLocation,
      workAddress: detailLocation,
      address: detailLocation,
      url,
      jd: jdText,
      sourceKeyword: clean(raw.sourceKeyword),
      score: Number.isFinite(raw.score) ? raw.score : null,
      matchReason: clean(raw.matchReason || raw.reason),
      riskFlags: riskFlags.map(clean).filter(Boolean),
      status: normalizeStatus(raw.status),
      createdAt: clean(raw.createdAt) || new Date().toISOString(),
      tags: Array.isArray(raw.tags) ? raw.tags.map(clean).filter(Boolean) : [],
      actionText: clean(raw.actionText),
      cardIndex: Number.isInteger(raw.cardIndex) ? raw.cardIndex : null,
      rawText
    };

    normalized.poolId = platform + ':' + jobId;
    normalized.id = clean(raw.id) || jobId;
    normalized.name = title;
    normalized.link = url;
    normalized.reason = normalized.matchReason;
    normalized.risks = normalized.riskFlags;
    if (typeof raw.match === 'boolean') normalized.match = raw.match;
    return normalized;
  }

  root.clean = clean;
  root.decodePrivateDigits = decodePrivateDigits;
  root.hashText = hashText;
  root.inferJobId = inferJobId;
  root.inferCity = inferCity;
  root.inferDistrictFromText = inferDistrictFromText;
  root.normalizePlatform = normalizePlatform;
  root.normalizeJob = normalizeJob;
  root.platformLabel = function (platform) {
    return normalizePlatform(platform) === 'zhilian' ? '智联' : 'BOSS';
  };
})();
