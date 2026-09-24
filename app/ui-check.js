/* 交互回归（2026-09-21 标准版重构后重写）
   断言的是新版面与新交互：
     1) 浮框 / 控件仓库 / 引导 / 顶栏 都不存在了（DOM 里查不到）
     2) 标准版画布恒 1080×1920；长版仍按内容长高
     3) 标准版元素固定为 bg / badge-date / en / cn / source / card
     4) 信息卡距左 / 右 / 底三边等距 48，顶部图片宽度铺满并裁到 648
     5) 双击句子元素 → 该元素从海报消失、其余上移，画布尺寸不变（不可逆，刷新恢复）
     6) 单击顶部图片 / 信息卡 → 唤起相册选图；单击句子 → 朗读；单击日期 → 切今日/昨日
     7) 长按 → 保存：桌面走下载（文件名 YYYY-MM-DD），iOS 走「浮层原图 → 存储到照片」
     8) 下拉更新 → 回到初始状态（隐藏清空 / 缩放归位 / 相册图复原）
     9) 摆位：浏览器里不做竖直补正（--stage-pt 恒 0）；独立全屏桩下按「物理屏 − 布局框」
        补正并把海报中心对准物理屏中线（真机 bug：独立形态下整体偏上半个状态栏）
    10) 语音独占层：点 3 区（英文句）朗读后升起波形 —— **只有竖条、没有任何底板**（无背景 / 描边 /
        毛玻璃，竖条自带极淡投影），宽度 = 正文列宽 × 90%、**按 3 区文字框居中（左右留白相等）**、
        只盖 3 区不碰中文句与日期胶囊；播放中其余手势全部失效；点波形即停并恢复；
        中文句 / 出处单击不再发音但双击仍能删除；?raw=1 里没有波形层
    10b) 播放与波形严格同步：波形只由音频事件驱动（`playing` 才升，`pause` / `ended` / `error`
         / `emptied` 即收），`play()` 的 Promise 只用于报错；没有音频文件、或 play() 成功但
         始终不出声（静默失败）都**不出波形**；音频被外部暂停、或 currentTime 卡死时看门狗
         在几秒内收起；`inspect().voiceDiag` 自证每次收尾的原因与时长
    10c) 冷启动首点：桩模拟「mp3 还没下完」（play 挂 1 秒才 settle，期间被 pause 就是 AbortError）
         —— 必须照样出声出波形，不打断挂起的 play、errName 为空
    10d) 海报圆角（32 设计值）：**画进成品**（画布四角透明、圆角内不透明），屏幕用同一半径显示
         （= 32 × 显示比例）；口径是「圆角只许画进 canvas，不许只加 CSS」，不是「不许有圆角」
    11) 换图调整层：独立不透明弹层，**原海报完全不动**；层里只有居中的换图区与这张图
        （窗口内清晰、窗外是这张图压暗 62% 的其余部分、窗口是圆角矩形）；
        没有任何描边 / 虚线（源码里不再有 drawEditFrame）；点窗口 = 换同一张、点窗外 = 完成；
        退出后弹层收起、海报没有位移
    12) 文字字号：进入即按固定设计基准显示（短句 base=1、字号正好 50/44/36/28，不再自适应放大）；
        2/3/4/5 各区一份交互变换，滑句子区 3/4/5 联动、滑日期只改日期；超长句整块等比缩小保底；
        3 区（英文句）用 EB Garamond（自托管 woff2，OFL），字族放在 layout.en.family 上，
        量测 / 绘制 / 标注三处共用它（长版仍是无衬线）
    13) 缩放上限按区不同：2 区（日期）3 倍、3/4/5 区 1.6 倍；胶囊（含高度）随字号等比变大、
        活动区随之下移（短句字号不受影响）；到上限提示「已放到最大」
    14) 真机诊断页（?diag=1）：面板出现且放开文本选择、含形态/屏幕/安全区/舞台/海报/版面/音频自证；
        该模式下长按不弹保存；不带参数与 ?raw=1 下都不出现

   跑法：先 node server.js（8787），再
     NODE_PATH=<node workspace>/node_modules node app/ui-check.js  */
const path = require('path');
const fs = require('fs');

/* playwright 是外挂工具（不在 package.json 里），找不到就说明怎么借，而不是崩 */
let chromium;
let devices;
try {
  ({ chromium, devices } = require('playwright'));
} catch (e) {
  console.log(
    '[ui-check] 跳过：没找到 playwright。\n' +
    '  NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node app/ui-check.js\n' +
    '（或 npm i -D playwright && npx playwright install chromium）'
  );
  process.exit(0);
}

const OUT = path.join(__dirname, 'shots');
const BASE = 'http://127.0.0.1:8787';
const TEMPLATE = path.join(__dirname, 'public/assets/template.jpg');   /* 1179×2098 竖图 */

/**
 * 可控的 Audio 桩（每个页面导航前注入）。
 *
 * ⚠ 2026-09-22 起语音改成**事件驱动**：波形只在音频真的派发 `playing` 时升起，
 * 所以桩必须像真浏览器一样在 `play()` 之后派发 `playing` —— 否则新实现会被误判成「没波形」。
 * `__audioStub.mode('silent')` 模拟「play() 成功但永远不出声」，用来钉死
 * 「没有真出声就绝不升波形」这条要求。
 *
 * 模型忠于规范：`pause()` 只改状态、不派发事件（项目自己的收尾是「先摘监听再 pause」，
 * 真实浏览器里那个 pause 事件也不会再被自己收到）；测试要模拟「被外部暂停」用
 * `pauseExternally()`。duration 故意给大值 —— 硬上限是时长 + 1500ms（封顶 20s），
 * 太小会在断言途中自动收起。
 */
const AUDIO_STUB = () => {
  const made = [];
  let mode = 'normal';        /* normal 正常 | silent play 成功但永不出声 | cold 冷缓存（play 挂 1s 才 settle） */
  const COLD_MS = 1000;
  class StubAudio extends EventTarget {
    constructor(src) {
      super();
      this.src = src || '';
      this.paused = true;
      this.muted = false;
      this.volume = 1;
      this.currentTime = 0;
      this.duration = 30;
      this.plays = 0;
      this.pauses = 0;
      made.push(this);
    }
    play() {
      this.paused = false;
      this.plays++;
      /* 模拟真实播放：currentTime 会走 —— 否则「进度看门狗」会把静止当成卡死（测试桩假阳性） */
      if (!this.__tick) {
        this.__tick = setInterval(() => {
          if (this.paused || this.__stalled) return;
          this.currentTime += 0.25;
          if (this.currentTime >= this.duration) {     /* 放到头 = 真的播完 */
            this.paused = true;
            clearInterval(this.__tick);
            this.__tick = null;
            this.dispatchEvent(new Event('ended'));
          }
        }, 250);
      }
      if (mode === 'cold') {
        /* 冷缓存模型：play() 要等一会儿才 settle；**这段时间里被 pause，按规范以 AbortError
           打断**（老实现就是这样：prime 那次 play 还挂着，speak 又去 pause 它 → 第一次点必失败） */
        this.__pending = true;
        return new Promise((res, rej) => {
          this.__abort = () => {
            if (!this.__pending) return;
            this.__pending = false;
            const e = new Error('The play() request was interrupted by a call to pause()');
            e.name = 'AbortError';
            rej(e);
          };
          this.__timer = setTimeout(() => {
            if (!this.__pending) return;
            this.__pending = false;
            if (!this.paused) this.dispatchEvent(new Event('playing'));
            res();
          }, COLD_MS);
        });
      }
      if (mode !== 'silent') setTimeout(() => this.dispatchEvent(new Event('playing')), 20);
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.pauses++;
      if (this.__pending && this.__abort) this.__abort();      /* 打断挂起的 play */
    }
  }
  window.Audio = StubAudio;
  window.__audioStub = {
    made,
    last: () => made[made.length - 1] || null,
    count: () => made.length,
    mode: (m) => { mode = m || 'normal'; },
    /* 模拟「被外部暂停」（真浏览器会派发 pause 事件） */
    pauseExternally: (a) => {
      const el = a || window.__audioStub.last();
      el.pause();
      el.dispatchEvent(new Event('pause'));
      return el;
    },
    /* 模拟「卡死」：没暂停，但 currentTime 不再前进（解码卡住 / 被系统挂起） */
    stall: (a) => {
      const el = a || window.__audioStub.last();
      el.paused = false;
      el.__stalled = true;
      return el;
    },
  };
};

let fails = 0;
function ok(label, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '   ' + extra : ''));
  if (!cond) fails++;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  async function open(url, viewport = { width: 390, height: 844 }) {
    /* hasTouch：调整模式的「双指捏合」只能靠触摸事件模拟 */
    const p = await browser.newPage({ viewport, deviceScaleFactor: 2, hasTouch: true });
    await p.addInitScript(AUDIO_STUB);        /* 语音不能依赖真实播放，见 AUDIO_STUB 注释 */
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__ds && window.__ds.state.layout, null, { timeout: 15000 });
    return p;
  }

  const shot = (p, name) => p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  const info = (p) => p.evaluate(() => window.__ds.inspect());
  const ids = (d) => d.items.map((it) => it.id);
  const box = (d, id) => (d.items.find((it) => it.id === id) || {}).box;

  /* 按命中表反查屏幕坐标（画布坐标 → 屏幕坐标由页面自己换算） */
  async function pointOf(p, regionId, index = 0) {
    const pt = await p.evaluate(({ id, index }) => {
      const list = (window.__ds.state.regions || []).filter((r) => r.id === id);
      const r = list[index];
      if (!r) return null;
      const c = window.__ds.toClient(r.x + r.w / 2, r.y + r.h / 2);
      return { x: Math.round(c.x), y: Math.round(c.y) };
    }, { id: regionId, index });
    if (!pt) throw new Error('找不到区域 ' + regionId);
    return pt;
  }

  async function tap(p, regionId, index = 0, dbl = false) {
    const pt = await pointOf(p, regionId, index);
    if (dbl) await p.mouse.dblclick(pt.x, pt.y);
    else await p.mouse.click(pt.x, pt.y);
    await p.waitForTimeout(420);
    return pt;
  }

  /** 在某个区域上上下拖动（测试上下滑动缩放）；dy 为负 = 上滑 */
  async function dragY(p, regionId, dy) {
    const pt = await pointOf(p, regionId);
    await p.mouse.move(pt.x, pt.y);
    await p.mouse.down();
    await p.mouse.move(pt.x, pt.y + dy, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(340);
    return pt;
  }

  /** 在某个区域上向下拉（测试下拉更新）；dy 为正 = 下拉 */
  async function pullY(p, regionId, dy) {
    const pt = await pointOf(p, regionId);
    await p.mouse.move(pt.x, pt.y);
    await p.mouse.down();
    await p.mouse.move(pt.x, pt.y + dy, { steps: 10 });
    await p.mouse.up();
    await p.waitForTimeout(360);
    return pt;
  }

  /** 在某个区域上按住拖动（dx/dy 为 CSS px）—— 只在海报上可用（弹层里用 dragWin） */
  /** 退出调整模式：点弹层里窗口以外的地方（左上角永远在窗口之外，两块都适用） */
  async function finishAdjust(p) {
    await p.mouse.click(12, 12);
    await p.waitForTimeout(420);
  }

  /** 换图弹层里那个窗口的 rect / 中心（层内 CSS px，就是 client 坐标） */
  const windowRect = (p) => p.evaluate(() => window.__ds.inspect().edit.window);
  async function windowCenter(p) {
    const w = await windowRect(p);
    return { x: Math.round(w[0] + w[2] / 2), y: Math.round(w[1] + w[3] / 2) };
  }

  /** 在换图窗口上拖动（弹层里的单指平移）：坐标取自窗口 rect，而不是海报里的区域 */
  async function dragWin(p, dx, dy) {
    const c = await windowCenter(p);
    await p.mouse.move(c.x, c.y);
    await p.mouse.down();
    await p.mouse.move(c.x + dx, c.y + dy, { steps: 10 });
    await p.mouse.up();
    await p.waitForTimeout(260);
  }

  /**
   * 换图弹层的像素判定：塞一张纯白合成图，量
   *   窗口内（应 255，清晰）、窗口外的这张图（应被压暗 62%）、窗口角上（应被压暗 → 圆角生效）。
   * 白图让期望值可以精确算出来，不用靠肉眼。
   */
  async function whiteProbe(p, target) {
    await p.evaluate((t) => {
      const c = document.createElement('canvas');
      c.width = 1080; c.height = 1440;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
      if (t === 'card') window.__ds.state.template = c;
      else window.__ds.state.bgImage = c;
      window.__ds.state.fits[t] = { scale: 1, ox: 0, oy: 0 };
      window.__ds.scheduleRender();
    }, target);
    await p.waitForTimeout(450);
    return p.evaluate((t) => {
      const e = window.__ds.inspect().edit;
      const [wx, wy, ww, wh] = e.window;
      const cvs = document.getElementById('editCvs');
      const dpr = window.devicePixelRatio || 1;
      const ctx = cvs.getContext('2d');
      const at = (x, y) => {
        const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      return {
        target: t, window: e.window, radius: e.radius,
        center: at(wx + ww / 2, wy + wh / 2),
        edgeMid: at(wx + 8, wy + wh / 2),
        /* 角上取点按半径比例内缩：与圆弧中心的距离 = 1.13R > R，必然落在圆角之外
           （固定写 3px 会随 radius 变化而落到弧内，那样就测不出圆角） */
        corner: at(wx + e.radius * 0.2, wy + e.radius * 0.2),
        outside: at(wx + ww / 2, wy + wh + 26),
      };
    }, target);
  }

  /**
   * 往 state.content 塞指定文案后重绘，返回新的 inspect()。
   * 用来做「与线上当天句子无关」的确定性断言（短句正好等于设计基准、超长句触发保底）。
   * 调用方记得 reload 收尾，别把注入的文案带进后面的断言。
   */
  async function withContent(p, patch) {
    await p.evaluate((patch) => {
      window.__ds.state.content = Object.assign({}, window.__ds.state.content, patch);
      window.__ds.scheduleRender();
    }, patch);
    await p.waitForTimeout(420);
    return info(p);
  }

  /** 点波形层中心 —— 它本身就是播放期间的停止按钮 */
  async function tapWave(p) {
    const pt = await p.evaluate(() => {
      const r = document.getElementById('wave').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await p.mouse.click(pt.x, pt.y);
    await p.waitForTimeout(480);
  }

  /**
   * 双指捏合（调整模式的缩放）。Playwright 的 mouse 只有一个指针，
   * 所以走 CDP 的触摸事件：两指从 distance 出发，按 factor 拉开再抬起。
   */
  async function pinchOn(p, cx, cy, factor, from) {
    const cdp = await p.context().newCDPSession(p);
    const pts = (d) => [
      { x: Math.round(cx - d), y: Math.round(cy), id: 1 },
      { x: Math.round(cx + d), y: Math.round(cy), id: 2 },
    ];
    const d0 = from || 60;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: pts(d0 * (1 + (factor - 1) * (i / 8))),
      });
      await p.waitForTimeout(28);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(320);
    await cdp.detach();
  }

  const speakAt = (x) => x.meta.lastSpeakAt || 0;
  const viewDate = (p) => p.evaluate(() => window.__ds.state.viewDate || '');

  /* ---------------- 标准版：结构与尺寸 ---------------- */
  console.log('标准版 · 结构与尺寸');
  let p = await open(BASE + '/?debug=1');
  await p.waitForTimeout(600);
  await shot(p, 's1-standard');

  const gone = await p.evaluate(() =>
    ['pop', 'kit', 'frames', 'tip', 'mark', 'srcTag', 'segBg'].filter((id) => document.getElementById(id))
  );
  ok('浮框 / 控件仓库 / 引导已从 DOM 移除', gone.length === 0, gone.length ? '仍存在: ' + gone.join(',') : '');

  let d = await info(p);
  const H0 = d.canvas.h;   /* 画布高（设计坐标）；固定画布下恒为 1920 */
  ok('画布宽恒为设计基准 1080（设计坐标 = 标注通道的契约）', d.canvas.w === 1080, 'w=' + d.canvas.w);
  ok('画布固定 1080×1920（不按设备分辨率出图，adaptive 关闭）',
    d.canvas.adaptive === false && d.canvas.physW === 1080 && d.canvas.physH === 1920 &&
    d.canvas.u === 1 && d.canvas.h === 1920,
    JSON.stringify(d.canvas));
  ok('三段尺寸仍是设计值（活动区 576、图片区 648、卡片 496）',
    Math.round(d.text.band.h) === 576 && box(d, 'bg')[3] === 648 && box(d, 'card')[3] === 496,
    `${Math.round(d.text.band.h)} / ${box(d, 'bg')[3]} / ${box(d, 'card')[3]}`);

  /* 显示规则：宽度充满优先 + 等比 + 上下留色块（竖直居中）+ 不裁角 ——
     这几条合起来就是「屏幕上看到的 = 长按另存的那张位图」 */
  const shown = await p.evaluate(() => {
    const r = document.getElementById('poster').getBoundingClientRect();
    const s = document.getElementById('stage').getBoundingClientRect();
    const cs = getComputedStyle(document.getElementById('poster'));
    return {
      w: r.width, h: r.height, stageW: s.width, stageH: s.height,
      padTop: r.top - s.top, padBottom: s.bottom - r.bottom,
      radius: cs.borderRadius,
    };
  });
  const fitW = Math.min(shown.stageW, (shown.stageH * 1080) / 1920);
  ok('显示等比且宽度充满优先（宽 = min(舞台宽, 高×9/16)）',
    Math.abs(shown.w - fitW) < 1.5 && Math.abs(shown.w / shown.h - 1080 / 1920) < 0.002,
    `${shown.w.toFixed(1)}×${shown.h.toFixed(1)}（舞台 ${shown.stageW}×${shown.stageH}，期望宽 ${fitW.toFixed(1)}）`);
  /* 海报圆角（2026-09-22 用户要求）：**画进成品**、屏幕用同一半径显示 —— 这条同时钉三件事：
     屏幕半径 = 32 设计值 × 显示比例、画布四角透明、圆角内与边中点不透明。
     ⚠ 旧断言写的是「海报不裁角（无圆角）」：那是老口径（当时圆角只能在 CSS 上做，会破坏
     「显示 = 成品」）。现在圆角画在 canvas 里、屏幕跟着同半径，显示与成品仍然一致，
     口径改成「圆角只许画进 canvas，不许只加 CSS」。 */
  const radius = await p.evaluate(() => {
    const c = document.getElementById('poster');
    const rect = c.getBoundingClientRect();
    const ctx = c.getContext('2d');
    const W = c.width;
    const alphaAt = (x, y) => ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3];
    const k = W / 1080;                       /* 位图相对设计坐标的比例 */
    return {
      css: parseFloat(getComputedStyle(c).borderRadius),
      expectCss: 32 * (rect.width / 1080),
      corners: [alphaAt(1, 1), alphaAt(W - 2, 1), alphaAt(1, c.height - 2), alphaAt(W - 2, c.height - 2)],
      inside: alphaAt(40 * k, 40 * k),
      midEdge: alphaAt(W / 2, 1),
    };
  });
  ok('海报圆角：屏幕半径 = 32 设计值 × 显示比例（画进成品、屏幕同半径）',
    Math.abs(radius.css - radius.expectCss) < 0.6 && radius.css > 0,
    `屏幕 ${radius.css}px / 期望 ${radius.expectCss.toFixed(2)}px`);
  ok('海报四角确实是圆的：画布四角透明、圆角内与边中点不透明',
    radius.corners.every((a) => a === 0) && radius.inside === 255 && radius.midEdge === 255,
    `四角 alpha ${JSON.stringify(radius.corners)}｜圆角内 ${radius.inside}｜上边中点 ${radius.midEdge}`);
  ok('上下色块等宽（竖直居中）',
    Math.abs(shown.padTop - shown.padBottom) < 1 && shown.padTop > 0,
    `上 ${shown.padTop.toFixed(1)} / 下 ${shown.padBottom.toFixed(1)}（手机屏幕比 9:16 更高，坐实有留白）`);

  /* 竖直居中补正：浏览器里布局视口就是可见区，屏幕高远大于可见区（还含工具栏），
     所以绝对不能加偏移 —— 加了会把海报整体顶出屏幕下沿。这条钉住「只在独立形态生效」。 */
  const noShift = await p.evaluate(() => ({
    css: getComputedStyle(document.getElementById('stage')).paddingTop,
    info: window.__ds.inspect().stage,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
  }));
  ok('浏览器里不做居中补正（--stage-pt 恒 0、CSS 上内边距 0）',
    noShift.css === '0px' && noShift.info.padTop === 0 && noShift.standalone === false,
    JSON.stringify(noShift));

  /* 独立全屏（加到主屏）形态：布局框比物理屏矮一个状态栏且锚在顶部 —— 真机量到的是
     上 53pt / 下 112pt，而 iPhone 自己显示同一张图是 83pt / 80pt（整屏居中）。
     这里用桩注入 standalone 与 screen.height（Chromium 复现不了真机形态），
     视口取 402×812（= 874 − 62 状态栏）→ 应补 62px，补完海报中心对准物理屏中线。 */
  const st = await browser.newPage({ viewport: { width: 402, height: 812 }, deviceScaleFactor: 2, hasTouch: true });
  st.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  st.on('pageerror', (e) => errors.push('standalone pageerror: ' + e.message));
  await st.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    Object.defineProperty(window.screen, 'height', { get: () => 874 });
  });
  await st.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await st.waitForFunction(() => window.__ds && window.__ds.state.layout, null, { timeout: 15000 });
  await st.waitForTimeout(500);
  const stub = await st.evaluate(() => {
    const pad = window.__ds.syncStageCenter();
    const r = document.getElementById('poster').getBoundingClientRect();
    const s = document.getElementById('stage').getBoundingClientRect();
    return {
      pad, info: window.__ds.inspect().stage,
      css: getComputedStyle(document.getElementById('stage')).paddingTop,
      posterW: r.width, posterH: r.height, frameH: s.height,
      top: r.top - s.top,   /* 屏幕坐标下海报上边缘 = 上部留白 */
    };
  });
  const stubCenter = stub.top + stub.posterH / 2;      /* 屏幕坐标下的海报中心 */
  ok('独立全屏桩：按「物理屏 − 布局框」补正 62px',
    stub.pad === 62 && stub.css === '62px' && stub.info.standalone === true,
    JSON.stringify({ pad: stub.pad, css: stub.css, info: stub.info }));
  ok('独立全屏桩：补正后海报中心对准物理屏中线（整屏居中）',
    Math.abs(stubCenter - 874 / 2) < 1.5,
    `中心 ${stubCenter.toFixed(1)} / 期望 437（上留白 ${stub.top.toFixed(1)}）`);
  ok('独立全屏桩：海报仍宽度充满、没被压小',
    Math.abs(stub.posterW - 402) < 1.5 && Math.abs(stub.posterH - (402 * 1920) / 1080) < 1.5,
    `${stub.posterW.toFixed(1)}×${stub.posterH.toFixed(1)}`);
  await st.screenshot({ path: path.join(OUT, 's11-standalone.png') });
  await st.close();
  ok('标准版元素 = bg/badge-date/en/cn/source/card',
    JSON.stringify(ids(d)) === JSON.stringify(['bg', 'badge-date', 'en', 'cn', 'source', 'card']),
    ids(d).join(','));
  ok('顶部图片区固定 648', box(d, 'bg')[3] === 648, 'h=' + box(d, 'bg')[3]);

  /* 3 区（英文句）字体：EB Garamond（2026-09-24 用户指定，OFL 免费字体、自托管 woff2）。
     ⚠ 量测折行 / 绘制 / 标注三处必须共用 layout 上的 en.family —— 用不同字族会出现
     「折行按 A 算、画面按 B 画」的错位，这是换字体最该防的回归；长版不受影响。 */
  const enFont = await p.evaluate(() => ({
    loaded: document.fonts.check('400 50px AppGaramond'),
    enFamily: window.__ds.state.layout.en.family || '',
    cnFamily: window.__ds.state.layout.cn.family || '',
  }));
  ok('3 区字体 EB Garamond 已加载（自托管 woff2，启动时 fonts.load 等过它）',
    enFont.loaded === true,
    enFont.loaded ? 'document.fonts.check ✓' : '失败：检查 @font-face 与启动的 fonts.load 列表');
  ok('3 区字族 = AppGaramond（量测 / 绘制 / 标注三处共用 layout.en.family）',
    enFont.enFamily.includes('AppGaramond'), enFont.enFamily.slice(0, 44) + '…');
  ok('中文句仍是原来的无衬线（换字体没误伤 4 区）',
    enFont.cnFamily.includes('AppSans') && !enFont.cnFamily.includes('AppGaramond'),
    enFont.cnFamily.slice(0, 44) + '…');

  const cb = box(d, 'card');
  const mLeft = cb[0];
  const mRight = 1080 - (cb[0] + cb[2]);
  const mBottom = d.canvas.h - (cb[1] + cb[3]);
  /* 底边用画布高算，且给 0.2 容差 —— 标注表里的坐标是四舍五入到 0.1 的 */
  ok('信息卡三边等距 48',
    mLeft === 48 && mRight === 48 && Math.abs(mBottom - 48) < 0.2,
    `左${mLeft} 右${mRight} 底${mBottom.toFixed(2)}`);

  ok('正文左线 = 信息卡左线 48',
    box(d, 'en')[0] === 48 && box(d, 'cn')[0] === 48 && box(d, 'source')[0] === 48,
    `en ${box(d, 'en')[0]} / cn ${box(d, 'cn')[0]} / source ${box(d, 'source')[0]}`);
  const db = box(d, 'badge-date');
  ok('日期胶囊右线 = 48', db[0] + db[2] === 1080 - 48, '右线 ' + (db[0] + db[2]));

  /* 界面彻底无按钮：功能全部由手势承载 */
  const chrome = await p.evaluate(() => ({
    buttons: document.querySelectorAll('button').length,
    topbar: !!document.getElementById('topbar'),
    hint: (() => { const h = document.getElementById('hint'); return h ? !h.hidden : false; })(),
  }));
  ok('界面没有任何按钮 / 顶栏', chrome.buttons === 0 && !chrome.topbar,
    `buttons=${chrome.buttons} topbar=${chrome.topbar}`);
  ok('首次进入显示一次性手势提示', chrome.hint);

  /* 顶部图片：宽度铺满 1080、高度按比例，超出部分裁掉 */
  ok('顶部图片按宽度铺满（1080 宽、不裁切时不露底色）',
    d.bg && d.bg.w === 1080 && d.bg.blankBottom === 0, JSON.stringify(d.bg));

  const bandH = d.text.band.h;
  const gapTop = d.gaps.find((g) => g.id === 'gap-img-text').px;
  const gapBottom = d.gaps.find((g) => g.id === 'gap-text-card').px;
  ok('句子在中部区域里垂直居中', Math.abs(gapTop - gapBottom) <= 2, `上${gapTop} 下${gapBottom}`);
  /* 字号口径（2026-09-22 重定）：进入即按固定设计基准显示，不再自适应放大；
     只有整块装不下活动区时才整块等比缩小保底（base < 1）。详细断言见「字号基准与上下滑动缩放」一节 */
  ok('文字块装得下活动区（保底倍率 base ≤ 1，且不越过信息卡）',
    d.text.base <= 1 && (box(d, 'source')[1] + box(d, 'source')[3]) <= box(d, 'card')[1],
    `base=${d.text.base}｜文字底 ${box(d, 'source')[1] + box(d, 'source')[3]} / 卡片顶 ${box(d, 'card')[1]}`);

  /* ---------------- 双击隐藏 ---------------- */
  console.log('标准版 · 双击隐藏');
  const enY0 = box(d, 'en')[1];
  const speakBeforeDbl = speakAt(d);
  await tap(p, 'badge-date', 0, true);
  d = await info(p);
  ok('双击日期胶囊后它从海报消失', !ids(d).includes('badge-date'));
  ok('双击删除时不会顺带朗读', speakAt(d) === speakBeforeDbl,
    `lastSpeakAt ${speakBeforeDbl} → ${speakAt(d)}`);
  ok('开始操作后手势提示收起',
    await p.evaluate(() => { const h = document.getElementById('hint'); return !h || h.hidden; }));
  ok('隐藏后画布尺寸不变', d.canvas.h === H0);
  ok('隐藏后其余内容自动上移', box(d, 'en')[1] < enY0, `en.y ${enY0} → ${box(d, 'en')[1]}`);
  ok('隐藏后信息卡位置不变（贴底）', JSON.stringify(box(d, 'card')) === JSON.stringify(cb));
  await shot(p, 's2-hide-date');

  /* 删掉一个元素后**不会**自动放大填满中部区域（2026-09-22 起不再自适应放大）：
     base 已经是 1 时字号纹丝不动；只有当天句子本来就被保底缩小时，空出的高度才让 base 回升。
     旧断言写的是「字号自动放大」—— 那是老口径，且只在当天恰好触发保底时才碰巧成立。 */
  const fontBefore = d.items.find((it) => it.id === 'en').font;
  const baseBefore = d.text.base;
  await tap(p, 'source', 0, true);
  d = await info(p);
  const fontAfter = d.items.find((it) => it.id === 'en').font;
  ok('删掉出处后不再「自动放大填满」：base 为 1 时字号不动，否则只可能回升（绝不变小）',
    fontAfter >= fontBefore - 0.01 && (baseBefore < 1 || Math.abs(fontAfter - fontBefore) < 0.01) &&
    fontAfter <= 50 + 0.6,
    `${fontBefore} → ${fontAfter}｜base ${baseBefore} → ${d.text.base}`);

  for (const id of ['en', 'cn']) {
    await tap(p, id, 0, true);
    d = await info(p);
    ok('双击 ' + id + ' 后消失', !ids(d).includes(id));
  }
  ok('四个都隐藏后只剩图片与卡片', JSON.stringify(ids(d)) === JSON.stringify(['bg', 'card']), ids(d).join(','));
  ok('空文字块时画布尺寸不变', d.canvas.h === H0);
  await shot(p, 's3-all-hidden');

  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);
  ok('刷新后回到初始状态', ids(d).length === 6, ids(d).join(','));

  /* ---------------- 文字区：字号基准与上下滑动缩放 ---------------- */
  console.log('标准版 · 字号基准与上下滑动缩放');
  const fontAt = (x, id) => (x.items.find((it) => it.id === id) || {}).font;
  const fontOf = (x) => fontAt(x, 'en');
  const f0 = fontOf(d);

  /* 设计基准字号（2026-09-24 第三次由用户定值）：en 50、cn 44、source 36、日期 28；
     实际字号 = 设计基准 × 保底 base × 该区交互值 —— 今天的长句会被保底缩小，比例仍精确 */
  ok('字号 = 设计基准 × 保底 base（四个区逐一核对）',
    Math.abs(fontAt(d, 'en') - 50 * d.text.base) < 0.6 &&
    Math.abs(fontAt(d, 'cn') - 44 * d.text.base) < 0.6 &&
    Math.abs(fontAt(d, 'source') - 36 * d.text.base) < 0.6 &&
    Math.abs(fontAt(d, 'badge-date') - 28 * d.text.fx['badge-date']) < 0.6,
    `en ${fontAt(d, 'en')}｜cn ${fontAt(d, 'cn')}｜source ${fontAt(d, 'source')}｜日期 ${fontAt(d, 'badge-date')}｜base ${d.text.base}`);
  ok('每个文字区各有一份交互变换状态（架构：以后加移动就在同一对象里补 dx/dy）',
    ['badge-date', 'en', 'cn', 'source'].every((k) => d.text.fx[k] === 1),
    JSON.stringify(d.text.fx));

  /* 短句：base 回到 1，字号正好等于设计基准（与线上当天的句子无关，确定可测） */
  const shortD = await withContent(p, { en: 'Hi.', cn: '你好。', source: '—— 测试' });
  ok('短句时不再自动放大（base = 1、字号就是设计基准 50 / 44 / 36 / 28）',
    shortD.text.base === 1 && Math.abs(fontAt(shortD, 'en') - 50) < 0.6 &&
    Math.abs(fontAt(shortD, 'cn') - 44) < 0.6 &&
    Math.abs(fontAt(shortD, 'source') - 36) < 0.6 && Math.abs(fontAt(shortD, 'badge-date') - 28) < 0.6,
    `base=${shortD.text.base}｜en ${fontAt(shortD, 'en')}｜cn ${fontAt(shortD, 'cn')}｜source ${fontAt(shortD, 'source')}｜日期 ${fontAt(shortD, 'badge-date')}`);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);

  /* 3/4/5 联动：滑英文 → 三个一起变，日期不动 */
  const dateF0 = fontAt(d, 'badge-date');
  await dragY(p, 'en', -120);                        /* 上滑 = 放大 */
  d = await info(p);
  ok('上滑放大字号', fontOf(d) > f0, `${f0} → ${fontOf(d)}`);
  ok('3/4/5 联动：滑英文时英 / 中 / 出处同时变大，日期纹丝不动',
    d.text.fx.en > 1 && d.text.fx.en === d.text.fx.cn && d.text.fx.en === d.text.fx.source &&
    d.text.fx['badge-date'] === 1 && fontAt(d, 'badge-date') === dateF0,
    `fx ${JSON.stringify(d.text.fx)}｜日期 ${dateF0} → ${fontAt(d, 'badge-date')}`);
  await shot(p, 's7-zoom-in');

  const f1 = fontOf(d);
  await dragY(p, 'en', 240);                         /* 下滑 = 缩小 */
  d = await info(p);
  ok('下滑缩小字号', fontOf(d) < f1, `${f1} → ${fontOf(d)}`);

  /* 2 区独立：滑日期只改日期，句子三个纹丝不动 */
  const senF = { en: fontAt(d, 'en'), cn: fontAt(d, 'cn'), src: fontAt(d, 'source') };
  const dateF1 = fontAt(d, 'badge-date');
  await dragY(p, 'badge-date', -110);
  d = await info(p);
  ok('2 区独立：滑日期只放大日期，句子三个一点不动',
    fontAt(d, 'badge-date') > dateF1 && d.text.fx['badge-date'] > 1 &&
    fontAt(d, 'en') === senF.en && fontAt(d, 'cn') === senF.cn && fontAt(d, 'source') === senF.src,
    `日期 ${dateF1} → ${fontAt(d, 'badge-date')}｜en ${senF.en} → ${fontAt(d, 'en')}`);

  /* ---------------- 缩放上限按区不同：2 区 3 倍、3/4/5 区 1.6 倍（2026-09-22） ----------------
     下面用 `__ds.setZoom` 驱动：它调用的就是手势那条 applyZoom（同一条钳制路径），
     只是省掉「在几百像素高的测试视口里反复拖动去累积倍率」——真手势一次最多 +0.2~0.3 倍。 */
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  const caps = await p.evaluate(() => ({
    date: window.__ds.zoomMax('badge-date'), en: window.__ds.zoomMax('en'), source: window.__ds.zoomMax('source'),
  }));
  ok('缩放上限按区不同：2 区 3 倍、3/4/5 区 1.6 倍', caps.date === 3 && caps.en === 1.6 && caps.source === 1.6,
    JSON.stringify(caps));

  /* 换成短句，让保底倍率恒为 1 —— 这样「句子字号动没动」才是干净的信号 */
  const short2 = await withContent(p, { en: 'Hi.', cn: '你好。', source: '—— 测试' });
  const b0 = {
    box: box(short2, 'badge-date'),
    band: Object.assign({}, short2.text.band),
    font: { en: fontAt(short2, 'en'), cn: fontAt(short2, 'cn'), src: fontAt(short2, 'source') },
  };
  await p.evaluate(() => window.__ds.setZoom('badge-date', 9));       /* 远超上限 → 应被截在 3 */
  await p.waitForTimeout(460);
  const d3 = await info(p);
  const b3 = { box: box(d3, 'badge-date'), band: Object.assign({}, d3.text.band) };
  ok('2 区放到超上限被截在 3 倍（且不牵动 3/4/5 区）',
    d3.text.fx['badge-date'] === 3 && d3.text.fx.en === 1 && d3.text.fx.cn === 1 && d3.text.fx.source === 1,
    `fx ${JSON.stringify(d3.text.fx)}`);
  ok('2 区到上限时提示「已放到最大」',
    await p.evaluate(() => document.getElementById('toast').textContent) === '字号已放到最大',
    await p.evaluate(() => document.getElementById('toast').textContent));
  ok('胶囊整体等比变大：宽与高都长了 3 倍（高度不再固定）',
    Math.abs(b3.box[3] / b0.box[3] - 3) < 0.06 && Math.abs(b3.box[2] / b0.box[2] - 3) < 0.06,
    `胶囊 [${b0.box.map(Math.round)}] → [${b3.box.map(Math.round)}]`);
  ok('活动区随胶囊下移并变矮（句子在更矮的区域里重新居中）',
    b3.band.top > b0.band.top + 20 && b3.band.h < b0.band.h - 20,
    `活动区 ${JSON.stringify(b0.band)} → ${JSON.stringify(b3.band)}`);
  ok('2 区放大时短句字号一点不动（base 仍为 1，只有位置重新居中）',
    d3.text.base === 1 && fontAt(d3, 'en') === b0.font.en &&
    fontAt(d3, 'cn') === b0.font.cn && fontAt(d3, 'source') === b0.font.src,
    `base ${d3.text.base}｜en ${b0.font.en} → ${fontAt(d3, 'en')}`);
  await shot(p, 's14-date-zoom-3x');

  /* 极端：2 区 ×3 的同时塞长句 → 活动区被压到下限，句子被保底略微缩小（用户已确认接受） */
  const extreme = await withContent(p, {
    en: 'This is a fairly long sentence used to check the fallback shrink when the date badge is huge.'.repeat(2),
    cn: '这是一句用来验证「日期放很大时句子被保底缩小」的较长中文句子。'.repeat(2),
  });
  ok('极端情况：2 区 ×3 + 长句 → 句子保底略缩、活动区变矮，但仍不越过信息卡',
    extreme.text.base < 1 && extreme.text.band.h < b0.band.h - 20 &&
    box(extreme, 'source')[1] + box(extreme, 'source')[3] <= box(extreme, 'card')[1],
    `base ${extreme.text.base}｜活动区 h ${Math.round(extreme.text.band.h)}（默认 ${Math.round(b0.band.h)}）`);

  /* 3/4/5 仍被 1.6 截住（同一时刻 2 区仍是 3 倍，证明两组互不干扰） */
  await p.evaluate(() => window.__ds.setZoom('en', 9));
  await p.waitForTimeout(460);
  const enCap = await info(p);
  ok('3/4/5 放到超上限被截在 1.6 倍（2 区不受影响）',
    enCap.text.fx.en === 1.6 && enCap.text.fx.cn === 1.6 && enCap.text.fx.source === 1.6 &&
    enCap.text.fx['badge-date'] === 3,
    JSON.stringify(enCap.text.fx));
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);

  /* 缩到最小也不能压到卡片 */
  await dragY(p, 'en', 900);
  d = await info(p);
  ok('缩到下限后仍不越过信息卡',
    box(d, 'source')[1] + box(d, 'source')[3] <= box(d, 'card')[1],
    `文字底 ${box(d, 'source')[1] + box(d, 'source')[3]} / 卡片顶 ${box(d, 'card')[1]}`);

  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);
  ok('刷新后各文字区的缩放都归位',
    ['badge-date', 'en', 'cn', 'source'].every((k) => d.text.fx[k] === 1) &&
    Math.abs(fontOf(d) - f0) < 0.6,
    `fx=${JSON.stringify(d.text.fx)} font=${fontOf(d)}（初始 ${f0}）`);

  /* 装不下时整块等比缩小保底：塞超长句 → base < 1，且文字不越过信息卡 */
  const longD = await withContent(p, {
    en: 'This is an extremely long sentence '.repeat(14),
    cn: '这是一句被刻意拉得极长的话，用来验证装不下时整块等比缩小保底。'.repeat(6),
  });
  ok('超长句时整块等比缩小保底（base < 1、且不越过信息卡）',
    longD.text.base < 1 &&
    (box(longD, 'source')[1] + box(longD, 'source')[3]) <= box(longD, 'card')[1],
    `base=${longD.text.base}｜文字底 ${box(longD, 'source')[1] + box(longD, 'source')[3]} / 卡片顶 ${box(longD, 'card')[1]}`);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);

  /* ---------------- 单击：句子朗读 / 日期切今日昨日 ---------------- */
  console.log('标准版 · 单击朗读与切日');
  const s0 = speakAt(d);
  await tap(p, 'en');                        /* 单击句子 → 等 300ms 确认不是双击 → 朗读 */
  await p.waitForTimeout(500);
  d = await info(p);
  ok('单击句子会朗读', speakAt(d) > s0, `lastSpeakAt ${s0} → ${speakAt(d)}`);
  ok('单击不会把句子删掉', ids(d).includes('en'));

  /* ---------------- 语音独占层：波形即停止按钮 ---------------- */
  console.log('标准版 · 语音独占层');
  const snap = () => p.evaluate(() => JSON.stringify({
    hidden: window.__ds.state.hidden,
    zoom: window.__ds.state.zoom,
    viewDate: window.__ds.state.viewDate,
    save: window.__ds.state.lastSave,
  }));
  const waveGeom = () => p.evaluate(() => {
    const w = document.getElementById('wave');
    const r = w.getBoundingClientRect();
    const cs = getComputedStyle(w);
    const bar = w.querySelector('i');
    const bars = w.querySelectorAll('i');
    const bw = bar ? parseFloat(getComputedStyle(bar).width) : 0;
    const reg = (id) => {
      const it = (window.__ds.state.regions || []).find((x) => x.id === id);
      return it ? window.__ds.toClient(it.x, it.y) : null;
    };
    const en = reg('en');
    const cn = reg('cn');
    const enReg = window.__ds.state.regions.find((x) => x.id === 'en');
    const date = window.__ds.state.regions.find((x) => x.id === 'badge-date');
    /* 宽度基准：正文列宽（屏幕像素）= 984 × 显示比例，波形 = 它的 90%；
       居中基准是 **3 区文字框**（不是整列），偏移夹在列中心 ±10% 列宽内 */
    const c = document.getElementById('poster').getBoundingClientRect();
    const k = c.width / 1080;
    const colW = 984 * k;
    const w0 = colW * 0.9;
    const limit = colW * 0.1;
    const colCenter = c.left + 48 * k + colW / 2;
    const inkCenter = c.left + (enReg.x + enReg.w / 2) * k;
    const center = Math.min(colCenter + limit, Math.max(colCenter - limit, inkCenter));
    return {
      hidden: w.hidden,
      show: w.classList.contains('show'),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      enY: en ? en.y : null,
      cnY: cn ? cn.y : null,
      dateBottom: date ? window.__ds.toClient(date.x, date.y + date.h).y : null,
      /* 外观（2026-09-22）：只应有竖条，没有任何底板 / 描边 / 毛玻璃 */
      bgColor: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      radius: cs.borderRadius,
      panelShadow: cs.boxShadow,
      blur: cs.backdropFilter || 'none',
      barFilter: bar ? getComputedStyle(bar).filter : '',
      bars: bars.length,
      cover: r.width ? (bw * bars.length) / r.width : 0,
      colW,
      expectW: w0,
      expectX: center - w0 / 2,
      /* 相对 3 区文字框的左右留白（用户要的就是这两个数相等） */
      inkLeft: c.left + enReg.x * k,
      inkRight: c.left + (enReg.x + enReg.w) * k,
    };
  });

  const wg = await waveGeom();
  const voiceNow = (await info(p)).voice;
  ok('朗读后 3 区升起波形层', !wg.hidden && wg.show && !!voiceNow && voiceNow.target === 'en',
    JSON.stringify(voiceNow));
  ok('波形层只盖 3 区（不碰中文句、也不顶到日期胶囊）',
    wg.enY > wg.rect.y && wg.cnY > wg.rect.y + wg.rect.h &&
    (wg.dateBottom === null || wg.rect.y > wg.dateBottom),
    `面板 ${Math.round(wg.rect.y)}–${Math.round(wg.rect.y + wg.rect.h)}｜日期底 ${Math.round(wg.dateBottom)}｜3 区顶 ${Math.round(wg.enY)}｜中文句顶 ${Math.round(wg.cnY)}`);
  /* 2026-09-22 用户要求：波形**不加背景框**，屏幕上只有竖条 —— 这条把「有没有底板」钉死，
     顺带钉住「绝不 backdrop-filter」（一模糊就把底下的英文句糊掉）。 */
  ok('波形没有任何底板（背景透明、无描边 / 圆角 / 毛玻璃），只有竖条',
    (wg.bgColor === 'rgba(0, 0, 0, 0)' || wg.bgColor === 'transparent') &&
    wg.bgImage === 'none' && wg.blur === 'none' &&
    (wg.panelShadow === 'none' || wg.panelShadow === '') && parseFloat(wg.radius) === 0,
    `${wg.bgColor} / image ${wg.bgImage} / shadow ${wg.panelShadow} / radius ${wg.radius} / blur ${wg.blur}`);
  ok('竖条自带极淡投影（裸竖条在亮背景上也看得见）',
    /drop-shadow/.test(wg.barFilter), wg.barFilter);
  ok('竖条细、不横穿字形（透过波形仍能读英文句）',
    wg.cover < 0.35 && wg.bars >= 8, `横向覆盖 ${(wg.cover * 100).toFixed(0)}%｜${wg.bars} 根`);
  ok('波形宽度 = 正文列宽 × 90%（不随句子长短变）',
    Math.abs(wg.rect.w - wg.expectW) <= 1.5,
    `实测 ${Math.round(wg.rect.w)} / 期望 ${Math.round(wg.expectW)}（列宽 ${Math.round(wg.colW)}）`);
  /* 2026-09-22 用户指出「左边比右边空得多」（正文左对齐、右侧参差，按整列居中必然不均）：
     居中基准改成 3 区文字框 → 左右留白相等；偏移夹在列中心 ±10% 列宽内，短句也不会偏出。 */
  ok('波形按 3 区文字框居中：相对文字的左右留白相等（差 ≤ 1px）',
    Math.abs(wg.rect.x - wg.expectX) <= 1.5 &&
    Math.abs((wg.rect.x - wg.inkLeft) - (wg.inkRight - (wg.rect.x + wg.rect.w))) <= 1,
    `左留白 ${Math.round(wg.rect.x - wg.inkLeft)} / 右留白 ${Math.round(wg.inkRight - (wg.rect.x + wg.rect.w))}｜面板左 ${Math.round(wg.rect.x)} / 期望 ${Math.round(wg.expectX)}`);
  await shot(p, 's12-voice-playing');

  /* 独占：播放期间除波形区外，一切手势都失效 */
  const before = await snap();
  const fcIdle = p.waitForEvent('filechooser', { timeout: 1200 }).catch(() => null);
  await tap(p, 'card');                           /* 点信息卡：不该弹相册 */
  ok('播放中点信息卡不弹相册', !(await fcIdle));
  await tap(p, 'badge-date', 0, true);            /* 双击日期：不该删除 */
  await dragY(p, 'en', -140);                     /* 拖句子：不该缩放字号（且拖走了不算点波形） */
  await pullY(p, 'img', 150);                     /* 下拉：不该更新 */
  const holdPt = await pointOf(p, 'img');         /* 长按：不该保存 */
  await p.mouse.move(holdPt.x, holdPt.y);
  await p.mouse.down();
  await p.waitForTimeout(760);
  await p.mouse.up();
  await p.waitForTimeout(400);
  ok('播放中其余四种手势全部失效（双击删除 / 缩放 / 下拉 / 长按保存）',
    (await snap()) === before, '状态与播放前完全一致');
  ok('播放中波形层仍在（没被上一步的拖动误停）',
    await p.evaluate(() => !document.getElementById('wave').hidden && !!window.__ds.inspect().voice));

  /* 点波形 = 停止：波形消失、独占解除、真的 pause 了 */
  const pauses0 = await p.evaluate(() => (window.__audioStub.last() || {}).pauses || 0);
  await tapWave(p);
  const stopped = await p.evaluate(() => ({
    voice: window.__ds.inspect().voice,
    stopAt: window.__ds.state.lastVoiceStopAt,
    pauses: (window.__audioStub.last() || {}).pauses || 0,
  }));
  ok('点波形即停止播放（确实调了 pause）', stopped.pauses > pauses0 && stopped.stopAt > 0,
    `pauses ${pauses0} → ${stopped.pauses}`);
  ok('停止后波形消失、独占解除',
    stopped.voice === null && await p.evaluate(() => document.getElementById('wave').hidden));
  await shot(p, 's13-voice-stopped');

  /* 独占解除后立刻可用：点日期又能切今日 / 昨日（下面就是原有断言） */
  /* ---------------- 只点 3 区才播放：中文句 / 出处的单击不再发音 ---------------- */
  const sCn = speakAt(await info(p));
  await tap(p, 'cn');
  await p.waitForTimeout(600);
  ok('单击中文句不再朗读', speakAt(await info(p)) === sCn);
  await tap(p, 'source');
  await p.waitForTimeout(600);
  ok('单击出处不再朗读', speakAt(await info(p)) === sCn);

  /* 自然播完也自动收起：不把人困在独占态 */
  await tap(p, 'en');
  await p.waitForTimeout(600);
  ok('（准备）再次进入独占', !!(await info(p)).voice);
  await p.evaluate(() => { const a = window.__audioStub.last(); if (a) a.dispatchEvent(new Event('ended')); });
  await p.waitForTimeout(520);
  ok('音频播完波形自动收起、独占解除',
    (await info(p)).voice === null &&
    await p.evaluate(() => document.getElementById('wave').hidden === true || !document.getElementById('wave').classList.contains('show')));

  /* ------------- 播放与波形严格同步（2026-09-22：波形只听音频事件，不看 play() 的 Promise） -------------
     这几个场景就是用户报的「有声音没波形 / 有波形没声音 / 播一会儿停了波形还挂着」。
     桩可以精确复现它们；真机上的 iOS 音频会话在 Chromium 里复现不了（所以真机复测才是最终验收）。 */
  const voiceState = () => p.evaluate(() => ({
    hidden: document.getElementById('wave').hidden,
    show: document.getElementById('wave').classList.contains('show'),
    voice: !!window.__ds.inspect().voice,
    diag: window.__ds.inspect().voiceDiag,
  }));

  /* ① 没有音频文件：点 3 区不出波形（也不留播放态），只给一句轻提示 */
  const savedAudio = await p.evaluate(() => {
    const a = window.__ds.state.apiData.audio;
    window.__ds.state.apiData.audio = null;
    return a;
  });
  await tap(p, 'en');
  await p.waitForTimeout(600);
  const noAudio = await voiceState();
  const noAudioToast = await p.evaluate(() => document.getElementById('toast').textContent);
  ok('没有音频文件时点 3 区：不出波形、不留播放态（只给轻提示「没有可用发音」）',
    noAudio.hidden && !noAudio.voice && noAudioToast === '没有可用发音',
    `hidden ${noAudio.hidden}｜voice ${noAudio.voice}｜toast「${noAudioToast}」`);
  await p.evaluate((a) => { window.__ds.state.apiData.audio = a; }, savedAudio);

  /* ② play() 成功、但音频始终没派发 playing（静默失败）：也绝不出波形
        —— 这正是「看到波形却没声音」的根治点：波形只认真的出声 */
  await p.evaluate(() => window.__audioStub.mode('silent'));
  await tap(p, 'en');
  await p.waitForTimeout(700);
  const silent = await voiceState();
  const silentPlays = await p.evaluate(() => (window.__audioStub.last() || {}).plays || 0);
  ok('音频 play() 成功但始终没派发 playing → 不出波形（真出声才升波形）',
    silent.hidden && !silent.voice && silentPlays >= 1,
    `play() 调了 ${silentPlays} 次｜hidden ${silent.hidden}`);
  await p.evaluate(() => window.__audioStub.mode('normal'));

  /* ③ 被外部暂停（来电 / 切 App / 系统抢占）：波形立刻收，而不是挂到 20 秒 */
  await tap(p, 'en');
  await p.waitForTimeout(620);
  ok('（准备）重新进入独占', (await voiceState()).voice);
  await p.evaluate(() => window.__audioStub.pauseExternally());
  await p.waitForTimeout(460);
  const extPaused = await voiceState();
  ok('音频被外部暂停 → 波形立刻收起（voiceDiag = pause）',
    extPaused.hidden && !extPaused.voice && extPaused.diag.lastReason === 'pause',
    `reason ${extPaused.diag.lastReason}`);

  /* ④ 卡死：没暂停、但 currentTime 不再前进 → 看门狗收（旧实现最长要挂 20 秒） */
  await tap(p, 'en');
  await p.waitForTimeout(620);
  await p.evaluate(() => window.__audioStub.stall());
  const w0 = Date.now();
  let watchMs = 0;
  for (let i = 0; i < 16 && !watchMs; i++) {
    await p.waitForTimeout(250);
    if ((await voiceState()).hidden) watchMs = Date.now() - w0;
  }
  const stalled = await voiceState();
  /* 时限给到 4s：阈值是 1.5s，加上一个检查周期与上面的轮询粒度 —— 关键是「几秒内」，
     而不是旧实现那样一路挂到兜底的 20 秒（那才是「播一会儿停了、波形还挂着」） */
  ok('音频卡死（currentTime 不前进）→ 看门狗几秒内收起波形（voiceDiag = stalled）',
    watchMs > 0 && watchMs < 4000 && stalled.diag.lastReason === 'stalled',
    `${watchMs}ms｜reason ${stalled.diag.lastReason}`);

  /* ⑤ 自证：点波形停下来的那次 reason = tap，并记下这次实际响了多久 */
  await tap(p, 'en');
  await p.waitForTimeout(620);
  await tapWave(p);
  const diagTap = (await voiceState()).diag;
  ok('voiceDiag 记录收尾原因与实际播放时长（点波形 → tap）',
    diagTap.lastReason === 'tap' && diagTap.lastAt > 0 && diagTap.playedMs >= 0 && diagTap.dur > 0,
    JSON.stringify(diagTap));

  /* ⑥ 冷启动首点 —— 用户报的「第一次点总失败、等一会儿再点就行」：
        桩让 play() 挂 1 秒才 settle；老实现会在 300ms 后 pause 它（规范语义 = AbortError）→ 必失败。
        新实现只 seek、不打断挂起的 play，所以照样出声出波形，且 errName 为空、该元素一次都没被 pause。 */
  await p.evaluate(() => window.__audioStub.mode('cold'));
  await tap(p, 'en');
  await p.waitForTimeout(2400);
  const cold = await p.evaluate(() => {
    const el = window.__audioStub.last();
    return {
      voice: !!window.__ds.inspect().voice,
      hidden: document.getElementById('wave').hidden,
      diag: window.__ds.inspect().voiceDiag,
      play: el ? { plays: el.plays, pauses: el.pauses, volume: el.volume, muted: el.muted } : null,
    };
  });
  ok('冷启动首点：绝不打断挂起的 play（无 AbortError / play-rejected，该元素没被 pause）',
    cold.diag.lastReason === '' && cold.diag.errName === '' && cold.play && cold.play.pauses === 0,
    `reason「${cold.diag.lastReason}」errName「${cold.diag.errName}」${JSON.stringify(cold.play)}`);
  ok('冷启动首点：仍然出声出波形（音量已复位、未静音）',
    cold.voice && !cold.hidden && cold.play.volume === 1 && cold.play.muted === false,
    `voice ${cold.voice}｜hidden ${cold.hidden}｜音量 ${cold.play ? cold.play.volume : '-'}`);
  await tapWave(p);                              /* 收尾：停掉这次播放，别影响后面的断言 */
  await p.evaluate(() => window.__audioStub.mode('normal'));

  /* 双击删除仍保留（单击语义收窄不影响它）—— 删完立刻刷新，免得影响后面几节 */
  await tap(p, 'cn', 0, true);
  ok('中文句双击仍能删除', !ids(await info(p)).includes('cn'));
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(p);

  /* 导出页（?raw=1）里永远没有波形层 */
  const rawP = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await rawP.addInitScript(AUDIO_STUB);
  await rawP.goto(BASE + '/?raw=1&debug=1', { waitUntil: 'load' });
  await rawP.waitForFunction(() => window.__ds && window.__ds.state.layout, null, { timeout: 15000 });
  const rawWave = await rawP.evaluate(() => {
    window.__ds.playVoice();
    return { display: getComputedStyle(document.getElementById('wave')).display };
  });
  ok('导出页（?raw=1）里波形层不显示', rawWave.display === 'none', JSON.stringify(rawWave));
  const rawShake = await rawP.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const fire = (v) => window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      accelerationIncludingGravity: { x: v, y: 0.2, z: 9.8 },
    }));
    for (const v of [25, -25, 25, -25, 25, -25]) { fire(v); await sleep(60); }
    await sleep(150);
    return window.__ds.state.theme;
  });
  ok('导出页（?raw=1）里摇一摇不切主题（导出是独占的）', rawShake === 'night', rawShake);
  await rawP.close();

  /* ---------------- 四主题调色板与摇一摇换配色（2026-09-24） ----------------
     配色唯一来源是 THEMES；「显示 = 成品」要求主题画进 canvas（另存图随主题走），
     所以除了 inspect().theme 自证，还从画布位图上**取色**核对底色真的变了。
     摇一摇用合成 devicemotion 事件驱动**真监听**（对称振荡 ±25 —— 真实摇动就是
     围绕重力的方向翻转；判定用线性加速度，见 bindShake 注释）。 */
  console.log('标准版 · 四主题与摇一摇');
  const sampleLum = (p, x = 1040, y = 1350) => p.evaluate(([x, y]) => {
    const c = document.getElementById('poster');
    const k = c.width / 1080;                       /* 位图 → 设计坐标 */
    const ctx2 = c.getContext('2d');
    const d2 = ctx2.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
    return 0.3 * d2[0] + 0.59 * d2[1] + 0.11 * d2[2];   /* 感知亮度 */
  }, [x, y]);
  const themeEnter = async (qs) => {
    const tp = await open(BASE + '/?debug=1' + (qs ? '&theme=' + qs : ''));
    const d2 = await info(tp);
    const cs = await tp.evaluate(() => ({
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      wave: getComputedStyle(document.documentElement).getPropertyValue('--wave-c1').trim(),
      ds: document.documentElement.dataset.theme,
    }));
    return { tp, d2, cs };
  };

  {
    const { tp, d2, cs } = await themeEnter('');
    ok('默认进入 = 墨蓝夜空（inspect().theme 只增字段 + data-theme 同步）',
      d2.theme.id === 'night' && d2.theme.name === '墨蓝夜空' && cs.ds === 'night',
      JSON.stringify(d2.theme));
    ok('night 画布底色是暗色（取色抽验：显示 = 成品）', (await sampleLum(tp)) < 60,
      'lum=' + Math.round(await sampleLum(tp)));
    ok('night 的页面底色 --bg 与波形强调色是默认值',
      cs.bg === '#0b0f17' && cs.wave.startsWith('rgba(34,211,238'),
      `--bg ${cs.bg}｜--wave-c1 ${cs.wave}`);
    await tp.close();
  }
  {
    const { tp, d2, cs } = await themeEnter('paper');
    const lum = await sampleLum(tp);
    ok('?theme=paper：暖纸墨字当次生效、底色反转为浅色（白天可读）',
      d2.theme.id === 'paper' && lum > 150, 'lum=' + Math.round(lum));
    ok('paper 的波形强调色换成琥珀墨（--wave-c1）', cs.wave.startsWith('rgba(194,118,42'), cs.wave);
    await tp.close();
  }
  {
    const { tp, d2, cs } = await themeEnter('pine');
    ok('?theme=pine：松烟墨绿生效、底色仍是暗色',
      d2.theme.id === 'pine' && (await sampleLum(tp)) < 60);
    ok('pine 的波形强调色换成琥珀金（与 night/paper 都不同）',
      cs.wave.startsWith('rgba(245,158,11'), cs.wave);
    await tp.close();
  }
  {
    const { tp, d2, cs } = await themeEnter('dusk');
    ok('?theme=dusk：紫霞暮色生效、底色仍是暗色',
      d2.theme.id === 'dusk' && (await sampleLum(tp)) < 60);
    ok('dusk 的波形强调色换成玫瑰金（与 pine 不同）',
      cs.wave.startsWith('rgba(232,160,168'), cs.wave);
    await tp.close();
  }
  {
    /* 无效参数必须回落默认，不能半白屏 */
    const { tp, d2 } = await themeEnter('nope');
    ok('?theme=nope（无效参数）回落默认 night', d2.theme.id === 'night');
    await tp.close();
  }

  /* 摇一摇：真监听 + 空闲态守卫 + 冷却 + 记忆 */
  const sp = await open(BASE + '/?debug=1');
  await sp.evaluate(() => localStorage.removeItem('ds:theme'));   /* 干净起点 */
  await sp.reload({ waitUntil: 'load' });
  await sp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  const shakeInPage = () => sp.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const fire = (v) => window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      accelerationIncludingGravity: { x: v, y: 0.2, z: 9.8 },
    }));
    for (const v of [25, -25, 25, -25, 25, -25]) { fire(v); await sleep(60); }
    await sleep(150);
  });
  await shakeInPage();
  d = await info(sp);
  ok('摇① 切到下一个主题（paper）并 toast 报主题名',
    d.theme.id === 'paper' &&
    (await sp.evaluate(() => document.getElementById('toast').textContent)) === '配色 · 暖纸墨字',
    await sp.evaluate(() => document.getElementById('toast').textContent));
  ok('摇出来的选择写入 localStorage（按设备记忆）',
    (await sp.evaluate(() => localStorage.getItem('ds:theme'))) === 'paper');
  await shakeInPage();
  d = await info(sp);
  ok('摇②（在 900ms 冷却内）不再切换 —— 防一次长摇连切',
    d.theme.id === 'paper');
  await sp.waitForTimeout(1000);
  await shakeInPage();
  d = await info(sp);
  ok('出冷却后摇③ 切到 pine（循环顺序 night→paper→pine→dusk→night）',
    d.theme.id === 'pine');
  /* 播放独占态：摇动被忽略，不打断朗读 */
  await sp.evaluate(() => window.__ds.playVoice());
  await sp.waitForTimeout(400);
  await shakeInPage();
  d = await info(sp);
  ok('播放独占态摇动不切主题（也不停播）',
    d.theme.id === 'pine' && !!d.voice);
  await sp.evaluate(() => window.__ds.stopVoice('tap'));
  /* reload 记忆：无参进入应停在摇出来的主题上 */
  await sp.reload({ waitUntil: 'load' });
  await sp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(sp);
  ok('reload 后主题保留（localStorage 读回）', d.theme.id === 'pine');
  /* URL 不污染记忆：?theme= 只当次生效 */
  await sp.goto(BASE + '/?debug=1&theme=dusk', { waitUntil: 'load' });
  await sp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  const urlVisit = await sp.evaluate(() => ({
    theme: window.__ds.state.theme, saved: localStorage.getItem('ds:theme') }));
  ok('?theme=dusk 只当次生效，不写入记忆', urlVisit.theme === 'dusk' && urlVisit.saved === 'pine',
    JSON.stringify(urlVisit));
  await sp.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await sp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  d = await info(sp);
  ok('退出 URL 预览后回到记忆的主题', d.theme.id === 'pine');
  await sp.close();

  /* ---------------- 真机诊断页（?diag=1，2026-09-22） ----------------
     手机上复现不了的问题（音频会话 / 装到主屏后的安全区 / 真机字形）改用纯文本上报：
     面板可长按「全选 / 拷贝」，所以这个模式必须放开文本选择，并让「长按保存」让路。 */
  console.log('标准版 · 真机诊断页');
  const diagP = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true });
  await diagP.addInitScript(AUDIO_STUB);
  /* 断言要读 __ds.state.lastSave，所以顺带带上 debug=1（诊断面板本身只依赖模块状态，不需要它） */
  await diagP.goto(BASE + '/?diag=1&debug=1', { waitUntil: 'load' });
  await diagP.waitForFunction(() => window.__ds && window.__ds.state.layout, null, { timeout: 15000 });
  await diagP.waitForTimeout(1400);
  const diag = await diagP.evaluate(() => {
    const el = document.getElementById('diag');
    const cs = getComputedStyle(el);
    return {
      hidden: el.hidden,
      z: Number(cs.zIndex),
      select: cs.userSelect || cs.webkitUserSelect || '',
      text: el.textContent || '',
    };
  });
  ok('?diag=1 时诊断面板出现（纯文本、在最上层、放开文本选择）',
    !diag.hidden && diag.text.length > 120 && diag.z >= 80 && /text/.test(diag.select),
    `hidden ${diag.hidden}｜z ${diag.z}｜select「${diag.select}」｜${diag.text.length} 字`);
  ok('诊断面板含关键字段（形态 / 屏幕 / 安全区 / 舞台补正 / 海报与圆角 / 版面 / 字号 / 音频自证）',
    ['形态', '屏幕', '安全区', '舞台', '海报', '版面', '字号', '音频'].every((k) => diag.text.includes(k)) &&
    /voiceDiag/.test(diag.text) && /活动区/.test(diag.text) && /padTop=/.test(diag.text) && /圆角/.test(diag.text),
    diag.text.split('\n').slice(0, 2).join(' ／ '));
  /* 长按落在面板**下方**未被遮住的海报上：诊断模式下不该弹保存浮层（长按留给「全选 / 拷贝」） */
  await diagP.mouse.move(200, 820);
  await diagP.mouse.down();
  await diagP.waitForTimeout(780);
  await diagP.mouse.up();
  await diagP.waitForTimeout(420);
  const diagHold = await diagP.evaluate(() => ({
    save: window.__ds.state.lastSave,
    sheet: document.getElementById('saveSheet').hidden,
  }));
  ok('诊断模式下长按不弹保存浮层（把长按让给系统的「全选 / 拷贝」）',
    diagHold.save === null && diagHold.sheet === true, JSON.stringify(diagHold));
  await diagP.close();

  /* 不带参数 / 导出页：都不该有诊断面板 */
  const noDiag = await p.evaluate(() => {
    const el = document.getElementById('diag');
    return { hidden: el ? el.hidden : true, display: el ? getComputedStyle(el).display : 'none' };
  });
  ok('不带 ?diag=1 时诊断面板不存在（默认 hidden）',
    noDiag.hidden === true && noDiag.display === 'none', JSON.stringify(noDiag));
  const rawDiagP = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await rawDiagP.goto(BASE + '/?raw=1&diag=1', { waitUntil: 'load' });
  await rawDiagP.waitForTimeout(1200);
  const rawDiag = await rawDiagP.evaluate(() => getComputedStyle(document.getElementById('diag')).display);
  ok('导出页（?raw=1&diag=1）里诊断面板仍不显示', rawDiag === 'none', rawDiag);
  await rawDiagP.close();

  const t0 = await p.evaluate(() => window.__ds.state.lastToggleAt || 0);
  await tap(p, 'badge-date');
  await p.waitForTimeout(1400);
  const t1 = await p.evaluate(() => window.__ds.state.lastToggleAt || 0);
  ok('单击日期胶囊触发今日/昨日切换', t1 > t0, `lastToggleAt ${t0} → ${t1}`);
  const v1 = await viewDate(p);
  if (v1) {
    ok('切到了昨日存档', /^\d{4}-\d{2}-\d{2}$/.test(v1), 'viewDate=' + v1 + '（' + (await p.evaluate(() => window.__ds.state.content.date)) + '）');
    await tap(p, 'badge-date');
    await p.waitForTimeout(1400);
    ok('再点一次回到今天', (await viewDate(p)) === '', 'viewDate=' + (await viewDate(p)));
  } else {
    ok('昨日没有存档时留在今天并提示', true, 'viewDate 仍为空（loadDaily 已 toast 说明）');
  }

  /* ---------------- 单击选图 ---------------- */
  console.log('标准版 · 单击选图');
  let chooser = p.waitForEvent('filechooser', { timeout: 5000 });
  await tap(p, 'img');
  ok('单击顶部图片唤起相册', !!(await chooser));
  await (await chooser).setFiles(TEMPLATE);
  await p.waitForTimeout(800);
  d = await info(p);
  ok('换成竖图后画布尺寸不变', d.canvas.h === H0, 'h=' + d.canvas.h);
  ok('换成竖图后图片区仍是 648', box(d, 'bg')[3] === 648);
  /* 这条是本轮修的 bug：竖图原来会一路画到中部区域，把文字背景糊掉 */
  ok('竖图被裁到 648 高（不再溢出污染中部）',
    d.bg.clipped === true && d.bg.h > 648 && d.bg.blockH === 648,
    `图片实际高 ${d.bg.h}，只显示 ${d.bg.blockH}`);
  ok('换竖图后句子没有被顶走（仍在中部活动区里）', box(d, 'en')[1] >= d.text.band.top,
    'en.y=' + box(d, 'en')[1] + ' / 活动区顶=' + d.text.band.top);
  ok('换成竖图后信息卡没有被挤走', JSON.stringify(box(d, 'card')) === JSON.stringify(cb));
  await shot(p, 's4-tall-photo');

  /* ---------------- 图片手动调整模式 ---------------- */
  console.log('标准版 · 图片手动调整');
  ok('换完图立刻进入调整模式，且默认不动（scale=1 / 不平移）',
    !!d.edit && d.edit.target === 'img' &&
    d.fits.img.scale === 1 && d.fits.img.ox === 0 && d.fits.img.oy === 0,
    JSON.stringify({ edit: d.edit, fit: d.fits.img }));
  ok('调整模式里给出常驻操作提示',
    await p.evaluate(() => {
      const h = document.getElementById('hint');
      return !h.hidden && /双指/.test(h.textContent);
    }));

  /* 新界面：独立不透明弹层 —— 海报完全不动，层里只有居中的换图区与这张图 */
  const view = await p.evaluate(() => {
    const L = document.getElementById('editLayer');
    const cs = getComputedStyle(L);
    const cvsRect = document.getElementById('editCvs').getBoundingClientRect();
    return {
      edit: window.__ds.inspect().edit,
      hidden: L.hidden,
      opacity: Number(cs.opacity),
      bg: cs.backgroundColor,
      border: cs.borderWidth,
      outlineStyle: cs.outlineStyle,
      posterTransform: document.getElementById('poster').style.transform,
      cvs: { w: cvsRect.width, h: cvsRect.height },
      vw: window.innerWidth,
      vh: window.innerHeight,
      s: document.getElementById('poster').getBoundingClientRect().width / 1080,
    };
  });
  const W = view.edit.window;
  ok('换图弹出不透明弹层（覆盖整屏、底色不透明、无描边）',
    !view.hidden && view.opacity > 0.9 && /^rgb\(/.test(view.bg) &&
    view.border === '0px' && view.outlineStyle === 'none' &&
    Math.abs(view.cvs.w - view.vw) < 1 && Math.abs(view.cvs.h - view.vh) < 1,
    `${view.bg}｜border ${view.border}｜画布 ${view.cvs.w}×${view.cvs.h}｜视口 ${view.vw}×${view.vh}`);
  ok('原海报完全不动（没有位移、也没有被改动绘制）',
    view.posterTransform === '', JSON.stringify(view.posterTransform));
  ok('窗口在弹层里正中，尺寸 = 该区成品尺寸（不放大）',
    Math.abs(W[0] + W[2] / 2 - view.vw / 2) < 2 &&
    Math.abs(W[1] + W[3] / 2 - view.vh / 2) < 2 &&
    Math.abs(W[2] - 1080 * view.s) < 2 &&
    Math.abs(W[3] - 648 * view.s) < 2,
    `窗口 ${W.map((v) => Math.round(v)).join(',')}｜视口中心 ${view.vw / 2},${view.vh / 2}`);
  ok('窗口是圆角矩形（圆角 = 18 设计值 × 显示比例）',
    Math.abs(view.edit.radius - 18 * view.s) < 0.3, 'r=' + view.edit.radius.toFixed(2));

  /* 像素级验证「内清晰 / 外半透明 / 圆角生效」：换成纯白图，期望值可直接算出来 */
  const wp = await whiteProbe(p, 'img');
  const DIM = [6, 10, 18];
  const dimmed = [0.38 * 255 + 0.62 * DIM[0], 0.38 * 255 + 0.62 * DIM[1], 0.38 * 255 + 0.62 * DIM[2]];
  ok('窗口内图像原样清晰（纯白图 → 255）',
    wp.center.every((v) => v > 250), JSON.stringify(wp.center));
  ok('窗口外这张图的其余部分被压暗成半透明（纯白图 → 约 101/103/108）',
    wp.outside.every((v, i) => Math.abs(v - dimmed[i]) < 6),
    JSON.stringify(wp.outside) + '｜期望 ' + dimmed.map((v) => Math.round(v)).join(','));
  ok('窗口是圆角：角上被压暗、边中点是清晰的',
    wp.corner.every((v) => v < 150) && wp.edgeMid.every((v) => v > 250),
    `角 ${JSON.stringify(wp.corner)}｜边中 ${JSON.stringify(wp.edgeMid)}`);
  ok('虚线框已被彻底移除（源码里不再有 drawEditFrame）',
    !fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8').includes('drawEditFrame'));

  /* 调整期间其它手势让路：长按不保存、点句子不朗读（都在窗口上操作） */
  const saveBefore = await p.evaluate(() => window.__ds.state.lastSave);
  const speakBefore = speakAt(d);
  const imgMid = await windowCenter(p);
  await p.mouse.move(imgMid.x, imgMid.y);
  await p.mouse.down();
  await p.waitForTimeout(760);
  await p.mouse.up();
  await p.waitForTimeout(500);
  ok('调整模式下长按不会保存',
    (await p.evaluate(() => window.__ds.state.lastSave)) === saveBefore,
    'lastSave 未变');

  /* 双指捏合 = 缩放 */
  const imgPt = await windowCenter(p);
  await pinchOn(p, imgPt.x, imgPt.y, 1.8);
  d = await info(p);
  ok('双指捏合放大了图片', d.fits.img.scale > 1.1, 'scale=' + d.fits.img.scale.toFixed(2));
  ok('放大后画布尺寸不变、图片区仍是 648（设计值）',
    d.canvas.h === H0 && box(d, 'bg')[3] === 648);

  /* 单指拖动 = 平移（把图片别处露出来），且不许把窗口拖出白边 */
  const fit0 = (await info(p)).fits.img;
  await dragWin(p, 0, 120);
  d = await info(p);
  const afterPan = d.fits.img;
  ok('单指拖动改变了图片位移', afterPan.oy !== fit0.oy, `oy ${fit0.oy} → ${afterPan.oy}`);
  ok('拖动后图片仍盖满窗口（不留白）',
    d.bg.y <= 0 && d.bg.y + d.bg.h >= d.bg.blockH,
    `图片 y=${d.bg.y} 高=${d.bg.h}，窗口 648`);
  ok('拖动没有改变其它元素', JSON.stringify(box(d, 'card')) === JSON.stringify(cb));
  await shot(p, 's10-adjust-img');

  /* 点窗口 = 换同一张。弹层里看不到海报，所以「点另一块换图」这条路径**已不存在**：
     这里只断言「点窗口真会唤起相册」，不去 fulfill（否则会重置刚调好的 fits.img）。 */
  const winC = await windowCenter(p);
  const swapChooser = p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await p.mouse.click(winC.x, winC.y);
  await p.waitForTimeout(420);
  ok('点窗口一次即唤起相册（换同一张）', !!(await swapChooser));

  /* 换信息卡：直接走它的入口（弹层里点不到另一块，这是本方案接受的代价） */
  await p.setInputFiles('#fCardImage', TEMPLATE);
  await p.waitForTimeout(900);
  d = await info(p);
  ok('换信息卡后进入调整模式、目标切到卡片', !!d.edit && d.edit.target === 'card', JSON.stringify(d.edit));
  ok('换信息卡后三边仍是 48',
    box(d, 'card')[0] === 48 &&
    Math.abs(d.canvas.h - (box(d, 'card')[1] + box(d, 'card')[3]) - 48) < 0.2,
    `左${box(d, 'card')[0]} 底${(d.canvas.h - (box(d, 'card')[1] + box(d, 'card')[3])).toFixed(2)}`);
  ok('新卡片的调整从头开始（scale=1，顺着自动识别的位置）',
    d.fits.card.scale === 1 && d.fits.card.ox === 0 && d.fits.card.oy === 0, JSON.stringify(d.fits.card));
  ok('之前对图片的调整结果仍在', d.fits.img.scale > 1.1, 'scale=' + d.fits.img.scale.toFixed(2));
  await shot(p, 's5-new-card');

  /* 卡片这块也做一次像素判定：窗口尺寸跟着目标变，窗外同样是这张图压暗后的其余部分 */
  const wpc = await whiteProbe(p, 'card');
  const sCard = await p.evaluate(() => document.getElementById('poster').getBoundingClientRect().width / 1080);
  ok('信息卡窗口尺寸 = 984×496 设计值 × 显示比例（不放大）',
    Math.abs(wpc.window[2] - 984 * sCard) < 2 && Math.abs(wpc.window[3] - 496 * sCard) < 2,
    `${Math.round(wpc.window[2])}×${Math.round(wpc.window[3])}（期望 ${(984 * sCard).toFixed(1)}×${(496 * sCard).toFixed(1)}）`);
  ok('信息卡窗口内清晰、窗外是这张图压暗后的其余部分',
    wpc.center.every((v) => v > 250) && wpc.outside.every((v) => v > 60 && v < 150),
    `内 ${JSON.stringify(wpc.center)}｜外 ${JSON.stringify(wpc.outside)}`);

  /* 点窗口以外 = 完成（且不触发朗读） */
  await finishAdjust(p);
  d = await info(p);
  ok('点区域外退出调整模式', d.edit === null, JSON.stringify(d.edit));
  ok('退出后弹层收起、海报仍没有位移',
    await p.evaluate(() => document.getElementById('editLayer').hidden &&
      document.getElementById('poster').style.transform === ''));
  ok('退出时不会顺带朗读', speakAt(d) === speakBefore, `lastSpeakAt ${speakBefore} → ${speakAt(d)}`);
  ok('退出后提示收起',
    await p.evaluate(() => { const h = document.getElementById('hint'); return !h || h.hidden || h.classList.contains('hide'); }));
  ok('调整结果被保留（退出不等于复原）', d.fits.img.scale > 1.1, 'scale=' + d.fits.img.scale.toFixed(2));

  /* ---------------- 长按保存（界面无按钮，保存只能靠长按） ---------------- */
  console.log('标准版 · 长按保存');
  const mid = await p.evaluate(() => {
    const c = window.__ds.toClient(540, 1352);   /* 文字活动区与卡片之间的空白处 */
    return { x: Math.round(c.x), y: Math.round(c.y) };
  });
  await p.mouse.move(mid.x, mid.y);
  await p.mouse.down();
  await p.waitForTimeout(760);
  await p.mouse.up();
  await p.waitForTimeout(600);
  const toastText = await p.evaluate(() => {
    const t = document.getElementById('toast');
    return t.className.includes('show') ? t.textContent : '';
  });
  ok('长按海报触发保存', !!toastText, toastText);
  ok('保存不再依赖任何按钮（页面确实没有按钮）',
    (await p.evaluate(() => document.querySelectorAll('button').length)) === 0);
  await shot(p, 's6-longpress');

  /* 桌面 / Android 通道：真的触发下载，且文件名是 YYYY-MM-DD（不是 9212026） */
  const dlP = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await dlP.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await dlP.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await dlP.waitForTimeout(600);
  const dlEvent = dlP.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  const dlPt = await dlP.evaluate(() => {
    const c = window.__ds.toClient(540, 1352);
    return { x: Math.round(c.x), y: Math.round(c.y) };
  });
  await dlP.mouse.move(dlPt.x, dlPt.y);
  await dlP.mouse.down();
  await dlP.waitForTimeout(760);
  await dlP.mouse.up();
  const dl = await dlEvent;
  const dlName = dl ? dl.suggestedFilename() : '';
  ok('非 iOS 长按真的触发下载', !!dl, dlName);
  ok('下载文件名规范成 dailysentence-YYYY-MM-DD.png',
    /^dailysentence-\d{4}-\d{2}-\d{2}\.png$/.test(dlName), dlName);
  ok('非 iOS 不弹保存浮层', await dlP.evaluate(() => document.getElementById('saveSheet').hidden));
  await dlP.close();

  /* iOS 通道：Safari 上 <a download> 只会弹文件预览（用户报的 bug），
     必须改走「浮层出原图 + 长按存储到照片」。用 iPhone UA 模拟这条路径。 */
  const iPhone = devices['iPhone 13'];
  const iosCtx = await browser.newContext({ ...iPhone, deviceScaleFactor: 2 });
  const ip = await iosCtx.newPage();
  ip.on('pageerror', (e) => errors.push('ios pageerror: ' + e.message));
  const iosDownloads = [];
  ip.on('download', (d) => iosDownloads.push(d.suggestedFilename()));
  await ip.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await ip.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await ip.waitForTimeout(700);
  const ipt = await ip.evaluate(() => {
    const c = window.__ds.toClient(540, 1352);
    return { x: Math.round(c.x), y: Math.round(c.y) };
  });
  await ip.mouse.move(ipt.x, ipt.y);
  await ip.mouse.down();
  await ip.waitForTimeout(760);
  await ip.mouse.up();
  await ip.waitForTimeout(700);
  const sheet = await ip.evaluate(() => {
    const s = document.getElementById('saveSheet');
    const im = document.getElementById('saveImg');
    return {
      hidden: s.hidden,
      src: (im.getAttribute('src') || '').slice(0, 5),
      alt: im.getAttribute('alt'),
      tip: document.getElementById('saveTip').textContent,
      kind: (window.__ds.state.lastSave || {}).kind,
    };
  });
  ok('iOS 长按弹出保存浮层（不再走下载）', !sheet.hidden && sheet.kind === 'sheet',
    JSON.stringify(sheet));
  ok('浮层里给的是可直接长按的原图（blob URL）', sheet.src === 'blob:', sheet.src);
  ok('iOS 长按不产生文件下载', iosDownloads.length === 0, iosDownloads.join(','));
  await ip.screenshot({ path: path.join(OUT, 's9-ios-save.png') });

  /* 点图以外的地方关闭（图片本身必须不响应，否则会吃掉 iOS 的长按菜单） */
  const outside = await ip.evaluate(() => {
    const r = document.getElementById('saveImg').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom + 8), bottom: Math.round(r.bottom) };
  });
  await ip.mouse.click(outside.x, outside.y);
  await ip.waitForTimeout(400);
  ok('点空白处关闭保存浮层', await ip.evaluate(() => document.getElementById('saveSheet').hidden));
  await iosCtx.close();

  /* ---------------- 下拉更新 = 回到初始状态 ---------------- */
  console.log('标准版 · 下拉更新回到初始');
  /* 先把状态弄乱：删掉日期、换成竖图、调一下图、放大字号 */
  await tap(p, 'badge-date', 0, true);
  const fc2 = p.waitForEvent('filechooser', { timeout: 5000 });
  await tap(p, 'img');
  await (await fc2).setFiles(TEMPLATE);
  await p.waitForTimeout(800);
  const winC2 = await windowCenter(p);        /* 弹层里的窗口中心（不是海报坐标） */
  await pinchOn(p, winC2.x, winC2.y, 1.5);    /* 调整模式：放大一下 */
  await finishAdjust(p);                      /* 退出调整模式 */
  await dragY(p, 'en', -120);
  const messy = await info(p);
  ok('（准备）状态已改乱',
    messy.meta.hidden.date === true && messy.text.fx.en > 1 &&
    messy.bg.clipped === true && messy.fits.img.scale > 1.1,
    `hidden.date=${messy.meta.hidden.date} fx.en=${messy.text.fx.en} clipped=${messy.bg.clipped} scale=${messy.fits.img.scale.toFixed(2)}`);

  await pullY(p, 'img', 150);                 /* 图片区向下拉 = 更新 */
  await p.waitForTimeout(2600);
  const back = await info(p);
  ok('下拉后隐藏状态被清空',
    JSON.stringify(back.meta.hidden) === JSON.stringify({ date: false, en: false, cn: false, source: false }));
  ok('下拉后各文字区缩放归位',
    ['badge-date', 'en', 'cn', 'source'].every((k) => back.text.fx[k] === 1),
    JSON.stringify(back.text.fx));
  ok('下拉后相册图被换回上游默认（不再裁切）', back.bg && back.bg.clipped === false,
    JSON.stringify(back.bg));
  ok('下拉后手动调整也一并归位',
    back.fits.img.scale === 1 && back.fits.img.ox === 0 && back.fits.img.oy === 0 && back.edit === null,
    JSON.stringify(back.fits.img));
  ok('六个元素都回来了',
    JSON.stringify(ids(back)) === JSON.stringify(['bg', 'badge-date', 'en', 'cn', 'source', 'card']),
    ids(back).join(','));
  ok('下拉更新后画布尺寸不变', back.canvas.h === H0);
  await shot(p, 's8-after-pull');
  await p.close();

  /* ---------------- 桌面：必须是「非触摸」上下文，走固定 1080×1920 的基准路径 ---------------- */
  console.log('桌面视口（真桌面：无触摸）');
  const dp = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  dp.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message));
  await dp.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await dp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await dp.waitForTimeout(600);
  await shot(dp, 'd1-standard');
  const dd = await info(dp);
  ok('桌面：画布就是 1080×1920（自适应关闭）',
    dd.canvas.adaptive === false && dd.canvas.w === 1080 && dd.canvas.h === 1920 &&
    dd.canvas.physW === 1080 && dd.canvas.physH === 1920,
    JSON.stringify(dd.canvas));
  ok('桌面：U = 1（版面与改造前逐像素一致）', dd.canvas.u === 1, 'u=' + dd.canvas.u);
  ok('桌面：三段尺寸仍是 648 / 496 / 576',
    Math.round(box(dd, 'bg')[3]) === 648 && Math.round(box(dd, 'card')[3]) === 496 &&
    Math.round(dd.text.band.h) === 576,
    `${box(dd, 'bg')[3]} / ${box(dd, 'card')[3]} / ${Math.round(dd.text.band.h)}`);
  await dp.close();

  /* ---------------- 手机：画布固定 + 显示规则 + 开关可用 ---------------- */
  console.log('手机：固定 1080×1920 与显示规则');
  const mobileCtx = await browser.newContext({ ...devices['iPhone 15 Pro'] });   /* dpr 3，别覆盖 */
  const mp = await mobileCtx.newPage();
  mp.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await mp.goto(BASE + '/?debug=1', { waitUntil: 'load' });
  await mp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await mp.waitForTimeout(700);
  const md = await info(mp);
  ok('手机（dpr 3、纯触摸）：画布仍是固定 1080×1920',
    md.canvas.adaptive === false && md.canvas.physW === 1080 && md.canvas.physH === 1920 &&
    md.canvas.u === 1, JSON.stringify(md.canvas));
  ok('手机：画布缓冲 = 1080×1920（长按另存就是这张）',
    md.canvas.bitmapW === 1080 && md.canvas.bitmapH === 1920,
    `${md.canvas.bitmapW}x${md.canvas.bitmapH}`);
  ok('手机：安全区不参与版面（卡片底边距恒为设计值，成品与设备无关）',
    md.canvas.safe.top === 0 && md.canvas.safe.bottom === 0,
    JSON.stringify(md.canvas.safe));
  await shot(mp, 'm1-phone');

  /* 尺寸变化（旋转 / 工具栏收起展开 / 改窗口）都不许改画布与版面 ——
     真机上「截屏与另存版面不一致」的根因就在这里，回归必须守住 */
  const beforePhys = md.canvas.physW + 'x' + md.canvas.physH;
  await mp.setViewportSize({ width: 659, height: 393 });
  await mp.waitForTimeout(800);
  const rd = await info(mp);
  ok('旋转后画布尺寸不变',
    rd.canvas.physW === md.canvas.physW && rd.canvas.physH === md.canvas.physH,
    `${beforePhys} → ${rd.canvas.physW}x${rd.canvas.physH}`);
  ok('旋转后版面完全不变（设计高 / 活动区 / 字号都一致）',
    Math.round(rd.canvas.h) === Math.round(md.canvas.h) &&
    Math.round(rd.text.band.h) === Math.round(md.text.band.h) &&
    JSON.stringify(rd.text.fx) === JSON.stringify(md.text.fx) &&
    rd.text.base === md.text.base,
    `设计高 ${Math.round(md.canvas.h)} → ${Math.round(rd.canvas.h)}，base ${md.text.base} → ${rd.text.base}`);

  await mp.setViewportSize({ width: 500, height: 1000 });
  await mp.waitForTimeout(800);
  const vd = await info(mp);
  ok('改视口尺寸后画布仍不变（固定画布与窗口无关）',
    vd.canvas.physW === 1080 && vd.canvas.physH === 1920 && Math.round(vd.canvas.h) === 1920,
    `${vd.canvas.physW}x${vd.canvas.physH}`);

  /* 开关：?fit=device 时要能切回「按设备分辨率出图」—— 框架保留、不许腐烂 */
  await mp.setViewportSize({ width: 393, height: 659 });
  await mp.goto(BASE + '/?debug=1&fit=device', { waitUntil: 'load' });
  await mp.waitForFunction(() => window.__ds && window.__ds.state.layout);
  await mp.waitForTimeout(700);
  const fd = await info(mp);
  ok('?fit=device 仍按设备比例出图（开关可用、框架未腐烂）',
    fd.canvas.adaptive === true && fd.canvas.physW === 1180 && fd.canvas.physH === 1978 &&
    fd.canvas.u > 1, JSON.stringify(fd.canvas));
  ok('?fit=device 时设计高 = 位图高 ÷ U（自适应分支完好）',
    Math.abs(fd.canvas.h - fd.canvas.physH / fd.canvas.u) < 2 && Math.round(fd.canvas.h) !== 1920,
    `设计高 ${Math.round(fd.canvas.h)}，U=${fd.canvas.u}`);
  await mobileCtx.close();

  /* ---------------- 长版：本阶段必须没被动过 ---------------- */
  console.log('长版（应保持旧版面）');
  const lp = await open(BASE + '/?debug=1&long=1');
  await lp.waitForTimeout(800);
  const ld = await info(lp);
  ok('长版仍有单词卡与关键词', ids(ld).includes('panel') && ids(ld).includes('title'), ids(ld).join(','));
  ok('长版仍按内容长高（设计高 ≥ 设备画布高）', ld.canvas.h >= 1920, 'h=' + ld.canvas.h);
  ok('长版：画布缓冲比设备位图更高（内容长高，不是被裁掉）',
    ld.canvas.bitmapH > ld.canvas.physH,
    `缓冲 ${ld.canvas.bitmapH} vs 设备 ${ld.canvas.physH}`);
  ok('长版仍是原比例模式（只有标准版走「宽度铺满 + 裁切」）',
    ld.opts.bgStyle === 'natural' && ld.text.band === null, JSON.stringify(ld.opts));
  await shot(lp, 'l1-long');
  await lp.close();

  /* ---------------- raw ---------------- */
  const rp = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  rp.on('pageerror', (e) => errors.push('raw pageerror: ' + e.message));
  await rp.goto(BASE + '/?raw=1', { waitUntil: 'load' });
  await rp.waitForTimeout(2600);
  await shot(rp, 'raw');
  await rp.close();

  await browser.close();
  console.log(errors.length ? '\nCONSOLE ERRORS:\n' + errors.join('\n') : '\nno console errors');
  console.log(fails ? `\nFAIL: ${fails} 项断言未通过` : '\n全部断言通过');
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
