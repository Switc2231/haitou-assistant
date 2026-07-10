// ===== 海投助手 侧边栏交互 =====
const $ = (id) => document.getElementById(id);
const CFG_FIELDS = ['resumeText', 'noAiGreeting', 'keyword', 'priorityWords', 'excludeWords', 'city', 'count'];
const AI_TEXT_FIELDS = ['aiApiKey'];
const AI_BOOL_FIELDS = ['aiEnabled'];
const LEGACY_AI_FIELDS = ['dsKey', 'deepseekKey', 'dsModel', 'deepseekModel', 'dsBaseUrl', 'deepseekBaseUrl'];
const MAX_DELIVER_PER_RUN = 5;
const MAX_LOG_ITEMS = 200;
const MAX_RESUME_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_AI_MODEL = 'deepseek-chat';
let currentScreened = [];
let hasResumeImage = false;
const DEFAULT_KEYWORDS = '';
const DEFAULT_EXCLUDE_WORDS = '';
const DEFAULT_NO_AI_GREETING = '';

// 折叠
document.querySelectorAll('.card-h[data-toggle]').forEach(h => {
  h.addEventListener('click', () => {
    const body = $(h.dataset.toggle);
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });
});

$('aiToggle').addEventListener('click', () => {
  const body = $('aiFields');
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
});

$('aiEnabled').addEventListener('change', updateAiSummary);
AI_TEXT_FIELDS.forEach(f => {
  const el = $(f);
  if (el) el.addEventListener('input', updateAiSummary);
});

// 载入配置
chrome.storage.local.get(CFG_FIELDS.concat(AI_TEXT_FIELDS).concat(AI_BOOL_FIELDS).concat(LEGACY_AI_FIELDS).concat(['resumeImage']), (d) => {
  migrateLegacyAiConfig(d);
  CFG_FIELDS.forEach(f => { if (d[f] !== undefined && $(f)) $(f).value = d[f]; });
  AI_TEXT_FIELDS.forEach(f => { if (d[f] !== undefined && $(f)) $(f).value = d[f]; });
  AI_BOOL_FIELDS.forEach(f => { if ($(f)) $(f).checked = d[f] === true; });
  if (d.keyword === undefined && $('keyword')) $('keyword').value = DEFAULT_KEYWORDS;
  if (d.noAiGreeting === undefined && $('noAiGreeting')) $('noAiGreeting').value = DEFAULT_NO_AI_GREETING;
  if (d.priorityWords === undefined && $('priorityWords')) $('priorityWords').value = '';
  if (d.excludeWords === undefined && $('excludeWords')) $('excludeWords').value = DEFAULT_EXCLUDE_WORDS;
  if (d.city === undefined && $('city')) $('city').value = '';
  if (d.count === undefined && $('count')) $('count').value = '5';
  if (d.resumeImage) { hasResumeImage = true; showImg(d.resumeImage); }
  updateNoAiGreetingStatus();
  updateAiSummary();
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state && Array.isArray(state.screened) && state.screened.length) setScreened(state.screened);
    if (state && state.phase) {
      updatePhase(state.phase);
      setRunning(state.running === true || ['collecting', 'screening', 'delivering'].indexOf(state.phase) >= 0);
    }
  });
});

function migrateLegacyAiConfig(d) {
  const patch = {};
  if (!d.aiApiKey && (d.dsKey || d.deepseekKey)) { d.aiApiKey = d.dsKey || d.deepseekKey; patch.aiApiKey = d.aiApiKey; }
  if (!d.aiModel && (d.dsModel || d.deepseekModel)) { d.aiModel = d.dsModel || d.deepseekModel; patch.aiModel = d.aiModel; }
  if (!d.aiBaseUrl && (d.dsBaseUrl || d.deepseekBaseUrl)) { d.aiBaseUrl = d.dsBaseUrl || d.deepseekBaseUrl; patch.aiBaseUrl = d.aiBaseUrl; }
  if (Object.keys(patch).length) chrome.storage.local.set(patch);
}

function updateAiSummary() {
  const enabled = $('aiEnabled') && $('aiEnabled').checked;
  const ready = enabled && $('aiApiKey').value.trim();
  const title = enabled ? (ready ? 'AI增强（可选）：已开启' : 'AI增强（可选）：待填写') : 'AI增强（可选）：未开启';
  const desc = '不填也能用本地规则；填写 API Key 后，筛选和话术会更准。';
  const strong = document.querySelector('#aiToggle strong');
  const em = document.querySelector('#aiToggle em');
  if (strong) strong.textContent = title;
  if (em) em.textContent = desc;
}

function noAiGreetingReady() {
  const text = ($('noAiGreeting').value || '').trim();
  return !!text && !/【[^】]+】/.test(text);
}

function updateNoAiGreetingStatus() {
  const el = $('noAiGreetingStatus');
  if (!el) return;
  const text = ($('noAiGreeting').value || '').trim();
  if (!text) { el.textContent = '选填：可以参考示例，也可以完全自己写；留空时不发送文字。'; return; }
  if (/【[^】]+】/.test(text)) { el.textContent = '尚未填完：请替换所有【占位内容】，当前不会发送。'; return; }
  el.textContent = '已填写完成：未接入AI时将原样发送这段自我介绍。';
}

$('noAiGreeting').addEventListener('input', updateNoAiGreetingStatus);

function showImg(dataUrl) { $('imgPrev').innerHTML = '<img src="' + dataUrl + '">'; }

$('resumeImg').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > MAX_RESUME_IMAGE_BYTES) {
    e.target.value = '';
    return addLog('简历图片超过4MB，请压缩后重新上传，避免浏览器本地存储失败。', 'error');
  }
  const reader = new FileReader();
  reader.onerror = () => addLog('简历图片读取失败，请重新选择。', 'error');
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    chrome.storage.local.set({ resumeImage: dataUrl }, () => {
      if (chrome.runtime.lastError) {
        hasResumeImage = false;
        $('imgPrev').innerHTML = '';
        addLog('简历图片保存失败：' + chrome.runtime.lastError.message, 'error');
        return;
      }
      hasResumeImage = true;
      showImg(dataUrl);
      addLog('简历图片已保存。', 'success');
    });
  };
  reader.readAsDataURL(file);
});

$('saveCfg').addEventListener('click', () => {
  const obj = {};
  CFG_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
  AI_TEXT_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
  AI_BOOL_FIELDS.forEach(f => { obj[f] = $(f).checked; });
  chrome.storage.local.set(obj, () => { updateAiSummary(); const s = $('saved'); s.style.display = 'inline'; setTimeout(() => s.style.display = 'none', 1500); });
});

function saveCfgSync() {
  return new Promise(res => {
    const obj = {};
    CFG_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
    AI_TEXT_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
    AI_BOOL_FIELDS.forEach(f => { obj[f] = $(f).checked; });
    chrome.storage.local.set(obj, () => { updateAiSummary(); res(); });
  });
}

$('testAi').addEventListener('click', async () => {
  await saveCfgSync();
  const apiKey = $('aiApiKey').value.trim();
  if (!$('aiEnabled').checked) return addLog('请先启用 AI增强。', 'warn');
  if (!apiKey) return addLog('请填写 API Key 后再测试。', 'warn');
  addLog('正在测试 AI增强接口...', 'info');
  try {
    const aiDefaults = await getAiEndpointDefaults();
    const resp = await fetch(aiDefaults.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: aiDefaults.model, messages: [{ role: 'user', content: 'ping' }], temperature: 0 })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    addLog('连接成功', 'success');
  } catch (e) {
    addLog('连接失败，请检查 API Key', 'error');
  }
});

function normalizeApiBaseUrl(value) {
  const text = (value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (!/^https:\/\//i.test(text)) return '';
  return text.replace(/\/chat\/completions$/i, '');
}

function getAiEndpointDefaults() {
  return new Promise(resolve => {
    chrome.storage.local.get(['aiBaseUrl', 'aiModel'], d => {
      resolve({ baseUrl: normalizeApiBaseUrl(d.aiBaseUrl) || DEFAULT_AI_BASE_URL, model: (d.aiModel || '').trim() || DEFAULT_AI_MODEL });
    });
  });
}

// 运行控制
$('btnCollect').addEventListener('click', async () => {
  await saveCfgSync();
  if (!$('keyword').value.trim()) return addLog('请先填岗位关键词，可一行一个', 'error');
  if (!$('aiEnabled').checked) {
    const deliveryMode = noAiGreetingReady() ? '投递时使用已填写的无AI自我介绍。' : '没有有效自我介绍时只发送已上传的简历图片。';
    addLog('AI增强未开启：使用本地规则筛选；' + deliveryMode, 'warn');
  }
  $('reviewCard').style.display = 'none';
  setRunning(true);
  chrome.runtime.sendMessage({ type: 'START_COLLECT' }, (resp) => {
    if (chrome.runtime.lastError) { setRunning(false); return addLog('启动失败：' + chrome.runtime.lastError.message, 'error'); }
    if (!resp || !resp.ok) { setRunning(false); addLog((resp && resp.error) || '当前已有任务在运行', 'warn'); }
  });
});

$('btnDeliver').addEventListener('click', () => {
  const aiDeliveryReady = $('aiEnabled').checked && $('aiApiKey').value.trim() && $('resumeText').value.trim();
  const noAiReady = noAiGreetingReady();
  if (!aiDeliveryReady && !noAiReady && !hasResumeImage) return addLog('安全停止：没有简历图片，也没有填写完成的无AI自我介绍。', 'error');
  if (!aiDeliveryReady && noAiReady) addLog('本轮使用已填写的无AI自我介绍。', 'info');
  else if (!aiDeliveryReady) addLog('无AI自我介绍尚未填完，本轮只发送简历图片。', 'warn');
  const selected = Array.from(document.querySelectorAll('.job-item input:checked')).map(c => c.dataset.id).filter(Boolean);
  if (!selected.length) return addLog('请至少勾选一个岗位', 'error');
  let ids = selected;
  if (ids.length > MAX_DELIVER_PER_RUN) {
    addLog('为防止卡死，本轮最多处理前5个，其余可下一轮继续。', 'warn');
    ids = ids.slice(0, MAX_DELIVER_PER_RUN);
  }
  setRunning(true);
  addLog('开始按队列投递 ' + ids.length + ' 个岗位', 'info');
  chrome.runtime.sendMessage({ type: 'START_DELIVER', jobIds: ids }, (resp) => {
    if (chrome.runtime.lastError) { setRunning(false); return addLog('启动失败：' + chrome.runtime.lastError.message, 'error'); }
    if (!resp || !resp.ok) { setRunning(false); addLog((resp && resp.error) || '当前已有任务在运行', 'warn'); }
  });
});

$('btnPause').addEventListener('click', () => {
  if ($('btnPause').textContent === '暂停') { $('btnPause').textContent = '继续'; chrome.runtime.sendMessage({ type: 'PAUSE' }); }
  else { $('btnPause').textContent = '暂停'; chrome.runtime.sendMessage({ type: 'RESUME' }); }
});
$('btnStop').addEventListener('click', () => {
  $('btnStop').disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP' }, (resp) => {
    if (!resp || !resp.ok) addLog((resp && resp.error) || '停止请求失败', 'error');
  });
});
$('btnReset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET' }, (resp) => {
    if (!resp || !resp.ok) return addLog((resp && resp.error) || '当前任务尚未结束，不能重置', 'warn');
    $('reviewCard').style.display = 'none';
    setRunning(false);
  });
});
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

$('selAll').addEventListener('change', (e) => {
  document.querySelectorAll('.job-item input[type="checkbox"]:not(:disabled)').forEach(c => c.checked = e.target.checked);
});

$('btnExportCsv').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_JOB_POOL' }, (resp) => {
    const allRows = resp && resp.ok && Array.isArray(resp.jobs) ? resp.jobs : currentScreened;
    const sourceRows = $('exportScope').value === 'filtered'
      ? currentScreened.filter(job => job && job.match === true)
      : allRows;
    exportCsv(sourceRows || []);
  });
});

$('reviewList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.job-item');
  if (!item) return;
  if (btn.dataset.act === 'openJob') {
    const url = item.dataset.url || '';
    if (!url) return addLog('这个岗位没有可打开的详情链接。', 'warn');
    markViewed(item);
    chrome.runtime.sendMessage({ type: 'OPEN_JOB_URL', url: url }, (resp) => {
      if (chrome.runtime.lastError) { addLog('打开详情失败：' + chrome.runtime.lastError.message, 'error'); return; }
      if (resp && resp.message) addLog(resp.message, resp.level || (resp.ok ? 'info' : 'error'));
      else addLog('已打开详情页', 'info');
    });
    return;
  }
  if (btn.dataset.act === 'skipJob') {
    markStatus(item, 'skipped', { skippedAt: new Date().toISOString(), userSkipped: true });
    addLog('已跳过：' + (item.dataset.title || '该岗位'), 'warn');
    return;
  }
  if (btn.dataset.act === 'blockCompany') {
    const company = item.dataset.company || '';
    document.querySelectorAll('.job-item').forEach(row => {
      if ((row.dataset.company || '') === company) markStatus(row, 'blocked');
    });
    addLog('已屏蔽公司：' + (company || item.dataset.title || '该公司'), 'warn');
  }
});

function setRunning(running) {
  $('btnCollect').disabled = running;
  $('btnPause').disabled = !running;
  $('btnStop').disabled = !running;
  if (!running) $('btnPause').textContent = '暂停';
}

// 渲染审核列表
function setScreened(screened) {
  currentScreened = (screened || []).map(normalizeUiJob);
  renderReview(currentScreened);
}
function renderReview(screened) {
  const allRows = (screened || []).map(normalizeUiJob);
  const matched = allRows.filter(j => j.match === true);
  $('reviewCount').textContent = '显示 ' + allRows.length + ' · 匹配 ' + matched.length;
  let html = '';
  allRows.forEach(j => { html += renderJobItem(j); });
  $('reviewList').innerHTML = html || '<div class="job-sub">无岗位</div>';
  $('reviewCard').style.display = 'block';
}
function normalizeUiJob(j) {
  j = j || {};
  if (!j.poolId) j.poolId = (j.platform || 'boss') + ':' + (j.jobId || j.id || '');
  if (!j.district) j.district = inferDistrictFromText([j.detailLocation, j.workAddress, j.address, j.city, j.location, j.title || j.name, j.jd || j.rawText, j.company].join(' '));
  return j;
}
function normalizedStatus(j) { return (j && j.status) || 'discovered'; }
function formatLocation(j) { return csvLocation(j); }

function inferDistrictFromText(value) {
  const text = (value == null ? '' : String(value)).replace(/\s+/g, '');
  if (!text) return '';
  const districts = [
    ['深汕特别合作区', ['深汕特别合作区', '深汕合作区', '深汕']],
    ['大鹏新区', ['大鹏新区', '大鹏']],
    ['南山区', ['南山区', '南山']], ['福田区', ['福田区', '福田']],
    ['罗湖区', ['罗湖区', '罗湖']], ['宝安区', ['宝安区', '宝安']],
    ['龙岗区', ['龙岗区', '龙岗']], ['龙华区', ['龙华区', '龙华']],
    ['光明区', ['光明区', '光明']], ['坪山区', ['坪山区', '坪山']],
    ['盐田区', ['盐田区', '盐田']]
  ];
  for (const item of districts) {
    if (item[1].some(alias => text.indexOf(alias) >= 0)) return item[0];
  }
  return '';
}
function isPending(j) { return ['', 'discovered', 'scored', 'pending', 'selected'].indexOf(normalizedStatus(j)) >= 0; }
function isViewed(j) { return normalizedStatus(j) === 'viewed' || !!(j && j.viewedAt); }
function isSkipped(j) {
  const status = normalizedStatus(j);
  if (status === 'blocked') return true;
  if (status !== 'skipped') return false;
  return !!(j && (j.skippedAt || j.userSkipped));
}
function isApplied(j) {
  return !!(j && j.applicationAt) || ['applied', 'delivered', 'contacted', 'success', 'sent', 'already_contacted', 'duplicate_in_chat'].indexOf(normalizedStatus(j)) >= 0;
}
function hasRisk(j) { return (Array.isArray(j.riskFlags) && j.riskFlags.length) || (Array.isArray(j.risks) && j.risks.length); }

function renderJobItem(j) {
  const title = j.title || j.name || '未知岗位';
  const id = j.poolId || j.id || j.jobId || '';
  const skipped = isSkipped(j);
  const locked = skipped || isApplied(j) || normalizedStatus(j) === 'needs_review';
  const matched = j.match === true;
  const checked = matched && !locked ? ' checked' : '';
  const disabled = locked ? ' disabled' : '';
  const location = formatLocation(j);
  const district = csvDistrict(j);
  const placeLine = '区域：' + (district || '未识别') + (location ? ' · 地点：' + location : '');
  const matchText = matched ? '是' : '否';
  const reasonClass = matched ? 'm' : 'n';
  const risk = riskText(j);
  const riskHtml = risk ? '<div class="job-risk">风险提示：' + esc(risk) + '</div>' : '';
  const actionHtml = '<div class="job-actions">'
    + (j.url || j.link ? '<button type="button" data-act="openJob">查看</button>' : '')
    + '<button type="button" data-act="skipJob">跳过</button><button type="button" data-act="blockCompany">屏蔽公司</button></div>';
  return '<div class="job-item match-' + (matched ? 'yes' : 'no') + (skipped ? ' skip' : '') + (isViewed(j) ? ' viewed' : '') + '" data-title="' + esc(title) + '" data-company="' + esc(j.company) + '" data-url="' + esc(j.url || j.link || '') + '">'
    + '<input type="checkbox"' + checked + disabled + ' data-id="' + esc(id) + '">'
    + '<div class="job-main"><div class="job-title-row"><span class="job-badge">BOSS</span><span class="job-title">' + esc(title) + '</span></div>'
    + '<div class="job-sub">' + esc(j.company) + ' · ' + esc(j.salary) + (j.sourceKeyword ? ' · 来源：' + esc(j.sourceKeyword) : '') + '</div>'
    + '<div class="job-sub">' + esc(placeLine) + '</div>'
    + '<div class="job-match">匹配：' + esc(matchText) + '</div>'
    + '<div class="job-reason ' + reasonClass + '">匹配理由：' + esc(j.matchReason || j.reason || '') + '</div>'
    + riskHtml + actionHtml + '</div></div>';
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function riskText(j) {
  if (Array.isArray(j.riskFlags) && j.riskFlags.length) return j.riskFlags.join('、');
  if (Array.isArray(j.risks) && j.risks.length) return j.risks.join('、');
  return '';
}
function statusMeta(j) {
  if (normalizedStatus(j) === 'needs_review') return { text: '待人工确认' };
  if (isApplied(j)) return { text: '已投递/已沟通' };
  if (normalizedStatus(j) === 'failed') return { text: '失败' };
  if (isSkipped(j)) return { text: '已跳过' };
  if (isViewed(j)) return { text: '已查看' };
  return { text: '未处理' };
}
function markViewed(item) { markStatus(item, 'viewed', { viewedAt: new Date().toISOString() }); }
function markStatus(item, status, extra) {
  const box = item.querySelector('input[type="checkbox"]');
  const id = box && box.dataset.id;
  if (!id) return;
  currentScreened = currentScreened.map(job => {
    if (job.poolId !== id && job.id !== id && job.jobId !== id) return job;
    return Object.assign({}, job, extra || {}, { status: status });
  });
  chrome.runtime.sendMessage({ type: 'MARK_JOB_STATUS', jobId: id, status: status, patch: extra || {} }, () => {});
  renderReview(currentScreened);
}

// 消息接收
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') addLog(msg.text, msg.level);
  if (msg.type === 'PROGRESS') $('progText').textContent = (msg.label ? msg.label + ' ' : '') + msg.cur + '/' + msg.total;
  if (msg.type === 'PHASE') {
    updatePhase(msg.phase);
    if (msg.phase === 'review' || msg.phase === 'done' || msg.phase === 'idle') setRunning(false);
  }
  if (msg.type === 'SCREENED') setScreened(msg.screened);
  if (msg.type === 'DONE') { setRunning(false); $('progText').textContent = ''; }
});

function updatePhase(phase) {
  const map = { idle: '未开始', collecting: '收集中', screening: '筛选中', review: '待审核', delivering: '投递中', done: '已完成' };
  $('phaseText').textContent = map[phase] || phase;
}

function exportCsv(rows) {
  rows = (rows || []).map(normalizeUiJob);
  if (!rows.length) return addLog('当前岗位池为空，无法导出CSV。', 'warn');
  const headers = ['序号','平台','状态','是否匹配','岗位名称','公司','薪资','城市','区域','详细地点','来源关键词','评分','匹配理由','风险提示','岗位链接','岗位ID','投递/沟通时间','查看时间','入池时间','人工备注','后续状态'];
  const csvRows = [headers].concat(rows.map((j, index) => [
    index + 1, 'BOSS', statusMeta(j).text, matchCsvText(j),
    j.title || j.name || '', j.company || '', j.salary || '',
    csvCity(j), csvDistrict(j) || '未识别', csvLocation(j),
    j.sourceKeyword || '', Number.isFinite(j.score) ? j.score : '',
    j.matchReason || j.reason || '', csvRiskText(j),
    j.url || j.link || '', j.jobId || j.id || '',
    csvApplicationTime(j), formatCsvDate(j.viewedAt), formatCsvDate(j.createdAt), '', ''
  ]));
  const csv = '﻿' + csvRows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = formatFileTimestamp(new Date());
  a.href = url;
  a.download = '海投助手_岗位池_' + ts + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addLog('已导出岗位池CSV：' + rows.length + ' 条', 'success');
}
function matchCsvText(j) {
  if (j.match === true) return '是';
  if (j.match === false) return '否';
  if (Number.isFinite(j.score)) return j.score >= 60 ? '是' : '否';
  return '否';
}
function configuredCity() { return ($('city') && $('city').value || '').trim().split(/[\/、,，\s]+/)[0].replace(/[市省]$/, ''); }
function inferCityFromText(value) {
  const text = value == null ? '' : String(value);
  const m = text.match(/(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州|天津|重庆|长沙|郑州|沈阳|青岛|合肥|厦门|福州|济南|宁波|东莞|无锡|昆明|哈尔滨|长春|大连|石家庄|佛山|惠州|珠海|中山|南宁|南昌|贵阳|海口|太原|兰州|银川|西宁|乌鲁木齐|呼和浩特)/);
  return m ? m[1] : '';
}
function csvCity(j) { return j.city || inferCityFromText(j.detailLocation || j.workAddress || j.address || j.location || '') || configuredCity(); }
function csvDistrict(j) { return j.district || inferDistrictFromText([j.detailLocation, j.workAddress, j.address, j.location, j.city, j.title || j.name, j.jd || j.rawText, j.company].join(' ')); }
function csvLocation(j) { return j.detailLocation || j.workAddress || j.address || j.location || csvCity(j); }
function csvRiskText(j) {
  if (Array.isArray(j.riskFlags) && j.riskFlags.length) return j.riskFlags.join('；');
  if (Array.isArray(j.risks) && j.risks.length) return j.risks.join('；');
  return '';
}
function csvApplicationTime(j) { return formatCsvDate(j.applicationAt || j.appliedAt || j.deliveredAt || j.contactedAt || j.sentAt); }
function formatFileTimestamp(date) { const p = n => String(n).padStart(2, '0'); return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + '_' + p(date.getHours()) + p(date.getMinutes()); }
function formatCsvDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function csvCell(value) { return '"' + csvPlainText(value).replace(/"/g, '""') + '"'; }
function csvPlainText(value) {
  if (value == null) return '';
  const text = String(value);
  if (text === 'undefined' || text === 'null') return '';
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function addLog(text, level) {
  level = level || 'info';
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const el = document.createElement('div');
  el.className = 'log-item ' + level;
  el.innerHTML = '<span class="log-time">[' + t + ']</span>' + esc(text);
  $('log').appendChild(el);
  while ($('log').children.length > MAX_LOG_ITEMS) $('log').removeChild($('log').firstChild);
  $('log').scrollTop = $('log').scrollHeight;
}
