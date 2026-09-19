#!/usr/bin/env node
/**
 * 上游页面解析回归（零依赖）
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
 */
const fs = require('fs');
const path = require('path');
const { parseDaily } = require('./server.js');

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
console.log(`parse-check: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
