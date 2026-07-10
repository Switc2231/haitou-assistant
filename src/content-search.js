// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  const SCRIPT_VERSION = '20260702-standalone-detail-v6';
  if (window.__bossToudiSearchVersion === SCRIPT_VERSION) return;
  window.__bossToudiSearch = true;
  window.__bossToudiSearchVersion = SCRIPT_VERSION;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clean = (value) => (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();

  function validCityCode(value) {
    const code = clean(value);
    return /^(?:100010000|101\d{6})$/.test(code) ? code : '';
  }

  function currentCityCode() {
    try {
      const fromUrl = validCityCode(new URL(location.href).searchParams.get('city'));
      if (fromUrl) return { code: fromUrl, source: 'url' };
    } catch (e) {}
    const selectors = [
      'input[name="city"]',
      'input[name="cityCode"]',
      'input[name*="city" i]',
      '[data-city-code]',
      '[data-city]'
    ];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const values = [
          node.value,
          node.getAttribute && node.getAttribute('value'),
          node.getAttribute && node.getAttribute('data-city-code'),
          node.getAttribute && node.getAttribute('data-city')
        ];
        for (const value of values) {
          const code = validCityCode(value);
          if (code) return { code: code, source: 'dom' };
        }
      }
    }
    const hidden = document.querySelectorAll('input[type="hidden"]');
    for (const node of hidden) {
      const code = validCityCode(node.value || node.getAttribute('value'));
      if (code) return { code: code, source: 'dom-hidden' };
    }
    return { code: '', source: '' };
  }

  function currentCityName() {
    const selectors = [
      '[data-city-name]',
      '.city-label',
      '.city-name',
      '.nav-city',
      '.search-city',
      '[class*="city-switch"]',
      '[class*="city-select"]'
    ];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const value = clean((node.getAttribute && node.getAttribute('data-city-name')) || node.textContent || '');
        if (value && value.length <= 12 && /[\u4e00-\u9fff]/.test(value)) return value.replace(/当前城市|切换城市|城市/g, '').trim();
      }
    }
    return '';
  }

  function readCurrentCity() {
    const code = currentCityCode();
    return { success: !!code.code, code: code.code, name: currentCityName(), source: code.source, url: location.href };
  }

  function isStandaloneJobDetailPage() {
    return /^\/job_detail\//.test(location.pathname || '');
  }

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
        const j = parseCard(c);
        if (j.id && !seen[j.id]) {
          seen[j.id] = 1;
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

  // 等待弹窗或详情区出现可点击的目标操作（用于“继续沟通”）
  function waitForText(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = findActionButton(document, texts);
        if (el) { clearInterval(iv); resolve(el); return; }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  const CHAT_ACTION_TEXTS = ['立即沟通', '继续沟通', '已沟通'];
  const CHAT_BUTTON_SELECTOR = '.job-detail-op .op-btn-chat, .op-btn.op-btn-chat, .op-btn-chat, .start-chat-btn';
  const CLICKABLE_SELECTOR = 'a, button, [role="button"], .op-btn-chat, .start-chat-btn';

  function actionLabel(el) {
    if (!el) return '';
    return clean(
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) ||
      el.innerText || el.textContent || el.value || ''
    );
  }

  function matchesActionText(label, texts) {
    const wanted = texts || CHAT_ACTION_TEXTS;
    return wanted.some(text => label === text || (label.indexOf(text) >= 0 && label.length <= 24));
  }

  function isDisabledControl(el) {
    if (!el) return true;
    const cls = clean(el.className || '').toLowerCase();
    return !!(
      el.disabled ||
      (el.getAttribute && el.getAttribute('aria-disabled') === 'true') ||
      /(?:^|\s)(?:disabled|is-disabled|btn-disable-chat)(?:\s|$)/.test(cls)
    );
  }

  function clickableControl(el) {
    if (!el) return null;
    if (el.matches && el.matches(CLICKABLE_SELECTOR)) return el;
    return el.closest ? el.closest(CLICKABLE_SELECTOR) : null;
  }

  function findActionButton(root, texts, includeDisabled) {
    const scope = root && root.querySelectorAll ? root : null;
    if (!scope) return null;
    const selectors = [CHAT_BUTTON_SELECTOR, 'a, button, [role="button"], span, div[class*="btn"]'];
    const seen = new Set();
    for (const selector of selectors) {
      const els = scope.querySelectorAll(selector);
      for (const el of els) {
        const control = clickableControl(el);
        if (!control || seen.has(control) || !isVisible(control)) continue;
        seen.add(control);
        const label = actionLabel(control);
        if (!matchesActionText(label, texts)) continue;
        if (!includeDisabled && isDisabledControl(control)) continue;
        return control;
      }
    }
    return null;
  }

  function waitForActionButton(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const root = detailRoot();
        const btn = root ? findActionButton(root, texts) : null;
        if (btn) { clearInterval(iv); resolve(btn); return; }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
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
    const btn = root ? findActionButton(root, CHAT_ACTION_TEXTS, true) : null;
    return btn ? actionLabel(btn) : '';
  }

  function detailRoot() {
    if (isStandaloneJobDetailPage()) return document.body;
    const preferred = Array.from(document.querySelectorAll(
      '.user-center-job-detail-box, .job-detail-box, .job-detail-container, .detail-content, .job-detail'
    )).filter(isVisible);
    return preferred.find(el => el.querySelector && el.querySelector(CHAT_BUTTON_SELECTOR)) || preferred[0] || null;
  }

  function extractJDText(root) {
    root = root || document;
    const selectors = [
      '.job-sec-text',
      '.job-detail-section',
      '.job-description',
      '[class*="job-desc"]',
      '[class*="job-sec"]'
    ];
    const parts = [];
    const seen = new Set();
    for (const selector of selectors) {
      const nodes = root.querySelectorAll(selector);
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').trim();
        if (text.length < 20 || seen.has(text)) continue;
        seen.add(text);
        parts.push(text);
      }
      if (parts.length) break;
    }
    if (parts.length) return parts.join('\n');
    if (!isStandaloneJobDetailPage()) return '';
    const pageText = (document.body.innerText || document.body.textContent || '').replace(/\r/g, '\n');
    const start = pageText.indexOf('职位描述');
    if (start < 0) return '';
    const tail = pageText.slice(start + 4);
    const endMatch = tail.search(/\n(?:公司基本信息|工商信息|相似职位|相关推荐)\s*\n/);
    return (endMatch >= 0 ? tail.slice(0, endMatch) : tail).trim();
  }

  function pageBlockReason() {
    const nodes = document.querySelectorAll(
      '[class*="captcha"], [class*="verify"], [class*="security-check"], iframe[src*="captcha"], iframe[src*="verify"]'
    );
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const label = actionLabel(node);
      if (!label || /验证|安全检查|访问过于频繁|滑块/.test(label) || node.tagName === 'IFRAME') {
        return label && label.length <= 40 ? label : '页面出现验证或安全检查';
      }
    }
    return '';
  }

  function actionDiagnostics(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const labels = [];
    const nodes = scope.querySelectorAll('a, button, [role="button"], [class*="btn"]');
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const label = actionLabel(node);
      if (!label || label.length > 30 || labels.indexOf(label) >= 0) continue;
      if (/沟通|联系|应聘|投递|登录|验证/.test(label)) labels.push(label);
      if (labels.length >= 6) break;
    }
    return labels.length ? labels.join('、') : '无相关可见操作';
  }

  function cleanAddress(value) {
    return clean(value)
      .replace(/^工作地址[：:\s]*/i, '')
      .replace(/^(查看地图|地图|导航)[：:\s]*/i, '')
      .replace(/查看地图|地图导航|导航/g, '')
      .trim();
  }

  function extractVisibleLocationLine(root) {
    root = root || detailRoot() || document;
    const cityPattern = /(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州|天津|重庆|长沙|郑州|沈阳|青岛|合肥|厦门|福州|济南|宁波|东莞|无锡|昆明|哈尔滨|长春|大连|石家庄|佛山|惠州|珠海|中山|南宁|南昌|贵阳|海口|太原|兰州|银川|西宁|乌鲁木齐|呼和浩特)/;
    const selectors = [
      '.job-primary .info-primary',
      '.job-primary',
      '.job-banner',
      '.job-detail-header',
      '.job-detail-box',
      '[class*="job-primary"]',
      '[class*="job-banner"]',
      '[class*="location"]',
      '[class*="area"]'
    ];
    for (const selector of selectors) {
      const nodes = root.querySelectorAll(selector);
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = clean(node.innerText || node.textContent || '');
        if (cityPattern.test(text) && text.length <= 160) return text;
      }
    }
    const text = (root.innerText || root.textContent || '').replace(/\r/g, '\n');
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    return lines.find(line => cityPattern.test(line) && line.length <= 80) || '';
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
    return addressEl || extractVisibleLocationLine(root) || '';
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
    if (!isStandaloneJobDetailPage()) {
      const card = findCardByJob(job);
      if (!card) return { success: false, error: '未找到岗位卡片' };
      card.scrollIntoView({ block: 'center' });
      await sleep(400);
      safeMouseClick(card.querySelector(SELECTORS.jobs.jobName) || card);
      await sleep(1600);
    }
    const det = detailRoot();
    const jd = extractJDText(det || document);
    const detailLocation = extractWorkAddress(det || document);
    const actionText = visibleActionText(det);
    if (!det || (!jd && !actionText)) {
      return {
        success: false,
        error: '岗位详情页未就绪（页面：' + location.pathname + '；JD：' + (jd ? '已读取' : '未读取') + '；沟通按钮：' + (actionText || '未识别') + '）'
      };
    }
    return {
      success: true,
      jd: jd.slice(0, 1800),
      detailLocation: detailLocation,
      workAddress: detailLocation,
      address: detailLocation,
      actionText: actionText,
      detailUrl: location.href,
      standaloneDetail: isStandaloneJobDetailPage()
    };
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）
  async function goChat(job) {
    let det = detailRoot();
    let btn = det ? findActionButton(det, CHAT_ACTION_TEXTS) : null;
    if (!btn) { // 面板可能关了，重新点卡片
      const card = findCardByJob(job);
      if (card) {
        card.scrollIntoView({ block: 'center' });
        safeMouseClick(card.querySelector(SELECTORS.jobs.jobName) || card);
        btn = await waitForActionButton(CHAT_ACTION_TEXTS, 5000);
        det = detailRoot();
      }
    }
    if (!btn) {
      const blocked = pageBlockReason();
      if (blocked) return { success: false, blocked: true, error: '页面需要人工处理：' + blocked };
      const disabled = det ? findActionButton(det, CHAT_ACTION_TEXTS, true) : null;
      if (disabled && isDisabledControl(disabled)) {
        return { success: false, blocked: true, error: '沟通按钮当前不可用：' + actionLabel(disabled) };
      }
      return {
        success: false,
        error: '未找到立即沟通按钮（详情面板：' + (det ? '已找到' : '未找到') + '；可见操作：' + actionDiagnostics(det || document) + '）'
      };
    }
    const btnText = actionLabel(btn);
    if (btnText.indexOf('继续沟通') >= 0 || btnText.indexOf('已沟通') >= 0) {
      const stateText = btnText.indexOf('已沟通') >= 0 ? '已沟通' : '继续沟通';
      return { success: false, alreadyContacted: true, actionText: stateText, error: '页面显示' + stateText + '，跳过避免重复沟通' };
    }
    if (btnText.indexOf('立即沟通') < 0) return { success: false, error: '当前详情页按钮不是立即沟通：' + (btnText || '空') };
    rememberExpectedChat(job);
    safeMouseClick(btn);
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { safeMouseClick(go); return { success: true, navigated: true }; }
    if (location.href.indexOf('/web/geek/chat') >= 0) return { success: true, navigated: true };
    const blocked = pageBlockReason();
    if (blocked) return { success: false, blocked: true, error: '点击立即沟通后需要人工处理：' + blocked };
    return { success: false, error: '点击立即沟通后未出现继续沟通按钮，也未进入聊天页' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_CURRENT_CITY_V1') {
      sendResponse(readCurrentCity());
      return;
    }
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20).then(jobs => sendResponse({ success: true, jobs: jobs })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD_V4') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT_V4') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
