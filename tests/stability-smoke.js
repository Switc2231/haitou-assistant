const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
require(path.join(rootDir, 'src/core/normalizeJob.js'));
require(path.join(rootDir, 'src/core/jobPool.js'));
require(path.join(rootDir, 'src/core/scoring.js'));

const core = globalThis.JobCopilotCore;

function score(raw, priorityWords, excludeWords) {
  const job = core.normalizeJob(raw, 'boss');
  return core.scoring.scoreByWords(job, priorityWords, excludeWords);
}

const directMatch = score({ name: '园区保安', sourceKeyword: '保安' }, ['保安'], []);
assert.strictEqual(directMatch.match, true, '一个真实目标词命中应进入推荐');
assert.ok(directMatch.score >= 60, '一个真实目标词命中应达到阈值');
const anotherProfession = score({ name: '内容运营', sourceKeyword: '内容运营' }, ['内容运营'], []);
assert.strictEqual(anotherProfession.score, directMatch.score, '不同职业命中同等数量目标词时不应有职业加分差异');

const sourceOnly = score({ name: '招商主管', sourceKeyword: '保安' }, ['保安'], []);
assert.strictEqual(sourceOnly.match, false, '来源关键词不能伪造岗位内容命中');
assert.deepStrictEqual(sourceOnly.evidence, [], '来源关键词不应成为评分证据');

const excluded = score({ name: '保安兼电话销售', sourceKeyword: '保安' }, ['保安'], ['电话销售']);
assert.strictEqual(excluded.match, false, '排除词必须覆盖加分词');
assert.ok(excluded.riskFlags.includes('电话销售'), '排除原因应保留给审核页');

const reviewJob = core.normalizeJob({ name: '行政文员', status: 'needs_review' }, 'boss');
assert.strictEqual(reviewJob.status, 'needs_review', '图片部分成功状态必须可持久化');
const rescoredReviewJob = core.scoring.applyScreenResult(reviewJob, { match: true, score: 80, reason: '测试' });
assert.strictEqual(rescoredReviewJob.status, 'needs_review', '重新评分不能清除待人工确认状态');

const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.version, '0.4.7', '图片防重测试版版本号应为 0.4.7');

const background = fs.readFileSync(path.join(rootDir, 'src/background.js'), 'utf8');
const search = fs.readFileSync(path.join(rootDir, 'src/content-search.js'), 'utf8');
const chat = fs.readFileSync(path.join(rootDir, 'src/content-chat.js'), 'utf8');
assert.ok(!/const\s+PRIORITY_WORDS\s*=/.test(background), '后台不应保留固定职业优先词数组');
assert.ok(!/const\s+EXCLUDE_WORDS\s*=/.test(background), '后台不应保留固定职业排除词数组');
assert.ok(background.includes('GO_CHAT_V3') && search.includes('GO_CHAT_V3'), '聊天导航应使用 V3 消息隔离旧脚本');
assert.ok(background.includes('SEND_ACTIVE_V6') && chat.includes('SEND_ACTIVE_V6'), '聊天发送应使用 V6 消息隔离旧脚本');
assert.ok(chat.includes('__bossToudiExpectedChatV3'), '聊天发送必须校验本次岗位建联令牌');
assert.ok(!/const\s+FALLBACK_GREETING\s*=/.test(background), '后台不能保留自动外发的兜底招呼语');
assert.ok(background.includes('validateOutgoingGreeting'), '后台必须在建联前校验外发话术');
assert.ok(chat.includes('validateOutgoingText'), '聊天页必须在填写输入框前再次校验外发话术');
assert.ok(chat.includes('claimImageSend'), '聊天页必须在上传前占用岗位图片发送锁');
assert.ok(chat.includes('__bossToudiImageSendLockV6:'), '图片发送锁必须使用V6独立命名空间');
assert.ok(chat.includes('hasExistingOwnImage'), '上传前必须检查当前会话是否已经存在自己发送的图片');
assert.ok(!background.includes('把HR当成不懂AI的人'), 'AI自我介绍提示不能预设AI岗位场景');
assert.ok(!background.includes('省掉哪些重复工作'), 'AI自我介绍提示不能强行套用AI提效表达');
const sidepanel = fs.readFileSync(path.join(rootDir, 'src/sidepanel.js'), 'utf8');
assert.ok(sidepanel.includes("const DEFAULT_KEYWORDS = '';"), '新用户不能预置某一职业方向');
assert.ok(sidepanel.includes("const DEFAULT_EXCLUDE_WORDS = '';"), '新用户不能预置某一职业排除规则');
assert.ok(sidepanel.includes("const DEFAULT_NO_AI_GREETING = '';"), '无AI自我介绍只能由用户主动填写，不能默认写入');
const sidepanelHtml = fs.readFileSync(path.join(rootDir, 'src/sidepanel.html'), 'utf8');
assert.ok(sidepanelHtml.includes('参考写法：您好，我叫【姓名】'), '侧栏应只用placeholder展示参考写法');
assert.ok(background.includes('/【[^】]+】/'), '后台必须拒绝仍含占位符的无AI自我介绍');
assert.ok(sidepanel.includes("$('city').value = '';"), '公开版新用户不应默认绑定深圳');
assert.ok(sidepanelHtml.includes('id="city" value=""'), '公开版城市输入框应默认留空');
['background.js', 'content.js', 'candidate_profile.json'].forEach(file => {
  assert.strictEqual(fs.existsSync(path.join(rootDir, file)), false, '公开版不应包含未被manifest加载的旧文件：' + file);
});

console.log('stability-smoke: all assertions passed');
