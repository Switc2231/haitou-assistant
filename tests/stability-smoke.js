const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
require(path.join(rootDir, 'src/core/normalizeJob.js'));
require(path.join(rootDir, 'src/core/city.js'));
require(path.join(rootDir, 'src/core/jobPool.js'));
require(path.join(rootDir, 'src/core/scoring.js'));

const core = globalThis.JobCopilotCore;

const sampleCityMap = {
  '全国': '100010000',
  '北京': '101010100',
  '深圳': '101280600',
  '广州': '101280100'
};
const configuredShenzhen = core.city.resolveConfiguredCity('广东省深圳市 南山区', sampleCityMap);
assert.strictEqual(configuredShenzhen.found, true, '省市区混合写法应识别到深圳');
assert.strictEqual(configuredShenzhen.code, '101280600', '深圳应解析为正确城市码');
const unknownCity = core.city.resolveConfiguredCity('不存在市', sampleCityMap);
assert.strictEqual(unknownCity.found, false, '未知城市必须失败，不能静默退回全国');
assert.strictEqual(unknownCity.code, '', '未知城市不能携带全国城市码');
const blankCity = core.city.resolveConfiguredCity('', sampleCityMap);
assert.strictEqual(blankCity.code, '100010000', '明确留空仍可表示全国搜索');
assert.strictEqual(core.city.validCityCode('101280600'), '101280600', 'BOSS城市码应通过校验');
assert.strictEqual(core.city.validCityCode('123'), '', '非城市码必须拒绝');
const bossCityMap = core.city.cityMapFromBossData({ zpData: { cityGroup: [
  { firstChar: 'F', cityList: [{ name: '佛山', code: 101280800 }] },
  { firstChar: 'H', cityList: [{ name: '惠州', code: 101280300 }] }
] } }, sampleCityMap);
assert.strictEqual(bossCityMap['佛山'], '101280800', '应从BOSS当前城市列表导入佛山');
assert.strictEqual(bossCityMap['惠州'], '101280300', '应从BOSS当前城市列表导入惠州');
const guardedCities = core.city.guardJobsForCity([
  { name: '深圳运营', location: '深圳·南山' },
  { name: '北京运营', location: '北京·朝阳' },
  { name: '区域未知岗位', location: '南山科技园' }
], { name: '深圳', code: '101280600' }, sampleCityMap);
assert.strictEqual(guardedCities.jobs.length, 2, '目标城市岗位和无法识别岗位应保留');
assert.strictEqual(guardedCities.mismatches.length, 1, '明确异地岗位必须拦截');
assert.strictEqual(guardedCities.unverified.length, 1, '区名但无城市名的岗位应标记人工确认');
assert.ok(guardedCities.unverified[0].riskFlags.includes('城市未识别，请人工确认'), '无法识别城市必须显示风险提示');
const backfilledCities = core.city.guardJobsForCity([
  { name: '酒店前台', location: '南山科技园', detailLocation: '深圳 经验不限 中专/中技', riskFlags: ['城市未识别，请人工确认'] }
], { name: '深圳', code: '101280600' }, sampleCityMap);
assert.strictEqual(backfilledCities.unverified.length, 0, '详情页补读到目标城市后不应继续人工确认');
assert.strictEqual(backfilledCities.jobs[0].cityCheck, 'matched', '详情页补读城市后应标记为匹配');
assert.ok(!backfilledCities.jobs[0].riskFlags.includes('城市未识别，请人工确认'), '补读成功后应清除旧城市风险提示');

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
assert.strictEqual(manifest.version, '0.5.1', '稳定测试版版本号应为 0.5.1');
assert.strictEqual(manifest.version_name, '0.5.1-city-detail-stable-v1', '测试版应清楚标记城市与独立详情稳定流程');

const background = fs.readFileSync(path.join(rootDir, 'src/background.js'), 'utf8');
const search = fs.readFileSync(path.join(rootDir, 'src/content-search.js'), 'utf8');
const chat = fs.readFileSync(path.join(rootDir, 'src/content-chat.js'), 'utf8');
const selectors = fs.readFileSync(path.join(rootDir, 'src/selectors.js'), 'utf8');
assert.ok(!/const\s+PRIORITY_WORDS\s*=/.test(background), '后台不应保留固定职业优先词数组');
assert.ok(!/const\s+EXCLUDE_WORDS\s*=/.test(background), '后台不应保留固定职业排除词数组');
assert.ok(background.includes('GO_CHAT_V4') && search.includes('GO_CHAT_V4'), '聊天导航应使用 V4 消息隔离旧脚本');
assert.ok(background.includes('OPEN_JD_V4') && search.includes('OPEN_JD_V4'), '详情读取应使用 V4 消息隔离旧脚本');
assert.ok(!search.includes("msg.type === 'OPEN_JD_V3'"), '新脚本不能继续响应旧版详情读取消息');
assert.ok(background.includes('bossDetailUrl(job)') && background.includes('await ensureTab(detailUrl)'), '投递应直接进入收集到的岗位详情链接');
assert.ok(background.includes("url.protocol !== 'https:'") && background.includes("url.hostname.endsWith('.zhipin.com')"), '岗位详情链接必须限制为HTTPS BOSS域名');
  assert.ok(background.includes('managedBossTabId') && !background.includes('active: true, currentWindow: true, url:'), '自动流程只能复用插件创建的工作标签页，不能改写用户当前BOSS标签页');
assert.ok(background.includes('const safeUrl = bossDetailUrl({ url: url })'), '人工查看入口也必须限制为有效BOSS详情链接');
assert.ok(search.includes('isStandaloneJobDetailPage') && search.includes("/^\\/job_detail\\//"), '页面脚本应识别独立岗位详情路由');
assert.ok(search.includes('岗位详情页未就绪'), '空详情读取不能再误报成功');
assert.ok(!/j\s*=\s*await\s+enrichAddressFromDetail/.test(search), '收集阶段不能点击岗位卡片并意外打开多个详情标签页');
assert.ok(manifest.content_scripts[0].matches.includes('*://*.zhipin.com/job_detail/*'), '独立岗位详情页应自动加载详情脚本');
assert.ok(!search.includes("msg.type === 'GO_CHAT_V3'"), '搜索页新脚本不能继续响应旧版建联消息');
assert.ok(search.includes('CHAT_BUTTON_SELECTOR') && search.includes('.op-btn-chat'), '建联按钮不能依赖特定a标签');
assert.ok(selectors.includes('.op-btn.op-btn-chat') && !selectors.includes("immediateChatBtn: 'a.op-btn-chat'"), '共享选择器应兼容非a标签聊天按钮');
assert.ok(search.includes('waitForActionButton') && search.includes('5000'), '详情按钮应等待动态渲染完成');
assert.ok(search.includes('isDisabledControl') && search.includes('pageBlockReason'), '按钮不可用或页面验证时必须安全停止');
assert.ok(search.includes('可见操作：'), '建联失败日志应提供可见操作诊断');
assert.ok(background.includes('resolveSearchCity') && background.includes('readBossCurrentCity'), '后台应优先读取BOSS当前城市');
assert.ok(background.includes('/wapi/zpCommon/data/cityGroup.json') && background.includes('bossCityMapCacheV1'), '后台应读取并缓存BOSS当前支持城市列表');
assert.ok(background.includes('guardJobsForCity'), '收集后必须执行本地城市复核');
assert.ok(background.includes('enrichUnverifiedJobsFromDetails') && background.includes('详情页补读城市成功'), '城市未知岗位应打开详情页补读城市');
assert.ok(!background.includes('未识别，已按全国搜索'), '未知城市不能静默退回全国');
assert.ok(background.includes('搜索城市码缺失') && background.includes('validCityCode(searchCity && searchCity.code)'), '搜索URL必须拒绝 city=undefined');
assert.ok(search.includes('GET_CURRENT_CITY_V1') && search.includes('currentCityCode'), '搜索页脚本应报告当前BOSS城市');
assert.ok(background.includes('SEND_ACTIVE_V6') && chat.includes('SEND_ACTIVE_V6'), '聊天发送应使用 V6 消息隔离旧脚本');
assert.ok(chat.includes('__bossToudiExpectedChatV3'), '聊天发送必须校验本次岗位建联令牌');
assert.ok(!/const\s+FALLBACK_GREETING\s*=/.test(background), '后台不能保留自动外发的兜底招呼语');
assert.ok(background.includes('validateOutgoingGreeting'), '后台必须在建联前校验外发话术');
assert.ok(chat.includes('validateOutgoingText'), '聊天页必须在填写输入框前再次校验外发话术');
assert.ok(chat.includes('claimImageSend'), '聊天页必须在上传前占用岗位图片发送锁');
assert.ok(chat.includes('__bossToudiImageSendLockV6:'), '图片发送锁必须使用V6独立命名空间');
  assert.ok(chat.includes('hasExistingOwnImage'), '上传前必须检查当前会话是否已经存在自己发送的图片');
  assert.ok(chat.includes('当前聊天会话未显示目标岗位或公司，拒绝发送'), '会话可见信息不匹配时必须拒绝发送');
  assert.ok(!chat.includes('items[0].click()'), '找不到输入框时不能切换到第一条会话');
assert.ok(!background.includes('把HR当成不懂AI的人'), 'AI自我介绍提示不能预设AI岗位场景');
assert.ok(!background.includes('省掉哪些重复工作'), 'AI自我介绍提示不能强行套用AI提效表达');
const sidepanel = fs.readFileSync(path.join(rootDir, 'src/sidepanel.js'), 'utf8');
assert.ok(sidepanel.includes("const DEFAULT_KEYWORDS = '';"), '新用户不能预置某一职业方向');
assert.ok(sidepanel.includes("const DEFAULT_EXCLUDE_WORDS = '';"), '新用户不能预置某一职业排除规则');
assert.ok(sidepanel.includes("const DEFAULT_NO_AI_GREETING = '';"), '无AI自我介绍只能由用户主动填写，不能默认写入');
assert.ok(sidepanel.includes('MAX_RESUME_IMAGE_BYTES') && sidepanel.includes('chrome.runtime.lastError'), '简历图片过大或本地保存失败时必须明确报错');
assert.ok(sidepanel.includes("$('exportScope').value === 'filtered'") && sidepanel.includes('job.match === true'), 'CSV导出范围选择必须真实生效');
const sidepanelHtml = fs.readFileSync(path.join(rootDir, 'src/sidepanel.html'), 'utf8');
assert.ok(sidepanelHtml.includes('v0.5.1 城市同步·独立详情版'), '侧栏必须显示当前版本，不能继续显示旧版号');
assert.ok(sidepanelHtml.includes('仅导出匹配岗位'), '导出范围文案应与实际行为一致');
assert.ok(sidepanelHtml.includes('参考写法：您好，我叫【姓名】'), '侧栏应只用placeholder展示参考写法');
assert.ok(sidepanel.includes("$('city').value = '';"), '城市应默认留空并优先读取BOSS当前页面');
assert.ok(sidepanelHtml.includes('BOSS当前城市优先') && sidepanelHtml.includes('不会自动改成全国'), '侧栏应解释城市来源与失败边界');
assert.ok(background.includes('/【[^】]+】/'), '后台必须拒绝仍含占位符的无AI自我介绍');

console.log('stability-smoke: all assertions passed');
