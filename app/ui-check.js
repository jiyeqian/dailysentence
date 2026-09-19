/* 交互回归：引导 / 点击即改 / 长按保存 / 顶栏按钮 / raw
   跑法：先 node server.js（8787），再
   NODE_PATH=<node workspace>/node_modules node app/ui-check.js  */
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, 'shots');
const BASE = 'http://127.0.0.1:8787/?debug=1';

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  async function page(viewport) {
    const p = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2600);
    return p;
  }

  const shot = (p, name) => p.screenshot({ path: path.join(OUT, name + '.png') });

  const popTitle = (p) => p.evaluate(() => {
    const pop = document.getElementById('pop');
    return pop.hidden ? '' : document.getElementById('popTitle').textContent;
  });

  async function closePop(p) {
    if (await p.isVisible('#popClose')) await p.click('#popClose');
    await p.waitForTimeout(200);
  }

  /* 依据命中表算出某个区域的屏幕中心点，然后真的点下去 */
  async function tapRegion(p, id, index = 0) {
    await closePop(p);
    const pt = await p.evaluate(({ id, index }) => {
      const list = (window.__ds.state.regions || []).filter((r) => r.id === id);
      const r = list[index];
      if (!r) return null;
      const c = window.__ds.toClient(r.x + r.w / 2, r.y + r.h / 2);
      return { x: Math.round(c.x), y: Math.round(c.y) };
    }, { id, index });
    if (!pt) throw new Error('找不到区域 ' + id);
    await p.mouse.click(pt.x, pt.y);
    await p.waitForTimeout(400);
    return pt;
  }

  const log = (label, v) => console.log(label + ' → ' + (v || '(空)'));

  /* ---------- 手机 ---------- */
  let p = await page({ width: 390, height: 844 });
  await shot(p, 'm1-guide');                        // 首访引导：第一个呼吸框
  await p.waitForTimeout(1700);
  await shot(p, 'm2-guide-step2');
  await p.waitForTimeout(3200);
  await shot(p, 'm3-guide-step4');

  let pt = await tapRegion(p, 'word', 0);
  log('点标题关键词', await popTitle(p));
  await shot(p, 'm4-pop-word');
  console.log('  锚点屏幕坐标', JSON.stringify(pt));

  await tapRegion(p, 'defs', 0);
  log('点释义', await popTitle(p));
  await shot(p, 'm5-pop-defs');

  await tapRegion(p, 'card', 0);
  log('点个人信息卡', await popTitle(p));
  await shot(p, 'm6-pop-card');

  await tapRegion(p, 'text', 0);
  log('点句子', await popTitle(p));
  await shot(p, 'm7-pop-text');

  await closePop(p);
  const blank = await p.evaluate(() => {
    for (let y = 30; y < 1900; y += 20) {
      for (const x of [540, 200, 880]) {
        if (!window.__ds.hitTest(x, y)) {
          const c = window.__ds.toClient(x, y);
          return { x: Math.round(c.x), y: Math.round(c.y), cx: x, cy: y };
        }
      }
    }
    return null;
  });
  console.log('  空白点（画布坐标）', blank ? blank.cx + ',' + blank.cy : '没找到');
  await p.mouse.click(blank.x, blank.y);
  await p.waitForTimeout(400);
  log('画面空白', (await popTitle(p)) || '(已收起)');
  await shot(p, 'm8-pop-page');
  await p.mouse.click(6, 420);                      // 海报之外
  await p.waitForTimeout(400);
  log('点海报外', (await popTitle(p)) || '(已收起)');

  /* 长按 → 保存 */
  await p.mouse.move(195, 200);
  await p.mouse.down();
  await p.waitForTimeout(720);
  await p.mouse.up();
  await p.waitForTimeout(700);
  const toastText = await p.evaluate(() => {
    const t = document.getElementById('toast');
    return t.className.includes('show') ? t.textContent : '';
  });
  log('长按海报', toastText);
  await shot(p, 'm9-longpress');

  /* 顶栏：朗读 / 背景比例 / 刷新 / 保存 都在 */
  log('背景按钮文案', await p.textContent('#bgLabel'));
  await p.close();

  /* ---------- 桌面 ---------- */
  p = await page({ width: 1280, height: 900 });
  await shot(p, 'd1-guide');
  await tapRegion(p, 'word', 0);
  log('桌面点关键词', await popTitle(p));
  await shot(p, 'd2-pop-word');
  await tapRegion(p, 'defs', 0);
  await shot(p, 'd3-pop-defs');
  await p.click('#btnBg');
  await p.waitForTimeout(600);
  log('顶栏切背景', await p.textContent('#bgLabel'));
  await shot(p, 'd4-bg-cover');
  await p.close();

  /* ---------- raw ---------- */
  const rp = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  rp.on('pageerror', (e) => errors.push('raw pageerror: ' + e.message));
  await rp.goto('http://127.0.0.1:8787/?raw=1', { waitUntil: 'networkidle' });
  await rp.waitForTimeout(2600);
  await shot(rp, 'raw');
  await rp.close();

  await browser.close();
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
