const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = new Map();
let listener = null;
let sentImageCount = 0;
class MockHTMLInputElement {}
Object.defineProperty(MockHTMLInputElement.prototype, 'files', {
  configurable: true,
  set(value) { this._files = value; },
  get() { return this._files || []; }
});
const fileInput = new MockHTMLInputElement();
fileInput.offsetParent = {};
fileInput.dispatchEvent = event => { if (event && event.type === 'change') sentImageCount++; };
const ownImageMessage = { querySelector: () => (sentImageCount ? {} : null) };
const context = {
  console,
  setTimeout,
  clearTimeout,
  window: { HTMLInputElement: MockHTMLInputElement },
  location: { href: 'https://www.zhipin.com/web/geek/chat' },
  sessionStorage: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  },
  document: {
    querySelectorAll: selector => {
      if (selector.includes('chat-header') || selector.includes('conversation-title')) return [{ innerText: '行政文员 · 甲公司' }];
      if (selector.includes('input[type=file]')) return [fileInput];
      if (selector.includes('item-myself')) return sentImageCount ? [ownImageMessage] : [];
      return [];
    },
    querySelector: selector => selector === 'input[type=file]' ? fileInput : null
  },
  atob,
  Uint8Array,
  File: class MockFile { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options && options.type; } },
  DataTransfer: class MockDataTransfer {
    constructor() {
      this.files = [];
      this.items = { add: file => this.files.push(file) };
    }
  },
  Event: class MockEvent { constructor(type) { this.type = type; } },
  getComputedStyle: () => ({ position: 'static' }),
  SELECTORS: {
    chat: { messageSent: '.item-myself', userList: '.user-list-content li' }
  },
  chrome: {
    runtime: {
      onMessage: { addListener: fn => { listener = fn; } }
    }
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content-chat.js'), 'utf8'), context);
assert.strictEqual(typeof listener, 'function', '聊天脚本应注册消息监听器');

function send(message) {
  return new Promise((resolve, reject) => {
    const keepAlive = listener(message, {}, resolve);
    assert.strictEqual(keepAlive, true, '异步消息应保持响应通道');
    setTimeout(() => reject(new Error('chat guard response timeout')), 3000);
  });
}

(async () => {
  const jobA = { poolId: 'boss:job-a', jobId: 'job-a', title: '行政文员', company: '甲公司' };
  const noToken = await send({ type: 'SEND_ACTIVE_V3', image: '', greeting: '测试', job: jobA });
  assert.strictEqual(noToken.success, false, '缺少建联令牌时必须拒绝发送');
  assert.match(noToken.error, /缺少本次建联校验信息/);

  store.set('__bossToudiExpectedChatV3', JSON.stringify({
    key: 'boss:job-a', title: '行政文员', company: '甲公司', createdAt: Date.now()
  }));
  const mismatch = await send({
    type: 'SEND_ACTIVE_V3', image: '', greeting: '测试',
    job: { poolId: 'boss:job-b', jobId: 'job-b', title: '运营助理', company: '乙公司' }
  });
  assert.strictEqual(mismatch.success, false, '岗位令牌不一致时必须拒绝发送');
  assert.match(mismatch.error, /校验不一致/);

  const dangerous = '您好，我对这个岗位很感兴趣。请先在插件设置页填写您的简历文字（或启用AI并配置API Key），系统将根据您的个人经历生成专属招呼语。';
  const forbidden = await send({ type: 'SEND_ACTIVE_V6', image: '', greeting: dangerous, job: jobA });
  assert.strictEqual(forbidden.success, false, '包含API/插件设置提示的话术必须拒绝发送');
  assert.strictEqual(forbidden.blocked, true, '系统提示拦截应返回明确blocked标记');
  assert.match(forbidden.error, /安全拦截/);

  store.set('__bossToudiExpectedChatV3', JSON.stringify({
    key: 'boss:job-a', title: '行政文员', company: '甲公司', createdAt: Date.now()
  }));
  const imageOnly = await send({
    type: 'SEND_ACTIVE_V6', image: 'data:image/png;base64,AA==', greeting: '', job: jobA
  });
  assert.strictEqual(imageOnly.success, true, '无AI文字时应允许只发送已上传的简历图片');
  assert.strictEqual(imageOnly.imageOnly, true, '图片单发结果应明确标记imageOnly');
  assert.strictEqual(imageOnly.verified, true, '图片数量增加后才可确认图片单发成功');

  store.set('__bossToudiExpectedChatV3', JSON.stringify({
    key: 'boss:job-a', title: '行政文员', company: '甲公司', createdAt: Date.now()
  }));
  const duplicateImage = await send({
    type: 'SEND_ACTIVE_V6', image: 'data:image/png;base64,AA==', greeting: '', job: jobA
  });
  assert.strictEqual(duplicateImage.success, false, '同一岗位第二次图片调用必须被拒绝');
  assert.strictEqual(duplicateImage.duplicateImage, true, '重复图片拒绝应返回明确duplicateImage标记');
  assert.strictEqual(sentImageCount, 1, '重复调用不能再次触发文件上传change事件');

  console.log('chat-guard-smoke: all assertions passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
