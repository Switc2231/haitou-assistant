// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  const SCRIPT_VERSION = '20260701-stability-v3';
  if (window.__bossToudiSearchVersion === SCRIPT_VERSION) return;
  window.__bossToudiSearch = true;
  window.__bossToudiSearchVersion = SCRIPT_VERSION;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clean = (value) => (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();

  function expectedJobKey(job) {
    job = job || {};
    return clean(job.poolId || job.jobId || job.id || ((job.title || job.name || '') + '|' + (job.company || ''))).toLowerCase();
  }

  function rememberExpectedChat(job) {
    try {
      sessionStorage.setItem('__bossToudiExpectedChatV3', JSON.stringify({
        key: expectedJobKey(job),
        title: clean(job && (job.title || job.name)),
        company: clean(job && job.company),
        createdAt: Date.now(),
        sourceUrl: location.href
      }));
    } catch (e) {}
  }

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const areaEl = card.querySelector('.job-area, .job-location, [class*="job-area"], [class*="job-location"]');
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const id = (m && m[1]) || ((nameEl ? nameEl.textContent.trim() : '') + '|' + (salEl ? salEl.textContent.trim() : ''));
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    let company = '';
    const compEl = card.querySelector('.company-name a, .company-name, [class*="company-name"], .boss-info .company-name, .company-info a, [class*="company"] a');
    if (compEl) company = compEl.textContent.trim();
    const actionText = Array.from(card.querySelectorAll('a, button, span'))
      .map(el => (el.textContent || '').trim())
      .find(tx => tx === '立即沟通' || tx === '继续沟通' || tx === '已沟通') || '';
    return {
      id: id,
      name: nameEl ? nameEl.textContent.trim() : '未知岗位',
      salary: salEl ? salEl.textContent.trim() : '',
      location: areaEl ? clean(areaEl.textContent) : '',
      tags: tags,
      company: company,
      link: link,
      actionText: actionText
    };
  }

  async function scrape(count) {
    const seen = {};
    const jobs = [];
    let stall = 0;
    for (let loop = 0; loop < 40 && jobs.length < count && stall < 4; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        let j = parseCard(c);
        if (j.id && !seen[j.id]) {
          seen[j.id] = 1;
          j = await enrichAddressFromDetail(c, j);
          jobs.push(j);
          added++;
          if (jobs.length >= count) break;
        }
      }
      if (added === 0) stall++; else stall = 0;
      if (jobs.length >= count) break;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await sleep(1200);
    }
    return jobs.slice(0, count);
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    for (const c of cards) { const j = parseCard(c); if (j.name === job.name && (!job.company || j.company === job.company)) return c; }
    return null;
  }

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  function isVisible(el) {
    return !!(el && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed'));
  }

  // 等待出现文字完全匹配的可见元素（用于弹窗"继续沟通"按钮）
  function waitForText(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const els = document.querySelectorAll('a, button, span, div');
        for (const el of els) {
          const tx = (el.textContent || '').trim();
          if (texts.indexOf(tx) >= 0 && el.offsetParent !== null) { clearInterval(iv); resolve(el); return; }
        }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  function findActionButton(root, texts) {
    root = root || document;
    const scope = root.querySelector ? root : document;
    const primary = scope.querySelector(SELECTORS.jobs.immediateChatBtn);
    if (primary && isVisible(primary)) {
      const tx = (primary.textContent || '').trim();
      if (!texts || texts.indexOf(tx) >= 0) return primary;
    }
    const els = scope.querySelectorAll('a, button, span');
    for (const el of els) {
      const tx = (el.textContent || '').trim();
      if ((!texts || texts.indexOf(tx) >= 0) && isVisible(el)) return el;
    }
    return null;
  }

  function safeMouseClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function visibleActionText(root) {
    root = root || document;
    const btn = findActionButton(root, ['立即沟通', '继续沟通', '已沟通']);
    return btn ? (btn.textContent || '').trim() : '';
  }

  function detailRoot() {
    return document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
  }

  function cleanAddress(value) {
    return clean(value)
      .replace(/^工作地址[：:\s]*/i, '')
      .replace(/^(查看地图|地图|导航)[：:\s]*/i, '')
      .replace(/查看地图|地图导航|导航/g, '')
      .trim();
  }

  function extractWorkAddress(root) {
    root = root || detailRoot() || document;
    const text = (root.innerText || root.textContent || '').replace(/\r/g, '\n');
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('工作地址') < 0) continue;
      const inline = cleanAddress(line);
      if (inline && inline !== '工作地址') return inline;
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const candidate = cleanAddress(lines[j]);
        if (candidate && !/^(职位|岗位|公司|立即沟通|继续沟通|已沟通)$/.test(candidate)) return candidate;
      }
    }
    const inlineMatch = text.match(/工作地址[：:\s]*([^\n\r]+)/);
    if (inlineMatch && inlineMatch[1]) return cleanAddress(inlineMatch[1]);
    const addressEl = Array.from(root.querySelectorAll('[class*="address"],[class*="location"],[class*="map"]'))
      .map(el => cleanAddress(el.innerText || el.textContent || ''))
      .find(tx => /深圳|北京|上海|广州|杭州|成都|武汉|西安|南京|苏州/.test(tx) && tx.length >= 4 && tx.length <= 120);
    return addressEl || '';
  }

  async function enrichAddressFromDetail(card, job) {
    try {
      card.scrollIntoView({ block: 'center' });
      await sleep(250);
      safeMouseClick(card.querySelector(SELECTORS.jobs.jobName) || card);
      await sleep(900);
      const det = detailRoot();
      const detailLocation = extractWorkAddress(det || document);
      if (!detailLocation) return job;
      return Object.assign({}, job, {
        detailLocation: detailLocation,
        workAddress: detailLocation,
        address: detailLocation
      });
    } catch (e) {
      return job;
    }
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD
  async function openJD(job) {
    const card = findCardByJob(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
    card.scrollIntoView({ block: 'center' });
    await sleep(400);
    safeMouseClick(card.querySelector(SELECTORS.jobs.jobName) || card);
    await sleep(1600);
    let jd = '';
    const det = detailRoot();
    if (det) jd = (det.innerText || '').trim();
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => (s.innerText || '').trim()).filter(Boolean).join('\n');
    }
    const detailLocation = extractWorkAddress(det || document);
    return {
      success: true,
      jd: jd.slice(0, 1800),
      detailLocation: detailLocation,
      workAddress: detailLocation,
      address: detailLocation,
      actionText: visibleActionText(det || document)
    };
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）
  async function goChat(job) {
    let det = detailRoot();
    let btn = findActionButton(det || document, ['立即沟通', '继续沟通', '已沟通']);
    if (!btn) { // 面板可能关了，重新点卡片
      const card = findCardByJob(job);
      if (card) {
        safeMouseClick(card.querySelector(SELECTORS.jobs.jobName) || card);
        await sleep(1600);
        det = detailRoot();
        btn = findActionButton(det || document, ['立即沟通', '继续沟通', '已沟通']);
      }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    const btnText = (btn.textContent || '').trim();
    if (btnText === '继续沟通' || btnText === '已沟通') {
      return { success: false, alreadyContacted: true, actionText: btnText, error: '页面显示' + btnText + '，跳过避免重复沟通' };
    }
    if (btnText !== '立即沟通') return { success: false, error: '当前详情页按钮不是立即沟通：' + (btnText || '空') };
    rememberExpectedChat(job);
    safeMouseClick(btn);
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { safeMouseClick(go); return { success: true, navigated: true }; }
    if (location.href.indexOf('/web/geek/chat') >= 0) return { success: true, navigated: true };
    return { success: false, error: '点击立即沟通后未出现继续沟通按钮，也未进入聊天页' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20).then(jobs => sendResponse({ success: true, jobs: jobs })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD_V3' || msg.type === 'OPEN_JD' || msg.type === 'OPEN_JD_V2') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT_V3' || msg.type === 'GO_CHAT_V2' || msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
