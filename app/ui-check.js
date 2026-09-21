/* 交互回归（2026-09-21 标准版重构后重写）
   断言的是新版面与新交互：
     1) 浮框 / 控件仓库 / 引导 都不存在了（DOM 里查不到）
     2) 标准版画布恒 1080×1920；长版仍按内容长高
     3) 标准版元素固定为 bg / badge-date / en / cn / source / card
     4) 信息卡距左 / 右 / 底三边等距 48
     5) 双击句子元素 → 该元素从海报消失、其余上移，画布尺寸不变（不可逆，刷新恢复）
     6) 单击顶部图片 / 信息卡 → 唤起相册选图；换图后版面几何不变
     7) 长按海报 → 保存（toast 出现）
     8) 顶栏四个按钮都在，背景比例可切换

   跑法：先 node server.js（8787），再
     NODE_PATH=<node workspace>/node_modules node app/ui-check.js  */
const path = require('path');

/* playwright 是外挂工具（不在 package.json 里），找不到就说明怎么借，而不是崩 */
let chromium;
try {
  ({ chromium } = require('playwright'));
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
  ok('默认背景是铺满裁切', (await p.textContent('#bgLabel')).trim() === '铺满');

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
  await tap(p, 'badge-date', 0, true);
  d = await info(p);
  ok('双击日期胶囊后它从海报消失', !ids(d).includes('badge-date'));
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

  /* ---------------- 长按保存 / 顶栏 ---------------- */
  console.log('标准版 · 保存与顶栏');
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
  await shot(p, 's6-longpress');

  const btns = await p.evaluate(() => ['btnPlay', 'btnBg', 'btnRefresh', 'btnSave'].map((id) => !!document.getElementById(id)));
  ok('顶栏四个按钮都在', btns.every(Boolean), btns.join(','));
  const bg0 = await p.textContent('#bgLabel');
  await p.click('#btnBg');
  await p.waitForTimeout(500);
  const bg1 = await p.textContent('#bgLabel');
  ok('背景比例可切换', bg0 !== bg1, bg0 + ' → ' + bg1);
  ok('切换后画布仍是 1920', (await info(p)).canvas.h === 1920);

  /* ---------------- 顶栏「重新获取」= 回到初始状态 ---------------- */
  console.log('标准版 · 重新获取回到初始');
  /* 先把状态弄乱：删掉日期、换相册图、放大字号（背景比例上一步已切成原比例） */
  await tap(p, 'badge-date', 0, true);
  const fc2 = p.waitForEvent('filechooser', { timeout: 5000 });
  await tap(p, 'img');
  await (await fc2).setFiles(TEMPLATE);
  await p.waitForTimeout(600);
  await dragY(p, 'en', -120);
  const messy = await info(p);
  ok('（准备）状态已改乱',
    messy.meta.hidden.date === true && messy.text.zoom > 1 && messy.opts.bgStyle === 'natural',
    `hidden.date=${messy.meta.hidden.date} zoom=${messy.text.zoom} bg=${messy.opts.bgStyle}`);

  await p.click('#btnRefresh');
  await p.waitForTimeout(2800);
  const back = await info(p);
  ok('隐藏状态被清空',
    JSON.stringify(back.meta.hidden) === JSON.stringify({ date: false, en: false, cn: false, source: false }));
  ok('缩放归位', back.text.zoom === 1, 'zoom=' + back.text.zoom);
  ok('背景比例回到初始（铺满）',
    back.opts.bgStyle === 'cover' && (await p.textContent('#bgLabel')).trim() === '铺满',
    back.opts.bgStyle);
  ok('六个元素都回来了',
    JSON.stringify(ids(back)) === JSON.stringify(['bg', 'badge-date', 'en', 'cn', 'source', 'card']),
    ids(back).join(','));
  ok('重新获取后画布仍 1920', back.canvas.h === 1920);
  await shot(p, 's8-after-refresh');

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
  ok('长版默认仍是原比例（只有标准版默认铺满）',
    (await lp.textContent('#bgLabel')).trim() === '原比例', await lp.textContent('#bgLabel'));
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
