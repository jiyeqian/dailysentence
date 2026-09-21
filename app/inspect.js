/* 版面标注通道：把海报上每个视觉零件导出成「编号 + 坐标」的结构化清单，
   并生成一张带编号的标注图。用途是**沟通**而不是测试：
   你看图标号说「③ 往左挪」，我按编号查 id 改代码，不必识图。

   跑法（需先 node server.js，默认 8787）：
     NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
       node app/inspect.js --tag before            # 出 JSON + 标注图
     node app/inspect.js --diff before after       # 改前 / 改后逐项比对

   常用参数：
     --tag <名>      输出文件名后缀（默认 latest，同名覆盖）
     --raw           只截海报本体（不加顶栏）
     --desktop       桌面视口 1280×900（默认手机 390×844 @2x）
     --long          长版海报（带例句）
     --word/--en/--cn/--source  固定文案，保证两次导出可比
     --base <url>    服务地址，默认 http://127.0.0.1:8787
     --full          整页截图：海报比视口高时（长版 / 加高版面）也能截全
     --no-shot       只出 JSON，不截图

   产物落在 app/shots/（已 gitignore）：
     inspect-<tag>.json   版面清单（给 AI 读）
     annot-<tag>.png      编号标注图（给人看）
*/
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const HINT = '需要 playwright：\n' +
  '  NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node app/inspect.js\n' +
  '（或用 npm i -D playwright && npx playwright install chromium 装一份）';

/* ------------------------------ 参数 ------------------------------ */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const arg = (name, dflt) => {
  const v = flag(name);
  return v === true || v == null ? dflt : v;
};
const has = (name) => argv.includes('--' + name);

/* ------------------------------ diff ------------------------------ */

function resolveShot(p) {
  if (fs.existsSync(p)) return p;
  const inShots = path.join(OUT, p);
  if (fs.existsSync(inShots)) return inShots;
  const withExt = path.join(OUT, 'inspect-' + p + '.json');
  if (fs.existsSync(withExt)) return withExt;
  return null;
}

function diff(aPath, bPath) {
  const A = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const B = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  const map = (d) => {
    const m = {};
    for (const it of d.items) m[it.id] = it;
    return m;
  };
  const ma = map(A);
  const mb = map(B);
  const ids = [...new Set([...Object.keys(ma), ...Object.keys(mb)])];
  const n1 = (v) => (v == null ? '' : Math.round(v * 10) / 10);
  const lines = [];
  const num = (v) => (isFinite(v) ? Math.round(v * 10) / 10 : v);

  for (const id of ids) {
    const a = ma[id];
    const b = mb[id];
    if (!a) { lines.push('+ ' + id + '  新增  ' + b.label); continue; }
    if (!b) { lines.push('- ' + id + '  移除  ' + a.label); continue; }
    const d = a.box.map((v, i) => num(b.box[i] - v));
    const moved = d.some((v) => Math.abs(v) >= 0.5);
    const dFont = Math.abs((b.font || 0) - (a.font || 0)) >= 0.5;
    const dText = (a.text || '') !== (b.text || '');
    if (!moved && !dFont && !dText) continue;
    const bits = [];
    if (moved) bits.push('Δbox=[' + d.map((v) => (v > 0 ? '+' : '') + v).join(', ') + ']');
    if (dFont) bits.push('字号 ' + n1(a.font) + ' → ' + n1(b.font));
    if (dText) bits.push('文案改了');
    lines.push('~ ' + id + '  ' + b.label + '  ' + bits.join('  '));
  }

  const ga = {};
  for (const g of A.gaps) ga[g.id] = g.px;
  for (const g of B.gaps) {
    if (ga[g.id] == null || ga[g.id] === g.px) continue;
    lines.push('~ ' + g.id + '  ' + g.label + '  ' + ga[g.id] + 'px → ' + g.px + 'px');
  }

  console.log('diff ' + path.basename(aPath) + ' → ' + path.basename(bPath));
  console.log(lines.length ? lines.join('\n') : '（没有任何变化）');
}

/* ------------------------------ 标注图 ------------------------------ */

/** 在页面上叠一层编号框：位置由 window.__ds.toClient 换算，绝不会错位 */
function overlaySource(items) {
  const host = document.createElement('div');
  host.id = '__dsAnnot';
  Object.assign(host.style, {
    position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '99999',
  });

  const colors = {
    guide: 'rgba(255,214,10,0.75)',
    bg: 'rgba(80,200,255,0.6)',
    badge: 'rgba(255,45,146,0.85)',
    item: 'rgba(255,59,48,0.9)',
  };

  for (const it of items) {
    const col = colors[it.kind] || colors.item;
    const a = window.__ds.toClient(it.box[0], it.box[1]);
    const b = window.__ds.toClient(it.box[0] + it.box[2], it.box[1] + it.box[3]);
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      left: Math.round(a.x) + 'px',
      top: Math.round(a.y) + 'px',
      width: Math.max(2, Math.round(b.x - a.x)) + 'px',
      height: Math.max(2, Math.round(b.y - a.y)) + 'px',
      border: '1.5px ' + (it.kind === 'item' ? 'solid' : 'dashed') + ' ' + col,
      background: it.kind === 'item' ? 'rgba(255,59,48,0.07)' : 'transparent',
      boxSizing: 'border-box',
    });
    host.appendChild(box);

    const chip = document.createElement('div');
    chip.textContent = it.i + (it.id ? '·' + it.id : '');
    const above = a.y > 22;
    Object.assign(chip.style, {
      position: 'fixed',
      left: Math.round(a.x) + 'px',
      top: (above ? Math.round(a.y) - 19 : Math.round(a.y) + 2) + 'px',
      background: col,
      color: '#fff',
      font: '600 12px/1.5 -apple-system,sans-serif',
      padding: '1px 5px',
      borderRadius: '6px',
      whiteSpace: 'nowrap',
      maxWidth: '260px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    host.appendChild(chip);
  }
  document.body.appendChild(host);
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.log('[inspect] 跳过：没找到 playwright。\n' + HINT);
    return 0;
  }

  const tag = arg('tag', 'latest');
  const base = String(arg('base', DEFAULT_BASE)).replace(/\/+$/, '');
  const q = ['debug=1'];
  if (has('raw')) q.push('raw=1');
  if (has('long')) q.push('long=1');
  for (const k of ['word', 'en', 'cn', 'source', 'bg']) {
    const v = flag(k);
    if (typeof v === 'string') q.push(k + '=' + encodeURIComponent(v));
  }
  const url = base + '/?' + q.join('&');

  const browser = await chromium.launch();
  try {
    const viewport = has('desktop')
      ? { width: 1280, height: 900 }
      : { width: 390, height: 844 };
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: has('desktop') ? 1 : 2,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(
      () => window.__ds && typeof window.__ds.inspect === 'function' && window.__ds.state.layout,
      null,
      { timeout: 20000 }
    );
    /* 引导呼吸框会盖在画面上，标注图里不要它 */
    await page.evaluate(() => { try { window.__ds.guide.stop(); } catch (e) {} });

    const data = await page.evaluate(() => window.__ds.inspect());
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

    const jsonPath = path.join(OUT, 'inspect-' + tag + '.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    console.log('版面清单 ' + jsonPath);

    if (!has('no-shot')) {
      await page.evaluate(overlaySource, data.items);
      const shotPath = path.join(OUT, 'annot-' + tag + '.png');
      /* 海报比视口高时（长版 / 内容挤到加高）必须整页截，否则下半张会丢 */
      await page.screenshot({ path: shotPath, fullPage: has('full') });
      console.log('标注图   ' + shotPath);
    }

    /* 控制台打印精简对照表：编号 → id / 中文名 / 坐标 / 字号 */
    console.log('\n编号  id            中文名            坐标 [x, y, w, h]            字号');
    for (const it of data.items) {
      const box = it.box.map((v) => Math.round(v)).join(', ');
      console.log(
        String(it.i).padStart(3) + '   ' +
        it.id.padEnd(13) + '  ' +
        it.label.padEnd(16) + '  ' +
        ('[' + box + ']').padEnd(26) + '  ' +
        (it.font ? Math.round(it.font * 10) / 10 : '-')
      );
    }
    if (data.gaps.length) {
      console.log('\n间距：');
      for (const g of data.gaps) console.log('  ' + g.id.padEnd(16) + g.label.padEnd(18) + g.px + 'px');
    }
    if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
    return 0;
  } finally {
    await browser.close();
  }
}

(async () => {
  const d = flag('diff');
  if (has('diff')) {
    const rest = argv.slice(argv.indexOf('--diff') + 1).filter((s) => !s.startsWith('--'));
    if (rest.length < 2) {
      console.log('用法：node app/inspect.js --diff <改前.json|tag> <改后.json|tag>');
      process.exit(1);
    }
    const a = resolveShot(rest[0]);
    const b = resolveShot(rest[1]);
    if (!a || !b) {
      console.log('找不到文件：' + (!a ? rest[0] : rest[1]) + '（可传路径或 inspect-<tag> 的 tag）');
      process.exit(1);
    }
    diff(a, b);
    return;
  }
  try {
    process.exit(await main());
  } catch (e) {
    console.error('FAIL', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
