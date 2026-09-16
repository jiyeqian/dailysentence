/* =========================================================================
 * 每日一句 · 海报生成器
 * 从欧路词典「英语每日一句」抓取内容，与用户的乐词模板卡片合成一张手机海报。
 * 全部合成在浏览器 Canvas 完成，图片不上传任何服务器。
 * ========================================================================= */
'use strict';

/* ----------------------------- 基本常量 ------------------------------ */

const CW = 1080;
const CH = 1920;

const F_SANS =
  '"AppSans","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",-apple-system,sans-serif';
const F_SERIF = '"AppSerif","Songti SC",STSong,Georgia,"Times New Roman",serif';
const F_MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';

const MX = 84;            // 文字左右安全边距
const PANEL_BOTTOM_GAP = 40;

const POS_COLOR = {
  'n.': '#2563eb', 'v.': '#7c3aed', 'vt.': '#7c3aed', 'vi.': '#7c3aed',
  'adj.': '#d97706', 'adv.': '#059669', 'prep.': '#0891b2', 'conj.': '#db2777',
  'pron.': '#4f46e5', 'int.': '#ea580c', 'aux.': '#64748b', 'abbr.': '#64748b',
};

/* ------------------------------- 状态 -------------------------------- */

const DEFAULT_RATIOS = { L: 0.0364, T: 0.5934, R: 0.9636, B: 0.8491 };

const state = {
  apiData: null,
  content: { word: '', phonetic: '', en: '', cn: '', defs: [], examples: [], source: '', date: '', dateCN: '' },
  bgImage: null,
  template: null,
  ratios: { ...DEFAULT_RATIOS },
  opts: {
    bgStyle: 'cover',
    fontScale: 1,
    showDate: true,
    showRule: true,
    showSource: true,
    showExamples: false,
  },
};

const $ = (id) => document.getElementById(id);
const cvs = $('poster');
const QS = new URLSearchParams(location.search);

const FROST_OK = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    c.filter = 'blur(2px)';
    return c.filter === 'blur(2px)';
  } catch (e) {
    return false;
  }
})();

/* ------------------------------ 小工具 ------------------------------- */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const RE_LATIN = /[A-Za-z0-9][A-Za-z0-9'’\-.\u2011]*/;
const NO_LINE_START = '，。、；：？！）】》」』…·%,.;:?!)]}';

/** 把文本切成「不可再拆的最小单元」：英文词 / 空格 / 单个 CJK 字符 */
function tokenize(text) {
  const out = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’\-.\u2011]*|[ \t]+|[\s\S]/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

/** 按宽度折行（中文逐字断行，英文按词断行，避免行首标点） */
function wrapText(ctx, text, maxWidth) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const tokens = tokenize(src);
  const lines = [];
  let line = '';
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (/^[ ]+$/.test(tk)) {
      if (line) line += ' ';
      continue;
    }
    const next = line + tk;
    if (line.trim() && ctx.measureText(next).width > maxWidth) {
      if (NO_LINE_START.indexOf(tk) >= 0) {
        lines.push((line + tk).replace(/\s+$/, ''));
        line = '';
        continue;
      }
      lines.push(line.replace(/\s+$/, ''));
      line = tk;
    } else {
      line = next;
    }
  }
  if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  return lines;
}

/** 逐字带字距绘制（用于小标签，兼容不支持 letterSpacing 的浏览器） */
function drawSpaced(ctx, text, x, y, spacing) {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return cx - x - spacing;
}
function measureSpaced(ctx, text, spacing) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return Math.max(0, w - spacing);
}

function drawCover(ctx, im, dx, dy, dw, dh) {
  const s = Math.max(dw / im.width, dh / im.height);
  const w = im.width * s;
  const h = im.height * s;
  ctx.drawImage(im, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

/** 背景底噪，掩盖低分辨率配图放大后的塑料感 */
let _noise = null;
function noisePattern(ctx) {
  if (!_noise) {
    const c = document.createElement('canvas');
    c.width = c.height = 180;
    const x = c.getContext('2d');
    const d = x.createImageData(180, 180);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      d.data[i + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    _noise = c;
  }
  return ctx.createPattern(_noise, 'repeat');
}

/* ============================ 数据获取 ============================= */

function fmtDateBadge(date, dateISO) {
  if (date) return date;
  return dateISO || '';
}

async function loadDaily(force) {
  setOverlay(true, '正在获取今日句子…');
  let data = null;
  try {
    const r = await fetch('/api/daily' + (force ? '?refresh=1' : ''), { cache: 'no-store' });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || '接口异常');
    data = j;
    try { localStorage.setItem('ds:last', JSON.stringify(j)); } catch (e) {}
  } catch (err) {
    const cached = safeGet('ds:last');
    if (cached) {
      data = cached;
      toast('网络不可用，已使用上次缓存的内容');
    } else {
      setOverlay(false);
      $('subtitle').textContent = '获取失败：' + err.message;
      toast('获取失败：' + err.message);
      return;
    }
  }

  state.apiData = data;
  state.content = {
    word: data.word || '',
    phonetic: data.phonetic || '',
    en: data.en || '',
    cn: data.cn || '',
    defs: (data.definitions || []).slice(),
    examples: (data.examples || []).slice(),
    source: (data.source && data.source.author) || '',
    date: data.date || '',
    dateCN: data.dateCN || '',
  };
  /* 便于分享 / 调试：允许用 ?word=&en=&cn= 覆盖文案 */
  ['word', 'en', 'cn', 'source'].forEach((k) => {
    const v = QS.get(k);
    if (v) state.content[k] = v;
  });
  fillForm();
  $('subtitle').textContent =
    (data.date ? data.date + ' · ' : '') + (data.word ? '关键词 ' + data.word : '今日一句');
  $('linkSource').href = data.permalink || 'https://dict.eudic.net/home/dailysentence';

  await loadBackground(data.image);
  render();
}

function safeGet(k) {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null');
  } catch (e) {
    return null;
  }
}

async function loadBackground(url) {
  if (!url) return;
  const im = await loadImage(url).catch(() => null);
  if (im) {
    state.bgImage = im;
    setOverlay(false);
  } else {
    const cached = safeGet('ds:last');
    if (cached && cached.image && cached.image !== url) {
      const im2 = await loadImage(cached.image).catch(() => null);
      if (im2) state.bgImage = im2;
    }
    setOverlay(false);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = 'sync';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片加载失败'));
    im.src = src;
  });
}

/* ============================ 模板与自动识别 ========================= */

async function loadTemplate(src) {
  const im = await loadImage(src);
  state.template = im;
  detectCard(im);
  syncRatioSliders();
}

/**
 * 自动识别模板中「个人信息卡片」的位置：
 * 对缩略图做「近纯白」二值化 + 连通域，取不接触画布边缘的最大白块。
 */
function detectCard(img) {
  const SW = 200;
  const SH = Math.max(1, Math.round((img.height * SW) / img.width));
  const c = document.createElement('canvas');
  c.width = SW;
  c.height = SH;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, SW, SH);
  let data;
  try {
    data = x.getImageData(0, 0, SW, SH).data;
  } catch (e) {
    return;
  }

  const mask = new Uint8Array(SW * SH);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = Math.min(data[p], data[p + 1], data[p + 2]) >= 248 ? 1 : 0;
  }

  const seen = new Uint8Array(SW * SH);
  const stack = new Int32Array(SW * SH);
  let best = null;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let count = 0;
    let border = false;
    let minX = SW, maxX = -1, minY = SH, maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const py = (idx / SW) | 0;
      const px = idx - py * SW;
      count++;
      if (py === 0 || px === 0 || py === SH - 1 || px === SW - 1) border = true;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (px < SW - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (py > 0 && mask[idx - SW] && !seen[idx - SW]) { seen[idx - SW] = 1; stack[sp++] = idx - SW; }
      if (py < SH - 1 && mask[idx + SW] && !seen[idx + SW]) { seen[idx + SW] = 1; stack[sp++] = idx + SW; }
    }
    if (border) continue;
    if (count < SW * SH * 0.04) continue;
    if (!best || count > best.count) best = { count, minX, maxX, minY, maxY };
  }

  if (best && best.maxX > best.minX && best.maxY > best.minY) {
    state.ratios = {
      L: best.minX / SW,
      T: best.minY / SH,
      R: (best.maxX + 1) / SW,
      B: (best.maxY + 1) / SH,
    };
  } else {
    state.ratios = { ...DEFAULT_RATIOS };
  }
}

function syncRatioSliders() {
  const r = state.ratios;
  $('rTop').value = Math.round(r.T * 100);
  $('rH').value = Math.round((r.B - r.T) * 100);
  $('rM').value = Math.round(r.L * 100);
  updateRangeLabels();
}

function updateRangeLabels() {
  $('vTop').textContent = $('rTop').value + '%';
  $('vH').textContent = $('rH').value + '%';
  $('vM').textContent = $('rM').value + '%';
  $('vFont').textContent = $('rFont').value + '%';
}

/* ============================== 布局 ================================ */

const T = (size, weight, family) => `${weight} ${Math.round(size)}px ${family}`;

function computeLayout(ctx) {
  const K = state.opts.fontScale;
  const r = state.ratios;

  /* ---- 底部解析面板：先算高度，它决定卡片能被压到多低 ---- */
  const panelX = Math.round(r.L * CW);
  const panelW = Math.round((r.R - r.L) * CW);
  const padX = 46;
  const padY = 34;
  const innerW = panelW - padX * 2;

  const wordSize = 47 * K;
  const phSize = 31 * K;
  const row1H = wordSize * 1.3;

  const defSize = 36 * K;
  const defLH = defSize * 1.62;
  const chipSize = 25 * K;

  const defItems = [];
  for (const d of state.content.defs) {
    let chipW = 0;
    if (d.pos) {
      ctx.font = T(chipSize, 700, F_SANS);
      chipW = ctx.measureText(d.pos).width + chipSize * 1.05;
    }
    ctx.font = T(defSize, 400, F_SANS);
    const lines = wrapText(ctx, d.text, innerW - chipW - 18);
    defItems.push({ pos: d.pos || '', chipW, lines, h: Math.max(defLH, lines.length * defLH) });
  }

  const exItems = [];
  if (state.opts.showExamples) {
    for (const e of state.content.examples.slice(0, 2)) {
      const enSize = 28 * K;
      const cnSize = 26 * K;
      ctx.font = T(enSize, 400, F_SANS);
      const enLines = wrapText(ctx, e.en, innerW - 24);
      ctx.font = T(cnSize, 400, F_SANS);
      const cnLines = wrapText(ctx, e.cn, innerW - 24);
      exItems.push({ enLines, cnLines, enSize, cnSize, h: enLines.length * enSize * 1.5 + cnLines.length * cnSize * 1.55 });
    }
  }

  const sourceH = state.opts.showSource && state.content.source ? 27 * K * 1.5 : 0;
  const footH = 22 * K * 1.6;

  let contentH = row1H + 16;
  for (const it of defItems) contentH += it.h + 10;
  if (exItems.length) contentH += 10 + exItems.reduce((s, e) => s + e.h + 16, 0);
  if (sourceH) contentH += sourceH + 4;

  const panelH = Math.round(padY * 2 + contentH + 24 + 1 + 16 + footH);
  const panelY = CH - PANEL_BOTTOM_GAP - panelH;

  /* ---- 个人信息卡片：取模板中的相对位置，必要时上移避让 ---- */
  const cardX = Math.round(r.L * CW);
  const cardW = Math.round((r.R - r.L) * CW);
  const cardH = Math.round((r.B - r.T) * CH);
  let cardY = Math.round(r.T * CH);
  const minGap = 26;
  const maxCardY = panelY - minGap - cardH;
  let shifted = false;
  if (cardY > maxCardY) {
    cardY = maxCardY;
    shifted = true;
  }

  /* ---- 顶部文字块：自适应字号，保证不压到卡片 ---- */
  const textTop = 96;
  const avail = Math.max(220, cardY - 40 - textTop);
  const titleBase = 118 * K;

  let block = null;
  for (let f = 1; f >= 0.7; f -= 0.025) {
    block = buildTextBlock(ctx, titleBase * f, avail);
    if (block.total <= avail) break;
  }
  if (block.total > avail) block = buildTextBlock(ctx, titleBase * 0.7, avail);

  return {
    K, r,
    textTop,
    title: block.title,
    rule: block.rule,
    en: block.en,
    cn: block.cn,
    textBottom: textTop + block.total,
    card: { x: cardX, y: cardY, w: cardW, h: cardH, shifted },
    panel: {
      x: panelX, y: panelY, w: panelW, h: panelH,
      padX, padY, innerW,
      wordSize, phSize, row1H,
      defItems, defLH, chipSize, defSize,
      exItems, sourceH, footH,
    },
  };
}

function buildTextBlock(ctx, titleSize, avail) {
  const K = state.opts.fontScale;
  const maxW = CW - 2 * MX;

  /* 日期徽标占位 → 标题可用宽度 */
  let badgeW = 0;
  if (state.opts.showDate && state.content.date) {
    ctx.font = T(25, 600, F_SANS);
    badgeW = measureSpaced(ctx, state.content.date, 2.5) + 56;
  }

  /* 标题（关键词）：自动缩到一行放得下 */
  let ts = titleSize;
  const word = state.content.word || '每日一句';
  const titleMax = maxW - badgeW - 40;
  ctx.font = T(ts, 700, F_SERIF);
  while (ts > 56 && ctx.measureText(word).width > titleMax) {
    ts -= 3;
    ctx.font = T(ts, 700, F_SERIF);
  }
  const titleH = ts * 1.12;

  /* 分隔线 */
  const rule = { on: state.opts.showRule, gapTop: 30, h: 4, w: 86, gapBottom: 32 };

  let y = titleH;
  if (rule.on) y += rule.gapTop + rule.h + rule.gapBottom;
  else y += 26;

  /* 英文 */
  const enSize = 42 * K;
  const enLH = enSize * 1.32;
  ctx.font = T(enSize, 400, F_SANS);
  const enLines = wrapText(ctx, state.content.en, maxW);
  y += enLines.length * enLH;

  /* 中文 */
  y += 34 * K;
  const cnSize = 42 * K;
  const cnLH = cnSize * 1.46;
  ctx.font = T(cnSize, 400, F_SANS);
  const cnLines = wrapText(ctx, state.content.cn, maxW);
  y += cnLines.length * cnLH;

  return {
    total: y,
    title: { size: ts, h: titleH, text: word, badgeW },
    rule: Object.assign({}, rule, { y: titleH + rule.gapTop }),
    en: { size: enSize, lh: enLH, lines: enLines, y: titleH + (rule.on ? rule.gapTop + rule.h + rule.gapBottom : 26) },
    cn: {
      size: cnSize, lh: cnLH, lines: cnLines,
      y: titleH + (rule.on ? rule.gapTop + rule.h + rule.gapBottom : 26) + enLines.length * enLH + 34 * K,
    },
  };
}

/* ============================== 绘制 ================================ */

function render() {
  const ctx = cvs.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';

  const L = computeLayout(ctx);

  drawBackground(ctx, L);
  drawScrim(ctx, L);
  drawGrain(ctx);
  drawTopText(ctx, L);
  drawProfileCard(ctx, L);
  drawPanel(ctx, L);
  return L;
}

/* --------------------------- 背景 --------------------------- */

function drawBackground(ctx, L) {
  const im = state.bgImage;
  if (!im) {
    const g = ctx.createLinearGradient(0, 0, CW, CH);
    g.addColorStop(0, '#16233a');
    g.addColorStop(1, '#070b13');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, CH);
    return;
  }

  const style = state.opts.bgStyle;
  if (style === 'cover') {
    drawCover(ctx, im, 0, 0, CW, CH);
    return;
  }

  /* 模糊铺底 */
  ctx.save();
  if (FROST_OK) ctx.filter = 'blur(42px) brightness(0.48) saturate(1.12)';
  drawCover(ctx, im, -60, -60, CW + 120, CH + 120);
  ctx.restore();

  /* 清晰主图：放在「文字块底部」到「卡片顶部」之间 */
  const freeTop = Math.min(L.textBottom + 26, L.card.y - 200);
  const freeBottom = L.card.y - 22;
  const freeH = freeBottom - freeTop;
  if (freeH < 130) return;

  const aspect = im.width / im.height;

  if (style === 'band') {
    let bh = Math.min(freeH * 1.16, 760);
    let bw = bh * aspect;
    if (bw > CW) {
      bw = CW;
      bh = bw / aspect;
    }
    const bx = (CW - bw) / 2;
    const by = freeTop + (freeH - bh) / 2;
    ctx.drawImage(feathered(im, bw, bh, bh * 0.26), bx, by, bw, bh);
  } else {
    /* 图片卡片 */
    let bw = CW - MX * 1.2;
    let bh = bw / aspect;
    if (bh > freeH) {
      bh = freeH;
      bw = bh * aspect;
    }
    if (bw > CW - MX) {
      bw = CW - MX;
      bh = bw / aspect;
    }
    const bx = (CW - bw) / 2;
    const by = freeTop + (freeH - bh) / 2;
    const r = 30;
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, r);
    ctx.shadowColor = 'rgba(4,10,22,0.55)';
    ctx.shadowBlur = 46;
    ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#0a1018';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, r);
    ctx.clip();
    ctx.drawImage(im, bx, by, bw, bh);
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    g.addColorStop(0, 'rgba(4,10,22,0.22)');
    g.addColorStop(1, 'rgba(4,10,22,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw, bh);
    ctx.restore();
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, r);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

/** 生成上下边缘羽化的图片，让清晰图与模糊底自然衔接 */
function feathered(im, w, h, feather) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(im, 0, 0, c.width, c.height);
  x.globalCompositeOperation = 'destination-in';
  const f = Math.min(0.42, feather / c.height);
  const g = x.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(f, 'rgba(0,0,0,1)');
  g.addColorStop(1 - f, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 顶部压暗 + 底部压暗 + 四角暗角 */
function drawScrim(ctx, L) {
  const topEnd = Math.max(620, L.textBottom + 140);

  const g = ctx.createLinearGradient(0, 0, 0, topEnd);
  g.addColorStop(0, 'rgba(6,11,22,0.72)');
  g.addColorStop(0.42, 'rgba(6,11,22,0.42)');
  g.addColorStop(1, 'rgba(6,11,22,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, topEnd);
  ctx.fillStyle = 'rgba(6,11,22,0.10)';
  ctx.fillRect(0, 0, CW, CH);

  const gb = ctx.createLinearGradient(0, CH - 620, 0, CH);
  gb.addColorStop(0, 'rgba(6,11,22,0)');
  gb.addColorStop(1, 'rgba(6,11,22,0.55)');
  ctx.fillStyle = gb;
  ctx.fillRect(0, CH - 620, CW, 620);

  const v = ctx.createRadialGradient(CW / 2, CH * 0.44, CW * 0.26, CW / 2, CH * 0.5, CH * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, CW, CH);
}

function drawGrain(ctx) {
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = noisePattern(ctx);
  ctx.fillRect(0, 0, CW, CH);
  ctx.restore();
}

/* --------------------------- 顶部文字 --------------------------- */

function drawTopText(ctx, L) {
  const shadow = () => {
    ctx.shadowColor = 'rgba(3,8,18,0.55)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 4;
  };
  const noShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };

  /* 日期徽标 */
  if (state.opts.showDate && state.content.date) {
    const label = state.content.date;
    ctx.font = T(25, 600, F_SANS);
    const tw = measureSpaced(ctx, label, 2.5);
    const pw = tw + 56;
    const ph = 52;
    const px = CW - MX - pw;
    const py = L.textTop + 4;
    ctx.save();
    roundRect(ctx, px, py, pw, ph, ph / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.textBaseline = 'middle';
    drawSpaced(ctx, label, px + 28, py + ph / 2 + 1, 2.5);
    ctx.textBaseline = 'alphabetic';
  }

  /* 标题 */
  const t = L.title;
  const ty = L.textTop + t.size * 0.86;
  ctx.save();
  ctx.font = T(t.size, 700, F_SERIF);
  ctx.fillStyle = '#ffffff';
  shadow();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = t.size * 0.055;
  ctx.lineJoin = 'round';
  ctx.strokeText(t.text, MX, ty);
  ctx.fillText(t.text, MX, ty);
  ctx.restore();

  /* 分隔线 */
  if (L.rule.on) {
    ctx.save();
    const g = ctx.createLinearGradient(MX, 0, MX + L.rule.w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0.12)');
    ctx.fillStyle = g;
    roundRect(ctx, MX, L.textTop + L.rule.y, L.rule.w, L.rule.h, L.rule.h / 2);
    ctx.fill();
    ctx.restore();
  }

  /* 英文 */
  ctx.save();
  ctx.font = T(L.en.size, 400, F_SANS);
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  shadow();
  L.en.lines.forEach((ln, i) => {
    ctx.fillText(ln, MX, L.textTop + L.en.y + i * L.en.lh + L.en.size * 0.86);
  });
  ctx.restore();

  /* 中文 */
  ctx.save();
  ctx.font = T(L.cn.size, 400, F_SANS);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  shadow();
  L.cn.lines.forEach((ln, i) => {
    ctx.fillText(ln, MX, L.textTop + L.cn.y + i * L.cn.lh + L.cn.size * 0.86);
  });
  ctx.restore();
  noShadow();
}

/* --------------------------- 个人信息卡片 --------------------------- */

function drawProfileCard(ctx, L) {
  const c = L.card;
  const src = state.ratios;

  ctx.save();
  roundRect(ctx, c.x, c.y, c.w, c.h, 18);
  ctx.shadowColor = 'rgba(4,10,22,0.42)';
  ctx.shadowBlur = 46;
  ctx.shadowOffsetY = 20;
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  if (state.template) {
    const tw = state.template.width;
    const th = state.template.height;
    ctx.save();
    roundRect(ctx, c.x, c.y, c.w, c.h, 18);
    ctx.clip();
    ctx.drawImage(
      state.template,
      src.L * tw, src.T * th, (src.R - src.L) * tw, (src.B - src.T) * th,
      c.x, c.y, c.w, c.h
    );
    ctx.restore();
  }
}

/* --------------------------- 底部解析面板 --------------------------- */

function drawPanel(ctx, L) {
  const P = L.panel;
  const R = 30;

  /* 毛玻璃底 */
  ctx.save();
  roundRect(ctx, P.x, P.y, P.w, P.h, R);
  ctx.clip();
  if (FROST_OK) {
    ctx.filter = 'blur(30px) saturate(1.2) brightness(1.08)';
    ctx.drawImage(ctx.canvas, 0, 0, CW, CH, 0, 0, CW, CH);
    ctx.filter = 'none';
  }
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.fillRect(P.x, P.y, P.w, P.h);
  ctx.restore();

  ctx.save();
  roundRect(ctx, P.x, P.y, P.w, P.h, R);
  ctx.shadowColor = 'rgba(4,10,22,0.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  /* 左侧强调竖条 */
  ctx.save();
  const barH = Math.min(P.h - P.padY * 2, P.row1H + 22);
  const g = ctx.createLinearGradient(0, P.y + P.padY, 0, P.y + P.padY + barH);
  g.addColorStop(0, '#4f8dfd');
  g.addColorStop(1, '#22d3ee');
  ctx.fillStyle = g;
  roundRect(ctx, P.x + 22, P.y + P.padY + 4, 5, barH - 8, 3);
  ctx.fill();
  ctx.restore();

  const x0 = P.x + P.padX;
  let y = P.y + P.padY;

  /* 关键词 + 音标 */
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.font = T(P.wordSize, 600, F_SANS);
  const word = state.content.word || '';
  ctx.fillStyle = '#0f172a';
  const baseline1 = y + P.wordSize * 0.94;
  ctx.fillText(word, x0, baseline1);
  const ww = ctx.measureText(word).width;

  if (state.content.phonetic) {
    ctx.font = T(P.phSize, 400, F_MONO);
    ctx.fillStyle = '#7c8aa5';
    ctx.fillText('/ ' + state.content.phonetic + ' /', x0 + ww + 18, baseline1 - P.wordSize * 0.09);
  }
  ctx.restore();
  y += P.row1H + 16;

  /* 释义行 */
  for (const it of P.defItems) {
    let cx = x0;
    if (it.pos) {
      const col = POS_COLOR[it.pos] || '#475569';
      const chipH = P.chipSize * 1.72;
      const chipW = it.chipW;
      const chipY = y + (it.h - chipH) / 2;
      ctx.save();
      roundRect(ctx, cx, chipY, chipW, chipH, chipH / 2);
      ctx.fillStyle = hexA(col, 0.14);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.font = T(P.chipSize, 700, F_SANS);
      ctx.fillStyle = col;
      ctx.textBaseline = 'middle';
      ctx.fillText(it.pos, cx + chipW / 2 - ctx.measureText(it.pos).width / 2, chipY + chipH / 2 + 1);
      ctx.restore();
      cx += chipW + 18;
    }
    ctx.save();
    ctx.font = T(P.defSize, 400, F_SANS);
    ctx.fillStyle = '#334155';
    it.lines.forEach((ln, i) => {
      ctx.fillText(ln, cx, y + i * P.defLH + P.defSize * 0.86);
    });
    ctx.restore();
    y += it.h + 10;
  }

  /* 例句 */
  if (P.exItems.length) {
    y += 6;
    for (const ex of P.exItems) {
      ctx.save();
      ctx.fillStyle = 'rgba(15,23,42,0.06)';
      roundRect(ctx, x0, y + 6, 4, ex.h - 14, 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.font = T(ex.enSize, 400, F_SANS);
      ctx.fillStyle = '#475569';
      ex.enLines.forEach((ln, i) => ctx.fillText(ln, x0 + 24, y + i * ex.enSize * 1.5 + ex.enSize * 0.86));
      let yy = y + ex.enLines.length * ex.enSize * 1.5;
      ctx.font = T(ex.cnSize, 400, F_SANS);
      ctx.fillStyle = '#8b98ad';
      ex.cnLines.forEach((ln, i) => ctx.fillText(ln, x0 + 24, yy + i * ex.cnSize * 1.55 + ex.cnSize * 0.86));
      ctx.restore();
      y += ex.h + 16;
    }
  }

  /* 出处 */
  if (P.sourceH) {
    ctx.save();
    ctx.font = T(27 * L.K, 500, F_SANS);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('本句出自 · ' + state.content.source, x0, y + 27 * L.K * 0.9);
    ctx.restore();
    y += P.sourceH + 4;
  }

  /* 页脚：分隔线 + 日期 / 来源 */
  y += 24;
  ctx.save();
  ctx.strokeStyle = 'rgba(15,23,42,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x0 + P.innerW, y);
  ctx.stroke();
  ctx.restore();

  const footSize = 22 * L.K;
  ctx.save();
  ctx.font = T(footSize, 500, F_SANS);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(state.content.dateCN || state.content.date || '', x0, y + 16 + footSize * 0.86);
  ctx.textAlign = 'right';
  ctx.fillText('欧路词典 · 英语每日一句', x0 + P.innerW, y + 16 + footSize * 0.86);
  ctx.restore();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ============================== 交互 ================================ */

const els = {};

function fillForm() {
  const c = state.content;
  $('fWord').value = c.word;
  $('fEn').value = c.en;
  $('fCn').value = c.cn;
  $('fDefs').value = c.defs.map((d) => d.pos + d.text).join('\n');
  $('fSource').value = c.source;
}

function readForm() {
  const c = state.content;
  c.word = $('fWord').value.trim();
  c.en = $('fEn').value.trim();
  c.cn = $('fCn').value.trim();
  c.source = $('fSource').value.trim();
  c.defs = $('fDefs')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([a-zA-Z]{1,6}\.)\s*(.*)$/);
      return m ? { pos: m[1].toLowerCase(), text: m[2].trim() } : { pos: '', text: l };
    });
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = requestAnimationFrame(() => {
    renderTimer = null;
    render();
  });
}

function bindUI() {
  let inputTimer = null;
  ['fWord', 'fEn', 'fCn', 'fDefs', 'fSource'].forEach((id) => {
    $(id).addEventListener('input', () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        readForm();
        scheduleRender();
      }, 220);
    });
  });

  $('btnRefresh').addEventListener('click', async () => {
    $('btnRefresh').classList.add('spin');
    await loadDaily(true);
    $('btnRefresh').classList.remove('spin');
  });

  $('segBg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    [...$('segBg').children].forEach((x) => x.classList.toggle('on', x === b));
    state.opts.bgStyle = b.dataset.v;
    scheduleRender();
  });

  $('fTemplate').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      await loadTemplate(url);
      scheduleRender();
      toast('已识别模板卡片位置');
    } catch (err) {
      toast('模板图片读取失败');
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  $('btnAuto').addEventListener('click', () => {
    if (!state.template) return;
    detectCard(state.template);
    syncRatioSliders();
    scheduleRender();
    toast('已重新识别卡片位置');
  });

  const bindRange = (id, apply) => {
    $(id).addEventListener('input', () => {
      apply();
      updateRangeLabels();
      scheduleRender();
    });
  };
  bindRange('rTop', () => {
    const t = Number($('rTop').value) / 100;
    const h = Number($('rH').value) / 100;
    state.ratios.T = t;
    state.ratios.B = Math.min(0.98, t + h);
  });
  bindRange('rH', () => {
    const t = Number($('rTop').value) / 100;
    const h = Number($('rH').value) / 100;
    state.ratios.T = t;
    state.ratios.B = Math.min(0.98, t + h);
  });
  bindRange('rM', () => {
    const m = Number($('rM').value) / 100;
    state.ratios.L = m;
    state.ratios.R = 1 - m;
  });
  bindRange('rFont', () => {
    state.opts.fontScale = Number($('rFont').value) / 100;
  });

  const bindCheck = (id, key) => {
    $(id).addEventListener('change', () => {
      state.opts[key] = $(id).checked;
      scheduleRender();
    });
  };
  bindCheck('cDate', 'showDate');
  bindCheck('cRule', 'showRule');
  bindCheck('cSource', 'showSource');
  bindCheck('cExamples', 'showExamples');

  $('btnSave').addEventListener('click', savePoster);

  $('btnPlay').addEventListener('click', () => {
    const url = state.apiData && state.apiData.audio && state.apiData.audio.normal;
    if (!url) return toast('没有可用发音');
    new Audio(url).play().catch(() => toast('发音播放失败'));
  });

  $('btnSource').addEventListener('click', () => {
    const url = (state.apiData && state.apiData.permalink) || 'https://dict.eudic.net/home/dailysentence';
    window.open(url, '_blank', 'noopener');
  });
}

/* ------------------------------ 保存 ------------------------------- */

async function savePoster() {
  try {
    const blob = await new Promise((res) => cvs.toBlob(res, 'image/png', 0.96));
    if (!blob) throw new Error('导出失败');
    const name = 'dailysentence-' + (state.content.date.replace(/\//g, '') || 'today') + '.png';
    const file = new File([blob], name, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '每日一句' });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    toast('已开始下载，iOS 也可长按预览图存到相册');
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

/* ------------------------------ UI 辅助 ----------------------------- */

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function setOverlay(show, text) {
  const o = $('overlay');
  if (text) $('overlayText').textContent = text;
  o.classList.toggle('hide', !show);
}

/* ============================== 启动 ================================ */

(async function boot() {
  const qs = QS;
  if (qs.get('raw') === '1') document.body.classList.add('raw');
  if (qs.get('bg')) state.opts.bgStyle = qs.get('bg');
  if (qs.get('ex') === '1') state.opts.showExamples = true;
  bindUI();
  [...$('segBg').children].forEach((b) => b.classList.toggle('on', b.dataset.v === state.opts.bgStyle));
  $('cExamples').checked = state.opts.showExamples;
  updateRangeLabels();

  /* 字体度量必须先就绪，否则折行与居中会算错 */
  try {
    await Promise.all([
      document.fonts.load(`700 120px AppSerif`),
      document.fonts.load(`400 40px AppSans`),
      document.fonts.load(`600 40px AppSans`),
    ]);
    if (document.fonts.ready) await document.fonts.ready;
  } catch (e) {}

  state.ratios = { ...DEFAULT_RATIOS };
  try {
    await loadTemplate('assets/template.jpg');
  } catch (e) {}

  await loadDaily(false);
  if (!state.apiData) {
    setOverlay(false);
    render();
  }
})();
