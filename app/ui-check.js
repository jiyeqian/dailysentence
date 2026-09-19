/* UI 回归验证：桌面 / 手机视口下截图 + 控制台错误检查 */
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, 'shots');
const BASE = 'http://127.0.0.1:8787';

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  async function shot(name, viewport, actions) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    page.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500); // 等字体与每日一句数据
    if (actions) await actions(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    await page.close();
    console.log('shot:', name);
  }

  // 1. 桌面：默认（抽屉收起）
  await shot('desktop-collapsed', { width: 1280, height: 900 });
  // 2. 桌面：点「微调」标签展开抽屉
  await shot('desktop-tune-open', { width: 1280, height: 900 }, async (p) => {
    await p.click('.tab[data-tab="tune"]');
  });
  // 3. 桌面：文案标签
  await shot('desktop-copy-open', { width: 1280, height: 900 }, async (p) => {
    await p.click('.tab[data-tab="copy"]');
  });
  // 4. 手机：默认收起
  await shot('mobile-collapsed', { width: 390, height: 844 }, null);
  // 5. 手机：展开文案抽屉
  await shot('mobile-copy-open', { width: 390, height: 844 }, async (p) => {
    await p.click('.tab[data-tab="copy"]');
  });
  // 6. 手机：预览模式
  await shot('mobile-zen', { width: 390, height: 844 }, async (p) => {
    await p.click('#btnEye');
  });
  // 7. raw 模式
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push('raw pageerror: ' + e.message));
  await page.goto(BASE + '/?raw=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, 'raw.png'), fullPage: false });
  await page.close();
  console.log('shot: raw');

  await browser.close();
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
