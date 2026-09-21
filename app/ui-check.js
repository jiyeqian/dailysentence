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

  /* 按命中表反查屏幕坐标，再真的点下去（画布坐标 → 屏幕坐标由页面自己换算） */
  async function tap(p, regionId, index = 0, dbl = false) {
    const pt = await p.evaluate(({ id, index }) => {
      const list = (window.__ds.state.regions || []).filter((r) => r.id === id);
      const r = list[index];
      if (!r) return null;
      const c = window.__ds.toClient(r.x + r.w / 2, r.y + r.h / 2);
      return { x: Math.round(c.x), y: Math.round(c.y) };
    }, { id: regionId, index });
    if (!pt) throw new Error('找不到区域 ' + regionId);
    if (dbl) await p.mouse.dblclick(pt.x, pt.y);
    else await p.mouse.click(pt.x, pt.y);
    await p.waitForTimeout(420);
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

  for (const id of ['en', 'cn', 'source']) {
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
    const c = window.__ds.toClient(540, 1300);   /* 句子与卡片之间的空白处 */
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
  ok('铺满模式下画布仍是 1920', (await info(p)).canvas.h === 1920);

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
