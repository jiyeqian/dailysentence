#!/usr/bin/env node

/* 海报体检：按「现象」量数字，**默认不出图** —— 沟通改用文本，省 token 也省事。

   与 inspect.js 的分工：
     inspect.js  给「编号 → id → 坐标 → 字号」的清单 + 编号标注图（给人看图认编号）
     measure.js  给「当前实现是否符合预期」的体检报告（给双方读数字，可 --json 给 AI 读）

   跑法（需先 node app/server.js，默认 8787）：
     NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
       node app/measure.js                          # 手机视口一次性体检
     node app/measure.js --voice                    # 连带量波形（面板、左右留白、与邻居间距）
     node app/measure.js --zoom badge-date=3        # 先把 2 区放到 3 倍再量（可重复）
     node app/measure.js --standalone               # 独立全屏形态桩（量 --stage-pt 补正）
     node app/measure.js --viewport desktop         # 桌面视口；也支持 402x874 这类写法
     node app/measure.js --json                     # 机器可读（AI 读这个最省）
     node app/measure.js --checks                   # 逐条给 PASS/FAIL，有 FAIL 时退出码 1
     node app/measure.js --crop 3 --dpr 3           # 唯一会写文件的开关：出 3 区的局部放大图

   产物：只有 --crop 才会写 app/shots/measure-crop.png（该目录已 gitignore）。
*/

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const HINT = '需要 playwright：\n' +
  '  NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node app/measure.js\n' +
  '（或用 npm i -D playwright && npx playwright install chromium 装一份）';

/* 海报圆角的设计值（与 app/public/app.js 的 POSTER_RADIUS 一致；这里只用于「期望值」对照） */
const POSTER_RADIUS = 32;
/* 波形宽度 = 正文列宽 × 0.9（与 WAVE_W_RATIO 一致），列宽 = 1080 − 2×48 */
const WAVE_W_RATIO = 0.9;
const TEXT_X = 48;

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

/** --zoom 可重复：收集所有 `--zoom <id>=<z>` */
const zooms = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--zoom' && argv[i + 1] && !argv[i + 1].startsWith('--')) zooms.push(argv[i + 1]);
}

/* ------------------------------ 页面内取数 ------------------------------ */

/**
 * 在页面里把体检项一次性读出来。全部走 __ds.inspect() 与 __ds 的既有出口，
 * 只有「波形面板 rect / 画布像素」这类必须碰 DOM 的读数才自己算 ——
 * 算法与 ui-check.js 的波形断言完全一致（面板 rect ↔ 3 区文字框），保证两处口径不漂。
 */
function probe() {
  const ds = window.__ds;
  const insp = ds.inspect();
  const c = document.getElementById('poster');
  const cr = c.getBoundingClientRect();
  const cs = getComputedStyle(c);
  const stage = document.getElementById('stage').getBoundingClientRect();
  const ctx = c.getContext('2d');
  const K = c.width / 1080;                 /* 位图 / 设计 */
  const dispK = cr.width / 1080;            /* 屏幕 / 设计 */
  const alphaAt = (x, y) => ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3];
  const item = (id) => insp.items.find((x) => x.id === id) || null;
  const r1 = (v) => Math.round(v * 10) / 10;

  /* 波形：只在与 3 区文字框的换算上有意义，所以用同一套屏幕坐标 */
  const wEl = document.getElementById('wave');
  const wr = wEl.getBoundingClientRect();
  const wcs = getComputedStyle(wEl);
  const bar = wEl.querySelector('i');
  const barN = wEl.querySelectorAll('i');
  const bw = bar ? parseFloat(getComputedStyle(bar).width) : 0;
  const regs = ds.state.regions || [];
  const enReg = regs.find((x) => x.id === 'en');
  const cnReg = regs.find((x) => x.id === 'cn');
  const dateReg = regs.find((x) => x.id === 'badge-date');
  const waveOn = !wEl.hidden && !!enReg && wcs.display !== 'none';
  const colW = (1080 - 2 * TEXT_X) * dispK;
  const wave = waveOn ? {
    panel: { x: r1(wr.x - cr.left), y: r1(wr.y - cr.top), w: r1(wr.width), h: r1(wr.height) },
    colW: r1(colW),
    expectW: r1(colW * WAVE_W_RATIO),
    inkLeft: r1(enReg.x * dispK),
    inkRight: r1((enReg.x + enReg.w) * dispK),
    padLeft: r1(wr.x - cr.left - enReg.x * dispK),
    padRight: r1((enReg.x + enReg.w) * dispK - (wr.x - cr.left + wr.width)),
    toCn: cnReg ? r1(ds.toClient(cnReg.x, cnReg.y).y - (wr.y + wr.height)) : null,
    toDate: dateReg ? r1(wr.y - ds.toClient(dateReg.x, dateReg.y + dateReg.h).y) : null,
    bars: barN.length,
    cover: wr.width ? r1(((bw * barN.length) / wr.width) * 1000) / 1000 : 0,
    /* 「无底板」：没有背景色 / 背景图 / 描边 / 圆角 / 毛玻璃 —— 与回归同一套判据 */
    bare: (wcs.backgroundColor === 'rgba(0, 0, 0, 0)' || wcs.backgroundColor === 'transparent') &&
      wcs.backgroundImage === 'none' && wcs.backdropFilter === 'none' &&
      (!wcs.boxShadow || wcs.boxShadow === 'none') && parseFloat(wcs.borderRadius) === 0,
  } : null;

  const radius = {
    css: r1(parseFloat(cs.borderRadius)),
    expect: r1(POSTER_RADIUS * dispK),
    corners: [alphaAt(1, 1), alphaAt(c.width - 2, 1), alphaAt(1, c.height - 2), alphaAt(c.width - 2, c.height - 2)],
    inside: alphaAt(40 * K, 40 * K),
    midEdge: alphaAt(c.width / 2, 1),
  };

  /* 文字区：编号 / id / 中文名 / box / 字号 / 该区交互倍率 */
  const regions = insp.items
    .filter((it) => ['badge-date', 'en', 'cn', 'source'].includes(it.id))
    .map((it) => ({
      i: it.i, id: it.id, label: it.label,
      box: it.box.map(r1), font: it.font,
      fx: insp.text.fx[it.id],
    }));

  return {
    canvas: insp.canvas,
    page: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    display: {
      stage: insp.stage,
      stageRect: { w: r1(stage.width), h: r1(stage.height) },
      rect: { x: r1(cr.x), y: r1(cr.y), w: r1(cr.width), h: r1(cr.height) },
      fitW: r1(Math.min(stage.width, (stage.height * 1080) / 1920)),
    },
    radius,
    layout: {
      /* 顶图高只在 state.layout 里（inspect 的契约里没有它，别去猜） */
      imgH: ds.state.layout && ds.state.layout.imgBlock ? r1(ds.state.layout.imgBlock.h) : null,
      band: insp.text.band ? { top: r1(insp.text.band.top), h: r1(insp.text.band.h) } : null,
      card: item('card') ? item('card').box.map(r1) : null,
      base: insp.text.base,
      regions,
      gaps: insp.gaps,
    },
    wave,
    voice: {
      hasAudio: !!(ds.state.apiData && ds.state.apiData.audio && ds.state.apiData.audio.normal),
      active: !!insp.voice,
      diag: insp.voiceDiag,
    },
    state: {
      voice: insp.voice, edit: insp.edit, hidden: ds.state.hidden,
      fx: insp.text.fx, standalone: insp.stage.standalone,
    },
  };
}

/* ------------------------------ 对照检查 ------------------------------ */

function buildChecks(d, opts) {
  const ck = [];
  const add = (name, expect, actual, pass) => ck.push({ name, expect, actual, pass });
  const eq = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1.5 : tol);

  add('画布尺寸', opts.fit ? '按设备比例（?fit=device）' : '1080×1920',
    d.canvas.w + '×' + d.canvas.h,
    opts.fit ? d.canvas.adaptive === true : (d.canvas.w === 1080 && d.canvas.h === 1920));

  add('显示等比且宽度充满优先', '宽 = min(舞台宽, 高×9/16)',
    d.display.rect.w + '（期望 ' + d.display.fitW + '）',
    eq(d.display.rect.w, d.display.fitW) && eq(d.display.rect.w / d.display.rect.h, 1080 / 1920, 0.002));

  add('海报圆角 = 32 设计值 × 显示比例', d.radius.expect + 'px', d.radius.css + 'px', eq(d.radius.css, d.radius.expect, 0.6));
  add('海报四角透明（圆角画进成品）', '四角 alpha = 0', JSON.stringify(d.radius.corners), d.radius.corners.every((a) => a === 0));
  add('圆角内 / 边中点不透明', '255 / 255', d.radius.inside + ' / ' + d.radius.midEdge, d.radius.inside === 255 && d.radius.midEdge === 255);

  if (d.layout.band) {
    add('活动区高度为正', '> 0', d.layout.band.h + 'px', d.layout.band.h > 0);
  }
  add('保底倍率不超过 1（进入即设计基准）', '≤ 1', String(d.layout.base), d.layout.base <= 1);
  for (const rg of d.layout.regions) {
    add(rg.i + ' 区（' + rg.label + '）字号 = 设计基准 × base × fx', '> 0',
      rg.font + '（fx ' + rg.fx + '）', rg.font > 0 && rg.fx >= 0.6 && rg.fx <= 3.001);
  }

  if (d.wave) {
    add('波形宽度 = 正文列宽 × 90%', d.wave.expectW + 'px', d.wave.panel.w + 'px', eq(d.wave.panel.w, d.wave.expectW));
    add('波形相对 3 区文字框左右留白相等', '差 ≤ 1px',
      '左 ' + d.wave.padLeft + ' / 右 ' + d.wave.padRight,
      Math.abs(d.wave.padLeft - d.wave.padRight) <= 1);
    add('波形位于 3 区文字框内（不偏出左右）', '左留白 ≥ 0 且右留白 ≥ 0',
      '左 ' + d.wave.padLeft + ' / 右 ' + d.wave.padRight,
      d.wave.padLeft >= -1 && d.wave.padRight >= -1);
    add('波形没有任何底板（只有竖条）', '背景透明 / 无描边 / 无圆角 / 无毛玻璃', String(d.wave.bare), d.wave.bare === true);
    add('波形不碰中文句', '≥ 0px', d.wave.toCn + 'px', d.wave.toCn == null || d.wave.toCn >= 0);
    add('波形不顶日期胶囊', '≥ 0px', d.wave.toDate + 'px', d.wave.toDate == null || d.wave.toDate >= 0);
    add('竖条数量与覆盖率', '≥ 8 根、覆盖 < 35%', d.wave.bars + ' 根 / ' + (d.wave.cover * 100).toFixed(0) + '%',
      d.wave.bars >= 8 && d.wave.cover < 0.35);
  }

  add('有可用发音文件', 'true', String(d.voice.hasAudio), d.voice.hasAudio === true);
  return ck;
}

/* ------------------------------ 打印 ------------------------------ */

function print(d, ck, opts) {
  const f2 = (v) => (v == null ? '-' : v);
  const box = (b) => (b ? '[' + b.join(', ') + ']' : '-');
  const L = [];
  L.push('═══ 海报体检 · ' + opts.viewport + ' · ' + opts.url + ' ═══');
  L.push('① 画布与显示');
  L.push('   画布 ' + d.canvas.w + '×' + d.canvas.h + '  U=' + d.canvas.u +
    '  adaptive=' + d.canvas.adaptive + '  safe ' + d.canvas.safe.top + '/' + d.canvas.safe.bottom);
  L.push('   舞台 ' + d.display.stageRect.w + '×' + d.display.stageRect.h +
    '  standalone=' + d.display.stage.standalone + '  padTop=' + d.display.stage.padTop +
    '  screenH=' + d.display.stage.screenH + '  frameH=' + d.display.stage.frameH);
  L.push('   海报 ' + d.display.rect.w + '×' + d.display.rect.h + ' @ (' + d.display.rect.x + ', ' + d.display.rect.y + ')' +
    '  圆角 ' + d.radius.css + 'px / 期望 ' + d.radius.expect + 'px');
  L.push('② 三段几何（设计坐标）');
  L.push('   1 顶图高 ' + f2(d.layout.imgH) + '   活动区 ' + (d.layout.band ? JSON.stringify(d.layout.band) : '-') +
    '   6 信息卡 ' + box(d.layout.card) + '   base ' + d.layout.base);
  for (const rg of d.layout.regions) {
    L.push('   ' + rg.i + ' ' + rg.id.padEnd(11) + box(rg.box).padEnd(24) + ' font ' + rg.font + '  fx ' + rg.fx);
  }
  if (opts.gaps && d.layout.gaps.length) {
    L.push('   间距：' + d.layout.gaps.map((g) => g.id + ' ' + g.px).join(' · '));
  }
  if (d.wave) {
    L.push('③ 波形');
    L.push('   面板 ' + box([d.wave.panel.x, d.wave.panel.y, d.wave.panel.w, d.wave.panel.h]) +
      '  相对 3 区文字框：左留白 ' + d.wave.padLeft + ' / 右留白 ' + d.wave.padRight +
      (Math.abs(d.wave.padLeft - d.wave.padRight) <= 1 ? '  ✓相等' : '  ✗不等'));
    L.push('   ' + d.wave.bars + ' 根竖条 · 横向覆盖 ' + (d.wave.cover * 100).toFixed(0) + '% · 无底板 ' +
      (d.wave.bare ? '✓' : '✗') + '  距中文句 ' + f2(d.wave.toCn) + 'px · 距日期胶囊 ' + f2(d.wave.toDate) + 'px');
  } else if (opts.voice) {
    L.push('③ 波形：此刻没有波形（未在播放）');
  }
  L.push('④ 圆角自证');
  L.push('   四角 alpha ' + JSON.stringify(d.radius.corners) + ' · 圆角内 ' + d.radius.inside + ' · 上边中点 ' + d.radius.midEdge);
  L.push('⑤ 语音自证');
  L.push('   hasAudio=' + d.voice.hasAudio + ' · 正在播放=' + d.voice.active);
  L.push('   voiceDiag ' + JSON.stringify(d.voice.diag));
  if (opts.checks && ck) {
    L.push('─── checks ───');
    for (const c of ck) {
      L.push('   ' + (c.pass ? '✓' : '✗') + ' ' + c.name + '   期望 ' + c.expect + '｜实测 ' + c.actual);
    }
    const bad = ck.filter((c) => !c.pass).length;
    L.push(bad ? '   ✗ ' + bad + ' 项未通过' : '   ✓ 全部通过');
  }
  console.log(L.join('\n'));
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.log('[measure] 跳过：没找到 playwright。\n' + HINT);
    return 0;
  }

  const base = String(arg('base', DEFAULT_BASE)).replace(/\/+$/, '');
  const vpName = String(arg('viewport', '390x844'));
  const desktop = vpName === 'desktop';
  let vw = 390;
  let vh = 844;
  let dpr = 2;
  if (desktop) { vw = 1280; vh = 900; dpr = 1; } else if (/^\d+x\d+$/.test(vpName)) {
    const p = vpName.split('x').map(Number);
    vw = p[0];
    vh = p[1];
  }
  if (has('dpr')) dpr = Number(arg('dpr', dpr)) || dpr;

  const opts = {
    viewport: vw + 'x' + vh + '@' + dpr + 'x',
    fit: has('fit'),
    voice: has('voice'),
    checks: has('checks'),
    gaps: has('gaps') || has('checks'),
  };

  const q = ['debug=1'];
  if (has('raw')) q.push('raw=1');
  if (has('long')) q.push('long=1');
  if (has('fit')) q.push('fit=device');
  for (const k of ['word', 'en', 'cn', 'source', 'bg']) {
    const v = flag(k);
    if (typeof v === 'string') q.push(k + '=' + encodeURIComponent(v));
  }
  opts.url = '?' + q.join('&');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: vw, height: vh },
      deviceScaleFactor: dpr,
      hasTouch: !desktop,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    if (has('standalone')) {
      /* 独立全屏（加到主屏）形态的桩：Chromium 里复现不了，注入 standalone 与物理屏高 */
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { get: () => true });
        Object.defineProperty(window.screen, 'height', { get: () => 874 });
      });
    }

    await page.goto(base + '/' + opts.url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(
      () => window.__ds && typeof window.__ds.inspect === 'function' && window.__ds.state.layout,
      null,
      { timeout: 20000 }
    );
    await page.waitForTimeout(700);

    /* --zoom：走 __ds.setZoom（与手势同一条钳制路径），可重复 */
    for (const z of zooms) {
      const i = z.indexOf('=');
      const id = i < 0 ? z : z.slice(0, i);
      const val = i < 0 ? 1 : Number(z.slice(i + 1));
      await page.evaluate(([id2, v]) => window.__ds.setZoom(id2, v), [id, val]);
      await page.waitForTimeout(450);
    }
    if (has('voice')) {
      await page.evaluate(() => window.__ds.playVoice());
      await page.waitForTimeout(600);
    }

    const d = await page.evaluate(probe);
    const ck = opts.checks ? buildChecks(d, opts) : null;

    if (has('crop')) {
      const target = String(arg('crop', ''));
      const clip = await page.evaluate(([t]) => {
        const ds = window.__ds;
        const c = document.getElementById('poster');
        const cr = c.getBoundingClientRect();
        const K = cr.width / 1080;
        const pad = 12;
        if (t === 'wave') {
          const r = document.getElementById('wave').getBoundingClientRect();
          return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
        }
        const it = (ds.inspect().items || []).find((x) => x.id === t || String(x.i) === t);
        if (it) {
          return {
            x: cr.left + it.box[0] * K - pad, y: cr.top + it.box[1] * K - pad,
            width: it.box[2] * K + pad * 2, height: it.box[3] * K + pad * 2,
          };
        }
        if (/^-?[\d.]+(,-?[\d.]+){3}$/.test(t)) {
          const v = t.split(',').map(Number);
          return { x: cr.left + v[0] * K, y: cr.top + v[1] * K, width: v[2] * K, height: v[3] * K };
        }
        return null;
      }, [target]);
      if (!clip) {
        console.log('[measure] --crop 认不出目标：' + target + '\n  可用：wave / 区域编号或 id（如 3 或 en）/ 设计坐标 x,y,w,h');
        return 1;
      }
      if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
      const shot = path.join(OUT, 'measure-crop.png');
      /* clip 落在视口之外要配 fullPage（长版 / 海报比视口高时），见 skill 的踩坑备忘 */
      await page.screenshot({ path: shot, clip, fullPage: true });
      console.log('局部放大图 ' + shot + '  （clip ' + JSON.stringify(clip).replace(/"/g, '') + '）');
    }

    if (has('json')) {
      console.log(JSON.stringify({ options: opts, ...d, checks: ck }, null, 2));
    } else {
      print(d, ck, opts);
    }
    if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));

    if (opts.checks && ck && ck.some((c) => !c.pass)) return 1;
    return 0;
  } finally {
    await browser.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('[measure] 失败：' + (e && e.message));
  process.exit(2);
});
