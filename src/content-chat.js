// ===== 聊天页 content script：打开会话 + 先发图片 + 再发招呼语 =====
(function () {
  const SCRIPT_VERSION = '20260701-image-lock-v6';
  const IMAGE_SEND_LOCK_TTL_MS = 30 * 60 * 1000;
  if (window.__bossToudiChatVersion === SCRIPT_VERSION) return;
  window.__bossToudiChat = true;
  window.__bossToudiChatVersion = SCRIPT_VERSION;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function clean(value) {
    return (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  }

  const FORBIDDEN_OUTGOING_PATTERNS = [
    /api\s*key/i,
    /插件(?:设置|配置|页面)?/i,
    /设置页/i,
    /启用\s*ai.{0,20}配置/i,
    /请先.{0,24}(?:填写|配置).{0,24}(?:简历|api)/i,
    /系统将根据.{0,30}(?:简历|个人经历|生成)/i,
    /专属招呼语/i
  ];

  function validateOutgoingText(value) {
    const text = clean(value);
    if (!text) return { ok: false, error: '没有可发送的招呼语' };
    return FORBIDDEN_OUTGOING_PATTERNS.some(pattern => pattern.test(text))
      ? { ok: false, error: '安全拦截：话术包含插件/API配置等系统提示，禁止发送' }
      : { ok: true };
  }

  function expectedJobKey(job) {
    job = job || {};
    return clean(job.poolId || job.jobId || job.id || ((job.title || job.name || '') + '|' + (job.company || ''))).toLowerCase();
  }

  function activeConversationContext() {
    const selectors = [
      '.user-list-content li.active', '.user-list-content li.selected',
      '.user-list-content li[class*="active"]', '.user-list-content li[class*="selected"]',
      '.chat-header', '[class*="chat-header"]', '.conversation-title', '[class*="conversation-title"]'
    ];
    const seen = {};
    const parts = [];
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const text = clean(el.innerText || el.textContent || '');
        if (text && !seen[text]) { seen[text] = true; parts.push(text); }
      });
    });
    return parts.join(' | ').slice(0, 500);
  }

  function verifyExpectedChat(job) {
    if (location.href.indexOf('/web/geek/chat') < 0) return { ok: false, error: '当前页面不是BOSS聊天页' };
    let expected = null;
    try { expected = JSON.parse(sessionStorage.getItem('__bossToudiExpectedChatV3') || 'null'); } catch (e) {}
    if (!expected || !expected.key) return { ok: false, error: '缺少本次建联校验信息，拒绝向未确认会话发送' };
    if (!expected.createdAt || Date.now() - expected.createdAt > 90000) return { ok: false, error: '本次建联校验已过期，拒绝发送' };
    const key = expectedJobKey(job);
    if (!key || key !== expected.key) return { ok: false, error: '当前会话与待投岗位校验不一致，拒绝发送' };
    const context = activeConversationContext();
    const contextNorm = normText(context);
    const titleNorm = normText(job && (job.title || job.name));
    const companyNorm = normText(job && job.company);
    const visibleMatch = !!((titleNorm && contextNorm.indexOf(titleNorm) >= 0) || (companyNorm && contextNorm.indexOf(companyNorm) >= 0));
    return { ok: true, proof: visibleMatch ? 'job-token+visible-context' : 'job-token', context: context };
  }

  function clearExpectedChat() {
    try { sessionStorage.removeItem('__bossToudiExpectedChatV3'); } catch (e) {}
  }

  function claimImageSend(job) {
    const jobKey = expectedJobKey(job);
    if (!jobKey) return { ok: false, error: '缺少岗位标识，拒绝发送简历图片' };
    const storageKey = '__bossToudiImageSendLockV6:' + jobKey;
    let existing = null;
    try { existing = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (e) {}
    if (existing && existing.at && Date.now() - existing.at < IMAGE_SEND_LOCK_TTL_MS) {
      return { ok: false, duplicate: true, error: '同一岗位的简历图片刚刚已经发送或正在发送，已阻止重复上传' };
    }
    const token = Date.now() + ':' + Math.random().toString(36).slice(2);
    try { sessionStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), token: token })); }
    catch (e) { return { ok: false, error: '无法建立图片发送锁，已拒绝发送' }; }
    return { ok: true, storageKey: storageKey, token: token };
  }

  function releaseImageSendClaim(claim) {
    if (!claim || !claim.storageKey) return;
    try {
      const current = JSON.parse(sessionStorage.getItem(claim.storageKey) || 'null');
      if (current && current.token === claim.token) sessionStorage.removeItem(claim.storageKey);
    } catch (e) {}
  }

  // 多选择器找第一个可见元素
  function findVisible(selList) {
    for (const sel of selList) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed')) return el;
      }
    }
    return null;
  }
  async function waitVisible(selList, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = findVisible(selList);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  const INPUT_SELS = ['div#chat-input', '#chat-input', 'div.chat-input', '.chat-input[contenteditable]', '[contenteditable="true"]', 'textarea.input-area', '.chat-editor textarea', 'textarea[placeholder]', 'textarea'];
  const SEND_SELS = ['button.btn-send', '.btn-send', 'button[class*="send"]', '[class*="send-btn"]'];
  const IMG_SELS = ['.btn-sendimg input[type=file]', '.toolbar input[type=file]', 'input[type=file]'];
  const OWN_MESSAGE_SELS = [SELECTORS.chat.messageSent, '.item-myself', '[class*="item-myself"]'];

  function normText(s) {
    return (s || '').replace(/\s+/g, '').replace(/[，。,.！!？?；;：:]/g, '').toLowerCase();
  }

  function ownMessages() {
    return Array.from(document.querySelectorAll(OWN_MESSAGE_SELS.join(',')))
      .filter(el => !el.isContentEditable && !el.closest('[contenteditable="true"], textarea, input'))
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(Boolean);
  }

  function hasExactOwnMessage(text) {
    const target = normText(text);
    if (!target) return false;
    return ownMessages().some(msg => {
      const current = normText(msg);
      return current === target || current.indexOf(target) >= 0;
    });
  }

  // 诊断：把页面里可编辑元素结构dump成字符串（找不到输入框时回传，便于定位）
  function dumpInputs() {
    const out = [];
    document.querySelectorAll('[contenteditable="true"], textarea, div[id*="input"], div[class*="input"]').forEach((el, i) => {
      if (i < 8) out.push(el.tagName + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className.slice(0, 40) : ''));
    });
    return out.join(' | ') || '无可编辑元素';
  }

  function dataURLtoFile(dataUrl, name) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'resume.png', { type: mime });
  }

  async function openConversation(company, hrName, position) {
    await waitVisible([SELECTORS.chat.userList], 8000);
    const items = Array.from(document.querySelectorAll(SELECTORS.chat.userList));
    if (!items.length) return { ok: false, err: '会话列表为空' };
    let target = null;
    const ck = (company || '').replace(/\s/g, '');
    const hk = (hrName || '').replace(/\s/g, '');
    const pk = (position || '').replace(/\s/g, '');
    for (const li of items) {
      const tx = (li.textContent || '').replace(/\s/g, '');
      if (ck && tx.indexOf(ck) >= 0) { target = li; break; }
      if (pk && tx.indexOf(pk) >= 0) { target = li; break; }
      if (hk && tx.indexOf(hk) >= 0) { target = li; break; }
    }
    if (!target) target = items[0]; // 兜底：最新一条（刚建联的通常在顶部）
    target.click();
    await sleep(1600);
    return { ok: true };
  }

  function ownImageCount() {
    const ownEls = document.querySelectorAll(OWN_MESSAGE_SELS.join(','));
    let count = 0;
    ownEls.forEach(el => {
      if (el.querySelector('img') || el.querySelector('[class*="file"]') || el.querySelector('[class*="image"]')) count++;
    });
    return count;
  }

  async function hasExistingOwnImage() {
    for (let i = 0; i < 4; i++) {
      if (ownImageCount() > 0) return true;
      await sleep(250);
    }
    return ownImageCount() > 0;
  }

  async function sendImage(image) {
    if (!image) return true;
    const input = findVisible(IMG_SELS) || document.querySelector('input[type=file]');
    if (!input) return false;
    const beforeCount = ownImageCount();
    const file = dataURLtoFile(image, 'resume.png');
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files').set;
    setter.call(input, dt.files);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (ownImageCount() > beforeCount) return true;
    }
    return false;
  }

  function inputText(el) { return (el.isContentEditable || el.getAttribute('contenteditable') === 'true') ? (el.textContent || '') : (el.value || ''); }

  function pressEnter(el) {
    const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opt));
    el.dispatchEvent(new KeyboardEvent('keypress', opt));
    el.dispatchEvent(new KeyboardEvent('keyup', opt));
  }

  async function sendText(greeting) {
    const outgoingCheck = validateOutgoingText(greeting);
    if (!outgoingCheck.ok) return { ok: false, blocked: true, err: outgoingCheck.error };
    if (hasExactOwnMessage(greeting)) return { ok: false, duplicate: true, err: '聊天中已存在完全相同话术，已跳过' };
    const input = await waitVisible(INPUT_SELS, 8000);
    if (!input) return { ok: false, err: '未找到输入框｜页面候选：' + dumpInputs() };
    input.focus();
    await sleep(300);
    const editable = input.isContentEditable || input.getAttribute('contenteditable') === 'true';
    if (editable) {
      input.textContent = greeting;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: greeting }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, greeting);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(700);
    if (!inputText(input).trim()) return { ok: false, err: '文字未填入输入框' };

    const before = ownMessages().length;
    // 以回车为主发送；只有看到自己的招呼语气泡才算成功。
    pressEnter(input);

    for (let i = 0; i < 24; i++) {
      await sleep(300);
      const after = ownMessages().length;
      if (after > before && hasExactOwnMessage(greeting)) return { ok: true, verified: true, before: before, after: after };
      if (i === 4 && inputText(input).trim()) {
        const btn = findVisible(SEND_SELS);
        if (btn && !btn.classList.contains('disabled') && !btn.disabled) btn.click();
      }
    }
    const after = ownMessages().length;
    const inputState = inputText(input).trim() ? '输入框仍有文字' : '输入框已清空';
    const bubbleState = after > before ? '看到新气泡但未匹配招呼语' : '未看到新增自己消息';
    return { ok: false, err: '发送未确认（' + inputState + '，' + bubbleState + '）' };
  }

  async function doSend(msg) {
    const hasGreeting = !!clean(msg.greeting);
    if (!msg.image && !hasGreeting) return { success: false, blocked: true, error: '没有简历图片或可发送的自我介绍' };
    if (hasGreeting) {
      const outgoingCheck = validateOutgoingText(msg.greeting);
      if (!outgoingCheck.ok) return { success: false, blocked: true, error: outgoingCheck.error };
    }
    const oc = await openConversation(msg.company, msg.hrName, msg.position);
    if (!oc.ok) return { success: false, error: oc.err };
    const imageJob = msg.job || { poolId: msg.poolId, jobId: msg.jobId, title: msg.position, company: msg.company };
    let imageClaim = null;
    if (msg.image) {
      if (await hasExistingOwnImage()) return { success: false, duplicateImage: true, error: '当前会话已经存在自己发送的图片，已跳过再次上传简历' };
      imageClaim = claimImageSend(imageJob);
      if (!imageClaim.ok) return { success: false, duplicateImage: imageClaim.duplicate === true, error: imageClaim.error };
    }
    let imgOk = false;
    try { imgOk = await sendImage(msg.image); }
    catch (e) { releaseImageSendClaim(imageClaim); throw e; }
    if (msg.image && !imgOk) { releaseImageSendClaim(imageClaim); return { success: false, error: '未找到简历上传入口' }; }
    const imageSent = !!(msg.image && imgOk);
    if (!hasGreeting) return { success: true, verified: imageSent, imageOnly: true, imageSent: imageSent, proof: 'own-image-count-increased' };
    await sleep(800);
    let tr;
    try { tr = await sendText(msg.greeting); }
    catch (e) { return { success: false, imageSent: imageSent, error: e.message }; }
    if (!tr.ok) return { success: false, duplicate: tr.duplicate === true, imageSent: imageSent, error: tr.err };
    return { success: true, imageOk: imgOk, imageSent: imageSent, verified: tr.verified === true, proof: 'own-message matched', before: tr.before, after: tr.after };
  }

  // 只向本次从岗位详情页建立、且岗位令牌一致的会话发送。
  async function sendActive(image, greeting, job) {
    const hasGreeting = !!clean(greeting);
    if (!image && !hasGreeting) return { success: false, blocked: true, error: '没有简历图片或可发送的自我介绍' };
    if (hasGreeting) {
      const outgoingCheck = validateOutgoingText(greeting);
      if (!outgoingCheck.ok) return { success: false, blocked: true, error: outgoingCheck.error };
    }
    const chatCheck = verifyExpectedChat(job);
    if (!chatCheck.ok) return { success: false, error: chatCheck.error };
    if (hasGreeting && hasExactOwnMessage(greeting)) { clearExpectedChat(); return { success: false, duplicate: true, error: '聊天中已存在完全相同话术，跳过避免重复发送' }; }
    let imageClaim = null;
    if (image) {
      if (await hasExistingOwnImage()) {
        clearExpectedChat();
        return { success: false, duplicateImage: true, error: '当前会话已经存在自己发送的图片，已跳过再次上传简历' };
      }
      imageClaim = claimImageSend(job);
      if (!imageClaim.ok) {
        clearExpectedChat();
        return { success: false, duplicateImage: imageClaim.duplicate === true, error: imageClaim.error };
      }
    }
    let imgOk = false;
    try { imgOk = await sendImage(image); }
    catch (e) { releaseImageSendClaim(imageClaim); clearExpectedChat(); throw e; }
    if (image && !imgOk) { releaseImageSendClaim(imageClaim); return { success: false, error: '未找到简历上传入口' }; }
    const imageSent = !!(image && imgOk);
    if (!hasGreeting) {
      clearExpectedChat();
      return { success: true, verified: imageSent, imageOnly: true, imageSent: imageSent, proof: chatCheck.proof + '+own-image-count-increased' };
    }
    let input = await waitVisible(INPUT_SELS, 6000);
    if (!input) {
      const items = document.querySelectorAll(SELECTORS.chat.userList);
      if (items[0]) { items[0].click(); await sleep(1500); }
      input = await waitVisible(INPUT_SELS, 6000);
    }
    if (!input) { clearExpectedChat(); return { success: false, imageSent: imageSent, error: '未找到输入框｜' + dumpInputs() }; }
    await sleep(800);
    let tr;
    try { tr = await sendText(greeting); }
    catch (e) { clearExpectedChat(); return { success: false, imageSent: imageSent, error: e.message }; }
    clearExpectedChat();
    if (!tr.ok) return { success: false, duplicate: tr.duplicate === true, imageSent: imageSent, error: tr.err };
    return { success: true, imageOk: imgOk, imageSent: imageSent, verified: tr.verified === true, proof: chatCheck.proof + '+own-message', before: tr.before, after: tr.after };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SEND') {
      doSend(msg).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SEND_ACTIVE_V6' || msg.type === 'SEND_ACTIVE_V5' || msg.type === 'SEND_ACTIVE_V4' || msg.type === 'SEND_ACTIVE_V3' || msg.type === 'SEND_ACTIVE_V2' || msg.type === 'SEND_ACTIVE') {
      sendActive(msg.image, msg.greeting, msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
