// ===== 海投助手 Service Worker：BOSS直聘岗位收集、AI筛选、自动沟通与投递 =====
importScripts(
  '/src/selectors.js',
  '/src/core/normalizeJob.js',
  '/src/core/jobPool.js',
  '/src/core/scoring.js'
);
const DIRECT_DELIVER_CAP = 5;
const MAX_COLLECT_TOTAL = 60;
const REQUEST_TIMEOUT_MS = 30000;
const TAB_ACTION_TIMEOUT_MS = 15000;
const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_AI_MODEL = 'deepseek-chat';
const FORBIDDEN_OUTGOING_PATTERNS = [
  /api\s*key/i,
  /插件(?:设置|配置|页面)?/i,
  /设置页/i,
  /启用\s*ai.{0,20}配置/i,
  /请先.{0,24}(?:填写|配置).{0,24}(?:简历|api)/i,
  /系统将根据.{0,30}(?:简历|个人经历|生成)/i,
  /专属招呼语/i
];

let state = {
  phase: 'idle', paused: false, aborted: false,
  jobs: [], screened: [], greetings: {}, results: [], processed: {}, applicationHistory: {}
};
let aiFailureLogged = false;
let activeRun = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// ── 小工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
function log(text, level) { chrome.runtime.sendMessage({ type: 'LOG', text: text, level: level || 'info' }).catch(() => {}); }
function pushPhase() { chrome.runtime.sendMessage({ type: 'PHASE', phase: state.phase }).catch(() => {}); }
function progress(cur, total, label) { chrome.runtime.sendMessage({ type: 'PROGRESS', cur: cur, total: total, label: label || '' }).catch(() => {}); }
async function waitIfPaused() { while (state.paused && !state.aborted) await sleep(400); }
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || '请求') + '超时')), ms);
    })
  ]);
}
function launchRun(label, runner) {
  if (activeRun) return { ok: false, error: '当前已有任务在运行，请先等待或停止。' };
  activeRun = Promise.resolve()
    .then(runner)
    .catch(e => {
      log((label || '任务') + '异常：' + (e && e.message ? e.message : e), 'error');
      state.phase = 'idle';
      pushPhase();
    })
    .finally(() => {
      activeRun = null;
      if (['collecting', 'screening', 'delivering'].indexOf(state.phase) >= 0) {
        state.phase = 'idle';
        pushPhase();
      }
    });
  return { ok: true };
}
async function getCfg() {
  const cfg = await withTimeout(chrome.storage.local.get([
    'aiEnabled', 'aiBaseUrl', 'aiModel', 'aiApiKey',
    'dsKey', 'deepseekKey', 'dsModel', 'deepseekModel', 'dsBaseUrl', 'deepseekBaseUrl',
    'resumeText', 'noAiGreeting', 'resumeImage', 'city', 'keyword',
    'priorityWords', 'excludeWords', 'count', 'platformBoss'
  ]), REQUEST_TIMEOUT_MS, '读取配置');
  if (!cfg.aiApiKey && (cfg.dsKey || cfg.deepseekKey)) cfg.aiApiKey = cfg.dsKey || cfg.deepseekKey;
  if (!cfg.aiModel && (cfg.dsModel || cfg.deepseekModel)) cfg.aiModel = cfg.dsModel || cfg.deepseekModel;
  if (!cfg.aiBaseUrl && (cfg.dsBaseUrl || cfg.deepseekBaseUrl)) cfg.aiBaseUrl = cfg.dsBaseUrl || cfg.deepseekBaseUrl;
  cfg.aiBaseUrl = normalizeApiBaseUrl(cfg.aiBaseUrl) || DEFAULT_AI_BASE_URL;
  cfg.aiModel = (cfg.aiModel || '').trim() || DEFAULT_AI_MODEL;
  return cfg;
}
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
function normalizeApiBaseUrl(value) {
  const text = (value || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(text)) return '';
  return text.replace(/\/chat\/completions$/i, '');
}
function aiReady(cfg) {
  return !!(cfg && cfg.aiEnabled === true && (cfg.aiApiKey || '').trim());
}
function logAiFallbackOnce() {
  if (aiFailureLogged) return;
  aiFailureLogged = true;
  log('AI增强调用失败：筛选将使用本地规则；投递将使用填写完成的无AI自我介绍，否则只发送简历图片。', 'warn');
}
function jobInfo(j) { return '平台：BOSS\n岗位：' + (j.title || j.name || '') + '\n技能标签：' + ((j.tags || []).join('、')) + '\n薪资：' + (j.salary || '') + '\n公司：' + (j.company || '') + (j.location ? ('\n地点：' + j.location) : ''); }
function findJob(id) { return JobCopilotCore.jobPool.findByPoolId(state.jobs, id); }
function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase(); }
function parseKeywords(raw) {
  const parts = (raw || '').split(/[\n\r,，、/|;；]+/).map(s => s.trim()).filter(Boolean);
  const seen = {};
  return parts.filter(k => {
    const key = norm(k);
    if (!key || seen[key]) return false;
    seen[key] = 1;
    return true;
  });
}
function validateOutgoingGreeting(value) {
  const text = (value || '').trim();
  if (!text) return { ok: false, error: '没有可发送的招呼语' };
  if (FORBIDDEN_OUTGOING_PATTERNS.some(pattern => pattern.test(text))) {
    return { ok: false, error: '招呼语包含插件/API配置等系统提示，已禁止外发' };
  }
  return { ok: true, text: text };
}
function completedNoAiGreeting(cfg) {
  const text = ((cfg && cfg.noAiGreeting) || '').trim();
  if (!text || /【[^】]+】/.test(text)) return '';
  const checked = validateOutgoingGreeting(text);
  return checked.ok ? checked.text : '';
}
function hashText(s) {
  let h = 2166136261;
  const t = norm(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
function jobDedupeKey(job) { return JobCopilotCore.jobPool.dedupeKey(job); }
async function loadProcessed() {
  const d = await withTimeout(chrome.storage.local.get(['processed', 'applicationHistory']), REQUEST_TIMEOUT_MS, '读取投递记录');
  state.processed = d.processed || {};
  state.applicationHistory = d.applicationHistory || {};
}
function alreadyHandled(job) {
  if (!job) return false;
  return !!(state.processed[job.poolId] || state.processed[job.id] || state.applicationHistory[jobDedupeKey(job)]);
}
async function markHandled(job, status, greeting, note) {
  if (!job) return;
  const key = jobDedupeKey(job);
  const item = {
    status: status || 'handled',
    at: new Date().toISOString(),
    platform: job.platform || 'boss',
    jobId: job.jobId || job.id || '',
    title: job.title || job.name || '',
    company: job.company || '',
    salary: job.salary || '',
    link: job.url || job.link || '',
    messageHash: greeting ? hashText(greeting) : '',
    note: note || ''
  };
  state.processed[job.poolId || job.id] = 1;
  if (job.id) state.processed[job.id] = 1;
  state.applicationHistory[key] = item;
  const targetIds = [job.poolId, job.id, job.jobId].filter(Boolean);
  function update(list) {
    return (list || []).map(candidate => {
      if (!candidate || !targetIds.some(id => candidate.poolId === id || candidate.id === id || candidate.jobId === id)) return candidate;
      return Object.assign({}, candidate, {
        status: item.status,
        applicationAt: item.at,
        applicationStatus: item.status,
        applicationNote: item.note
      });
    });
  }
  state.jobs = update(state.jobs);
  state.screened = update(state.screened);
  await chrome.storage.local.set({
    processed: state.processed,
    applicationHistory: state.applicationHistory,
    sw_jobs: state.jobs,
    sw_screened: state.screened,
    sw_greetings: state.greetings
  });
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}
function localScreen(cfg, job, jd) {
  const configuredPriority = parseKeywords(cfg && cfg.priorityWords);
  const priorityWords = configuredPriority.length ? configuredPriority : parseKeywords(cfg && cfg.keyword);
  const excludeWords = parseKeywords(cfg && cfg.excludeWords);
  return JobCopilotCore.scoring.scoreByWords(
    Object.assign({}, job, { jd: jd || job.jd || job.rawText || '' }),
    priorityWords,
    excludeWords
  );
}

// ── AI增强：OpenAI 兼容接口 ──
async function callAI(messages, maxTokens) {
  const cfg = await getCfg();
  const baseUrl = normalizeApiBaseUrl(cfg.aiBaseUrl) || DEFAULT_AI_BASE_URL;
  const model = (cfg.aiModel || '').trim();
  const apiKey = (cfg.aiApiKey || '').trim();
  if (!aiReady(cfg)) throw new Error('AI增强未配置完整');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.5, max_tokens: maxTokens || 300 }),
      signal: ctl.signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('AI请求30秒超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error('AI接口 ' + resp.status + ': ' + t.slice(0, 120)); }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// 筛选：只判断是否值得投（用岗位标签快速判断，不生成招呼语）
async function screenJob(cfg, job) {
  if (!aiReady(cfg) || !resumeFull(cfg)) return localScreen(cfg, job, '');
  const sys = '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·适中】保留(match=true)：岗位方向与求职者简历的专业/技能/经历相关，且求职者的经验年限、学历、级别够得着该岗位（不超纲）。剔除(match=false)：方向与简历明显无关；岗位要求的经验/学历/硬技能明显超出简历；岗位级别明显高于求职者当前水平。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"reason":"一句话理由"}';
  const user = '求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  let raw = '';
  try {
    raw = await callAI([{ role: 'system', content: sys }, { role: 'user', content: user }], 200);
  } catch (e) {
    logAiFallbackOnce();
    return localScreen(cfg, job, '');
  }
  let p = null;
  try { p = JSON.parse(raw); } catch (e) { const m = raw && raw.match(/\{[\s\S]*\}/); if (m) { try { p = JSON.parse(m[0]); } catch (e2) {} } }
  if (!p) {
    const fallback = localScreen(cfg, job, '');
    fallback.reason = (fallback.reason ? fallback.reason + '；' : '') + 'AI解析失败，已按本地规则判断';
    fallback.riskFlags = (fallback.riskFlags || []).concat(['AI解析失败']);
    return fallback;
  }
  return {
    match: p.match === true,
    score: Number.isFinite(p.score) ? p.score : (p.match === true ? 78 : 35),
    reason: p.reason || '',
    matchReason: p.reason || '',
    riskFlags: Array.isArray(p.riskFlags) ? p.riskFlags : []
  };
}

// 投递时：结合该岗位的【完整JD】+ 简历，现场生成专属招呼语
async function genGreetingFromJD(cfg, job, jd) {
  const noAiGreeting = completedNoAiGreeting(cfg);
  if (!aiReady(cfg) || !resumeFull(cfg)) return noAiGreeting;
  const sys = '你是求职者本人，在BOSS直聘给招聘方发一句自然的自我介绍。回复会原样发送，严禁输出注释、设置说明、系统提示、括号备注、字数统计或引导语。要求：1.只根据【简历】和【岗位JD】选择最相关的2到3项真实信息。2.不要预设行业或职业方向，不要因为简历出现某个工具就强行强调它；只有岗位明确要求时才提及。3.不要使用赋能、闭环、生态、抓手、链路等虚词。4.不得编造简历中不存在的经历、技能、证书或数据。5.全文80-150字，像真人求职沟通，结尾自然表达希望进一步沟通。';
  const jdText = (jd && jd.trim()) ? jd.trim() : ('技能标签：' + (job.tags || []).join('、'));
  const user = '我的简历：\n' + resumeFull(cfg) + '\n\n目标岗位：' + (job.title || job.name || '') + (job.company ? ('（' + job.company + '）') : '') + '\n该岗位JD：\n' + jdText + '\n\n请生成一段自然的BOSS打招呼语，直接输出招呼语本身，不要任何多余内容。';
  try {
    const raw = await callAI([{ role: 'system', content: sys }, { role: 'user', content: user }], 300);
    const checked = validateOutgoingGreeting(raw);
    if (checked.ok) return checked.text;
    log('AI生成内容未通过安全校验：' + checked.error + '，已改用安全备用方式。', 'warn');
    return noAiGreeting;
  } catch (e) {
    logAiFallbackOnce();
    return noAiGreeting;
  }
}

// ── tab 注入 + 发消息 ──
async function ensureInjected(tabId, file) {
  try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: [file] }); } catch (e) {}
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    const type = (msg && msg.type) || '';
    const isSend = type === 'SEND' || /^SEND_ACTIVE(?:_V[2-6])?$/.test(type);
    const timeout = (type === 'SCRAPE' || isSend) ? REQUEST_TIMEOUT_MS : TAB_ACTION_TIMEOUT_MS;
    const timeoutText = type === 'SCRAPE' ? '页面扫描30秒超时' : isSend ? '发送确认30秒超时' : '页面动作15秒超时';
    const timer = setTimeout(() => resolve({ success: false, error: timeoutText }), timeout);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'no response' });
    });
  });
}
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(false), TAB_ACTION_TIMEOUT_MS);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(lis);
      setTimeout(() => resolve(ok), ok ? 1200 : 0);
    }
    function lis(id, info) { if (id === tabId && info.status === 'complete') finish(true); }
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') finish(true); });
  });
}
function resolveCity(cfg) {
  const firstCity = (cfg.city || '').split(/[\/、,，\s]+/)[0].replace(/[市省]$/, '') || '';
  const code = (typeof CITY_MAP !== 'undefined' && CITY_MAP[firstCity]) || '100010000';
  return { name: firstCity, code: code, found: code !== '100010000' || firstCity === '全国' };
}
function buildSearchUrl(cfg, keyword) {
  const c = resolveCity(cfg);
  const params = new URLSearchParams({ query: keyword || cfg.keyword || '', city: c.code });
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
}
async function ensureTab(url) {
  let tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  let tab = tabs[0];
  if (!tab) tab = await chrome.tabs.create({ url: url });
  else await chrome.tabs.update(tab.id, { url: url });
  await waitTabComplete(tab.id);
  await sleep(2000);
  return tab;
}
async function getSearchTab(cfg, keyword) { return ensureTab(buildSearchUrl(cfg, keyword)); }
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }
async function waitForTabUrl(tabId, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || TAB_ACTION_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const url = await curUrl(tabId);
    if (predicate(url)) return url;
    await sleep(250);
  }
  return '';
}

function normalizeList(list, platform) {
  return (list || []).map(job => JobCopilotCore.normalizeJob(job, job.platform || platform));
}
async function loadStoredPool() {
  const d = await withTimeout(chrome.storage.local.get(['sw_jobs', 'sw_screened']), REQUEST_TIMEOUT_MS, '读取岗位池');
  return {
    jobs: normalizeList(d.sw_jobs || [], 'boss'),
    screened: normalizeList(d.sw_screened || [], 'boss')
  };
}
async function persistPool() {
  await chrome.storage.local.set({ sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened });
}
async function screenJobsIntoReview(cfg, jobs) {
  let done = 0;
  const total = jobs.length;
  const scored = [];
  if (!jobs.length) return scored;
  progress(0, total, '筛选');
  const CONC = 3;
  for (let i = 0; i < jobs.length; i += CONC) {
    if (state.aborted) break; await waitIfPaused();
    const batch = jobs.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      let res;
      if (alreadyHandled(job) || ['继续沟通', '已沟通'].indexOf(job.actionText || '') >= 0) {
        res = { match: false, score: 20, reason: '已沟通过/本地已有记录，跳过避免重复投递', riskFlags: ['重复沟通风险'] };
      }
      else try { res = await screenJob(cfg, job); }
      catch (e) { res = { match: false, score: 25, reason: '筛选异常:' + e.message, riskFlags: ['筛选异常'] }; }
      scored.push(JobCopilotCore.scoring.applyScreenResult(job, res));
      done++; progress(done, total, '筛选');
    }));
  }
  return scored;
}

async function ensurePoolLoaded() {
  if (!state.jobs.length || !state.screened.length) {
    const stored = await loadStoredPool().catch(() => ({ jobs: [], screened: [] }));
    if (!state.jobs.length) state.jobs = stored.jobs;
    if (!state.screened.length) state.screened = stored.screened;
  }
}

async function updateJobStatus(poolId, status, patch) {
  await ensurePoolLoaded();
  const target = (poolId || '').trim();
  const nextStatus = (status || '').trim();
  if (!target) return { ok: false, error: 'missing job id' };
  if (!nextStatus) return { ok: false, error: 'missing status' };
  let changed = false;
  const extra = patch && typeof patch === 'object' ? patch : {};
  function update(list) {
    return (list || []).map(job => {
      if (!job || (job.poolId !== target && job.id !== target && job.jobId !== target)) return job;
      changed = true;
      return Object.assign({}, job, extra, { status: nextStatus });
    });
  }
  state.jobs = update(state.jobs);
  state.screened = update(state.screened);
  if (changed) {
    await persistPool();
    chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
  }
  return { ok: changed };
}

function attachApplicationHistory(list) {
  return (list || []).map(job => {
    const normalized = JobCopilotCore.normalizeJob(job, job && job.platform);
    const history = state.applicationHistory[jobDedupeKey(normalized)]
      || state.applicationHistory[normalized.poolId]
      || state.applicationHistory[normalized.id]
      || state.applicationHistory[normalized.jobId];
    if (!history) return normalized;
    return Object.assign({}, normalized, {
      applicationAt: history.at || '',
      applicationStatus: history.status || '',
      applicationNote: history.note || ''
    });
  });
}

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false;
  aiFailureLogged = false;
  const cfg = await getCfg();
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
  state.phase = 'collecting'; pushPhase();
  await loadProcessed();
  const keywords = parseKeywords(cfg.keyword);
  if (!keywords.length) { log('请先填写岗位关键词', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!aiReady(cfg) || !(cfg.resumeText || '').trim()) {
    log('AI增强未就绪：使用本地规则筛选；投递时优先使用填写完成的无AI自我介绍，否则仅发送简历图片。', 'warn');
  }

  const _c = resolveCity(cfg);
  log('关键词 ' + keywords.length + ' 个：' + keywords.join(' / '));
  log('城市：' + (_c.found ? _c.name : '全国'));
  if (cfg.city && !_c.found) log('城市"' + cfg.city + '"未识别，已按全国搜索', 'warn');
  const count = Math.max(1, Math.min(parseInt(cfg.count) || 5, 20));
  const seenJobs = {};
  const bossJobs = [];

  log('收集岗位中（每个关键词最多 ' + count + ' 个，总上限 ' + MAX_COLLECT_TOTAL + ' 个）...');
  for (let i = 0; i < keywords.length && bossJobs.length < MAX_COLLECT_TOTAL; i++) {
    if (state.aborted) break; await waitIfPaused();
    const keyword = keywords[i];
    log('  [' + (i + 1) + '/' + keywords.length + '] 搜索：' + keyword);
    const tab = await getSearchTab(cfg, keyword);
    await ensureInjected(tab.id, 'src/content-search.js');
    const r = await sendToTab(tab.id, { type: 'SCRAPE', count: count });
    if (!r || !r.success) { log('  收集失败：' + (r && r.error), 'error'); continue; }
    let added = 0;
    (r.jobs || []).forEach(job => {
      job.sourceKeyword = keyword;
      const normalized = JobCopilotCore.normalizeJob(job, 'boss');
      const key = jobDedupeKey(normalized);
      if (!seenJobs[key] && bossJobs.length < MAX_COLLECT_TOTAL) {
        seenJobs[key] = 1;
        bossJobs.push(normalized);
        added++;
      }
    });
    log('  收到 ' + ((r.jobs || []).length) + ' 个，新增去重后 ' + added + ' 个');
    await rand(800, 1500);
  }
  log('BOSS 收集到 ' + bossJobs.length + ' 个去重岗位', bossJobs.length ? 'success' : 'warn');
  if (!bossJobs.length) { state.phase = 'idle'; pushPhase(); return; }

  // 筛选（并发3）
  state.phase = 'screening'; pushPhase();
  log(aiReady(cfg) && (cfg.resumeText || '').trim() ? 'AI增强筛选中...' : '本地规则筛选中...');
  const scoredBoss = await screenJobsIntoReview(cfg, bossJobs);
  state.jobs = JobCopilotCore.jobPool.mergeJobs([], scoredBoss.length ? scoredBoss : bossJobs);
  state.screened = JobCopilotCore.jobPool.mergeJobs([], scoredBoss);
  const matched = state.screened.filter(j => j.match).length;
  log('筛选完成：匹配 ' + matched + ' / ' + state.screened.length, 'success');
  await persistPool();
  state.phase = 'review'; pushPhase();
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}

// ── 流程：投递（单个闭环：建联→进聊天页→发图片+招呼语→回搜索页→下一个）──
async function runDeliver(jobIds) {
  state.aborted = false; state.paused = false; state.results = [];
  aiFailureLogged = false;
  state.phase = 'delivering'; pushPhase();
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  await loadProcessed();
  const cfg = await getCfg();
  if (!cfg.resumeImage) log('未上传简历图片，本轮只能发送安全校验通过的自我介绍文字。', 'warn');

  const selectedJobs = (jobIds || []).map(id => findJob(id)).filter(Boolean);
  let ids = selectedJobs.filter(job => !alreadyHandled(job)).map(job => job.poolId || job.id);
  if (ids.length > DIRECT_DELIVER_CAP) { log('为防止卡死，本轮最多处理前5个，其余可下一轮继续。', 'warn'); ids = ids.slice(0, DIRECT_DELIVER_CAP); }
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }
  for (let k = 0; k < ids.length; k++) {
    if (state.aborted) break; await waitIfPaused();
    const job = findJob(ids[k]);
    if (!job) { log('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); continue; }
    if (alreadyHandled(job)) { recordSkip(job, '本地已有投递/沟通记录'); log('[' + (k + 1) + '/' + ids.length + '] 已有记录，跳过：' + job.name, 'warn'); progress(k + 1, ids.length, '正在投递'); continue; }
    log('正在投递 ' + (k + 1) + '/' + ids.length + '：' + (job.title || job.name) + ' - ' + (job.company || ''));

    // 1. 回搜索页，点开卡片读取该岗位完整JD
    const searchUrl = buildSearchUrl(cfg, job.sourceKeyword || parseKeywords(cfg.keyword)[0]);
    const tab = await ensureTab(searchUrl);
    await ensureInjected(tab.id, 'src/content-search.js');
    log('  读取岗位JD...');
    const jdr = await sendToTab(tab.id, { type: 'OPEN_JD_V3', job: job });
    const jd = (jdr && jdr.jd) || '';
    if (jdr && (jdr.actionText === '继续沟通' || jdr.actionText === '已沟通')) {
      await markHandled(job, 'already_contacted', '', '详情页显示' + jdr.actionText);
      recordSkip(job, '详情页显示' + jdr.actionText);
      log('  页面显示' + jdr.actionText + '，跳过避免重复', 'warn');
      progress(k + 1, ids.length, '正在投递');
      continue;
    }

    // 2. 生成或读取安全的自我介绍；无文字时允许仅发送简历图片
    if (aiReady(cfg) && resumeFull(cfg)) log('  AI根据简历与岗位JD生成自我介绍...');
    else if (completedNoAiGreeting(cfg)) log('  使用已填写完成的无AI自我介绍...');
    else log('  无可发送文字，本岗位只发送简历图片。', 'warn');
    let greeting = '';
    try { greeting = await genGreetingFromJD(cfg, job, jd); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (greeting) {
      const outgoingCheck = validateOutgoingGreeting(greeting);
      if (!outgoingCheck.ok) {
        recordFail(job, outgoingCheck.error);
        log('  安全停止：' + outgoingCheck.error, 'error');
        progress(k + 1, ids.length, '正在投递');
        continue;
      }
      greeting = outgoingCheck.text;
    }
    if (!greeting && !cfg.resumeImage) {
      recordFail(job, '没有简历图片或可发送的自我介绍');
      log('  安全停止：没有简历图片或可发送的自我介绍', 'error');
      progress(k + 1, ids.length, '正在投递');
      continue;
    }

    // 3. 点立即沟通 → 继续沟通（跳聊天页）
    log('  建立联系（立即沟通 → 继续沟通）...');
    const gr = await sendToTab(tab.id, { type: 'GO_CHAT_V3', job: job });
    if (gr && gr.alreadyContacted) {
      await markHandled(job, 'already_contacted', greeting, gr.error || '页面显示已沟通');
      recordSkip(job, gr.error || '页面显示已沟通');
      log('  ' + (gr.error || '页面显示已沟通，跳过'), 'warn');
      progress(k + 1, ids.length, '正在投递');
      continue;
    }
    if (!gr || gr.success === false) {
      // 页面跳转会中断旧消息通道，以实际URL为准。
      const navUrl = await waitForTabUrl(tab.id, url => url.indexOf('/web/geek/chat') >= 0, 4000);
      if (navUrl) {
        log('  建联响应丢失但页面已进入聊天页，继续投递', 'warn');
      } else {
        recordFail(job, (gr && gr.error) || '建联失败');
        if (gr && gr.error) log('  建联失败：' + gr.error, 'error');
        progress(k + 1, ids.length, '正在投递');
        continue;
      }
    }
    const chatUrl = await waitForTabUrl(tab.id, url => url.indexOf('/web/geek/chat') >= 0, TAB_ACTION_TIMEOUT_MS);
    if (!chatUrl) {
      recordFail(job, '未跳转聊天页');
      log('  未进入聊天页，跳过', 'error');
      progress(k + 1, ids.length, '正在投递');
      continue;
    }
    await waitTabComplete(tab.id); await sleep(1200);

    // 4. 聊天页当前打开的即该岗位会话，先发图片再发招呼语（无需匹配）
    const u = await curUrl(tab.id);
    if (u.indexOf('/web/geek/chat') < 0) { recordFail(job, '未跳转聊天页'); log('  未进入聊天页，跳过', 'error'); progress(k + 1, ids.length, '正在投递'); continue; }
    await ensureInjected(tab.id, 'src/content-chat.js');
    log(greeting ? '  发送简历图片与自我介绍...' : '  仅发送简历图片...');
    const r = await sendToTab(tab.id, {
      type: 'SEND_ACTIVE_V6',
      image: cfg.resumeImage || '',
      greeting: greeting,
      job: { poolId: job.poolId || job.id, jobId: job.jobId || job.id, title: job.title || job.name, company: job.company || '' }
    });
    if (r && r.duplicateImage) {
      const reason = r.error || '当前会话已有自己发送的图片，需人工确认';
      await markHandled(job, 'needs_review', greeting, reason);
      recordSkip(job, reason);
      log('  ' + reason, 'warn');
    }
    else if (r && r.duplicate) {
      await markHandled(job, 'duplicate_in_chat', greeting, r.error || '聊天中已有相同话术');
      recordSkip(job, r.error || '聊天中已有相同话术');
      log('  ' + (r.error || '聊天中已有相同话术，跳过'), 'warn');
    }
    else if (r && r.success && r.verified === true) {
      const note = r.imageOnly ? '简历图片发送成功，未发送插件文字' : '发送成功：' + (r.proof || '已验证自己消息');
      recordOk(job);
      await markHandled(job, 'sent', greeting, note);
      log(r.imageOnly ? '  ✓ 简历图片发送成功（未发送插件文字）' : '  ✓ 投递成功（已验证聊天气泡）', 'success');
    }
    else if (r && r.success) {
      recordFail(job, '发送未通过页面验证');
      log('  失败：发送未通过页面验证', 'error');
    }
    else if (r && r.imageSent) {
      const reason = '简历图片已发送，但文字发送失败：' + (r.error || '未知错误') + '；已停止自动重试，请人工确认';
      await markHandled(job, 'needs_review', greeting, reason);
      recordFail(job, reason);
      log('  ' + reason, 'error');
    }
    else {
      recordFail(job, (r && r.error) || '发送失败');
      log('  失败：' + ((r && r.error) || '发送失败'), 'error');
    }
    progress(k + 1, ids.length, '正在投递');
    await rand(2500, 4500);
  }
  if (state.aborted) log('已停止队列：当前岗位结束后未继续处理下一个。', 'warn');
  finishDeliver();
}
function recordOk(job) { state.results.push({ id: job.poolId || job.id, name: job.title || job.name, ok: true }); }
function recordSkip(job, msg) { state.results.push({ id: job.poolId || job.id, name: job.title || job.name, ok: false, skip: true, msg: msg }); }
function recordFail(job, msg) { state.results.push({ id: job.poolId || job.id, name: job.title || job.name, ok: false, msg: msg }); }
function finishDeliver() {
  const ok = state.results.filter(r => r.ok).length;
  const skip = state.results.filter(r => r.skip).length;
  const fail = state.results.length - ok - skip;
  state.phase = 'done'; pushPhase();
  log('投递完成：成功 ' + ok + ' | 跳过 ' + skip + ' | 失败 ' + fail, 'success');
  chrome.runtime.sendMessage({ type: 'DONE', ok: ok, fail: fail }).catch(() => {});
}

// ── 消息入口 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_COLLECT') { sendResponse(launchRun('收集/筛选', runCollect)); return; }
  if (msg.type === 'START_DELIVER') { sendResponse(launchRun('投递', () => runDeliver(msg.jobIds))); return; }
  if (msg.type === 'OPEN_JOB_URL') {
    (async () => {
      const url = (msg.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return sendResponse({ ok: false, message: '这个岗位没有可打开的详情链接。', level: 'warn' });
      await chrome.tabs.create({ url: url, active: true });
      sendResponse({ ok: true, message: '已打开详情页' });
    })().catch(e => sendResponse({ ok: false, message: '打开详情失败：' + e.message, level: 'error' }));
    return true;
  }
  if (msg.type === 'MARK_JOB_STATUS') {
    updateJobStatus(msg.jobId, msg.status, msg.patch)
      .then(resp => sendResponse(resp))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'GET_JOB_POOL') {
    (async () => {
      await ensurePoolLoaded();
      await loadProcessed().catch(() => {});
      sendResponse({ ok: true, jobs: attachApplicationHistory(state.screened.length ? state.screened : state.jobs) });
    })();
    return true;
  }
  if (msg.type === 'PAUSE') { state.paused = true; log('已暂停', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESUME') { state.paused = false; log('继续', 'info'); sendResponse({ ok: true }); return; }
  if (msg.type === 'STOP') {
    state.aborted = true;
    state.paused = false;
    log('已收到停止请求，当前动作结束后停止。', 'warn');
    if (state.phase !== 'delivering') { state.phase = 'idle'; pushPhase(); }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'RESET') {
    if (activeRun) { sendResponse({ ok: false, error: '当前任务仍在运行，请先停止并等待结束。' }); return; }
    state.processed = {}; state.applicationHistory = {};
    state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
    state.phase = 'idle'; pushPhase();
    chrome.storage.local.set({ processed: {}, applicationHistory: {}, sw_jobs: [], sw_screened: [], sw_greetings: {} })
      .then(() => { log('已重置（清空岗位池、已投记录和去重历史）', 'warn'); sendResponse({ ok: true }); })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'GET_STATE') {
    (async () => {
      if (!state.screened.length) {
        const stored = await loadStoredPool().catch(() => ({ jobs: [], screened: [] }));
        state.jobs = stored.jobs;
        state.screened = stored.screened;
      }
      sendResponse({ phase: state.phase, running: !!activeRun, screened: state.screened });
    })();
    return true;
  }
});

loadProcessed().catch(() => {});
