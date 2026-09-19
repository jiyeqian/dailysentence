#!/usr/bin/env node
/**
 * 上游页面解析 + 存档回归（零依赖）
 *
 *   node app/parse-check.js
 *
 * 上游「每日一句」页面改过好几次结构，每次都要保证「新结构能解析」且
 * 「老结构不回归」。这里把出现过的每种结构钉成用例：
 *
 *   1. 2026-09-20  短语型：`1. get something done 使某事被完成`（词与释义同行、无音标、带序号）
 *   2. 2026-09-18  词 + 英/美双音标 + 词性释义
 *   3. 更早期      词 + 单音标（无语言标签）
 *   4. 2026-09-19  解析块整块退化成 CSS，出处被塞在中文译文末尾
 *   5. 解析块彻底缺失 → 只能给候选关键词
 *   6. 解析里的短编号条目应当仍是释义，不能被当成用法条目吃掉
 *
 * 外加存档（data/）的用例：写入 / 幂等 / 合并 / 读取。
 * 存档写到临时目录，不会污染 app/data —— 靠 DS_DATA_DIR 环境变量指定。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-archive-'));
process.env.DS_DATA_DIR = TMP_DATA; // 必须在 require server.js 之前

const {
  parseDaily,
  archiveDaily,
  listDays,
  readRecord,
  mergeContent,
  contentOf,
  todayISO,
} = require('./server.js');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

/* ---------------------------------------------------------------- */
/* 用例：2026-09-20 短语型（真实页面快照）                            */
/* ---------------------------------------------------------------- */
const todayFile = path.join(__dirname, 'fixtures', 'daily-2026-09-20.html');
if (fs.existsSync(todayFile)) {
  const d = parseDaily(fs.readFileSync(todayFile, 'utf8'));
  eq('0920 关键词', d.word, 'get something done');
  eq('0920 音标', d.phonetics, []);
  eq('0920 释义', d.definitions, [{ pos: '', text: '使某事被完成，让别人为自己做某事' }]);
  eq('0920 例句条数', d.examples.length, 4);
  eq('0920 例句首条', d.examples[0], {
    en: 'I need to get my hair cut this weekend.',
    cn: '我这个周末得去理个发。',
  });
  eq('0920 用法条目', d.usages.length, 2);
  eq('0920 用法标题', d.usagesTitle, '用法详解');
  eq('0920 出处', d.source.author, '乔治·卡林');
  ok('0920 不算缺解析', d.missing === false, d.missing);
  ok('0920 公众号推广被拦下', /获取本期晨读完整讲义/.test(d.notice), d.notice);
} else {
  ok('0920 夹具存在', false, todayFile);
}

/* ---------------------------------------------------------------- */
/* 历史结构（内联片段）                                              */
/* ---------------------------------------------------------------- */
const head = (aninfo) => `<!doctype html><html><body>
<p class="daytime">9/18/2026</p>
<div class="head-img"><img src="http://x/y.jpg" class="himg" id="showerimg" /></div>
<div class="sentence">
<p class="sect sect_en">The truth is rarely pure and never simple.</p>
<p class="sect-trans">真相很少纯粹，也绝不简单。</p>
</div>
<div class="btn-name" id="normal-play" data="https://a/n.mp3"></div>
<div class="btn-name" id="slow-play" data="https://a/s.mp3"></div>
<a class="voiceText" href=http://dict.eudic.net/home/dailysentence/abc target=_blank></a>
<div class="analysis">${aninfo}</div>
</body></html>`;

/* 2. 2026-09-18：英/美双音标 + 词性释义 + 例句 */
{
  const html = head(`<div class="an-info info_en">
<span class='detail_header'>本句出自：奥斯卡·王尔德（Oscar Wilde）</span><br />
<span class="exp">爱尔兰作家、诗人、剧作家。</span><br /><br />
<span class='detail_header'>解析:</span><br />
<span class="exp">deceive 英 /dɪˈsiːv/ 美 /dɪˈsiːv/</span><br />
<span class="exp">vt. 欺骗，蒙蔽</span><br />
<span class="exp">vi. 行骗</span><br />
<span class='detail_header'>例句:</span><br />
<span class="eg">He deceived her. </span><br />
<span class="exp">他欺骗了她。</span><br />
</div>`);
  const d = parseDaily(html);
  eq('0918 关键词', d.word, 'deceive');
  eq('0918 双音标', d.phonetics, [{ label: '英', ph: 'dɪˈsiːv' }, { label: '美', ph: 'dɪˈsiːv' }]);
  eq('0918 释义', d.definitions, [
    { pos: 'vt.', text: '欺骗，蒙蔽' },
    { pos: 'vi.', text: '行骗' },
  ]);
  eq('0918 例句', d.examples, [{ en: 'He deceived her.', cn: '他欺骗了她。' }]);
  eq('0918 出处', d.source.author, '奥斯卡·王尔德');
  ok('0918 不算缺解析', d.missing === false, d.missing);
}

/* 3. 更早期：单音标无语言标签 */
{
  const html = head(`<div class="an-info">
<span class='detail_header'>本句出自：某某</span><br /><br />
<span class='detail_header'>解析:</span><br />
<span class="exp">impulse  /ˈɪmpʌls/</span><br />
<span class="exp">n. 冲动， impetus</span><br />
</div>`);
  const d = parseDaily(html);
  eq('早期 关键词', d.word, 'impulse');
  eq('早期 单音标', d.phonetics, [{ label: '', ph: 'ˈɪmpʌls' }]);
  eq('早期 兼容串字段', d.phonetic, 'ˈɪmpʌls');
  eq('早期 释义', d.definitions, [{ pos: 'n.', text: '冲动， impetus' }]);
}

/* 4. 2026-09-19：解析块退化成 CSS，出处塞在中文译文末尾 */
{
  const html = `<!doctype html><html><body>
<p class="daytime">9/19/2026</p>
<div class="sentence">
<p class="sect sect_en">What we do for ourselves dies with us.</p>
<p class="sect-trans">我们为自己做的事会随我们一同消亡，为他人和世界做的事则会永存。——卢梭</p>
</div>
<div class="analysis"><div class="an-info info_en">
<style>.eg {color:#117AC1;} .exp {color:#858585;}</style>
</div></div>
</body></html>`;
  const d = parseDaily(html);
  ok('0919 判为缺解析', d.missing === true, d.missing);
  eq('0919 出处从译文摘出', d.source.author, '卢梭');
  ok('0919 译文摘净', d.cn === '我们为自己做的事会随我们一同消亡，为他人和世界做的事则会永存。', d.cn);
  ok('0919 给出候选', d.candidates.length > 0, d.candidates);
}

/* 5. 解析块彻底缺失 */
{
  const d = parseDaily(`<!doctype html><html><body>
<p class="sect sect_en">When cheese gets its picture taken, what does it say?</p>
<p class="sect-trans">奶酪拍照时，会说些什么？</p>
</body></html>`);
  ok('缺失 判为缺解析', d.missing === true, d.missing);
  eq('缺失 无关键词', d.word, '');
  ok('缺失 有候选', d.candidates.length === 3, d.candidates);
  ok('缺失 仍算抓取成功', d.ok === true, d.ok);
}

/* 6. 解析里的短编号条目是释义，不是用法 */
{
  const html = head(`<div class="an-info">
<span class='detail_header'>解析:</span><br />
<span class="exp">1. make up one's mind</span><br />
<span class="exp">1. 下定决心</span><br />
<span class="exp">2. 拿定主意</span><br />
</div>`);
  const d = parseDaily(html);
  eq('短编号 关键词', d.word, "make up one's mind");
  eq('短编号 仍是释义', d.definitions, [
    { pos: '', text: '下定决心' },
    { pos: '', text: '拿定主意' },
  ]);
  eq('短编号 不进用法', d.usages, []);
}

/* ---------------------------------------------------------------- */
/* 7. 存档：写入 / 幂等 / 合并 / 读取                                  */
/* ---------------------------------------------------------------- */
{
  const day = (iso, extra) =>
    Object.assign(
      {
        ok: true,
        date: '9/20/2026',
        dateISO: iso,
        dateCN: '2026年9月20日',
        en: 'A sentence.',
        cn: '一句话。',
        word: 'word',
        phonetics: [{ label: '英', ph: 'wɜːd' }],
        definitions: [{ pos: 'n.', text: '词' }],
        examples: [{ en: 'An example.', cn: '一个例子。' }],
        usages: [],
        usagesTitle: '',
        source: { title: '本句出自：某人', author: '某人', desc: '描述' },
        imageRaw: 'http://x/y.jpg',
        image: '/api/img?u=x',
        permalink: 'https://dict.eudic.net/home/dailysentence/abc',
        audio: { normal: 'https://a/n.mp3', slow: 'https://a/s.mp3' },
        missing: false,
        candidates: [],
        cached: true, // 只在当次请求有意义的字段，不该进存档
      },
      extra || {}
    );

  const first = archiveDaily(day('2026-09-18'));
  ok('存档 写入成功', !!first && first.rev === 1, first && first.rev);
  eq('存档 列表有这一天', listDays().map((d) => d.dateISO), ['2026-09-18']);
  eq('存档 读回关键词', readRecord('2026-09-18').word, 'word');
  ok('存档 丢掉临时字段', contentOf(day('2026-09-18')).cached === undefined, null);

  /* 内容没变 → 不重复写盘（rev 不动） */
  archiveDaily(day('2026-09-18'));
  eq('存档 幂等（内容没变不写盘）', readRecord('2026-09-18').rev, 1);

  /* 上游第二次给出了更多内容 → 合并补齐 */
  const better = archiveDaily(
    day('2026-09-18', {
      phonetics: [{ label: '英', ph: 'wɜːd' }, { label: '美', ph: 'wɝːd' }],
      definitions: [{ pos: 'n.', text: '词' }, { pos: 'v.', text: '措辞' }],
    })
  );
  eq('存档 合并后 rev+1', better.rev, 2);
  eq('存档 合并后释义更全', better.definitions.length, 2);
  eq('存档 合并后音标更全', better.phonetics.length, 2);
  ok('存档 保留首次抓取时间', better.firstSeenAt === first.firstSeenAt, {
    first: first.firstSeenAt,
    now: better.firstSeenAt,
  });

  /* 反向：完整内容在先、残缺内容在后，不能被覆盖掉 */
  const worse = archiveDaily(day('2026-09-18', { definitions: [], phonetics: [], missing: true, word: '' }));
  eq('存档 残缺不覆盖完整释义', worse.definitions.length, 2);
  eq('存档 残缺不覆盖关键词', worse.word, 'word');

  /* 缺解析的那天先入库、之后再补上释义 → missing 要翻回 false */
  archiveDaily(day('2026-09-17', { definitions: [], missing: true, word: '' }));
  eq('存档 缺解析有标记', readRecord('2026-09-17').missing, true);
  archiveDaily(day('2026-09-17'));
  eq('存档 补全后标记翻回', readRecord('2026-09-17').missing, false);
  eq('存档 列表按日期倒序', listDays().map((d) => d.dateISO), ['2026-09-18', '2026-09-17']);

  eq('存档 拒绝非法日期', archiveDaily(day('20-9-18')), null);
  eq('存档 读不存在的日期', readRecord('2026-09-16'), null);
  eq('存档 未抓成功不落盘', archiveDaily({ ok: false, dateISO: '2026-09-15' }), null);
  ok('存档 今天形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayISO()), todayISO());
  ok('存档 索引文件已生成', fs.existsSync(path.join(TMP_DATA, 'index.json')), TMP_DATA);
}

try {
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
} catch (e) {}

/* ---------------------------------------------------------------- */
console.log(`parse-check: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
