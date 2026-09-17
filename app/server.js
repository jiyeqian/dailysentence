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

/* ------------------------------------------------------------------ */
/* HTTP 抓取（自动跟随跳转，支持 http / https）                          */
/* ------------------------------------------------------------------ */

function fetchRaw(target, opts = {}) {
  const redirects = opts.redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      return reject(new Error('bad url: ' + target));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
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
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 5) {
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

  // ---- 兜底：没有解析块时，从英文句子里猜关键词 -------------------------
  if (!out.word && out.en) {
    const STOP = new Set(['the', 'a', 'an', 'and', 'but', 'or', 'by', 'of', 'to', 'in', 'on', 'is', 'are', 'not', 'it', 'that', 'this']);
    const words = out.en.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
    const cand = words.filter((w) => !STOP.has(w)).sort((a, b) => b.length - a.length)[0];
    if (cand) {
      out.word = cand;
      out.wordGuessed = true;
    }
  }

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

module.exports = { parseDaily };
