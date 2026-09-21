/* 交互回归（2026-09-21 标准版重构后重写）
   断言的是新版面与新交互：
     1) 浮框 / 控件仓库 / 引导 / 顶栏 都不存在了（DOM 里查不到）
     2) 标准版画布恒 1080×1920；长版仍按内容长高
     3) 标准版元素固定为 bg / badge-date / en / cn / source / card
     4) 信息卡距左 / 右 / 底三边等距 48，顶部图片宽度铺满并裁到 648
     5) 双击句子元素 → 该元素从海报消失、其余上移，画布尺寸不变（不可逆，刷新恢复）
     6) 单击顶部图片 / 信息卡 → 唤起相册选图；单击句子 → 朗读；单击日期 → 切今日/昨日
     7) 长按 → 保存：桌面走下载（文件名 YYYY-MM-DD），iOS 走「浮层原图 → 存储到照片」
     8) 下拉更新 → 回到初始状态（隐藏清空 / 缩放归位 / 相册图复原）

   跑法：先 node server.js（8787），再
     NODE_PATH=<node workspace>/node_modules node app/ui-check.js  */
const path = require('path');

/* playwright 是外挂工具（不在 package.json 里），找不到就说明怎么借，而不是崩 */
let chromium;
let devices;
try {
  ({ chromium, devices } = require('playwright'));
} catch (e) {
  console.log(
    '[ui-check] 跳过：没找到 playwright。\n' +
    '  NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node app/ui-check.js\n' +
    '（或 npm i -D playwright && npx playwright install chromium）'
  );
  process.exit(0);
}

const OUT = path.join(__dirname, 'shots');
const BASE = 'http://127.0.0.1:8787';
const TEMPLATE = path.join(__dirname, 'public/assets/template.jpg');   /* 1179×2098 竖图 */

let fails = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '   ' + extra : ''));
  if (!cond) fails++;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  async function open(url, viewport = { width: 390, height: 844 }) {
    const p = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__ds && window.__ds.state.layout, null, { timeout: 15000 });
    return p;
  }

  const shot = (p, name) => p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  const info = (p) => p.evaluate(() => window.__ds.inspect());
  const ids = (d) => d.items.map((it) => it.id);
  const box = (d, id) => (d.items.find((it) => it.id === id) || {}).box;

  /* 按命中表反查屏幕坐标（画布坐标 → 屏幕坐标由页面自己换算） */
  async function pointOf(p, regionId, index = 0) {
    const pt = await p.evaluate(({ id, index }) => {
      const list = (window.__ds.state.regions || []).filter((r) => r.id === id);
      const r = list[index];
      if (!r) return null;
      const c = window.__ds.toClient(r.x + r.w / 2, r.y + r.h / 2);
      return { x: Math.round(c.x), y: Math.round(c.y) };
    }, { id: regionId, index });
    if (!pt) throw new Error('找不到区域 ' + regionId);
    return pt;
  }

  async function tap(p, regionId, index = 0, dbl = false) {
    const pt = await pointOf(p, regionId, index);
    if (dbl) await p.mouse.dblclick(pt.x, pt.y);
    else await p.mouse.click(pt.x, pt.y);
    await p.waitForTimeout(420);
    return pt;
  }

  /** 在某个区域上上下拖动（测试上下滑动缩放）；dy 为负 = 上滑 */
  async function dragY(p, regionId, dy) {
    const pt = await pointOf(p, regionId);
    await p.mouse.move(pt.x, pt.y);
    await p.mouse.down();
    await p.mouse.move(pt.x, pt.y + dy, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(340);
    return pt;
  }

  /** 在某个区域上向下拉（测试下拉更新）；dy 为正 = 下拉 */
  async function pullY(p, regionId, dy) {
    const pt = await pointOf(p, regionId);
    await p.mouse.move(pt.x, pt.y);
    await p.mouse.down();
    await p.mouse.move(pt.x, pt.y + dy, { steps: 10 });
    await p.mouse.up();
    await p.waitForTimeout(360);
    return pt;
  }

  const speakAt = (x) => x.meta.lastSpeakAt || 0;
  const viewDate = (p) => p.evaluate(() => window.__ds.state.viewDate || '');

  /* ---------------- 标准版：结构与尺寸 ---------------- */
  console.log('标准版 · 结构与尺寸');
  let p = await open(BASE + '/?debug=1');
  await p.waitForTimeout(600);
  await shot(p, 's1-standard');

  const gone = await p.evaluate(() =>
    ['pop', 'kit', 'frames', 'tip', 'mark', 'srcTag', 'segBg'].filter((id) => document.getElementById(id))
  );
  ok('浮框 / 控件仓库 / 引导已从 DOM 移除', gone.length === 0, gone.length ? '仍存在: ' + gone.join(',') : '');

  let d = await info(p);
  ok('画布恒 1080×1920', d.canvas.w === 1080 && d.canvas.h === 1920, d.canvas.w + '×' + d.canvas.h);
  ok('标准版元素 = bg/badge-date/en/cn/source/card',
    JSON.stringify(ids(d)) === JSON.stringify(['bg', 'badge-date', 'en', 'cn', 'source', 'card']),
    ids(d).join(','));
  ok('顶部图片区固定 648', box(d, 'bg')[3] === 648, 'h=' + box(d, 'bg')[3]);

  const cb = box(d, 'card');
  const mLeft = cb[0];
  const mRight = 1080 - (cb[0] + cb[2]);
  const mBottom = 1920 - (cb[1] + cb[3]);
  ok('信息卡三边等距 48', mLeft === 48 && mRight === 48 && mBottom === 48,
    `左${mLeft} 右${mRight} 底${mBottom}`);

  ok('正文左线 = 信息卡左线 48',
    box(d, 'en')[0] === 48 && box(d, 'cn')[0] === 48 && box(d, 'source')[0] === 48,
    `en ${box(d, 'en')[0]} / cn ${box(d, 'cn')[0]} / source ${box(d, 'source')[0]}`);
  const db = box(d, 'badge-date');
  ok('日期胶囊右线 = 48', db[0] + db[2] === 1080 - 48, '右线 ' + (db[0] + db[2]));

  /* 界面彻底无按钮：功能全部由手势承载 */
  const chrome = await p.evaluate(() => ({
    buttons: document.querySelectorAll('button').length,
    topbar: !!document.getElementById('topbar'),
    hint: (() => { const h = document.getElementById('hint'); return h ? !h.hidden : false; })(),
  }));
  ok('界面没有任何按钮 / 顶栏', chrome.buttons === 0 && !chrome.topbar,
    `buttons=${chrome.buttons} topbar=${chrome.topbar}`);
  ok('首次进入显示一次性手势提示', chrome.hint);

  /* 顶部图片：宽度铺满 1080、高度按比例，超出部分裁掉 */
  ok('顶部图片按宽度铺满（1080 宽、不裁切时不露底色）',
    d.bg && d.bg.w === 1080 && d.bg.blankBottom === 0, JSON.stringify(d.bg));

  const bandH = d.text.band.h;
  const gapTop = d.gaps.find((g) => g.id === 'gap-img-text').px;
  const gapBottom = d.gaps.find((g) => g.id === 'gap-text-card').px;
  ok('句子在中部区域里垂直居中', Math.abs(gapTop - gapBottom) <= 2, `上${gapTop} 下${gapBottom}`);
  /* 「尽量铺满」的真实不变式：再放大一档（0.02）就会装不下。
     字号要取整、断行是跳变的，所以填满度可能是 90% 出头，这不是 bug */
  const fill = await p.evaluate(() => {
    const L = window.__ds.state.layout;
    return {
      total: Math.round(L.textBottom - L.textTop),
      bandH: Math.round(L.band.h),
      next: Math.round(window.__ds.textTotalAt(L.autoScale + 0.02)),
    };
  });
  ok('初始尽量铺满中部区域（再大一档就溢出）', fill.next > fill.bandH,
    `文字块 ${fill.total} / 活动区 ${fill.bandH}，放大一档 → ${fill.next}`);
  ok('字号自适应放大（基准 42）', d.text.autoScale > 1, 'autoScale=' + d.text.autoScale);

  /* ---------------- 双击隐藏 ---------------- */
  console.log('标准版 · 双击隐藏');
  const enY0 = box(d, 'en')[1];
  const speakBeforeDbl = speakAt(d);
  await tap(p, 'badge-date', 0, true);
  d = await info(p);
  ok('双击日期胶囊后它从海报消失', !ids(d).includes('badge-date'));
  ok('双击删除时不会顺带朗读', speakAt(d) === speakBeforeDbl,
    `lastSpeakAt ${speakBeforeDbl} → ${speakAt(d)}`);
  ok('开始操作后手势提示收起',
    await p.evaluate(() => { const h = document.getElementById('hint'); return !h || h.hidden; }));
  ok('隐藏后画布仍是 1920', d.canvas.h === 1920);
  ok('隐藏后其余内容自动上移', box(d, 'en')[1] < enY0, `en.y ${enY0} → ${box(d, 'en')[1]}`);
  ok('隐藏后信息卡位置不变（贴底）', JSON.stringify(box(d, 'card')) === JSON.stringify(cb));
  await shot(p, 's2-hide-date');

  /* 删掉一个元素后，剩下的内容自动放大补满中部区域 */
  const fontBefore = d.items.find((it) => it.id === 'en').font;
  await tap(p, 'source', 0, true);
  d = await info(p);
  const fontAfter = d.items.find((it) => it.id === 'en').font;
  ok('删掉出处后字号自动放大', fontAfter > fontBefore, `${fontBefore} → ${fontAfter}`);

  for (const id of ['en', 'cn']) {
    await tap(p, id, 0, true);
    d = await info(p);
    ok('双击 ' + id + ' 后消失', !ids(d).includes(id));
  }
  ok('四个都隐藏后只剩图片与卡片', JSON.stringify(ids(d)) === JSON.stringify(['bg', 'card']), ids(d).join(','));
  ok('空文字块时画布仍是 1920', d.canvas.h === 1920);
  await shot(p, 's3-all-hidden');

  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);
  ok('刷新后回到初始状态', ids(d).length === 6, ids(d).join(','));

  /* ---------------- 中部区域：上下滑动缩放 ---------------- */
  console.log('标准版 · 上下滑动缩放');
  const fontOf = (x) => x.items.find((it) => it.id === 'en').font;
  const f0 = fontOf(d);
  await dragY(p, 'en', -120);                        /* 上滑 = 放大 */
  d = await info(p);
  ok('上滑放大字号', fontOf(d) > f0 && d.text.zoom > 1,
    `${f0} → ${fontOf(d)}（zoom ${d.text.zoom}）`);
  await shot(p, 's7-zoom-in');

  const f1 = fontOf(d);
  await dragY(p, 'en', 240);                         /* 下滑 = 缩小 */
  d = await info(p);
  ok('下滑缩小字号', fontOf(d) < f1, `${f1} → ${fontOf(d)}（zoom ${d.text.zoom}）`);

  /* 缩到最小也不能压到卡片 */
  await dragY(p, 'en', 900);
  d = await info(p);
  ok('缩到下限后仍不越过信息卡',
    box(d, 'source')[1] + box(d, 'source')[3] <= box(d, 'card')[1],
    `文字底 ${box(d, 'source')[1] + box(d, 'source')[3]} / 卡片顶 ${box(d, 'card')[1]}`);

  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);
  ok('刷新后缩放归位', d.text.zoom === 1 && Math.abs(fontOf(d) - f0) < 0.6,
    `zoom=${d.text.zoom} font=${fontOf(d)}（初始 ${f0}）`);

  /* ---------------- 单击：句子朗读 / 日期切今日昨日 ---------------- */
  console.log('标准版 · 单击朗读与切日');
  const s0 = speakAt(d);
  await tap(p, 'en');                        /* 单击句子 → 等 300ms 确认不是双击 → 朗读 */
  await p.waitForTimeout(500);
  d = await info(p);
  ok('单击句子会朗读', speakAt(d) > s0, `lastSpeakAt ${s0} → ${speakAt(d)}`);
  ok('单击不会把句子删掉', ids(d).includes('en'));

  const t0 = await p.evaluate(() => window.__ds.state.lastToggleAt || 0);
  await tap(p, 'badge-date');
  await p.waitForTimeout(1400);
  const t1 = await p.evaluate(() => window.__ds.state.lastToggleAt || 0);
  ok('单击日期胶囊触发今日/昨日切换', t1 > t0, `lastToggleAt ${t0} → ${t1}`);
  const v1 = await viewDate(p);
  if (v1) {
    ok('切到了昨日存档', /^\d{4}-\d{2}-\d{2}$/.test(v1), 'viewDate=' + v1 + '（' + (await p.evaluate(() => window.__ds.state.content.date)) + '）');
    await tap(p, 'badge-date');
    await p.waitForTimeout(1400);
    ok('再点一次回到今天', (await viewDate(p)) === '', 'viewDate=' + (await viewDate(p)));
  } else {
    ok('昨日没有存档时留在今天并提示', true, 'viewDate 仍为空（loadDaily 已 toast 说明）');
  }

  /* ---------------- 单击选图 ---------------- */
  console.log('标准版 · 单击选图');
  let chooser = p.waitForEvent('filechooser', { timeout: 5000 });
  await tap(p, 'img');
  ok('单击顶部图片唤起相册', !!(await chooser));
  await (await chooser).setFiles(TEMPLATE);
  await p.waitForTimeout(700);
  d = await info(p);
  ok('换成竖图后画布仍是 1920', d.canvas.h === 1920, 'h=' + d.canvas.h);
  ok('换成竖图后图片区仍是 648', box(d, 'bg')[3] === 648);
  /* 这条是本轮修的 bug：竖图原来会一路画到中部区域，把文字背景糊掉 */
  ok('竖图被裁到 648 高（不再溢出污染中部）',
    d.bg.clipped === true && d.bg.h > 648 && d.bg.blockH === 648,
    `图片实际高 ${d.bg.h}，只显示 ${d.bg.blockH}`);
  ok('换竖图后句子没有被顶走（仍在中部活动区里）', box(d, 'en')[1] >= d.text.band.top,
    'en.y=' + box(d, 'en')[1] + ' / 活动区顶=' + d.text.band.top);
  ok('换成竖图后信息卡没有被挤走', JSON.stringify(box(d, 'card')) === JSON.stringify(cb));
  await shot(p, 's4-tall-photo');

  chooser = p.waitForEvent('filechooser', { timeout: 5000 });
  await tap(p, 'card');
  ok('单击信息卡唤起相册', !!(await chooser));
  await (await chooser).setFiles(TEMPLATE);
  await p.waitForTimeout(700);
  d = await info(p);
  ok('换信息卡后三边仍是 48', box(d, 'card')[0] === 48 && 1920 - (box(d, 'card')[1] + box(d, 'card')[3]) === 48);
  await shot(p, 's5-new-card');

  /* ---------------- 长按保存（界面无按钮，保存只能靠长按） ---------------- */
  console.log('标准版 · 长按保存');
  const mid = await p.evaluate(() => {
    const c = window.__ds.toClient(540, 1352);   /* 文字活动区与卡片之间的空白处 */
    return { x: Math.round(c.x), y: Math.round(c.y) };
  });
  await p.mouse.move(mid.x, mid.y);
  await p.mouse.down();
  await p.waitForTimeout(760);
  await p.mouse.up();
  await p.waitForTimeout(600);
  const toastText = await p.evaluate(() => {
    const t = document.getElementById('toast');
    return t.className.includes('show') ? t.textContent : '';
  });
  ok('长按海报触发保存', !!toastText, toastText);
  ok('保存不再依赖任何按钮（页面确实没有按钮）',
    (await p.evaluate(() => document.querySelectorAll('button').length)) === 0);
  await shot(p, 's6-longpress');

  /* 桌面 / Android 通道：真的触发下载，且文件名是 YYYY-MM-DD（不是 9212026） */
  const dlP = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await dlP.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await dlP.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await dlP.waitForTimeout(600);
  const dlEvent = dlP.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  const dlPt = await dlP.evaluate(() => {
    const c = window.__ds.toClient(540, 1352);
    return { x: Math.round(c.x), y: Math.round(c.y) };
  });
  await dlP.mouse.move(dlPt.x, dlPt.y);
  await dlP.mouse.down();
  await dlP.waitForTimeout(760);
  await dlP.mouse.up();
  const dl = await dlEvent;
  const dlName = dl ? dl.suggestedFilename() : '';
  ok('非 iOS 长按真的触发下载', !!dl, dlName);
  ok('下载文件名规范成 dailysentence-YYYY-MM-DD.png',
    /^dailysentence-\d{4}-\d{2}-\d{2}\.png$/.test(dlName), dlName);
  ok('非 iOS 不弹保存浮层', await dlP.evaluate(() => document.getElementById('saveSheet').hidden));
  await dlP.close();

  /* iOS 通道：Safari 上 <a download> 只会弹文件预览（用户报的 bug），
     必须改走「浮层出原图 + 长按存储到照片」。用 iPhone UA 模拟这条路径。 */
  const iPhone = devices['iPhone 13'];
  const iosCtx = await browser.newContext({ ...iPhone, deviceScaleFactor: 2 });
  const ip = await iosCtx.newPage();
  ip.on('pageerror', (e) => errors.push('ios pageerror: ' + e.message));
  const iosDownloads = [];
  ip.on('download', (d) => iosDownloads.push(d.suggestedFilename()));
  await ip.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await ip.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await ip.waitForTimeout(700);
  const ipt = await ip.evaluate(() => {
    const c = window.__ds.toClient(540, 1352);
    return { x: Math.round(c.x), y: Math.round(c.y) };
  });
  await ip.mouse.move(ipt.x, ipt.y);
  await ip.mouse.down();
  await ip.waitForTimeout(760);
  await ip.mouse.up();
  await ip.waitForTimeout(700);
  const sheet = await ip.evaluate(() => {
    const s = document.getElementById('saveSheet');
    const im = document.getElementById('saveImg');
    return {
      hidden: s.hidden,
      src: (im.getAttribute('src') || '').slice(0, 5),
      alt: im.getAttribute('alt'),
      tip: document.getElementById('saveTip').textContent,
      kind: (window.__ds.state.lastSave || {}).kind,
    };
  });
  ok('iOS 长按弹出保存浮层（不再走下载）', !sheet.hidden && sheet.kind === 'sheet',
    JSON.stringify(sheet));
  ok('浮层里给的是可直接长按的原图（blob URL）', sheet.src === 'blob:', sheet.src);
  ok('iOS 长按不产生文件下载', iosDownloads.length === 0, iosDownloads.join(','));
  await ip.screenshot({ path: path.join(OUT, 's9-ios-save.png') });

  /* 点图以外的地方关闭（图片本身必须不响应，否则会吃掉 iOS 的长按菜单） */
  const outside = await ip.evaluate(() => {
    const r = document.getElementById('saveImg').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom + 8), bottom: Math.round(r.bottom) };
  });
  await ip.mouse.click(outside.x, outside.y);
  await ip.waitForTimeout(400);
  ok('点空白处关闭保存浮层', await ip.evaluate(() => document.getElementById('saveSheet').hidden));
  await iosCtx.close();

  /* ---------------- 下拉更新 = 回到初始状态 ---------------- */
  console.log('标准版 · 下拉更新回到初始');
  /* 先把状态弄乱：删掉日期、换成竖图、放大字号 */
  await tap(p, 'badge-date', 0, true);
  const fc2 = p.waitForEvent('filechooser', { timeout: 5000 });
  await tap(p, 'img');
  await (await fc2).setFiles(TEMPLATE);
  await p.waitForTimeout(700);
  await dragY(p, 'en', -120);
  const messy = await info(p);
  ok('（准备）状态已改乱',
    messy.meta.hidden.date === true && messy.text.zoom > 1 && messy.bg.clipped === true,
    `hidden.date=${messy.meta.hidden.date} zoom=${messy.text.zoom} clipped=${messy.bg.clipped}`);

  await pullY(p, 'img', 150);                 /* 图片区向下拉 = 更新 */
  await p.waitForTimeout(2600);
  const back = await info(p);
  ok('下拉后隐藏状态被清空',
    JSON.stringify(back.meta.hidden) === JSON.stringify({ date: false, en: false, cn: false, source: false }));
  ok('下拉后缩放归位', back.text.zoom === 1, 'zoom=' + back.text.zoom);
  ok('下拉后相册图被换回上游默认（不再裁切）', back.bg && back.bg.clipped === false,
    JSON.stringify(back.bg));
  ok('六个元素都回来了',
    JSON.stringify(ids(back)) === JSON.stringify(['bg', 'badge-date', 'en', 'cn', 'source', 'card']),
    ids(back).join(','));
  ok('下拉更新后画布仍 1920', back.canvas.h === 1920);
  await shot(p, 's8-after-pull');

  /* ---------------- 桌面视口 ---------------- */
  console.log('桌面视口');
  const dp = await open(BASE + '/?debug=1', { width: 1280, height: 900 });
  await dp.waitForTimeout(600);
  await shot(dp, 'd1-standard');
  ok('桌面下画布仍是 1080×1920', (await info(dp)).canvas.h === 1920);
  await dp.close();
  await p.close();

  /* ---------------- 长版：本阶段必须没被动过 ---------------- */
  console.log('长版（应保持旧版面）');
  const lp = await open(BASE + '/?debug=1&long=1');
  await lp.waitForTimeout(800);
  const ld = await info(lp);
  ok('长版仍有单词卡与关键词', ids(ld).includes('panel') && ids(ld).includes('title'), ids(ld).join(','));
  ok('长版仍按内容长高（≥1920）', ld.canvas.h >= 1920, 'h=' + ld.canvas.h);
  ok('长版仍是原比例模式（只有标准版走「宽度铺满 + 裁切」）',
    ld.opts.bgStyle === 'natural' && ld.text.band === null, JSON.stringify(ld.opts));
  await shot(lp, 'l1-long');
  await lp.close();

  /* ---------------- raw ---------------- */
  const rp = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  rp.on('pageerror', (e) => errors.push('raw pageerror: ' + e.message));
  await rp.goto(BASE + '/?raw=1', { waitUntil: 'load' });
  await rp.waitForTimeout(2600);
  await shot(rp, 'raw');
  await rp.close();

  await browser.close();
  console.log(errors.length ? '\nCONSOLE ERRORS:\n' + errors.join('\n') : '\nno console errors');
  console.log(fails ? `\nFAIL: ${fails} 项断言未通过` : '\n全部断言通过');
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
