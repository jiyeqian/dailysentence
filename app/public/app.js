/* =========================================================================
 * 每日一句 · 海报生成器
 * 从欧路词典「英语每日一句」抓取内容，与用户的乐词模板卡片合成一张手机海报。
 * 全部合成在浏览器 Canvas 完成，图片不上传任何服务器。
 * ========================================================================= */
'use strict';

/* ----------------------------- 基本常量 ------------------------------ */

const CW = 1080;
const CH_MIN = 1920;      // 标准版海报高度
let CH = CH_MIN;          // 实际画布高度，开启「长版海报」时会按内容伸展

const F_SANS =
  '"AppSans","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",-apple-system,sans-serif';
const F_SERIF = '"AppSerif","Songti SC",STSong,Georgia,"Times New Roman",serif';
const F_MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';

const MX = 84;            // 文字左右安全边距
const TOP_PAD = 96;       // 文字块距海报顶端
const BOTTOM_PAD = 84;    // 信息卡距海报底端
const GAP_TEXT_PANEL = 56;  // 文字块 → 单词卡片
const GAP_PANEL_CARD = 46;  // 单词卡片 → 信息卡

const POS_COLOR = {
  'n.': '#2563eb', 'v.': '#7c3aed', 'vt.': '#7c3aed', 'vi.': '#7c3aed',
  'adj.': '#d97706', 'adv.': '#059669', 'prep.': '#0891b2', 'conj.': '#db2777',
  'pron.': '#4f46e5', 'int.': '#ea580c', 'aux.': '#64748b', 'abbr.': '#64748b',
};

/* ------------------------------- 状态 -------------------------------- */

const DEFAULT_RATIOS = { L: 0.0364, T: 0.5934, R: 0.9636, B: 0.8491 };

const state = {
  apiData: null,
  content: { word: '', phonetic: '', phonetics: [], en: '', cn: '', defs: [], examples: [], usages: [], usagesTitle: '', source: '', date: '', dateCN: '' },
  bgImage: null,
  template: null,
  ratios: { ...DEFAULT_RATIOS },
  opts: {
    bgStyle: 'natural',
    fontScale: 1,
    showDate: true,
    showRule: true,
    showSource: true,
    longPoster: false,
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
    phonetics: Array.isArray(data.phonetics) ? data.phonetics.slice() : [],
    en: data.en || '',
    cn: data.cn || '',
    defs: (data.definitions || []).slice(),
    examples: (data.examples || []).slice(),
    usages: (data.usages || []).slice(),
    usagesTitle: data.usagesTitle || '常用搭配',
    source: (data.source && data.source.author) || '',
    date: data.date || '',
    dateCN: data.dateCN || '',
  };
  /* 便于分享 / 调试：允许用 ?word=&en=&cn= 覆盖文案 */
  ['word', 'en', 'cn', 'source'].forEach((k) => {
    const v = QS.get(k);
    if (v) state.content[k] = v;
  });
  /* 调试音标排版：?ph=ˈɪmpʌls（单音标）或 ?ph=英:ɪɡˈzæmpl|美:ɪɡˈzɑːmpl（双音标） */
  const phRaw = QS.get('ph');
  if (phRaw) {
    state.content.phonetics = phRaw.split('|').filter(Boolean).map((seg) => {
      const i = seg.indexOf(':');
      return i > 0 ? { label: seg.slice(0, i), ph: seg.slice(i + 1) } : { label: '', ph: seg };
    });
    state.content.phonetic = '';
  }
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

/** 原比例模式下背景图占满宽度后的高度（高度按图片原始比例推算） */
function naturalImageH() {
  const im = state.bgImage;
  if (!im) return 0;
  return Math.round((CW * im.height) / im.width);
}

/** 文字块起始 y：原比例模式让位给顶部图片 */
function textTopY() {
  if (state.opts.bgStyle === 'natural' && state.bgImage) return naturalImageH() + 64;
  return TOP_PAD;
}

/**
 * 计算整张海报的版面。
 * 从上到下三段流式排布：文字块（句子 + 出处） → 单词卡片 → 个人信息卡片。
 * 高度取「内容所需高度」与 1920 的较大者：标准版通常就是 1920，装不下自动长高；
 * 长版海报会带上例句，因此更高。
 */
function computeLayout(ctx) {
  /* 版面是流式的，不会互相压盖，所以不做自动缩字：
     字号完全交给「字号」滑块，装不下时按需要长高（标准版下限 1920） */
  const M = measureAll(ctx, 1);

  CH = Math.max(CH_MIN, Math.ceil(M.total / 2) * 2);

  /* 内容比画布矮时，把信息卡压到最底部，余量留在单词卡片与信息卡之间 */
  const card = M.card;
  const bottomY = CH - BOTTOM_PAD - card.h;
  if (bottomY > card.y) card.y = bottomY;

  return {
    K: M.K,
    textTop: M.textTop,
    textBottom: M.textBottom,
    title: M.text.title,
    rule: M.text.rule,
    en: M.text.en,
    cn: M.text.cn,
    source: M.text.source,
    panel: M.panel,
    card,
    ch: CH,
  };
}

function measureAll(ctx, scale) {
  const K = state.opts.fontScale * scale;
  const textTop = textTopY();

  const text = buildTextBlock(ctx, K);
  const textBottom = textTop + text.total;

  const panel = buildWordCard(ctx, K, textBottom + GAP_TEXT_PANEL);
  const panelBottom = panel.y + panel.h;

  const card = buildProfileCard(panelBottom + GAP_PANEL_CARD);

  return {
    K, scale, textTop, text, textBottom, panel, panelBottom, card,
    total: card.y + card.h + BOTTOM_PAD,
  };
}

/** 顶部文字块：关键词标题 + 分隔线 + 英文 + 中文 + 出处 */
function buildTextBlock(ctx, K) {
  const maxW = CW - 2 * MX;

  /* 日期徽标占位 → 标题可用宽度 */
  let badgeW = 0;
  if (state.opts.showDate && state.content.date) {
    ctx.font = T(25, 600, F_SANS);
    badgeW = measureSpaced(ctx, state.content.date, 2.5) + 56;
  }

  /* 标题（关键词）：自动缩到一行放得下 */
  let ts = 118 * K;
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
  const afterTitle = titleH + (rule.on ? rule.gapTop + rule.h + rule.gapBottom : 26);

  /* 英文 */
  const enSize = 42 * K;
  const enLH = enSize * 1.32;
  ctx.font = T(enSize, 400, F_SANS);
  const enLines = wrapText(ctx, state.content.en, maxW);
  const enY = afterTitle;

  /* 中文 */
  const cnSize = 42 * K;
  const cnLH = cnSize * 1.46;
  const cnGap = 34 * K;
  ctx.font = T(cnSize, 400, F_SANS);
  const cnLines = wrapText(ctx, state.content.cn, maxW);
  const cnY = enY + enLines.length * enLH + cnGap;
  const cnBottom = cnY + cnLines.length * cnLH;

  /* 出处：紧跟在句子下方，不再放进单词卡片 */
  const sourceSize = 29 * K;
  const sourceOn = state.opts.showSource && !!state.content.source;
  const sourceY = cnBottom + (sourceOn ? 30 * K : 0);

  return {
    total: sourceY + (sourceOn ? sourceSize * 1.4 : 0),
    title: { size: ts, h: titleH, text: word, badgeW },
    rule: Object.assign({}, rule, { y: titleH + rule.gapTop }),
    en: { size: enSize, lh: enLH, lines: enLines, y: enY },
    cn: { size: cnSize, lh: cnLH, lines: cnLines, y: cnY },
    source: { on: sourceOn, size: sourceSize, y: sourceY, text: state.content.source },
  };
}

/**
 * 归一化音标，统一成 [{ label, ph, text }]。
 * 只有一个音标时不显示「英/美」标签，保持和以前一致的观感；
 * 英式 + 美式并存（2026-09-18 起上游会给两个）时才加标签区分。
 */
function phoneticList() {
  const c = state.content;
  const list = (c.phonetics && c.phonetics.length)
    ? c.phonetics
    : (c.phonetic ? [{ label: '', ph: c.phonetic }] : []);
  const single = list.length <= 1;
  return list
    .filter((p) => p && p.ph)
    .map((p) => ({
      label: p.label || '',
      ph: p.ph || '',
      text: (single || !p.label ? '' : p.label + ' ') + '/ ' + (p.ph || '') + ' /',
    }));
}


/** 单词卡片：关键词 + 音标 + 释义（+ 长版海报下的例句与常用搭配），无底部栏 */
function buildWordCard(ctx, K, topY) {
  const r = state.ratios;
  const x = Math.round(r.L * CW);
  const w = Math.round((r.R - r.L) * CW);
  const padX = 46;
  const padY = 34;
  const innerW = w - padX * 2;

  const wordSize = 47 * K;
  const phSize = 31 * K;
  const row1H = wordSize * 1.3;

  const defSize = 36 * K;
  const defLH = defSize * 1.62;
  const chipSize = 25 * K;

  /* 关键词 + 音标：可能是「英 /…/ 美 /…/」，放不下就逐档缩小音标字号 */
  ctx.font = T(wordSize, 600, F_SANS);
  const wordW = ctx.measureText(state.content.word || '').width;
  const phs = phoneticList();
  let phDrawSize = phSize;
  if (phs.length) {
    for (let s = 1; s >= 0.6; s -= 0.05) {
      const size = phSize * s;
      ctx.font = T(size, 400, F_MONO);
      const total = phs.reduce((acc, p) => acc + ctx.measureText(p.text).width, 0)
        + Math.max(0, phs.length - 1) * 22;
      phDrawSize = size;
      if (wordW + 18 + total <= innerW) break;
    }
  }

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

  /* 例句只在「长版海报」下出现 */
  const exItems = [];
  if (state.opts.longPoster) {
    for (const e of state.content.examples.slice(0, 3)) {
      const enSize = 28 * K;
      const cnSize = 26 * K;
      ctx.font = T(enSize, 400, F_SANS);
      const enLines = wrapText(ctx, e.en, innerW - 24);
      ctx.font = T(cnSize, 400, F_SANS);
      const cnLines = wrapText(ctx, e.cn, innerW - 24);
      exItems.push({
        enLines, cnLines, enSize, cnSize,
        h: enLines.length * enSize * 1.5 + cnLines.length * cnSize * 1.55,
      });
    }
  }

  let contentH = row1H + 16;
  for (const it of defItems) contentH += it.h + 10;
  if (exItems.length) contentH += 12 + exItems.reduce((s, e) => s + e.h + 16, 0);

  return {
    x, y: Math.round(topY), w, h: Math.round(padY * 2 + contentH),
    padX, padY, innerW,
    wordSize, phSize, phDrawSize, row1H, wordW,
    defItems, defLH, chipSize, defSize,
    exItems,
  };
}

/** 个人信息卡片：沿用模板里识别出的相对位置与宽高比例 */
function buildProfileCard(topY) {
  const r = state.ratios;
  return {
    x: Math.round(r.L * CW),
    y: Math.round(topY),
    w: Math.round((r.R - r.L) * CW),
    h: Math.max(120, Math.round((r.B - r.T) * CH_MIN)),
    shifted: false,
  };
}

/* ============================== 绘制 ================================ */

function render() {
  const ctx = cvs.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  /* 版面确定后才知道画布多高（长版海报会变高） */
  const L = computeLayout(ctx);

  if (cvs.width !== CW || cvs.height !== CH) {
    cvs.width = CW;
    cvs.height = CH;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';

  drawBackground(ctx, L);
  drawScrim(ctx, L);
  drawGrain(ctx);
  drawTopText(ctx, L);
  drawWordCard(ctx, L);
  drawProfileCard(ctx, L);
  return L;
}

/* --------------------------- 背景 --------------------------- */

function drawBackground(ctx, L) {
  const im = state.bgImage;
  if (!im) {
    darkBase(ctx);
    return;
  }

  /* 原比例：宽度铺满、顶端与海报顶端对齐，图片完整不裁切 */
  if (state.opts.bgStyle === 'natural') {
    darkBase(ctx);
    const ih = naturalImageH();
    ctx.drawImage(im, 0, 0, CW, ih);
    fadeImageBottom(ctx, ih);
    return;
  }

  /* 铺满：等比裁切填满整张海报 */
  drawCover(ctx, im, 0, 0, CW, CH);
}

function darkBase(ctx) {
  const g = ctx.createLinearGradient(0, 0, CW * 0.35, CH);
  g.addColorStop(0, '#16233a');
  g.addColorStop(1, '#070b13');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);
}

/**
 * 原比例模式下，让背景图下缘渐隐进海报底色。
 * 只作用于图片最下方一小段，主体依然清晰可辨，衔接也不生硬。
 */
function fadeImageBottom(ctx, ih) {
  const FADE = Math.min(200, Math.round(ih * 0.3));
  const g = ctx.createLinearGradient(0, ih - FADE, 0, ih);
  g.addColorStop(0, 'rgba(17,28,46,0)');
  g.addColorStop(0.55, 'rgba(17,28,46,0.4)');
  g.addColorStop(1, 'rgba(17,28,46,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, ih - FADE, CW, FADE);
}

/** 顶部压暗 + 底部压暗 + 四角暗角 */
function drawScrim(ctx, L) {
  /* 原比例：顶部图片保持干净，只在其下方轻压暗 + 底部收边 */
  if (state.opts.bgStyle === 'natural' && state.bgImage) {
    const ih = naturalImageH();
    ctx.fillStyle = 'rgba(6,11,22,0.06)';
    ctx.fillRect(0, ih, CW, CH - ih);
    const g = ctx.createLinearGradient(0, CH - 560, 0, CH);
    g.addColorStop(0, 'rgba(6,11,22,0)');
    g.addColorStop(1, 'rgba(6,11,22,0.4)');
    ctx.fillStyle = g;
    ctx.fillRect(0, ih, CW, CH - ih);
    return;
  }

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

  /* 出处：紧跟在句子下面 */
  if (L.source.on) {
    ctx.save();
    ctx.font = T(L.source.size, 500, F_SANS);
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    shadow();
    ctx.fillText('—— ' + L.source.text, MX, L.textTop + L.source.y + L.source.size * 0.86);
    ctx.restore();
  }

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

/* --------------------------- 单词卡片 --------------------------- */

function drawWordCard(ctx, L) {
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
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
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

  const phs = phoneticList();
  if (phs.length) {
    ctx.font = T(P.phDrawSize || P.phSize, 400, F_MONO);
    ctx.fillStyle = '#7c8aa5';
    const phY = baseline1 - P.wordSize * 0.09;
    let px = x0 + ww + 18;
    for (const p of phs) {
      ctx.fillText(p.text, px, phY);
      px += ctx.measureText(p.text).width + 22;
    }
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

  $('btnTemplate').addEventListener('click', () => $('fTemplate').click());

  $('fTemplate').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      await loadTemplate(url);
      scheduleRender();
      toast('已识别信息卡位置');
    } catch (err) {
      toast('模板图片读取失败');
    } finally {
      URL.revokeObjectURL(url);
      e.target.value = '';
    }
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
  bindCheck('cLong', 'longPoster');

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
  const bg = qs.get('bg');
  if (bg) state.opts.bgStyle = bg === 'cover' ? 'cover' : 'natural';  /* 旧参数 band/card 归入原比例 */
  if (qs.get('long') === '1' || qs.get('ex') === '1') state.opts.longPoster = true;
  bindUI();
  [...$('segBg').children].forEach((b) => b.classList.toggle('on', b.dataset.v === state.opts.bgStyle));
  $('cLong').checked = state.opts.longPoster;
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
