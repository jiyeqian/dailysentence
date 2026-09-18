#!/usr/bin/env node
/**
 * 每日一句海报生成器 —— 零依赖 Node HTTP 服务
 *
 * 职责：
 *   1) 抓取并解析 欧路词典「英语每日一句」页面  https://dict.eudic.net/home/dailysentence
 *   2) 以 JSON 返回：中英文、配图地址、关键词/音标/释义、例句、出处、发音音频
 *   3) 代理白名单内的图片（规避跨域 / http 混合内容问题）
 *   4) 托管 public/ 下的静态前端
 *
 * 环境变量：PORT（默认 8787）、HOST（默认 0.0.0.0）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const DAILY_PAGE = 'https://dict.eudic.net/home/dailysentence';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 图片代理域名白名单（防止 SSRF） */
const ALLOW_HOSTS = new Set([
  'static.esdict.cn',
  'static.frdic.com',
  'dict.eudic.net',
  'dict.frdic.com',
  'api.frdic.com',
  'www.eudic.net',
  'cdn.esdict.cn',
  'cdn.frdic.com',
]);

/* 上游对「反复新建连接」比较敏感，复用长连接能明显降低被 302 挡回的概率 */
const KA_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 });

/* ------------------------------------------------------------------ */
/* HTTP 抓取（自动跟随跳转，支持 http / https）                          */
/* ------------------------------------------------------------------ */

function fetchRaw(target, opts = {}) {
  const redirects = opts.redirects || 0;
  const maxRedirects = opts.maxRedirects === undefined ? 5 : opts.maxRedirects;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      return reject(new Error('bad url: ' + target));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign(
        {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          Referer: 'https://dict.eudic.net/',
        },
        opts.headers || {}
      ),
    };
    if (u.protocol === 'https:') reqOpts.agent = KA_AGENT;
    const req = mod.request(
      reqOpts,
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < maxRedirects) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          return fetchRaw(next, Object.assign({}, opts, { redirects: redirects + 1 })).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: code, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.setTimeout(opts.timeout || 15000, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* HTML 解析小工具                                                      */
/* ------------------------------------------------------------------ */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘',
  rsquo: '’', times: '×', deg: '°', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => safeCP(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeCP(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => (NAMED[n] !== undefined ? NAMED[n] : m));
}
function safeCP(n) {
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return '';
  }
}
function stripTags(s) {
  return decodeEntities(
    String(s)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function pick(re, html, idx = 1) {
  const m = String(html == null ? '' : html).match(re);
  if (!m) return '';
  return m[idx] === undefined ? m[0] || '' : m[idx];
}

/** 取 [a, b) 之间的片段；b 省略则一直到结尾；找不到 a 时返回空串 */
function sliceBetween(html, a, b) {
  const s = String(html == null ? '' : html);
  const i = s.indexOf(a);
  if (i < 0) return '';
  if (!b) return s.slice(i);
  const j = s.indexOf(b, i + a.length);
  return s.slice(i, j < 0 ? undefined : j);
}

/** 从 from 起，最早的某个 needle 出现位置；都没有返回 -1 */
function earliestOf(s, needles, from) {
  let best = -1;
  for (const n of needles) {
    const i = s.indexOf(n, from);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * 释义 / 例句正文统一处理：上游会把部分汉字随机换成一张小图
 * （<img class="dictimgtoword">），这里统一打成占位符 HOLE，
 * 方便后续「多次抓取 + 逐位合并」把缺字补回来。
 * 这些位置不会出现正经配图，所以任何 <img> 都按被换掉的汉字处理
 * —— 上游偶尔不写类名，只按类名匹配会漏掉，缺字就变成空格了。
 */
const HOLE = '\u0001';

function markDefImgs(s) {
  return String(s == null ? '' : s).replace(/<img[^>]*>/gi, HOLE);
}

/* ------------------------------------------------------------------ */
/* 关键词候选：上游没给解析内容时，从英文句子里挑「最像关键词」的词       */
/* ------------------------------------------------------------------ */

/** 闭类词（功能词）黑名单：代词 / 助动词 / 限定词 / 介词 / 连词 / 虚副词 */
const CLOSED_CLASS = new Set(
  (
    'i me my mine myself we us our ours ourselves you your yours yourself yourselves ' +
    'he him his himself she her hers herself it its itself they them their theirs themselves ' +
    'this that these those who whom whose which what whatever whoever someone somebody something ' +
    'anyone anybody anything everyone everybody everything nobody nothing none one ones ' +
    'am is are was were be been being do does did done doing have has had having ' +
    'will would shall should can could may might must ought ' +
    'a an the some any no every each either neither both all few many much more most ' +
    'several such another other others enough less least own same ' +
    'of to in on at by for with without about against between among into onto through during ' +
    'before after above below under over up down out off away along around near ' +
    'and but or nor so yet if because as than while although though unless until till since whether ' +
    'not very too also just only even still always never often sometimes usually really quite rather ' +
    'almost already ever else here there now then when where why how once again further thus hence ' +
    'yes please'
  )
    .split(/\s+/)
    .filter(Boolean)
);

/** 轻量词形还原（只用于候选词去重打分；正式查词典时另有更严谨的还原） */
function basicLemma(w) {
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes|zes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * 从英文句子挑 Top N 关键词候选。
 * 打分 = 基础 10 + 词频加成（同一词根每多出现一次 +12） + 长度偏好（6–12 字母 +6）。
 */
function extractKeywords(sentence, limit = 3) {
  const raw = String(sentence || '').match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const tally = new Map();
  for (const w0 of raw) {
    if (/['’]/.test(w0)) continue; // 缩写（don't / it's）不算关键词
    const w = w0.toLowerCase().replace(/^-+|-+$/g, '');
    if (!/^[a-z][a-z-]{2,}$/.test(w)) continue;
    if (CLOSED_CLASS.has(w)) continue;
    const key = basicLemma(w);
    if (CLOSED_CLASS.has(key)) continue;
    const t = tally.get(key) || { word: key, count: 0, len: key.replace(/-/g, '').length };
    t.count += 1;
    tally.set(key, t);
  }
  return [...tally.values()]
    .map((t) => {
      let score = 10 + (t.count - 1) * 12;
      if (t.len >= 6 && t.len <= 12) score += 6;
      else if (t.len >= 5) score += 3;
      else score -= 4;
      return { word: t.word, count: t.count, score };
    })
    .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 欧路词典词条页：补全上游缺失的 音标 / 释义 / 双语例句                  */
/* ------------------------------------------------------------------ */

const DICT_PAGE = 'https://dict.eudic.net/dicts/en/';

/** 词形还原候选（原词条释义质量差时按顺序回查） */
function lemmaCandidates(word) {
  const w = String(word || '').toLowerCase();
  const out = [];
  const push = (x) => {
    if (x && x.length >= 3 && x !== w && out.indexOf(x) < 0) out.push(x);
  };
  if (w.length > 4 && /ies$/.test(w)) push(w.slice(0, -3) + 'y');
  if (w.length > 4 && /(ches|shes|sses|xes|zes|oes)$/.test(w)) push(w.slice(0, -2));
  if (w.length > 4 && /ed$/.test(w)) {
    push(w.slice(0, -1)); // deceived -> deceive
    push(w.slice(0, -2)); // jumped   -> jump
    if (/([bdfglmnprt])\1ed$/.test(w)) push(w.slice(0, -3)); // stopped -> stop
  }
  if (w.length > 5 && /ing$/.test(w)) {
    push(w.slice(0, -3)); // walking -> walk
    push(w.slice(0, -3) + 'e'); // making  -> make
    if (/([bdfglmnprt])\1ing$/.test(w)) push(w.slice(0, -4)); // running -> run
  }
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) push(w.slice(0, -1));
  return out;
}

/** 解析词条页；缺字位置统一是 HOLE */
function parseDictPage(html, query) {
  const out = { ok: false, word: query, phonetics: [], definitions: [], examples: [] };
  if (!html) return out;

  /* ---- 音标：<span class="phontype">英</span><span class="Phonitic">/dɪ'siːv/</span> ---- */
  const phRegion =
    sliceBetween(html, 'class="phonitic-line"', 'class="globalVoice"') ||
    sliceBetween(html, 'class="phonitic-line"', '</h1>');
  const phRe = /<span class="phontype">([\s\S]*?)<\/span>\s*<span class="Phonitic">([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = phRe.exec(phRegion))) {
    const ph = stripTags(m[2]);
    if (ph) out.phonetics.push({ label: stripTags(m[1]), ph });
  }

  /* ---- 释义：英汉-汉英词典 #ExpFCchild（<div class="exp"> 或 <ol><li>） ----
     结束位置取「下一个分区」的最早出现处：有的词没有近义反义区，
     若只认 #ExpSYN 会把后面的生词本 / 历史记录等 <li> 也扫进来。 */
  const fcStart = html.indexOf('id="ExpFCchild"');
  const fcEnd = fcStart < 0 ? -1 : earliestOf(html, ['id="ExpSYN"', 'id="ExpSPEC"', 'id="ExpLJ"', 'id="SC_trans"'], fcStart + 14);
  const fc = (fcStart < 0 ? '' : html.slice(fcStart, fcEnd < 0 ? undefined : fcEnd)).replace(
    /<div id="trans"[\s\S]*?<\/div>/gi,
    ''
  );
  let segs = (fc.match(/<li>[\s\S]*?<\/li>/gi) || []).map((x) =>
    x.replace(/^<li>/i, '').replace(/<\/li>$/i, '')
  );
  if (!segs.length) {
    segs = (fc.match(/<div class="exp">[\s\S]*?<\/div>/gi) || []).map((x) =>
      x.replace(/^<div class="exp">/i, '').replace(/<\/div>$/i, '')
    );
  }
  if (!segs.length) {
    const t = fc.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (t) segs = [t];
  }

  let lastPos = '';
  for (const seg of segs) {
    let rest = seg;
    let pos = '';
    const im = rest.match(/^\s*<i>([^<]*)<\/i>\s*([\s\S]*)$/);
    if (im && /^[a-z]{1,6}\./i.test(im[1].trim())) {
      pos = im[1].trim();
      rest = im[2];
    }
    let text = stripTags(markDefImgs(rest));
    if (!text) continue;
    if (!pos) {
      const pm = text.match(/^([A-Za-z]{1,6}\.(?:\s*&\s*[A-Za-z]{1,6}\.)*)\s*(.+)$/);
      if (pm) {
        pos = pm[1];
        text = pm[2].trim();
      }
    }
    if (!pos) pos = lastPos;
    lastPos = pos || lastPos;
    if (text) out.definitions.push({ pos: pos.toLowerCase(), text });
  }

  /* ---- 双语例句：英语例句库 #ExpLJchild ---- */
  const lj = sliceBetween(html, 'id="ExpLJchild"').slice(0, 40000);
  const ljRe =
    /<div class="lj_item"[\s\S]*?<p class="line">([\s\S]*?)<\/p>\s*<p class="exp">([\s\S]*?)<\/p>/gi;
  let em;
  while ((em = ljRe.exec(lj))) {
    const en = stripTags(markDefImgs(em[1]));
    if (!en) continue;
    out.examples.push({ en, cn: stripTags(markDefImgs(em[2])) });
    if (out.examples.length >= 6) break;
  }

  out.ok = out.definitions.length > 0;
  return out;
}

/** 逐位合并两次抓取：占位符的位置用另一份的可用字符补上 */
function mergeString(a, b) {
  if (a == null) return b || '';
  if (b == null) return a || '';
  if (a === b) return a;
  if (a.length !== b.length) {
    return a.split(HOLE).length <= b.split(HOLE).length ? a : b;
  }
  /* 占位符和空格都算「没内容」：上游偶尔会把字整个吞掉、只留个空格，
     这种情况不能拿空格去覆盖另一份里的占位符，否则缺字就永远补不回来。 */
  const weak = (c) => c === HOLE || c === ' ';
  let out = '';
  for (let i = 0; i < a.length; i++) {
    const ca = a[i];
    const cb = b[i];
    if (!weak(ca)) out += ca;
    else if (!weak(cb)) out += cb;
    else out += ca === HOLE ? cb : ca;
  }
  return out;
}

function holeCount(r) {
  let n = 0;
  const scan = (s) => {
    n += String(s == null ? '' : s).split(HOLE).length - 1;
  };
  if (!r) return 1;
  r.definitions.forEach((d) => scan(d.text));
  r.phonetics.forEach((p) => scan(p.ph));
  r.examples.forEach((e) => {
    scan(e.en);
    scan(e.cn);
  });
  return n;
}

function mergeDictRuns(runs) {
  const ok = (runs || []).filter((r) => r && r.ok);
  if (!ok.length) return null;
  const size = (r) => r.definitions.length * 10 + r.phonetics.length;
  const base = ok.reduce((a, b) => (size(b) > size(a) ? b : a));
  const out = {
    ok: true,
    word: base.word,
    phonetics: base.phonetics.map((p) => ({ label: p.label, ph: p.ph })),
    definitions: base.definitions.map((d) => ({ pos: d.pos, text: d.text })),
    examples: base.examples.map((e) => ({ en: e.en, cn: e.cn })),
  };
  for (const r of ok) {
    if (r === base) continue;
    out.phonetics = out.phonetics.map((p, i) =>
      r.phonetics[i] ? { label: p.label || r.phonetics[i].label, ph: mergeString(p.ph, r.phonetics[i].ph) } : p
    );
    out.definitions = out.definitions.map((d, i) =>
      r.definitions[i]
        ? { pos: d.pos || r.definitions[i].pos, text: mergeString(d.text, r.definitions[i].text) }
        : d
    );
    out.examples = out.examples.map((e, i) =>
      r.examples[i]
        ? { en: mergeString(e.en, r.examples[i].en), cn: mergeString(e.cn, r.examples[i].cn) }
        : e
    );
  }
  return out;
}

/** 释义里带「过去式 / 复数」注解，说明查到的不是原形，释义质量差 */
const INFLECTED_NOTE = /(过去式|过去分词|现在分词|复数形式|复数|第三人称单数|的比较级|的最高级|被动式)/;

function isGoodDictResult(r) {
  if (!r || !r.ok || !r.definitions.length) return false;
  const total = r.definitions.reduce(
    (n, d) => n + d.text.split(HOLE).join('').trim().length,
    0
  );
  if (total < 2) return false;
  return !r.definitions.some((d) => INFLECTED_NOTE.test(d.text));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 词条页不加节流会被上游 302 到登录页（它把高频访问当异常），
   所以所有词条请求串行排队，并保证两次之间至少 DICT_MIN_GAP 毫秒。
   连续被挡回时再整体退避一小会儿，免得越试越黑、把后面的请求也拖死。 */
const DICT_MIN_GAP = 300;
let dictChain = Promise.resolve();
let dictLastAt = 0;
let dictBlockStreak = 0;
let dictCooldownUntil = 0;

function noteDictBlocked() {
  dictBlockStreak += 1;
  dictCooldownUntil = Date.now() + Math.min(1200 * dictBlockStreak, 12000);
}

function noteDictOk() {
  dictBlockStreak = 0;
  dictCooldownUntil = 0;
}

function dictRequest(url) {
  const task = dictChain.then(async () => {
    const wait = DICT_MIN_GAP - (Date.now() - dictLastAt);
    if (wait > 0) await sleep(wait);
    dictLastAt = Date.now();
    /* maxRedirects:0 —— 302 一律视为「这次没拿到」，交给上层重试，绝不跟随到登录页 */
    return fetchRaw(url, { maxRedirects: 0 });
  });
  dictChain = task.then(
    () => {},
    () => {}
  );
  return task;
}

async function fetchDictOnce(word) {
  if (Date.now() < dictCooldownUntil) return null; // 正在退避，直接放弃这次尝试
  try {
    const res = await dictRequest(DICT_PAGE + encodeURIComponent(word));
    if (res.status !== 200) {
      if (res.status >= 300 && res.status < 400) noteDictBlocked();
      return null;
    }
    const parsed = parseDictPage(res.body.toString('utf8'), word);
    if (parsed.ok) noteDictOk();
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * 抓词条 + 「多次抓取、逐位合并」。
 *
 * 要同时对付上游两个毛病：
 *   1) 每次请求都会随机把一部分汉字换成图片 → 必须多抓几次、逐位合并补字；
 *   2) 负载均衡下会有一部分请求被 302 挡回 → 失败要重试。
 * 所以按「失败不计入」的循环重试，凑够或补全就提前收工，请求数有上限。
 */
async function fetchDictMerged(word, maxAttempts = 4) {
  const runs = [];
  let merged = null;
  for (let i = 0; i < maxAttempts; i++) {
    if (i) await sleep(120);
    const r = await fetchDictOnce(word);
    if (!r) continue;
    runs.push(r);
    merged = mergeDictRuns(runs);
    if (merged && holeCount(merged) === 0) break;
  }
  return merged;
}

/** 查词（带缓存、词形还原、缺字合并），查不到返回 null */
async function lookupWord(rawWord) {
  const word = String(rawWord || '')
    .trim()
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z'’-]+$/, '');
  if (!word) return null;

  const key = 'dict:' + word.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;

  let best = await fetchDictMerged(word);
  if (best) best = Object.assign({}, best, { query: word });

  /* 查到的若是「过去式 / 复数」这类词条，释义质量差，回查原形 */
  if (!isGoodDictResult(best)) {
    for (const cand of lemmaCandidates(word).slice(0, 2)) {
      const r = await fetchDictMerged(cand, 3);
      if (!r) continue;
      if (isGoodDictResult(r)) {
        best = Object.assign({}, r, { query: word, lemma: cand });
        break;
      }
      if (!best || !best.ok) best = Object.assign({}, r, { query: word, lemma: cand });
    }
  }

  if (best && best.ok && best.definitions.length) {
    best = Object.assign({}, best, {
      /* 海报上放不下太多义项，最多留 4 条 */
      definitions: best.definitions.slice(0, 4).map((d) => ({
        pos: d.pos,
        /* 试到最后仍没补回来的缺字直接丢掉：留个占位符在海报上是块豆腐干，更难看 */
        text: d.text.split(HOLE).join(''),
      })),
      phonetics: best.phonetics.map((p) => ({ label: p.label, ph: p.ph.split(HOLE).join('') })),
      examples: best.examples.map((e) => ({ en: e.en.split(HOLE).join(''), cn: e.cn.split(HOLE).join('') })),
    });
    cacheSet(key, best, 12 * 60 * 60 * 1000);
    return best;
  }
  return null;
}

/**
 * 解析「关键词行」，兼容上游的几种写法：
 *   impulse  /ˈɪmpʌls/                      单个音标（无语言标签）
 *   example  英 /ɪɡˈzæmpl/                  只有英式
 *   example  英 /ɪɡˈzæmpl/  美 /ɪɡˈzɑːmpl/  英式 + 美式（2026-09-18 起出现）
 * 返回 { word, phonetics: [{ label, ph }] }
 */
function parseWordLine(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  const marks = [];
  const re = /(?:(英式|美式|英|美)\s*)?\/([^/]{1,80}?)\//g;
  let m;
  while ((m = re.exec(s))) {
    const ph = m[2].trim();
    if (ph) {
      marks.push({ label: m[1] || '', ph, start: m.index, end: m.index + m[0].length });
    }
  }
  let word = s;
  if (marks.length) {
    word = (s.slice(0, marks[0].start) + ' ' + s.slice(marks[marks.length - 1].end)).trim();
  }
  /* 兜底清掉残留在单词里的语言标签（如「example 英」） */
  word = word.replace(/[\s·、,，]*(英式|美式|英|美)$/, '').trim();
  return { word, phonetics: marks.map(({ label, ph }) => ({ label, ph })) };
}

/** 上游已知的分组小标题词表 */
const HEADER_WORDS = /^(本句出自|出自|来源|解析|词汇|单词|释义|词义|例句|示例|例|常见用法|常用用法|常见搭配|常用搭配|常用短语|搭配|用法|短语|词组|句式|表达|扩展|同义词|近义词|反义词|词根|词源|记忆|联想|辨析|注意)/;

/**
 * 判断某一行是不是分组小标题。
 * 「解析:」「例句：」带冒号；但 2026-09-18 起「例句」「常用搭配」是裸词无冒号，
 * 所以再补两条判据：已知标题词、以及「短小纯中文 + 前面有空行分隔」。
 */
function isSectionHeader(text, isDetailHeader, blankBefore) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  /* detail_header 是页面显式标注的标题，可能带长内容（如「本句出自：某某（原文名）」），不受长度限制 */
  if (isDetailHeader) return true;
  if (s.length > 14) return false;
  if (/[:：]\s*$/.test(s)) return true;
  if (HEADER_WORDS.test(s)) return true;
  if (blankBefore && /^[\u4e00-\u9fff]{2,6}$/.test(s)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 解析「每日一句」页面                                                 */
/* ------------------------------------------------------------------ */

function parseDaily(html) {
  const out = { fetchedAt: new Date().toISOString(), ok: false };

  // ---- 日期 ----------------------------------------------------------
  const dateText = stripTags(pick(/<p class="daytime">([\s\S]*?)<\/p>/i, html));
  out.date = dateText || '';
  const dm = dateText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dm) {
    out.dateISO = `${dm[3]}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
    out.dateCN = `${dm[3]}年${Number(dm[1])}月${Number(dm[2])}日`;
  }

  // ---- 配图（页面卡片左上角的大图）------------------------------------
  const imgTag = pick(/<img[^>]*id="showerimg"[^>]*>/i, html) || pick(/<img[^>]*class="himg"[^>]*>/i, html);
  let imgUrl = pick(/src="([^"]+)"/i, imgTag);
  if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
  out.imageRaw = imgUrl;
  out.image = imgUrl ? '/api/img?u=' + encodeURIComponent(imgUrl) : '';

  // ---- 中英文句子 -----------------------------------------------------
  out.en = stripTags(pick(/<p class="sect sect_en">([\s\S]*?)<\/p>/i, html));
  out.cn = stripTags(pick(/<p class="sect-trans">([\s\S]*?)<\/p>/i, html));

  // ---- 发音音频 -------------------------------------------------------
  out.audio = {
    normal: decodeEntities(pick(/id="normal-play"[^>]*data="([^"]+)"/i, html)),
    slow: decodeEntities(pick(/id="slow-play"[^>]*data="([^"]+)"/i, html)),
  };

  // ---- 永久链接 -------------------------------------------------------
  const perm = pick(/<a class="voiceText"[^>]*href=["']?([^"'\s>]+)/i, html);
  out.permalink = perm ? perm.replace(/^http:/, 'https:') : '';

  // ---- 解析正文 -------------------------------------------------------
  const anBlock = pick(/<div class="an-info[^"]*">([\s\S]*?)<\/div>/i, html);
  const items = anBlock
    .split(/<br\s*\/?>/i)
    .map((seg) => ({
      header: /detail_header/i.test(seg),
      text: stripTags(seg),
    }))
    .filter((it, i, arr) => it.text || (i > 0 && i < arr.length - 1)); // 丢掉首尾空段

  const JUNK = /(关注微信公众号|获取本期|完整讲义|讲义)/;
  let notice = '';

  const sections = [];
  let cur = null;
  let blankBefore = false; // 上一项是否空行（上游用空行把小标题与正文分开）
  for (const it of items) {
    if (!it.text) {
      blankBefore = true;
      continue;
    }
    if (JUNK.test(it.text)) {
      notice = (notice ? notice + ' ' : '') + it.text;
      blankBefore = false;
      continue;
    }
    const isHeader = isSectionHeader(it.text, it.header, blankBefore);
    blankBefore = false;
    if (isHeader) {
      cur = { label: it.text.replace(/[:：]\s*$/, '').trim(), lines: [] };
      sections.push(cur);
    } else {
      if (!cur) {
        cur = { label: '', lines: [] };
        sections.push(cur);
      }
      cur.lines.push(it.text);
    }
  }
  out.definitions = [];
  out.examples = [];
  out.usages = [];
  out.usagesTitle = '';
  out.word = '';
  out.phonetic = '';
  out.phonetics = [];
  out.notice = notice;
  out.source = { title: '', author: '', desc: '' };

  for (const sec of sections) {
    const label = sec.label;
    const lines = sec.lines;
    if (/本句出自|出自|来源/.test(label)) {
      out.source.title = sec.label ? label : lines.shift() || '';
      const tail = (out.source.title || '').replace(/^.*?[:：]\s*/, '');
      const am = tail.match(/^([^（(]+)/);
      out.source.author = (am ? am[1] : tail).trim();
      out.source.desc = lines.join(' ').trim();
    } else if (/^解析|^词汇|^单词|^释义|^词义/.test(label)) {
      if (lines.length) {
        const parsed = parseWordLine(lines.shift());
        out.word = parsed.word;
        out.phonetics = parsed.phonetics;
        /* 兼容字段：只有一个音标时给字符串，双音标交给 phonetics */
        out.phonetic = parsed.phonetics.length === 1 ? parsed.phonetics[0].ph : '';
        for (const l of lines) {
          const pm = l.match(/^([a-zA-Z]{1,6}\.)\s*(.+)$/);
          if (pm) out.definitions.push({ pos: pm[1].toLowerCase(), text: pm[2].trim() });
          else out.definitions.push({ pos: '', text: l });
        }
      }
    } else if (/^例句|^例/.test(label)) {
      let pendingEn = null;
      for (const l of lines) {
        const hasCJK = /[\u4e00-\u9fff]/.test(l);
        if (!hasCJK) {
          if (pendingEn) out.examples.push({ en: pendingEn, cn: '' });
          pendingEn = l;
        } else if (pendingEn) {
          out.examples.push({ en: pendingEn, cn: l });
          pendingEn = null;
        } else {
          out.examples.push({ en: '', cn: l });
        }
      }
      if (pendingEn) out.examples.push({ en: pendingEn, cn: '' });
    } else if (/用法|搭配|短语|词组|句式|表达/.test(label)) {
      out.usages = lines.slice();
      out.usagesTitle = label || '常用搭配';
    } else if (!out.source.desc && lines.length) {
      out.source.title = out.source.title || sec.label;
      out.source.desc = lines.join(' ').trim();
    }
  }

  // ---- 兜底：上游解析块缺失时，从英文句子里挑候选关键词 -----------------
  // 不再直接把「最长的词」当关键词（那是错的），只给出候选，由前端决定用哪个，
  // 并在海报上标出来源，避免把猜出来的词当成权威关键词展示。
  out.missing = !out.definitions.length;
  out.candidates = out.missing && out.en ? extractKeywords(out.en, 3) : [];

  out.ok = Boolean(out.en || out.cn);
  return out;
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

const memo = new Map(); // key -> { exp, value }

function cacheGet(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (hit.exp && hit.exp < Date.now()) {
    memo.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  memo.set(key, { value, exp: ttlMs ? Date.now() + ttlMs : 0 });
  if (memo.size > 200) {
    const k = memo.keys().next().value;
    memo.delete(k);
  }
}

/**
 * 上游「解析」块为空时（服务端偶发漏发），用词典页补全音标/释义/例句。
 * 上游有数据时永远以上游为准，绝不覆盖。
 */
async function supplementFromDict(data) {
  if (!data.missing) return data;

  const list = (data.candidates || []).map((c) => c.word);
  const target = data.word && !list.includes(data.word) ? data.word : null;
  const queue = target ? [target].concat(list) : list;
  if (!queue.length) return data;

  /* 首选候选先单独查；还是没有再补一个候选。全是 302 / 查不到也就算了，
     宁可回落到「不画单词卡片」，也不要把猜来的词当权威内容展示。 */
  let hit = null;
  for (const w of queue.slice(0, 2)) {
    try {
      hit = await lookupWord(w);
    } catch (e) {
      hit = null;
    }
    if (hit) break;
  }

  if (hit) {
    data.fallback = hit;
    data.fallbackWord = hit.query;
    data.fallbackNote = hit.lemma ? `已按原形 ${hit.lemma} 取释义` : '';
  }
  return data;
}

async function getDaily(force) {
  const key = 'daily';
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const res = await fetchRaw(DAILY_PAGE);
  if (res.status !== 200) throw new Error('上游返回 ' + res.status);
  const data = parseDaily(res.body.toString('utf8'));
  if (!data.ok) throw new Error('页面解析失败');
  await supplementFromDict(data);
  data.cached = true;
  cacheSet(key, data, 30 * 60 * 1000);
  return data;
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const immutable = ['.woff2', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(ext);
    fs.readFile(filePath, (e, buf) => {
      if (e) return send(res, 500, 'read error');
      send(res, 200, buf, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache',
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 服务入口                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = u.pathname;

  // ---- API：每日一句 --------------------------------------------------
  if (pathname === '/api/daily') {
    try {
      const data = await getDaily(u.searchParams.get('refresh') === '1');
      return send(res, 200, Buffer.from(JSON.stringify(data)), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      return send(
        res,
        502,
        Buffer.from(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) })),
        { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      );
    }
  }

  // ---- API：查词（补全上游缺失的音标 / 释义 / 例句）-------------------
  if (pathname === '/api/lookup') {
    const w = (u.searchParams.get('word') || '').trim();
    if (!/^[A-Za-z][A-Za-z'’-]{0,40}$/.test(w)) {
      return send(res, 400, Buffer.from(JSON.stringify({ ok: false, error: '关键词不合法' })), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }
    try {
      const r = await lookupWord(w);
      const payload = r ? Object.assign({ ok: true }, r) : { ok: false, word: w };
      return send(res, 200, Buffer.from(JSON.stringify(payload)), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      return send(
        res,
        502,
        Buffer.from(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) })),
        { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      );
    }
  }

  // ---- API：图片代理 --------------------------------------------------
  if (pathname === '/api/img') {
    let target = u.searchParams.get('u') || '';
    try {
      const parsed = new URL(target);
      if (!ALLOW_HOSTS.has(parsed.hostname)) {
        return send(res, 403, 'host not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const hit = cacheGet('img:' + target);
      if (hit) {
        return send(res, 200, hit.body, {
          'Content-Type': hit.type,
          'Cache-Control': 'public, max-age=86400',
        });
      }
      const up = await fetchRaw(parsed.toString(), { timeout: 20000 });
      if (up.status !== 200) {
        return send(res, 502, 'upstream ' + up.status, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      const type = up.headers['content-type'] || 'image/jpeg';
      cacheSet('img:' + target, { body: up.body, type }, 6 * 60 * 60 * 1000);
      return send(res, 200, up.body, {
        'Content-Type': type,
        'Content-Length': up.body.length,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
    } catch (err) {
      return send(res, 502, 'proxy error: ' + (err && err.message), {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
  }

  // ---- 健康检查 -------------------------------------------------------
  if (pathname === '/api/health') {
    return send(res, 200, Buffer.from(JSON.stringify({ ok: true, ts: Date.now() })), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[dailysentence] http://localhost:${PORT}  (HOST=${HOST})`);
});

module.exports = { parseDaily, parseDictPage, extractKeywords, lookupWord };
