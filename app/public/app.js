/* =========================================================================
 * 每日一句 · 海报生成器
 * 从欧路词典「英语每日一句」抓取内容，与用户的乐词模板卡片合成一张手机海报。
 * 全部合成在浏览器 Canvas 完成，图片不上传任何服务器。
 * ========================================================================= */
'use strict';

/* ----------------------------- 基本常量 ------------------------------ */

/* 版面一律用「设计坐标」书写：宽恒为 CW = 1080、高为 CH（设计值）。
 * 实际位图 = 设计坐标 × U，绘制统一靠 render() 里一次 ctx.setTransform(U,0,0,U,0,0) 完成缩放，
 * 所以下面所有尺寸 / 字号 / 间距都**不用**乘比例 —— 改版式时按 1080 基准写就行。 */
const CW = 1080;
let CH_MIN = 1920;        // 标准版画布高（设计坐标）；手机上是「设备长边」换算过来的
let CH = CH_MIN;          // 实际画布高，开启「长版海报」时会按内容伸展

const F_SANS =
  '"AppSans","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",-apple-system,sans-serif';
const F_SERIF = '"AppSerif","Songti SC",STSong,Georgia,"Times New Roman",serif';
const F_MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';
/* 3 区（英文句）专用：EB Garamond（2026-09-24 用户指定）。
   ⚠ 它是**纯西文字体**（只有 latin 字形），所以回退栈里除了 Georgia / Times 这类衬线，
   还必须带上中文字体 —— 英文句里万一夹中文或全角标点时会按字形回退，不至于出现豆腐块。 */
const F_EN = '"AppGaramond",Georgia,"Times New Roman","PingFang SC","Hiragino Sans GB","Microsoft YaHei",serif';

const MX = 84;            // 文字左右安全边距
const TOP_PAD = 96;       // 文字块距海报顶端
const BOTTOM_PAD = 84;    // 信息卡距海报底端
const GAP_TEXT_PANEL = 56;  // 文字块 → 单词卡片（长版）
const GAP_PANEL_CARD = 46;  // 单词卡片 → 信息卡（长版）

/* 标准版固定版面：三段式（顶部图片 → 句子 → 信息卡），画布恒 1080×1920 */
const IMG_BLOCK_H = 648;      // 顶部图片区高度：图片在这一块里 cover / contain
const CARD_PAD = 48;          // 信息卡距左 / 右 / 底，三边等距
const CARD_H = 496;           // 信息卡高度（沿用模板比例换算出的大小）
const TEXT_X = CARD_PAD;      // 标准版正文左基线 = 卡片左线（同一条纵向边线）

/* ------------------ 画布尺寸：固定 1080×1920（自适应留作开关） ------------------
 * **默认固定**：位图恒 1080×1920（9:16），手机与桌面同一条路径 —— 屏幕上看到的就是长按
 *   另存的那张位图，只是等比缩放，所以「显示 = 成品」永远成立。
 *   真机实测过按设备分辨率出图（`?fit=device`）：虽然能铺满全屏，但版面在不同屏幕上差异
 *   明显，且 iOS 启动瞬间视口高度会先大后小，导致版面跳一次 —— 不够美观，故不默认启用。
 * **开关**：`?fit=device` 时按设备分辨率出图：位图 = 屏幕比例、宽度不低于 1080，
 *   U = 位图宽 / 1080 → 部件等比放大（开关定义见下方 FIT_DEVICE，与 DEBUG 同一处）。
 * 框架（U / PHYS / SAFE / watchViewport / inspect().canvas 字段 / 极端比例压缩上限）全部保留。
 */
let U = 1;                            // 比例单位：设计值 × U = 位图像素（固定画布下恒为 1）
let PHYS = { w: CW, h: CH_MIN };      // 实际位图尺寸
let ADAPTIVE = false;                 // 是否走自适应画布（= FIT_DEVICE 且是移动设备）
let SAFE = { top: 0, bottom: 0 };     // 设备安全区（仅自适应模式下参与版面）
let STAGE_PT = 0;                     // 竖直居中补正量（px，写进 CSS 变量 --stage-pt；浏览器里恒 0）
let STAGE_INFO = { standalone: false, padTop: 0, screenH: 0, frameH: 0 };   // 最近一次量测，供 inspect 自证

/**
 * 移动设备判定：纯触摸、无 hover，**且物理短边够宽**。
 * 加后一条是因为 1x 屏幕（触屏模拟、老式低分屏）拿到「设备分辨率」只有几百像素宽，
 * 出图反而更糊 —— 那种情况继续用 1080×1920 更清楚。桌面鼠标 / 触屏笔记本都算桌面。
 */
function isMobileDevice(dpr) {
  const mq = window.matchMedia && window.matchMedia('(pointer: coarse) and (hover: none)').matches;
  if (!mq) return false;
  const vv = window.visualViewport;
  const shortCss = Math.min(vv ? vv.width : window.innerWidth, vv ? vv.height : window.innerHeight);
  return shortCss * dpr >= 640;
}

/** 读安全区的实际像素：用探针元素量 env(safe-area-inset-*)，比解析字符串可靠 */
function readSafeArea() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;' +
    'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(d);
  const cs = getComputedStyle(d);
  const top = parseFloat(cs.paddingTop) || 0;
  const bottom = parseFloat(cs.paddingBottom) || 0;
  d.remove();
  return { top, bottom };
}

/**
 * 独立全屏形态（已「添加到主屏幕」）：iOS 看 navigator.standalone，
 * 标准看 display-mode。只有这种形态下页面才真的从物理屏顶端开始画。
 */
function isStandalone() {
  if (navigator.standalone === true) return true;
  return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

/**
 * 竖直居中补正：算出 `--stage-pt`（`#stage` 的上内边距），返回补正后的值。
 *
 * 独立全屏下的实测现象（真机整屏截屏量出来的，不是猜）：
 *   上留白 159px / 下留白 335px（设备像素，屏高 2622 = 874pt，状态栏 62pt），
 *   而 iPhone 自己显示同一张 1080×1920 是 249px / 241px，即**整屏居中**。
 *   海报显示尺寸两边完全一致，差的就是位置：我们偏上 90px = 30pt。
 *
 * 反推居中所在的框高 = 2×50 + 715 ≈ 812pt = 874（物理屏）− 62（状态栏）：
 *   独立全屏下**布局视口比物理屏矮一个状态栏、且锚在屏幕顶端**（内容仍从 y=0
 *   开始画，状态栏压在上面），于是 `#stage` 里那套 flex 居中是在「缺了底部一块
 *   的框」里居中 → 整张海报偏上半个状态栏：照片顶在 53pt 落进状态栏区间（压刘海），
 *   底部多出 112pt 黑区。
 *
 * 修法：量「物理屏高 − 舞台实际框高」，把框补回物理屏大小。数学上这是精确解：
 *   在内容框 (pt .. F) 里居中得到的顶边 = (F + pt − P) / 2，要它等于 (S − P) / 2，
 *   只需 pt = S − F，与海报高 P 无关。因全局是 border-box，加内边距不改舞台框高，
 *   所以「量框高 → 写内边距」幂等、不会抖。
 *
 * **必须在浏览器里保持 0**：浏览器里布局视口就是可见区，而 screen.height 远大于
 * 可见区（还含工具栏），无条件加偏移会把海报整体顶出屏幕下沿。这条有回归钉着。
 */
function syncStageCenter() {
  const stage = $('stage');
  let pt = 0;
  const frameH = stage ? Math.round(stage.getBoundingClientRect().height) : 0;
  const screenH = Math.round((window.screen && window.screen.height) || 0);
  const standalone = isStandalone();

  if (stage && standalone && frameH > 0 && screenH > 0) {
    const posterH = Math.round(cvs.getBoundingClientRect().height);
    const diff = screenH - frameH;
    /* ① 差额必须在合理区间（比状态栏高很多 = 量错了，宁可不补）
       ② 补完内容框还得装得下海报，否则海报会被压缩出左右黑边 */
    if (diff > 0 && diff <= 240 && diff + posterH <= frameH) pt = diff;
  }

  const changed = pt !== STAGE_PT;
  STAGE_PT = pt;
  STAGE_INFO = { standalone, padTop: pt, screenH, frameH };
  /* 值没变就不写 DOM：这个函数在每次旋转 / 视口变化后都会被调到 */
  if (changed) document.documentElement.style.setProperty('--stage-pt', pt + 'px');
  return pt;
}

/**
 * 按设备算出位图尺寸与比例单位 U。返回「尺寸是否变了」，供 resize 时决定要不要重排。
 * 宽度取偶数（避免半像素），U 由实际宽度反推 → CW × U 正好是整数。
 */
function computeCanvasSize() {
  const vv = window.visualViewport;
  const vw = Math.round(vv ? vv.width : window.innerWidth);
  const vh = Math.round(vv ? vv.height : window.innerHeight);
  const dpr = window.devicePixelRatio || 1;

  /* 默认关：固定 1080×1920；只有显式开开关且确实是移动设备才走自适应分支 */
  ADAPTIVE = FIT_DEVICE && isMobileDevice(dpr);
  let w = CW;
  let h = CH_MIN;
  if (ADAPTIVE) {
    const short = Math.max(240, Math.min(vw, vh));
    const long = Math.max(short, Math.max(vw, vh));
    /* 位图宽取「设备物理宽」，但**不低于设计基准 1080**：2x 屏幕的手机物理宽只有 750
       左右，直接用会比现在的 1080 还糊；按比例放大到 1080 则等于超采样，更清晰。
       关键是**比例保持屏幕比例** → 显示时仍然贴满全屏、不出现黑边。 */
    w = 2 * Math.round(Math.max(CW, short * dpr) / 2);
    h = 2 * Math.round((w * (long / short)) / 2);
  }

  const changed = w !== PHYS.w || h !== PHYS.h;
  PHYS = { w, h };
  U = w / CW;
  CH_MIN = h / U;                     /* 设计坐标下的画布高（手机上比 1920 更高） */
  const safe = ADAPTIVE ? readSafeArea() : { top: 0, bottom: 0 };
  SAFE = { top: (safe.top * dpr) / U, bottom: (safe.bottom * dpr) / U };
  document.body.classList.toggle('adaptive', ADAPTIVE);
  return changed;
}

/** 视口变化（旋转 / 工具栏收起 / 窗口缩放）→ 防抖后按新尺寸重排 */
function watchViewport() {
  let t = null;
  const onResize = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      /* 旋转 / 独立形态启动时视口高度会变，居中补正跟着重算（幂等，只会写 CSS 变量） */
      syncStageCenter();
      /* 显示尺寸变了 → 海报的屏幕圆角跟着换算（与成品里的半径保持一致） */
      syncPosterRadius();
      /* 播放中遇到旋转：波形层跟着 3 区重新贴合，别飘走 */
      if (state.voice) layoutWave();
      /* 调整中遇到旋转：海报画布尺寸不变也要重排一次（弹层的画布与窗口尺寸都依赖视口） */
      if (computeCanvasSize() || state.edit) scheduleRender();
    }, 300);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
}

/* 中部区域：日期胶囊固定在顶部靠右，英文 + 中文 + 出处在其下方的活动区里居中铺满 */
const POSTER_RADIUS = 32;     // 海报四角圆角（设计值，2026-09-22 用户定）：画进成品，屏幕同半径显示
const DATE_TOP_PAD = 24;      // 日期胶囊距顶部图片区底
const DATE_H = 52;            // 日期胶囊高度（基准值；随 2 区的交互缩放一起等比放大）
const GAP_DATE_BAND = 28;     // 日期胶囊 → 文字活动区
const GAP_TEXT_CARD = 48;     // 文字活动区距信息卡顶（同时是底部最小留白）

/* ---- 设计基准字号（2026-09-22 第二次重定，**只用于标准版**）----
   四个区各给一个**定值**（不再由「当天实际显示大小」按比例推）：
     en（3 区）= 50、cn（4 区）= 44、source（5 区）= 36、日期（2 区）= 28
   从此**进入应用就是这个字号**（不再自适应放大），用户靠上/下滑调整；
   只有「整块装不下活动区」时才整块等比缩小保底（见 computeLayout）。
   长版（?long=1）沿用旧的 42 / 29 / 25，不受影响。 */
const SZ_EN = 50;             // 3 区（英文句）设计基准（2026-09-24：换 EB Garamond 后 x-height 偏小，用户逐个数值试过定 50）
const SZ_CN = 44;             // 4 区（中文句）设计基准
const SZ_SOURCE = 36;         // 5 区（出处）设计基准
const SZ_DATE = 28;           // 2 区（日期胶囊）设计基准
/* 3 区（英文句）行高倍数（只调行距，字号由设计基准 SZ_EN 决定）：EB Garamond 的 x-height 比原来
   的无衬线小，同字号观感偏紧，所以行距略放松；字号已由 44 提到 50，行距收回 1.3（用户实测） */
const EN_LH = 1.3;
const ZOOM_MIN = 0.6;         // 交互缩放范围（相对设计基准）：全体共用下限
const ZOOM_MAX = 1.6;         // 3/4/5 区的放大上限；2 区另有更高的上限，见 ZOOM_MAX_BY
const ZOOM_PER_PX = 0.001;    // 每像素缩放量：上滑 200px ≈ +20%
const DEFAULT_BG = 'cover';   // 默认背景：铺满裁切
const DBL_MS = 300;           // 双击判定窗口

const POS_COLOR = {
  'n.': '#2563eb', 'v.': '#7c3aed', 'vt.': '#7c3aed', 'vi.': '#7c3aed',
  'adj.': '#d97706', 'adv.': '#059669', 'prep.': '#0891b2', 'conj.': '#db2777',
  'pron.': '#4f46e5', 'int.': '#ea580c', 'aux.': '#64748b', 'abbr.': '#64748b',
};

/* ===================== 主题调色板（2026-09-24 摇一摇换配色） =====================
   配色的**唯一来源**：背景渐变、压暗层、四段文字色、强调色、卡片底与字色都从这里读
   （在此之前的硬编码已全部改走 PAL()）。新增主题 = 在这里加一条；摇一摇的循环顺序 =
   下面的书写顺序。铁律「显示 = 成品」：主题全部画进 canvas，长按另存的图就是当前主题。
   页面底色（--bg / --bg-2）与波形强调色（--wave-c1 / --wave-c2）由 applyTheme() 同步。
   POS_COLOR（词性色标）不进调色板 —— 它服务于白底卡面，四套主题卡面都是白的，共用不动。 */
const THEMES = {
  /* 墨蓝夜空：原默认配色，数值原样搬进来（改前什么样，现在还什么样） */
  night: {
    name: '墨蓝夜空',
    pageBg: '#0b0f17', pageBg2: '#101623',
    bgTop: '#16233a', bgBottom: '#070b13',
    fade: '17,28,46',        /* 原比例图片下缘渐隐（rgb 三元组，透明度在绘制侧拼） */
    scrim: '6,11,22',        /* 压暗层（同上，深浅不同的透明度共用这一个基色） */
    colTitle: '#ffffff',
    titleStroke: 'rgba(255,255,255,0.16)',
    colDate: 'rgba(255,255,255,0.94)', colEn: 'rgba(255,255,255,0.97)',
    colCn: 'rgba(255,255,255,0.88)', colSource: 'rgba(255,255,255,0.62)',
    ruleA: 'rgba(255,255,255,0.95)', ruleB: 'rgba(255,255,255,0.12)',
    dateBg: 'rgba(255,255,255,0.14)', dateBd: 'rgba(255,255,255,0.34)',
    textShadow: 'rgba(3,8,18,0.55)',
    cardBg: 'rgba(255,255,255,0.94)', cardBd: 'rgba(255,255,255,0.6)',
    cardWord: '#0f172a', cardPh: '#7c8aa5', cardDef: '#334155',
    cardExBar: 'rgba(15,23,42,0.06)', cardExEn: '#475569', cardExCn: '#8b98ad',
    cardChip: '#475569', profileBg: '#ffffff',
    accentA: '#4f8dfd', accentB: '#22d3ee',
    waveA: 'rgba(34,211,238,0.62)', waveB: 'rgba(79,141,253,0.40)',
  },
  /* 暖纸墨字：米白纸质底 + 深墨文字（暖调浅色，反色）。白天户外可读性最好。
     卡面仍接近白纸（词性色标照常工作）；文字阴影换成极淡暖灰 —— 深影在浅底上会显脏 */
  paper: {
    name: '暖纸墨字',
    pageBg: '#ede7da', pageBg2: '#e2dbcb',
    bgTop: '#f5f1e8', bgBottom: '#e6dfd0',
    fade: '237,231,218', scrim: '74,66,52',
    colTitle: '#2a2620',
    titleStroke: 'rgba(26,26,23,0.16)',
    colDate: 'rgba(26,26,23,0.90)', colEn: 'rgba(26,26,23,0.95)',
    colCn: 'rgba(26,26,23,0.85)', colSource: 'rgba(26,26,23,0.60)',
    ruleA: 'rgba(26,26,23,0.80)', ruleB: 'rgba(26,26,23,0.10)',
    dateBg: 'rgba(26,26,23,0.08)', dateBd: 'rgba(26,26,23,0.35)',
    textShadow: 'rgba(74,66,52,0.18)',
    cardBg: 'rgba(255,255,255,0.92)', cardBd: 'rgba(26,26,23,0.28)',
    cardWord: '#1a1a17', cardPh: '#8a8272', cardDef: '#3d3a33',
    cardExBar: 'rgba(26,26,23,0.08)', cardExEn: '#4c473c', cardExCn: '#7d7666',
    cardChip: '#5c5546', profileBg: '#fffdf8',
    accentA: '#c2762a', accentB: '#8f5b1e',
    waveA: 'rgba(194,118,42,0.62)', waveB: 'rgba(143,91,30,0.42)',
  },
  /* 绛红夜：深绛红底 + 暖米白文字 + 玫瑰金强调（2026-09-24 用户定稿，替换 pine/dusk ——
     那两个与墨蓝在小图预览里分不开）。沉稳的暖色，与 night 的冷蓝对比鲜明，夜间不刺眼 */
  ember: {
    name: '绛红夜',
    pageBg: '#1f0a10', pageBg2: '#14060b',
    bgTop: '#2a0e14', bgBottom: '#14060a',
    fade: '42,14,20', scrim: '18,6,10',
    colTitle: '#fff4ee',
    titleStroke: 'rgba(255,244,238,0.16)',
    colDate: 'rgba(255,244,238,0.94)', colEn: 'rgba(255,247,240,0.97)',
    colCn: 'rgba(255,240,232,0.88)', colSource: 'rgba(255,235,225,0.62)',
    ruleA: 'rgba(255,240,232,0.95)', ruleB: 'rgba(255,240,232,0.12)',
    dateBg: 'rgba(255,255,255,0.14)', dateBd: 'rgba(255,255,255,0.34)',
    textShadow: 'rgba(12,3,6,0.55)',
    cardBg: 'rgba(255,255,255,0.94)', cardBd: 'rgba(255,244,238,0.6)',
    cardWord: '#2b1218', cardPh: '#9a8590', cardDef: '#463339',
    cardExBar: 'rgba(43,18,24,0.06)', cardExEn: '#57424a', cardExCn: '#8a7680',
    cardChip: '#5c4650', profileBg: '#ffffff',
    accentA: '#e8a0a8', accentB: '#c76a7c',
    waveA: 'rgba(232,160,168,0.62)', waveB: 'rgba(199,106,124,0.42)',
  },
  /* 青瓷浅冷：淡青瓷底 + 墨青文字（第二个浅色，冷调）。与 paper（暖浅）、night（冷暗）
     拉开最大色差 —— 四主题 = 暗蓝/暖浅/暗红/冷浅，一眼可辨（2026-09-24 用户定稿） */
  celadon: {
    name: '青瓷浅冷',
    pageBg: '#e8eeea', pageBg2: '#dde5df',
    bgTop: '#f0f4f0', bgBottom: '#e2eae3',
    fade: '232,238,234', scrim: '52,74,64',
    colTitle: '#16302a',
    titleStroke: 'rgba(22,48,42,0.16)',
    colDate: 'rgba(22,48,42,0.90)', colEn: 'rgba(22,48,42,0.95)',
    colCn: 'rgba(22,48,42,0.85)', colSource: 'rgba(22,48,42,0.60)',
    ruleA: 'rgba(22,48,42,0.80)', ruleB: 'rgba(22,48,42,0.10)',
    dateBg: 'rgba(22,48,42,0.08)', dateBd: 'rgba(22,48,42,0.35)',
    textShadow: 'rgba(52,74,64,0.15)',
    cardBg: 'rgba(255,255,255,0.94)', cardBd: 'rgba(22,48,42,0.22)',
    cardWord: '#1a231f', cardPh: '#7f8a80', cardDef: '#33403a',
    cardExBar: 'rgba(22,48,42,0.08)', cardExEn: '#44514a', cardExCn: '#78857c',
    cardChip: '#4b5a50', profileBg: '#fdfefd',
    accentA: '#2a9d8f', accentB: '#177063',
    waveA: 'rgba(42,157,141,0.62)', waveB: 'rgba(23,112,99,0.42)',
  },
};

/** 当前主题的调色板（state.theme 由 applyTheme 维护；未知 id 兜底回默认，绝不画错色） */
function PAL() {
  return THEMES[state.theme] || THEMES.night;
}

const THEME_KEY = 'ds:theme';

/**
 * 把主题落到整张页面：state → CSS 变量（页面底色 + 波形强调色）→ 重绘。
 * save=false 用于启动读回与 URL 预览（那两个来源本来就带着值，不必再写存储）。
 */
function applyTheme(id, opts) {
  if (!THEMES[id]) id = 'night';
  const save = !(opts && opts.save === false);
  state.theme = id;
  const p = THEMES[id];
  const root = document.documentElement.style;
  root.setProperty('--bg', p.pageBg);
  root.setProperty('--bg-2', p.pageBg2);
  root.setProperty('--wave-c1', p.waveA);
  root.setProperty('--wave-c2', p.waveB);
  document.documentElement.dataset.theme = id;   /* 将来 CSS 侧按主题微调时的钩子 */
  if (save) {
    try { localStorage.setItem(THEME_KEY, id); } catch (e) {}
  }
  scheduleRender();
}

/**
 * 启动时定主题：URL ?theme= **只当次生效**（预览与回归用，不写存储 —— 不污染用户记忆）；
 * 否则读回上次摇一摇记住的选择；都没有 = night。
 * 无痕模式 / 存储被禁时读不到就静默走默认（与 ds:last 的处理一致）。
 */
function initTheme() {
  const qs = QS.get('theme');
  if (qs && THEMES[qs]) {
    applyTheme(qs, { save: false });
    return state.theme;
  }
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  applyTheme(saved && THEMES[saved] ? saved : 'night', { save: false });
  return state.theme;
}

/* ---------------- 版式（标准版 / 长版）与双指切换（2026-09-24） ---------------- */

const MODE_KEY = 'ds:mode';

/* 双指切版阈值：扩 ≥1.6 倍 = 标准版→长版；捏 ≤0.62 倍 = 长版→标准版。
   冷却防一次手势连切；调整模式里的双指仍归图片缩放（modePtrs 只在常态记录） */
const MODE_SWITCH_EXPAND = 1.6;
const MODE_SWITCH_PINCH = 0.62;
const MODE_SWITCH_COOLDOWN = 900;

/**
 * 切换版式并重绘。切换 = 用户主动手势（双指扩/捏），所以 fx 一并复位（版式换了，
 * 各区的字号交互值没有延续意义）；版式选择写入 localStorage（按设备记忆）。
 */
function applyMode(id) {
  const long = id === 'long';
  if (state.opts.longPoster === long) return;
  state.opts.longPoster = long;
  state.fx = defaultFx();
  try { localStorage.setItem(MODE_KEY, long ? 'long' : 'standard'); } catch (e) {}
  toast(long ? '已切换到长版' : '已切换到标准版');
  scheduleRender();
}

/**
 * 启动时定版式：URL ?long=1（或旧参数 ?ex=1）**强制指定**（优先于记忆）；
 * 否则读回上次的版式；都没有 = 标准版。静默设置，不 toast（这不是用户手势）。
 */
function initMode() {
  if (QS.get('long') === '1' || QS.get('ex') === '1') {
    state.opts.longPoster = true;
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch (e) {}
  state.opts.longPoster = saved === 'long';
}

/** 摇一摇用的循环顺序 = THEMES 的书写顺序（上面注释里说了） */
const THEME_ORDER = Object.keys(THEMES);

/* ------------------------------- 状态 -------------------------------- */

const DEFAULT_RATIOS = { L: 0.0364, T: 0.5934, R: 0.9636, B: 0.8491 };

const state = {
  apiData: null,
  theme: 'night',       // 当前主题 id（THEMES 的 key）；applyTheme() 维护，启动读 ?theme= / localStorage
  layout: null,         // 最近一次渲染的版面（点击命中用）
  regions: [],          // 可点区域表（画布坐标）
  annots: [],           // 版面标注表（画布坐标，仅 ?debug=1 登记）
  /* 双击隐藏的元素：只在内存里，刷新即恢复（标准版才有这套交互） */
  hidden: { date: false, en: false, cn: false, source: false },
  /* 每个文字区一份的「交互变换」：本次只有 scale（1 = 上面那套设计基准字号）。
     2/3/4/5 都能上下滑动缩放；将来加「交互式移动」就在同一对象里补 dx/dy，
     只改手势与绘制两处。默认值见 defaultFx()。 */
  fx: defaultFx(),
  lastSpeakAt: 0,       // 最近一次朗读的时间戳（回归断言用）
  lastToggleAt: 0,      // 最近一次「今日⇄昨日」切换的时间戳（回归断言用）
  lastSave: null,       // 最近一次保存：{ kind: 'sheet'|'share'|'download', name, at }
  voice: null,          // 非 null = 正在朗读（独占层）：{ target: 'en', style: 'bars', startedAt }
  lastVoiceStopAt: 0,   // 最近一次「波形停止」的时间戳（回归断言用）
  /* 朗读自证（2026-09-22）：真机「有声没波形 / 有波形没声」的问题靠它定位 ——
     lastReason 是最近一次收尾的原因（ended / pause / stalled / error / emptied /
     timeout / tap / restart / reset / play-rejected），playedMs 是这次实际响了多久。
     每次 speak() 会重置成新的一次尝试；播放期间 lastReason 为空串。 */
  voiceDiag: {
    lastReason: '', lastAt: 0, playedMs: 0, dur: 0, url: '', playedFrom: 0,
    errName: '',        // 播放失败时的错误名（NotAllowedError / AbortError / …）—— 真机自证用
    retries: 0,         // 这次朗读自动重试了几次（0/1）
  },
  viewDate: '',         // 正在看哪一天（''=今天）；往日数据来自服务端存档
  archived: false,      // 这份数据是从存档来的（不是上游实时）
  archiveOnly: false,   // 上游挂了，整份海报都是存档顶上的
  content: {
    word: '', phonetic: '', phonetics: [], en: '', cn: '',
    defs: [], examples: [], usages: [], usagesTitle: '', source: '', date: '', dateCN: '',
    /* '' = 上游原文；'dict' = 词典补全；'guess' = 只是自动选词、没拿到释义 */
    autoKind: '',
  },
  bgImage: null,
  bgDraw: null,         // 最近一次顶部图片的实际绘制结果 { w, h, blockH, clipped, blankBottom, scale, x, y }
  template: null,
  ratios: { ...DEFAULT_RATIOS },
  /* 图片手动调整：源图在展示窗口里的变换。scale = 相对基线的倍数，ox/oy = 相对基线的画布坐标平移。
     基线（1,0,0）就是「刚换完图时看到的样子」，不调就等于不调。 */
  fits: { img: { scale: 1, ox: 0, oy: 0 }, card: { scale: 1, ox: 0, oy: 0 } },
  /* 非 null = 正在手动调整某一块：{ target: 'img'|'card', moved } */
  edit: null,
  opts: {
    bgStyle: DEFAULT_BG,
    longPoster: false,    // true = 长版海报（?long=1 强制 / 双指扩切换 / 记忆读回），见 applyMode/initMode
  },
};

/**
 * 每个文字区一份的「交互变换」状态：本次只有 scale（1 = 设计基准字号）。
 * 将来加「交互式移动」时，在同一对象里补 dx/dy、只改手势与绘制两处。
 */
function defaultFx() {
  return {
    'badge-date': { scale: 1 }, en: { scale: 1 }, cn: { scale: 1 }, source: { scale: 1 },
  };
}

/** 取某区的交互变换；未知 id 也给一个稳定默认，调用方不必判空 */
function regionFx(id) {
  return (state.fx && state.fx[id]) || { scale: 1 };
}

/** 可交互缩放的文字区：3/4/5 联动（同一组），2 区独立 */
const ZOOM_GROUP = {
  'badge-date': ['badge-date'],
  en: ['en', 'cn', 'source'],
  cn: ['en', 'cn', 'source'],
  source: ['en', 'cn', 'source'],
};

/* 放大上限**按区不同**（2026-09-22）：2 区（日期胶囊）用户反馈「倍率太低」，提到 3 倍；
   3/4/5 区仍是 ZOOM_MAX。凡是钳制缩放 / 判「已到最大」的地方一律走 zoomMaxOf(id) ——
   直接引 ZOOM_MAX 会把日期的上限误判成 1.6（放到 1.6 就提示「已到最大」）。 */
const ZOOM_MAX_BY = { 'badge-date': 3 };

/** 某区的放大上限（未特别指定的区走共用值） */
function zoomMaxOf(id) {
  return ZOOM_MAX_BY[id] || ZOOM_MAX;
}

let limitHit = '';            /* 已经提示过的缩放极限（'max' / 'min' / ''），避免刷屏 */

/**
 * 改某一区的缩放并重绘（到上下限只提示一次）。
 * 3/4/5 属于同一联动组：拖其中任一，三个一起写同一个值；2 区自成一组。
 * 上限按区取（zoomMaxOf）：2 区可以放到 3 倍，其余仍是 1.6。
 *
 * 放在模块作用域（原来在 bindGestures 里）是为了让 `__ds.setZoom` 复用它 —— 调试面
 * 与手势必须走**同一条钳制路径**，否则「回归里量到的上限」跟真机手感不是一回事。
 */
function applyZoom(id, z) {
  const max = zoomMaxOf(id);
  const clamped = Math.max(ZOOM_MIN, Math.min(max, z));
  const group = ZOOM_GROUP[id] || [id];
  let changed = false;
  for (const key of group) {
    const cur = regionFx(key);
    if (cur.scale !== clamped) {
      cur.scale = clamped;
      changed = true;
    }
  }
  if (changed) scheduleRender();
  const limit = clamped >= max ? 'max' : (clamped <= ZOOM_MIN ? 'min' : '');
  if (limit && limit !== limitHit) {
    limitHit = limit;
    toast(limit === 'max' ? '字号已放到最大' : '字号已缩到最小');
  } else if (!limit) {
    limitHit = '';
  }
}

const $ = (id) => document.getElementById(id);
const cvs = $('poster');
const QS = new URLSearchParams(location.search);
/* 调试开关：挂 window.__ds、登记版面标注。生产路径不受影响 */
const DEBUG = QS.get('debug') === '1';
/* 画布尺寸开关：默认固定 1080×1920；`?fit=device` 才按设备分辨率出图（框架留着备用） */
const FIT_DEVICE = QS.get('fit') === 'device';
/* 真机诊断页：`?diag=1` 时叠一段可长按复制的纯文本（见 startDiag）。平时完全不存在 */
const DIAG = QS.get('diag') === '1';

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

/** 只往当前路径里追加一个圆角矩形（不开新路径）—— 需要与别的子路径一起 fill 时用它 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
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

/** 客户端视角的「今天」（本地时区，用来判断是不是在看往日） */
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** '2026-09-19' → '9月19日'；今天则给「今天」 */
function dateLabel(iso) {
  if (!iso) return '今天';
  if (iso === todayISO()) return '今天';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Number(m[2]) + '月' + Number(m[3]) + '日' : iso;
}

/**
 * 取一天的数据。date 省略 = 今天（上游实时，服务端会在上游故障时用存档顶上）；
 * 传日期 = 那一天的存档（上游只提供当天，往日只能靠存档）。
 */
async function loadDaily(force, date) {
  const iso = date || '';
  setOverlay(true, iso && iso !== todayISO() ? '正在读取存档…' : '正在获取今日句子…');
  let data = null;
  try {
    const q = [];
    if (force) q.push('refresh=1');
    if (iso) q.push('date=' + encodeURIComponent(iso));
    const r = await fetch('/api/daily' + (q.length ? '?' + q.join('&') : ''), { cache: 'no-store' });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || '接口异常');
    data = j;
    /* 只有「今天」才配叫上次缓存 —— 往日数据是存档来的，别把缓存覆盖成老数据 */
    if (!iso) {
      try { localStorage.setItem('ds:last', JSON.stringify(j)); } catch (e) {}
    }
  } catch (err) {
    const cached = !iso && safeGet('ds:last');
    if (cached) {
      data = cached;
      toast('网络不可用，已使用上次缓存的内容');
    } else {
      setOverlay(false);
      toast('获取失败：' + err.message);
      return;
    }
  }

  state.apiData = data;
  /* 进页面就把发音文件抓进 HTTP 缓存：冷启动时第一次点英文句才不用等它下载 ——
     不预热的话 prime 那次 play() 会一直挂着，见 speak() 里关于 AbortError 的说明 */
  preloadAudio();
  state.archived = !!data.fromArchive;
  state.archiveOnly = !!data.archiveOnly;
  state.viewDate = data.fromArchive ? (data.archiveDate || iso) : '';

  /* 上游挂了、拿存档顶上时，如实说清楚在看哪一天，别让人以为这是今天那句 */
  if (data.archiveOnly) {
    toast('上游暂时取不到，「' + dateLabel(data.archiveDate) + '」的内容来自存档');
  }

  /* 上游「解析」块偶尔会整段漏发：这时没有关键词也没有释义。
     不猜「最长的词」当关键词，而是按句意挑几个候选（服务端已带回 Top 3），
     能查到词典就用词典内容补全，并在海报上标出来源。
     往日存档不重跑这条链路：那是当时抓到的样子，重查词典既没意义也慢。 */
  const missing = !!data.missing;
  const fb = data.fallback || null;
  /* 上游没给关键词时，用服务端挑的候选词兜底（Top 1） */
  const cands = state.archived
    ? []
    : (Array.isArray(data.candidates) ? data.candidates : []);
  const autoWord =
    data.word || (fb && fb.query) || (cands[0] && cands[0].word) || '';

  state.content = {
    word: autoWord,
    phonetic: '',
    phonetics: fb ? (fb.phonetics || []).slice() : (Array.isArray(data.phonetics) ? data.phonetics.slice() : []),
    en: data.en || '',
    cn: data.cn || '',
    defs: fb ? (fb.definitions || []).slice() : (data.definitions || []).slice(),
    examples: fb ? (fb.examples || []).slice() : (data.examples || []).slice(),
    usages: (data.usages || []).slice(),
    usagesTitle: data.usagesTitle || '常用搭配',
    source: (data.source && data.source.author) || '',
    date: data.date || '',
    dateCN: data.dateCN || '',
    autoKind: missing ? (fb ? 'dict' : (autoWord ? 'guess' : '')) : '',
  };
  /* 便于分享 / 调试：允许用 ?word=&en=&cn= 覆盖文案 */
  ['word', 'en', 'cn', 'source'].forEach((k) => {
    const v = QS.get(k);
    if (v) {
      state.content[k] = v;
      if (k === 'word') state.content.autoKind = '';
    }
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
    state.fits.img = { scale: 1, ox: 0, oy: 0 };   /* 换了图，之前的手动调整作废 */
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
  /* 识别只用来决定「从这张图里抠哪一块」；卡片自身位置与尺寸是固定的 */
  detectCard(im);
  state.fits.card = { scale: 1, ox: 0, oy: 0 };   /* 换了模板图，卡片的调整作废 */
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

/* ============================== 布局 ================================ */

const T = (size, weight, family) => `${weight} ${Math.round(size)}px ${family}`;

/** 原比例模式下背景图占满宽度后的高度（高度按图片原始比例推算） */
function naturalImageH() {
  const im = state.bgImage;
  if (!im) return 0;
  return Math.round((CW * im.height) / im.width);
}

/** 长版文字块起始 y：让位给顶部图片块（2026-09-24 起长版与标准版同款 648 裁切窗口） */
function textTopY() {
  if (state.bgImage) return IMG_BLOCK_H + 64;
  return TOP_PAD;
}

/**
 * 计算整张海报的版面。两条路线：
 *
 * - 标准版（默认）：三段式固定版面 —— 顶部图片区（`IMG_BLOCK_H`）→ 句子 → 信息卡。
 *   画布恒 1080×1920；句子太长时**自动缩小文字块字号**装箱，绝不长高。
 * - 长版（`?long=1`）：沿用原来的流式版面（含单词卡与例句），按内容需要长高。
 */
function computeLayout(ctx) {
  return state.opts.longPoster ? computeLayoutLong(ctx) : computeLayoutStandard(ctx);
}

/** 标准版：固定 1080×1920，三段式；中部区域里的句子自动放大/缩小并纵向居中 */
function computeLayoutStandard(ctx) {
  CH = CH_MIN;

  /* 信息卡高度：设计值 496 与「不超过画布 28%」取小（宽屏设备上别占太多） */
  const cardH = Math.min(CARD_H, CH * 0.28);
  const cardBottomPad = CARD_PAD + SAFE.bottom;   /* 底边还要让开 Home 指示条 */

  /* 日期胶囊（2 区）：字号 / 字距 / 宽 / 高都随该区的交互缩放等比走；它不在活动区里，
     所以**不参与**下面的「保底缩小」。先算它，「固定占用」才准。
     ⚠ 高度会随缩放长大（2026-09-22 用户明确选定「胶囊整体变大、句子区跟着下移」）：
     胶囊底部往下推 → chrome 变大 → 顶图被压、活动区下移且变矮，极端时句子被保底略缩。
     这是刻意的取舍：胶囊放大后不会压到句子，代价是句子在更矮的区域里重新居中。
     绘制侧不用另改：圆角、基线、左内边距、字距本来就是按 k 的比例式（见 drawPoster）。 */
  const dateScale = regionFx('badge-date').scale;
  const dateSize = SZ_DATE * dateScale;
  const dateH = DATE_H * dateScale;
  let date = { on: false, x: CW - TEXT_X, y: 0, w: 0, h: dateH, size: dateSize, k: dateScale };
  if (!state.hidden.date && state.content.date) {
    ctx.font = T(dateSize, 600, F_SANS);
    const dw = measureSpaced(ctx, state.content.date, 2.5 * dateScale) + 56 * dateScale;
    date = { on: true, x: CW - TEXT_X - dw, y: 0, w: dw, h: dateH, size: dateSize, k: dateScale };
  }

  /* 除图片区以外、版面固定要占掉的高度（间距 + 日期行 + 卡片 + 底边距） */
  const chrome = DATE_TOP_PAD + (date.on ? date.h + GAP_DATE_BAND : 0) +
    GAP_TEXT_CARD + cardBottomPad + cardH;

  /* 图片区高度：设计值 648 与「不超过画布 45%」取小；若这样会把句子区挤到不足画布
     的 28%，就继续压图片区 —— 平板 / 折叠屏这类宽屏设备靠这一步保住句子区。
     手机 0.46 的比例下两条都不触发，桌面（U=1）与改造前逐像素一致。 */
  let imgH = Math.min(IMG_BLOCK_H, CH * 0.45);
  const need = imgH + chrome + CH * 0.28 - CH;
  if (need > 0) imgH = Math.max(120, imgH - need);

  const dateTop = imgH + DATE_TOP_PAD;
  date.y = dateTop;

  /* 信息卡：距左 / 右 / 底三边等距（底边另加安全区） */
  const card = {
    x: CARD_PAD,
    y: CH - cardBottomPad - cardH,
    w: CW - 2 * CARD_PAD,
    h: cardH,
    shifted: false,
  };

  /* 文字活动区：日期胶囊之下、信息卡之上；日期被删掉就把那一行还给句子 */
  const bandTop = date.on ? dateTop + date.h + GAP_DATE_BAND : imgH + DATE_TOP_PAD;
  const bandBottom = card.y - GAP_TEXT_CARD;
  const bandH = bandBottom - bandTop;

  /* 保底：只有「默认字号整块装不下活动区」时才整块等比缩小（保证不压到信息卡）。
     正常内容下 base = 1 —— 2026-09-22 起不再有「尽量填满」的自动放大。
     用户的交互缩放叠在它之上（base × fx[id].scale），所以放大仍可主动溢出活动区。 */
  const base = textFit(ctx, bandH);
  const text = buildTextBlockStandard(ctx, base);

  /* 在活动区里垂直居中；装不下时上下同量溢出，仍然是居中的 */
  const textTop = bandTop + (bandH - text.total) / 2;

  return {
    /* 对外契约（inspect().text）：各区的交互倍率 + 保底倍率 base */
    base,
    fx: {
      'badge-date': dateScale,
      en: regionFx('en').scale,
      cn: regionFx('cn').scale,
      source: regionFx('source').scale,
    },
    textX: TEXT_X,
    band: { top: bandTop, bottom: bandBottom, h: bandH },
    textTop,
    textBottom: textTop + text.total,
    title: null,              /* 标准版没有关键词大标题 */
    rule: { on: false },      /* 标准版没有标题分隔线 */
    date,
    en: text.en,
    cn: text.cn,
    source: text.source,
    panel: { hidden: true, x: card.x, y: card.y, w: card.w, h: 0, padX: 0, padY: 0, row1H: 0, wordW: 0, defItems: [], exItems: [], badge: null },
    card,
    ch: CH,
    imgBlock: { y: 0, h: imgH },
  };
}

/**
 * 标准版文字块的「基准总高」：各区交互倍率都为 1 时的总高。
 * 按「内容 + 隐藏状态 + 各区 fx」缓存 —— 拖动缩放时内容没变，不必重复量测。
 * （2026-09-22 起不再做「二分求最大铺满倍率」：字号是固定设计基准，
 *   只有整块装不下活动区时才用它算保底缩小；原来二分要跑约 12 次 measureText，现在 1 次。）
 */
/** 各区 fx = 1 的「单位变换」：保底测量专用 */
const UNIT_FX = { 'badge-date': 1, en: 1, cn: 1, source: 1 };

let _fitCacheKey = '';
let _fitCacheVal = 1;
function textFitBase(ctx) {
  const h = state.hidden;
  const c = state.content;
  /* key 里**不含用户缩放值**：保底只由「内容 + 隐藏状态」决定 —— 各区的 fx 是用户叠加的，
     不参与保底求解（详见上面 fxAll 的注释） */
  const key = [h.date ? 1 : 0, h.en ? 1 : 0, h.cn ? 1 : 0, h.source ? 1 : 0,
    c.en, c.cn, c.source].join('\u0001');
  if (key === _fitCacheKey) return _fitCacheVal;
  _fitCacheVal = buildTextBlockStandard(ctx, 1, UNIT_FX).total;
  _fitCacheKey = key;
  return _fitCacheVal;
}

/**
 * 保底倍率：默认字号装得下活动区就是 1（按设计基准显示）；装不下才整块等比缩小。
 * 下面那次复核是沿用旧版的一条教训：字号会被 T() 取整，倍率取整后文字块可能又撑破
 * 活动区（1.367 → 1.37 让字号从 57 跳到 58、瞬间多一行），所以逐档退到真的装得下。
 */
function textFit(ctx, bandH) {
  let base = Math.min(1, Math.round((bandH / Math.max(1, textFitBase(ctx))) * 100) / 100);
  let guard = 0;
  while (base > 0.1 && guard++ < 40 &&
    buildTextBlockStandard(ctx, base, UNIT_FX).total > bandH) {
    base = Math.round((base - 0.01) * 100) / 100;
  }
  return base;
}

/** 长版：原有流式版面（单词卡 + 例句），按内容长高 */
function computeLayoutLong(ctx) {
  /* 交互倍率（2026-09-24 起长版与标准版同语义）：3/4/5 联动缩句子、2 区缩日期胶囊；
     标题 / 分隔线 / 单词卡不随缩放。长版靠画布长高，没有标准版的「保底缩小」。 */
  const g = regionFx('en').scale;
  const dg = regionFx('badge-date').scale;
  const M = measureAll(ctx, 1, { en: g, date: dg });

  CH = Math.max(CH_MIN, Math.ceil(M.total / 2) * 2);

  /* 内容比画布矮时，把信息卡压到最底部，余量留在单词卡片与信息卡之间 */
  const card = M.card;
  const bottomY = CH - BOTTOM_PAD - card.h;
  if (bottomY > card.y) card.y = bottomY;

  return {
    /* 长版版面：字号由它自己的流式倍率决定，用户缩放叠在其上（fx 透出真实值） */
    base: 1,
    fx: { 'badge-date': dg, en: g, cn: g, source: g },
    textX: MX,                /* 长版继续用 84 的文字安全边距 */
    band: null,
    textTop: M.textTop,
    textBottom: M.textBottom,
    title: M.text.title,
    rule: M.text.rule,
    /* 日期胶囊在长版与标题同行；这里统一换算成「画布绝对坐标」*/
    date: Object.assign({}, M.text.date, {
      y: M.textTop + M.text.date.y,
      x: CW - MX - M.text.date.w,
    }),
    en: M.text.en,
    cn: M.text.cn,
    source: M.text.source,
    panel: M.panel,
    card,
    ch: CH,
    /* 顶部图片块（2026-09-24 起长版与标准版完全对齐）：固定 648 裁切窗口，
       走同一条「宽度铺满 + 硬裁切 + 下缘渐隐」绘制与 fit/调整层数学 ——
       此前长版是原比例完整背景（文字起点随图高走），无裁切也不可换图 */
    imgBlock: { x: 0, y: 0, w: CW, h: IMG_BLOCK_H },
  };
}

function measureAll(ctx, scale, fx) {
  const K = scale;
  const textTop = textTopY();

  const text = buildTextBlock(ctx, K, fx);
  const textBottom = textTop + text.total;

  const panel = buildWordCard(ctx, K, textBottom + GAP_TEXT_PANEL);
  const panelBottom = panel.hidden ? textBottom : panel.y + panel.h;

  const card = buildProfileCard(panelBottom + GAP_PANEL_CARD);

  return {
    K, scale, textTop, text, textBottom, panel, panelBottom, card,
    total: card.y + card.h + BOTTOM_PAD,
  };
}

/** 长版文字块：关键词标题 + 分隔线 + 英文 + 中文 + 出处 */
function buildTextBlock(ctx, K, fx) {
  const maxW = CW - 2 * MX;
  const h = state.hidden;   /* 双击删除（2026-09-24 起长版同样支持）：被删元素不参与排版 */
  /* 句子组（3/4/5 联动）与日期（2 区）的交互倍率：与标准版同语义 —— 只缩句子，
     标题 / 分隔线 / 单词卡不跟着变。未传 fx 时为 1（标注/测量路径）。 */
  const g = (fx && fx.en) || 1;
  const dg = (fx && fx.date) || 1;

  /* 日期徽标占位 → 标题可用宽度 */
  let badgeW = 0;
  if (state.content.date && !h.date) {
    ctx.font = T(25 * dg, 600, F_SANS);
    badgeW = measureSpaced(ctx, state.content.date, 2.5 * dg) + 56 * dg;
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
  const rule = { on: true, gapTop: 30, h: 4, w: 86, gapBottom: 32 };
  const afterTitle = titleH + (rule.on ? rule.gapTop + rule.h + rule.gapBottom : 26);

  /* 英文 */
  const enSize = 42 * K * g;
  const enLH = enSize * 1.32;
  ctx.font = T(enSize, 400, F_SANS);
  const enLines = wrapText(ctx, state.content.en, maxW);
  const enOn = !h.en && enLines.length;
  const enY = afterTitle;

  /* 中文 */
  const cnSize = 42 * K * g;
  const cnLH = cnSize * 1.46;
  const cnGap = 34 * K * g;
  ctx.font = T(cnSize, 400, F_SANS);
  const cnLines = wrapText(ctx, state.content.cn, maxW);
  const cnOn = !h.cn && cnLines.length;
  const cnY = enY + (enOn ? enLines.length * enLH + cnGap : 0);
  const cnBottom = cnY + (cnOn ? cnLines.length * cnLH : 0);

  /* 出处：紧跟在句子下方，不再放进单词卡片 */
  const sourceSize = 29 * K * g;
  const sourceOn = !!state.content.source && !h.source;
  const sourceY = cnBottom + (sourceOn ? 30 * K : 0);

  return {
    total: sourceY + (sourceOn ? sourceSize * 1.4 : 0),
    title: { size: ts, h: titleH, text: word, badgeW },
    rule: Object.assign({}, rule, { y: titleH + rule.gapTop }),
    /* 长版的日期胶囊：字号与胶囊尺寸**沿用旧值**（长版版面本阶段不动） */
    date: { on: !!state.content.date && !h.date, y: 4, h: 52 * dg, w: badgeW, size: 25 * dg, k: dg },
    /* 长版的英文句仍用无衬线（本轮只改标准版 3 区）；family 写在这里，绘制侧就不需要判版本 */
    en: { on: enOn, size: enSize, lh: enLH, lines: enLines, y: enY, family: F_SANS },
    cn: { on: cnOn, size: cnSize, lh: cnLH, lines: cnLines, y: cnY, family: F_SANS },
    source: { on: sourceOn, size: sourceSize, y: sourceY, text: state.content.source },
  };
}

/**
 * 标准版文字块：日期胶囊 → 英文 → 中文 → 出处。
 * 没有关键词大标题与分隔线；被双击隐藏的元素直接不参与排版，其余内容自动上移补齐。
 * 返回的 y 都是「相对文字块顶端」的偏移，与长版同一套画法。
 */
function buildTextBlockStandard(ctx, K, fxAll) {
  const maxW = CW - 2 * TEXT_X;
  const h = state.hidden;
  /* 该区最终倍率 = 保底 K（通常为 1，见 textFit）× 该区的交互值。
     fxAll 给了就按它算 —— 「保底测量」必须按各区 fx = 1 来量（见 textFitBase），
     否则用户一放大就会被保底再吃掉，滑了等于没滑。 */
  const sc = (id) => (fxAll ? fxAll[id] : regionFx(id).scale);
  const sx = (id) => K * sc(id);
  /* 段落间距按「句子这一组」的倍率走：3/4/5 联动，缩放时行距跟着一起放大 */
  const kb = K * sc('en');

  /* 日期胶囊不在这条流里（它固定在中部区域顶部靠右），所以从 0 开始量 */
  let y = 0;

  /* 英文（3 区）：2026-09-24 起改用 EB Garamond（F_EN）；字族同时写进 en.family，
     让绘制 / 标注 / 命中框都读它 —— 量测与绘制必须用同一个字族，否则折行与画面对不上 */
  const enSize = SZ_EN * sx('en');
  const enLH = enSize * EN_LH;
  const enOn = !h.en && !!state.content.en;
  ctx.font = T(enSize, 400, F_EN);
  const enLines = enOn ? wrapText(ctx, state.content.en, maxW) : [];
  const enY = y;
  if (enOn) y = enY + enLines.length * enLH;

  /* 中文（4 区） */
  const cnSize = SZ_CN * sx('cn');
  const cnLH = cnSize * 1.46;
  const cnOn = !h.cn && !!state.content.cn;
  ctx.font = T(cnSize, 400, F_SANS);
  const cnLines = cnOn ? wrapText(ctx, state.content.cn, maxW) : [];
  const cnY = y + (enOn && cnOn ? 34 * kb : 0);
  if (cnOn) y = cnY + cnLines.length * cnLH;

  /* 出处（5 区） */
  const sourceSize = SZ_SOURCE * sx('source');
  const sourceOn = !h.source && !!state.content.source;
  const sourceY = y + (sourceOn ? 30 * K : 0);
  if (sourceOn) y = sourceY + sourceSize * 1.4;

  return {
    total: y,
    en: { on: enOn, size: enSize, lh: enLH, lines: enLines, y: enY, family: F_EN },
    cn: { on: cnOn, size: cnSize, lh: cnLH, lines: cnLines, y: cnY, family: F_SANS },
    source: { on: sourceOn, size: sourceSize, y: sourceY, text: state.content.source },
  };
}

/**
 * 音标只保留内容，去掉外面那层斜杠 / 方括号 / 空白。
 * 数据源各处的写法不统一（`/dɪˈsiːv/`、`[dɪˈsiːv]`、`/ dɪˈsiːv /`），
 * 统一到这里剥干净，再由下面包一层 `/…/`，避免出现 `//` 或双份斜杠。
 */
function normPh(s) {
  return String(s == null ? '' : s)
    .replace(/^[\s/[]+/, '')
    .replace(/[\s/\]]+$/, '');
}

/**
 * 归一化音标，统一成 [{ label, ph, text }]。
 * 只有一个音标时不显示「英/美」标签，保持和以前一致的观感；
 * 英式 + 美式并存（2026-09-18 起上游会给两个）时才加标签区分，
 * 形如 `英 /dɪ'siːv/　美 /dɪ'siːv/`。
 */
function phoneticList() {
  const c = state.content;
  const list = (c.phonetics && c.phonetics.length)
    ? c.phonetics
    : (c.phonetic ? [{ label: '', ph: c.phonetic }] : []);
  const single = list.length <= 1;
  return list
    .filter((p) => p && p.ph)
    .map((p) => {
      const ph = normPh(p.ph);
      return {
        label: p.label || '',
        ph,
        text: (single || !p.label ? '' : p.label + ' ') + '/' + ph + '/',
      };
    });
}


/**
 * 卡片右下角的小圆标：一个加圈的字，说明关键词 / 释义不是上游今天给的内容。
 * 做得刻意轻 —— 是给留心的人看的，不该抢句子的注意力。
 */
const BADGE = {
  dict: { ch: '补', fg: '#3b73e0', bd: 'rgba(79,141,253,0.5)', bg: 'rgba(79,141,253,0.07)' },
  guess: { ch: '选', fg: '#7b8794', bd: 'rgba(148,163,184,0.55)', bg: 'rgba(148,163,184,0.08)' },
};

const BADGE_D = 38;   /* 圆标直径 */
const BADGE_FS = 21;  /* 圈内字号 */
const BADGE_MX = 22;  /* 距卡片右边 */
const BADGE_MY = 20;  /* 距卡片下边 */

function badgeOf() {
  return BADGE[state.content.autoKind] || null;
}

/** 单词卡片：关键词 + 音标 + 释义（+ 长版海报下的例句），无底部栏 */
function buildWordCard(ctx, K, topY) {
  const r = state.ratios;
  const x = Math.round(r.L * CW);
  const w = Math.round((r.R - r.L) * CW);

  /* 补全失败、连关键词都没有：干脆不画这张卡片，比画一张空卡片体面 */
  if (!state.content.word) {
    return {
      hidden: true, x, y: Math.round(topY), w, h: 0,
      padX: 0, padY: 0, innerW: 0, wordSize: 0, phSize: 0, phDrawSize: 0,
      row1H: 0, wordW: 0, defItems: [], defLH: 0, chipSize: 0, defSize: 0,
      exItems: [], badge: null,
    };
  }

  const padX = 46;
  const padY = 34;
  const innerW = w - padX * 2;

  /* 右下角圆标只占底部一点空间，标题行宽度不再被它挤 */
  const badge = badgeOf();
  const rowMaxW = innerW;

  /* 关键词可能是短语（上游会给「get something done」这类词组），
     先按最长能放进一行来定字号，再排音标 */
  const phSize = 31 * K;
  const phs = phoneticList();
  const word = state.content.word || '';
  let wordSize = 47 * K;
  ctx.font = T(wordSize, 600, F_SANS);
  let wordW = ctx.measureText(word).width;
  for (let s = 1; s >= 0.58 && wordW > rowMaxW; s -= 0.04) {
    wordSize = 47 * K * s;
    ctx.font = T(wordSize, 600, F_SANS);
    wordW = ctx.measureText(word).width;
  }
  const row1H = wordSize * 1.3;

  const defSize = 36 * K;
  const defLH = defSize * 1.62;
  const chipSize = 25 * K;

  /* 音标（可能是「英 /…/ 美 /…/」）与关键词挤在一行，放不下就逐档缩小音标字号 */
  let phDrawSize = phSize;
  if (phs.length) {
    for (let s = 1; s >= 0.6; s -= 0.05) {
      const size = phSize * s;
      ctx.font = T(size, 400, F_MONO);
      const total = phs.reduce((acc, p) => acc + ctx.measureText(p.text).width, 0)
        + Math.max(0, phs.length - 1) * 22;
      phDrawSize = size;
      if (wordW + 18 + total <= rowMaxW) break;
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

  /* 例句区（ex-0/ex-1）已按用户要求整体移除（2026-09-24）：长版单词卡只保留
     关键词 / 音标 / 释义 / 词性 chips，面板相应收紧、信息卡上移、画布总高变短。
     exItems 保留为空数组 —— 下游绘制/标注/命中表按空列表自然跳过，形状不变 */
  const exItems = [];

  let contentH = row1H + 16;
  for (const it of defItems) contentH += it.h + 10;
  if (exItems.length) contentH += 12 + exItems.reduce((s, e) => s + e.h + 16, 0);

  return {
    hidden: false,
    /* 有圆标时底部多留一点，免得压到最后一行释义上 */
    x, y: Math.round(topY), w, h: Math.round(padY * 2 + contentH + (badge ? 26 : 0)),
    padX, padY, innerW,
    wordSize, phSize, phDrawSize, row1H, wordW,
    defItems, defLH, chipSize, defSize,
    exItems, badge,
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

/* --------------------- 版面标注（?debug=1 专用） --------------------- */

/**
 * 把排版用到的每个 L 字段翻译成「有名字、有框」的条目。
 * 坐标一律是画布坐标（1080 宽基准），与 state.regions 同一坐标系，
 * 编号按版面从上到下（y 再 x）生成 —— 人报编号、AI 查 id，两边对得上。
 *
 * 只在 ?debug=1 时调用，生产渲染路径零开销；也不参与任何绘制。
 */
function buildAnnots(ctx, L) {
  const A = [];
  const r1 = (n) => Math.round(n * 10) / 10;
  const push = (id, label, x, y, w, h, extra) => {
    if (!(w > 0 && h > 0)) return;
    A.push(Object.assign({
      id, label,
      box: [r1(x), r1(y), r1(w), r1(h)],
      font: 0, color: '', text: '', kind: 'item',
    }, extra || {}));
  };
  /* 多行文本块的实际宽度：取最长一行 */
  const blockW = (lines, size, weight, family) => {
    ctx.font = T(size, weight, family);
    let w = 0;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    return w;
  };

  const c = state.content;
  const tx = L.textX;
  const maxW = CW - 2 * tx;
  const T0 = L.textTop;
  const C = PAL();           /* 标注表的颜色列必须如实反映当前主题（与手册「图文一致」的要求对应） */

  /* ---- 顶部文字块（标准版没有大标题与分隔线） ---- */
  if (L.title) {
    const t = L.title;
    ctx.font = T(t.size, 700, F_SERIF);
    push('title', '大标题关键词', tx, T0, Math.min(ctx.measureText(t.text).width, maxW), t.h,
      { font: r1(t.size), color: C.colTitle, text: t.text });
  }

  if (L.date && L.date.on) {
    /* 字号读版面实际值，别写死 —— 否则标注图上的字号与实际不一致 */
    push('badge-date', '日期胶囊', L.date.x, L.date.y, L.date.w, L.date.h,
      { font: r1(L.date.size == null ? 25 : L.date.size), color: C.colDate, text: c.date });
  }

  if (L.rule.on) {
    push('rule', '标题分隔线', tx, T0 + L.rule.y, L.rule.w, L.rule.h,
      { color: C.ruleA });
  }

  if (L.en.on) {
    push('en', '英文句', tx, T0 + L.en.y,
      blockW(L.en.lines, L.en.size, 400, L.en.family || F_SANS), L.en.lines.length * L.en.lh,
      { font: r1(L.en.size), color: C.colEn, text: L.en.lines.join(' ') });
  }

  if (L.cn.on) {
    push('cn', '中文句', tx, T0 + L.cn.y,
      blockW(L.cn.lines, L.cn.size, 400, F_SANS), L.cn.lines.length * L.cn.lh,
      { font: r1(L.cn.size), color: C.colCn, text: L.cn.lines.join('') });
  }

  if (L.source.on) {
    const st = '—— ' + L.source.text;
    ctx.font = T(L.source.size, 500, F_SANS);
    push('source', '出处', tx, T0 + L.source.y, ctx.measureText(st).width, L.source.size * 1.4,
      { font: r1(L.source.size), color: C.colSource, text: st });
  }

  /* ---- 单词卡片 ---- */
  const P = L.panel;
  if (!P.hidden && P.h > 0) {
    push('panel', '单词卡整体', P.x, P.y, P.w, P.h, { color: C.cardBg });

    const barH = Math.min(P.h - P.padY * 2, P.row1H + 22);
    push('panel-bar', '左侧渐变竖条', P.x + 22, P.y + P.padY + 4, 5, barH - 8,
      { color: C.accentA + ' → ' + C.accentB });

    const x0 = P.x + P.padX;
    const row1Top = P.y + P.padY;
    ctx.font = T(P.wordSize, 600, F_SANS);
    const ww = ctx.measureText(c.word || '').width;
    push('panel-word', '卡内关键词', x0, row1Top, ww, P.row1H,
      { font: r1(P.wordSize), color: C.cardWord, text: c.word });

    const phs = phoneticList();
    if (phs.length) {
      const ps = P.phDrawSize || P.phSize;
      ctx.font = T(ps, 400, F_MONO);
      let phW = -22;
      for (const p of phs) phW += ctx.measureText(p.text).width + 22;
      const phBase = row1Top + P.wordSize * 0.85;
      push('panel-ph', '音标', x0 + ww + 18, phBase - ps * 0.8, Math.max(0, phW), ps * 1.25,
        { font: r1(ps), color: C.cardPh, text: phs.map((p) => p.text).join(' ') });
    }

    let y = row1Top + P.row1H + 16;
    P.defItems.forEach((it, i) => {
      const many = P.defItems.length > 1;
      push('def-' + i, '释义' + (many ? ' ' + (i + 1) : ''), x0, y, P.innerW, it.h,
        { font: r1(P.defSize), color: C.cardDef, text: it.lines.join('') });
      if (it.pos) {
        const chipH = P.chipSize * 1.72;
        push('chip-' + i, '词性胶囊', x0, y + (it.h - chipH) / 2, it.chipW, chipH,
          { font: r1(P.chipSize), color: POS_COLOR[it.pos] || C.cardChip, text: it.pos });
      }
      y += it.h + 10;
    });

    if (P.exItems.length) {
      y += 6;
      P.exItems.forEach((ex, i) => {
        push('ex-' + i, '例句' + (P.exItems.length > 1 ? ' ' + (i + 1) : ''), x0, y, P.innerW, ex.h,
          { font: r1(ex.enSize), color: C.cardExEn, text: ex.enLines.join(' ') });
        y += ex.h + 16;
      });
    }

    if (P.badge) {
      const d = BADGE_D;
      push('badge-src', '右下来源圆标', P.x + P.w - BADGE_MX - d, P.y + P.h - BADGE_MY - d, d, d,
        { font: BADGE_FS, color: P.badge.fg, text: P.badge.ch, kind: 'badge' });
    }
  }

  /* ---- 信息卡 / 背景 / 安全边距 ---- */
  push('card', '个人信息卡', L.card.x, L.card.y, L.card.w, L.card.h, { color: C.profileBg });

  if (state.bgImage) {
    const natural = state.opts.bgStyle === 'natural';
    /* 标准版：宽度铺满、超出顶部图片区的部分被裁掉；长版仍是两种背景模式 */
    const label = L.imgBlock
      ? '顶部图片区（宽度铺满·超出裁切）'
      : '背景图区（' + (natural ? '原比例' : '铺满') + '）';
    push('bg', label, 0, 0, CW,
      L.imgBlock ? L.imgBlock.h : (natural ? naturalImageH() : CH), { kind: 'bg' });
  }

  /* 「文字安全边距」是长版的概念；标准版的对齐基准是信息卡的 48px 边距 */
  if (!L.imgBlock) {
    push('safe-l', '左安全边距', 0, 0, MX, CH, { kind: 'guide' });
    push('safe-r', '右安全边距', CW - MX, 0, MX, CH, { kind: 'guide' });
  }

  /* 编号 = 版面从上到下的顺序，报号不用来回找 */
  A.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  A.forEach((it, i) => { it.i = i + 1; });
  return A;
}

/** 间距量尺：「这两块太挤」这种描述的可执行翻译 */
function buildGaps(L) {
  const G = [];
  const add = (id, label, px) => {
    if (px == null || !isFinite(px)) return;
    G.push({ id, label, px: Math.round(px) });
  };
  const P = L.panel;
  const textBottom = L.textBottom;

  if (L.band) {
    /* 标准版（有活动区 band）：顶部图片区固定，句子在中部活动区里自适应并居中。
       ⚠ 别用 imgBlock 判版本 —— 2026-09-24 起长版也有 imgBlock（顶部图片块对齐标准版） */
    add('img-h', '顶部图片区高度', L.imgBlock.h);
    add('band-top', '图片区 → 中部活动区顶', L.band.top - (L.imgBlock.y + L.imgBlock.h));
    add('band-h', '中部活动区高度', L.band.h);
    add('gap-img-text', '活动区顶 → 文字块顶', L.textTop - L.band.top);
    add('gap-text-card', '文字块底 → 活动区底', L.band.bottom - textBottom);
    add('margin-x', '正文与信息卡距左右', L.textX);
  } else {
    add('margin-x', '左右安全边距', MX);
    add('top-pad', '海报顶 → 文字块顶', L.textTop);
    if (L.title && L.date && L.date.on) {
      add('gap-title-en', '大标题 → 英文句', L.en.y - L.title.h);
    }
    if (P && P.hidden) {
      add('gap-text-card', '文字块 → 信息卡', L.card.y - textBottom);
    } else {
      add('gap-text-panel', '文字块 → 单词卡', P.y - textBottom);
      add('gap-panel-card', '单词卡 → 信息卡', L.card.y - (P.y + P.h));
    }
  }
  add('bottom-pad', '信息卡 → 海报底', CH - (L.card.y + L.card.h));
  add('card-h', '信息卡高度', L.card.h);
  return G;
}

/** 版面快照：编号 + 坐标 + 字号 + 间距，供 app/inspect.js 导出 */
function inspect() {
  const ctx = cvs.getContext('2d');
  const L = state.layout || computeLayout(ctx);
  const items = buildAnnots(ctx, L);

  /* 自校验：标注框与点击命中表必须一致，否则说明派生公式与真实绘制漂移了 */
  const rCard = (state.regions || []).find((r) => r.id === 'card');
  const aCard = items.find((it) => it.id === 'card');
  if (rCard && aCard && (Math.abs(rCard.x - aCard.box[0]) > 1 || Math.abs(rCard.y - aCard.box[1]) > 1)) {
    console.warn('[inspect] 标注与命中表不一致 card:', rCard, aCard.box);
  }

  return {
    /* w/h = 设计坐标（恒以 1080 为基准，标注通道与回归都用它）；
       physW/physH = 设备位图尺寸（手机 = 设备分辨率；桌面 = 1080×1920）；
       bitmapW/bitmapH = 画布缓冲实际尺寸 —— 长版会按内容长高，比 physH 更高 */
    canvas: {
      w: CW, h: CH,
      u: Math.round(U * 10000) / 10000,
      physW: PHYS.w, physH: PHYS.h,
      bitmapW: cvs.width, bitmapH: cvs.height,
      adaptive: ADAPTIVE,
      safe: { top: Math.round(SAFE.top), bottom: Math.round(SAFE.bottom) },
    },
    items,
    gaps: buildGaps(L),
    opts: Object.assign({}, state.opts),
    /* 当前主题（2026-09-24 摇一摇换配色）：id = THEMES 的 key，name = toast 里的中文名。
       只增不改：标注通道与旧回归不认识它也无碍，新回归靠它自证「进了哪个主题」 */
    theme: { id: state.theme, name: (THEMES[state.theme] || THEMES.night).name },
    /* 摇一摇授权自证（只增字段）：state = granted / denied / error / ''（还没问过）。
       真机「授权弹窗不出现」时读它分辨：被拒 / pointerdown 不被当手势（历史坑） / 没有 API */
    shakeDiag: Object.assign({}, shakeDiag),
    ratios: Object.assign({}, state.ratios),
    /* 图片手动调整：正在调哪一块（null = 没在调）+ 两块各自的缩放/位移。
       window = 弹层里那个换图窗口的 rect（层内 CSS px）；radius = 它的圆角（CSS px）。
       回归与标注通道靠这两个字段量「窗口是否居中 / 尺寸是否等于成品里那块」。 */
    edit: state.edit ? {
      target: state.edit.target,
      moved: !!state.edit.moved,
      window: editWin ? [editWin.x, editWin.y, editWin.w, editWin.h] : null,
      radius: editWin ? editWin.r : null,
    } : null,
    fits: {
      img: Object.assign({}, state.fits.img),
      card: Object.assign({}, state.fits.card),
    },
    /* 文字字号状态（2026-09-22 改口径）：fx = 2/3/4/5 各区的交互倍率（1 = 设计基准字号），
       base = 保底倍率（只有整块装不下活动区时才 < 1）—— 「为什么字变小了」看它就知道 */
    text: {
      fx: Object.assign({
        'badge-date': 1, en: 1, cn: 1, source: 1,
      }, L.fx),
      base: L.base == null ? 1 : L.base,
      x: L.textX,
      band: L.band ? { top: L.band.top, h: L.band.h } : null,
    },
    meta: {
      date: state.content.date, word: state.content.word,
      autoKind: state.content.autoKind, bgImage: !!state.bgImage,
      hidden: Object.assign({}, state.hidden),
      lastSpeakAt: state.lastSpeakAt || 0,
    },
    /* 顶部图片的实际绘制结果：clipped = 是否发生了裁切（竖图会为 true） */
    bg: state.bgDraw,
    /* 竖直居中补正（syncStageCenter）：standalone = 是否独立全屏形态；
       padTop = 实际补进 #stage 的上内边距；screenH / frameH = 物理屏高与舞台框高。
       浏览器里 padTop 恒为 0 —— 那正是「没做无条件偏移」的自证。 */
    stage: Object.assign({}, STAGE_INFO),
    /* 语音独占层：null = 没在朗读（其余区域都能操作）；非 null 时**只有波形区可点** */
    voice: state.voice ? {
      active: true,
      target: state.voice.target,
      style: state.voice.style,
      since: state.voice.startedAt,
    } : null,
    /* 朗读自证（2026-09-22 新增，契约只增不改）：最后一次朗读为什么结束、实际响了多久。
       真机出现问题（说话没波形 / 波形没声 / 播一半就断）时，读它就能定位，不必靠猜。 */
    voiceDiag: Object.assign({}, state.voiceDiag),
  };
}

/* ============================== 绘制 ================================ */

function render() {
  const ctx = cvs.getContext('2d');

  /* 版面确定后才知道画布多高（长版海报会变高）；设计坐标 → 位图的换算见 computeCanvasSize */
  const L = computeLayout(ctx);
  const w = PHYS.w;
  const h = Math.max(2, 2 * Math.round((CH * U) / 2));

  /* 给 width/height 赋值会重置 2D 上下文，所以缩放变换必须在 resize 之后重设 */
  if (cvs.width !== w || cvs.height !== h) {
    cvs.width = w;
    cvs.height = h;
  }
  ctx.setTransform(U, 0, 0, U, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';

  /* 海报圆角（2026-09-22 用户要求）：**画进成品**，四角保持透明 ——
     长按另存的 PNG 本身就是一张圆角卡片，屏幕侧用同一半径显示（syncPosterRadius），
     所以「显示 = 成品」依旧成立。这是本项目**唯一**一个「画进 canvas 的显示属性」：
     绝不许只在 CSS 里加圆角（那样屏幕与成品就不一致了）。
     半径是设计值常量，不随 CH / U 变；clip 之后所有绘制（含 drawBackground 里那幅
     铺满画布的 fillRect）都被限制在圆角内，四角自然透明。 */
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, 0, 0, CW, CH, POSTER_RADIUS);
  ctx.clip();

  drawBackground(ctx, L);
  drawScrim(ctx, L);
  drawGrain(ctx);
  drawTopText(ctx, L);
  drawWordCard(ctx, L);
  drawProfileCard(ctx, L);
  ctx.restore();

  /* 换图调整层：原海报不动，弹层里只有居中的换图区与这张图（预览画在自己的画布上）。
     放在这里（唯一落点 render）而不是在 startEdit 里另算一份 —— 换图、旋转、拖动重绘
     都会经过它，位置永远跟着最新版面走，也不会出现「两个地方各算一套」的漂移。 */
  drawEditPreview(L);

  /* 版面即「可点区域地图」：留下坐标供点击命中与引导框使用 */
  state.layout = L;
  state.regions = buildHitRegions(L);
  /* 版面标注：给人看的编号图与给 AI 读的坐标清单共用这份数据（仅调试模式） */
  if (DEBUG) state.annots = buildAnnots(ctx, L);
  /* 屏幕上的圆角必须与成品里的半径一致（值没变不写 DOM） */
  syncPosterRadius();
  return L;
}

let posterRadiusCss = -1;   /* 上次写进 #poster 的 CSS 圆角（px）；值没变就不碰 DOM */

/**
 * 把海报圆角的**屏幕半径**同步到 CSS：`#poster` 的 `border-radius` 必须等于
 * 「设计值 32 × 显示比例（显示宽 / 1080）」，否则屏幕上的圆角与成品里的对不上，
 * 「显示 = 成品」就破了。
 *
 * ⚠ **不能用百分比**：百分比圆角在横向与纵向分别按宽 / 高解析，9:16 的框会变成椭圆角。
 * 与 syncStageCenter() 同一习惯：值没变就不写 DOM（render 每次都会调到它）。
 */
function syncPosterRadius() {
  const rect = cvs.getBoundingClientRect();
  if (!rect.width) return;
  const px = Math.round(POSTER_RADIUS * (rect.width / CW) * 100) / 100;
  if (px === posterRadiusCss) return;
  posterRadiusCss = px;
  cvs.style.borderRadius = px + 'px';
}

/* ===================== 图片手动调整（fit 模型） ===================== */

const FIT_MAX = 4;      /* 双指最多放大到基线的 4 倍 */

/** 某个可调区域在画布上的展示窗口：顶部图片区 / 信息卡 */
function fitBox(target, L) {
  if (target === 'img') {
    return { x: 0, y: 0, w: CW, h: (L && L.imgBlock ? L.imgBlock.h : IMG_BLOCK_H) };
  }
  const c = (L && L.card) || { x: CARD_PAD, y: CH_MIN - CARD_PAD - CARD_H, w: CW - 2 * CARD_PAD, h: CARD_H };
  return { x: c.x, y: c.y, w: c.w, h: c.h };
}

/**
 * 基线变换：`scale = 1` 时必须与「刚换完图看到的样子」一致。
 *
 * - 顶部图片：宽度铺满、左上角对齐 —— 与改造前逐像素相同
 * - 信息卡：等比缩放到「面积与自动识别出的那块矩形相当」，中心对准识别矩形的中心。
 *   旧实现是把识别矩形**拉伸**填满卡片，比例不合就变形；这里从此不再变形，
 *   代价只是比例差较大时边缘会有轻微位移。
 */
function fitBase(target, L) {
  const im = target === 'img' ? state.bgImage : state.template;
  if (!im || !im.width || !im.height) return null;
  const box = fitBox(target, L);
  let k; let x; let y;
  if (target === 'img') {
    k = CW / im.width;
    x = box.x;
    y = box.y;
  } else {
    const r = state.ratios;
    const cx = ((r.L + r.R) / 2) * im.width;
    const cy = ((r.T + r.B) / 2) * im.height;
    const area = Math.max(1, (r.R - r.L) * im.width * (r.B - r.T) * im.height);
    k = Math.sqrt((box.w * box.h) / area);
    x = box.x + box.w / 2 - cx * k;
    y = box.y + box.h / 2 - cy * k;
  }
  return { im, box, k, x, y };
}

/**
 * 把 fit 收进合法范围，并算出实际绘制参数。
 *
 * 缩放锚点 = 窗口中心（基线中心点不动），所以 scale = 1 时位置与基线完全一致。
 * 平移限制：某方向图片比窗口大 → 必须盖满该方向（不许露底色）；
 * 比窗口小（例如 16:9 宽图铺满宽度后只有 608 高）→ 该方向锁在缩放后的基线位置，
 * 既保住「宽图下方露一段底色」的既有观感，也没法把它拖出窗口。
 */
function fitDraw(base, fit) {
  const W = base.box.w;
  const H = base.box.h;
  const s = Math.max(1, Math.min(FIT_MAX, (fit && fit.scale) || 1));
  const iw = base.im.width * base.k * s;
  const ih = base.im.height * base.k * s;
  const xs = base.box.x + W / 2 - (base.box.x + W / 2 - base.x) * s;
  const ys = base.box.y + H / 2 - (base.box.y + H / 2 - base.y) * s;
  let x = xs + ((fit && fit.ox) || 0);
  let y = ys + ((fit && fit.oy) || 0);
  x = iw >= W ? Math.min(base.box.x, Math.max(base.box.x + W - iw, x)) : xs;
  y = ih >= H ? Math.min(base.box.y, Math.max(base.box.y + H - ih, y)) : ys;
  return { scale: s, ox: x - xs, oy: y - ys, x, y, k: base.k * s, w: iw, h: ih };
}

/** 当前调整目标的绘制参数（绘制与手势共用，保证「看到的就是调出来的」） */
function currentFitDraw(target, L) {
  const base = fitBase(target, L);
  if (!base) return null;
  return Object.assign({ base }, fitDraw(base, state.fits[target]));
}

/* --------------------------- 背景 --------------------------- */

function drawBackground(ctx, L) {
  const im = state.bgImage;
  if (!im) {
    drawBase(ctx);
    return;
  }

  /* 标准版顶部图片区：宽度统一铺满 1080、高度按原始比例，
     超出这个 648px 区域的部分**硬裁掉**（不裁的话竖图会一路糊到中部区域）。
     宽图（如 16:9 → 608 高）下方会露出一段底色。 */
  if (L.imgBlock) {
    drawBase(ctx);
    const blockH = L.imgBlock.h;
    const base = fitBase('img', L);
    const d = fitDraw(base, state.fits.img);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, CW, blockH);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base.im, d.x, d.y, d.w, d.h);
    ctx.restore();

    /* 下缘渐隐：图片底边还在窗口里就按底边渐隐，被裁掉则贴窗口底边收 */
    const visibleBottom = Math.min(blockH, Math.max(0, d.y + d.h));
    fadeImageBottom(ctx, visibleBottom);
    /* 记录实际绘制结果，回归可以结构化断言「裁了多少 / 放大到几倍 / 挪到哪」 */
    state.bgDraw = {
      w: Math.round(d.w), h: Math.round(d.h), blockH,
      clipped: d.h > blockH || d.w > CW || d.x < 0 || d.y < 0,
      blankBottom: Math.max(0, Math.round(blockH - (d.y + d.h))),
      scale: d.scale, x: Math.round(d.x), y: Math.round(d.y),
    };
    return;
  }

  /* 长版：原比例 = 宽度铺满、顶端与海报顶端对齐，图片完整不裁切 */
  if (state.opts.bgStyle === 'natural') {
    drawBase(ctx);
    const ih = naturalImageH();
    ctx.drawImage(im, 0, 0, CW, ih);
    fadeImageBottom(ctx, ih);
    return;
  }

  /* 铺满：等比裁切填满整张海报 */
  drawCover(ctx, im, 0, 0, CW, CH);
}

/** 海报底色：随主题走（2026-09-24 前是硬编码的墨蓝夜空，night 的数值就是原值） */
function drawBase(ctx) {
  const p = PAL();
  const g = ctx.createLinearGradient(0, 0, CW * 0.35, CH);
  g.addColorStop(0, p.bgTop);
  g.addColorStop(1, p.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);
}

/**
 * 原比例模式下，让背景图下缘渐隐进海报底色。
 * 只作用于图片最下方一小段，主体依然清晰可辨，衔接也不生硬。
 */
function fadeImageBottom(ctx, ih) {
  const FADE = Math.min(200, Math.round(ih * 0.3));
  const rgb = PAL().fade;    /* 渐隐进当前主题的底色，而不是写死的墨蓝 */
  const g = ctx.createLinearGradient(0, ih - FADE, 0, ih);
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(0.55, `rgba(${rgb},0.4)`);
  g.addColorStop(1, `rgba(${rgb},1)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, ih - FADE, CW, FADE);
}

/** 顶部压暗 + 底部压暗 + 四角暗角 */
function drawScrim(ctx, L) {
  /* 压暗基色随主题（暗色系各用各的近黑；paper 用暖褐 —— 纯黑压在浅底上会发灰发脏） */
  const s = PAL().scrim;
  /* 标准版：句子与卡片都落在底色上，不需要压暗图片；只做底部收边与暗角 */
  if (L.imgBlock) {
    const g = ctx.createLinearGradient(0, CH - 640, 0, CH);
    g.addColorStop(0, `rgba(${s},0)`);
    g.addColorStop(1, `rgba(${s},0.5)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, CH - 640, CW, 640);

    const v0 = ctx.createRadialGradient(CW / 2, CH * 0.44, CW * 0.26, CW / 2, CH * 0.5, CH * 0.78);
    v0.addColorStop(0, 'rgba(0,0,0,0)');
    v0.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = v0;
    ctx.fillRect(0, 0, CW, CH);
    return;
  }

  /* 长版 · 原比例：顶部图片保持干净，只在其下方轻压暗 + 底部收边 */
  if (state.opts.bgStyle === 'natural' && state.bgImage) {
    const ih = naturalImageH();
    ctx.fillStyle = `rgba(${s},0.06)`;
    ctx.fillRect(0, ih, CW, CH - ih);
    const g = ctx.createLinearGradient(0, CH - 560, 0, CH);
    g.addColorStop(0, `rgba(${s},0)`);
    g.addColorStop(1, `rgba(${s},0.4)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, ih, CW, CH - ih);
    return;
  }

  const topEnd = Math.max(620, L.textBottom + 140);

  const g = ctx.createLinearGradient(0, 0, 0, topEnd);
  g.addColorStop(0, `rgba(${s},0.72)`);
  g.addColorStop(0.42, `rgba(${s},0.42)`);
  g.addColorStop(1, `rgba(${s},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, topEnd);
  ctx.fillStyle = `rgba(${s},0.10)`;
  ctx.fillRect(0, 0, CW, CH);

  const gb = ctx.createLinearGradient(0, CH - 620, 0, CH);
  gb.addColorStop(0, `rgba(${s},0)`);
  gb.addColorStop(1, `rgba(${s},0.55)`);
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
  const P = PAL();           /* 本函数所有颜色都随主题（2026-09-24 前= night 的原值） */
  const shadow = () => {
    ctx.shadowColor = P.textShadow;
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 4;
  };
  const noShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };

  /* 关键词大标题：只有长版有 */
  if (L.title) {
    const t = L.title;
    const ty = L.textTop + t.size * 0.86;
    ctx.save();
    ctx.font = T(t.size, 700, F_SERIF);
    ctx.fillStyle = P.colTitle;
    shadow();
    ctx.strokeStyle = P.titleStroke;
    ctx.lineWidth = t.size * 0.055;
    ctx.lineJoin = 'round';
    ctx.strokeText(t.text, MX, ty);
    ctx.fillText(t.text, MX, ty);
    ctx.restore();
  }

  /* 分隔线 */
  if (L.rule.on) {
    ctx.save();
    const g = ctx.createLinearGradient(MX, 0, MX + L.rule.w, 0);
    g.addColorStop(0, P.ruleA);
    g.addColorStop(1, P.ruleB);
    ctx.fillStyle = g;
    roundRect(ctx, MX, L.textTop + L.rule.y, L.rule.w, L.rule.h, L.rule.h / 2);
    ctx.fill();
    ctx.restore();
  }

  /* 英文 */
  if (L.en.on !== false) {
    ctx.save();
    ctx.font = T(L.en.size, 400, L.en.family || F_SANS);   /* 与量测同一个字族，见 buildTextBlockStandard */
    ctx.fillStyle = P.colEn;
    shadow();
    L.en.lines.forEach((ln, i) => {
      ctx.fillText(ln, L.textX, L.textTop + L.en.y + i * L.en.lh + L.en.size * 0.86);
    });
    ctx.restore();
  }

  /* 中文 */
  if (L.cn.on !== false) {
    ctx.save();
    ctx.font = T(L.cn.size, 400, F_SANS);
    ctx.fillStyle = P.colCn;
    shadow();
    L.cn.lines.forEach((ln, i) => {
      ctx.fillText(ln, L.textX, L.textTop + L.cn.y + i * L.cn.lh + L.cn.size * 0.86);
    });
    ctx.restore();
  }

  /* 出处：紧跟在句子下面 */
  if (L.source.on) {
    ctx.save();
    ctx.font = T(L.source.size, 500, F_SANS);
    ctx.fillStyle = P.colSource;
    shadow();
    ctx.fillText('—— ' + L.source.text, L.textX, L.textTop + L.source.y + L.source.size * 0.86);
    ctx.restore();
  }

  /* 日期胶囊画在最后：句子被手动放大溢出时也不会把它盖住。
     标准版固定在中部区域顶部靠右，长版与标题同行（坐标为画布绝对值） */
  if (L.date && L.date.on) {
    const label = state.content.date;
    /* 字号 / 字距 / 内边距都读版面给的（标准版与长版都会随 2 区的交互缩放变化） */
    const dk = L.date.k == null ? 1 : L.date.k;
    const dsz = L.date.size == null ? 25 : L.date.size;
    ctx.font = T(dsz, 600, F_SANS);
    const pw = L.date.w;
    const ph = L.date.h;
    const px = L.date.x;
    const py = L.date.y;
    ctx.save();
    roundRect(ctx, px, py, pw, ph, ph / 2);
    ctx.fillStyle = P.dateBg;
    ctx.fill();
    ctx.strokeStyle = P.dateBd;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = P.colDate;
    ctx.textBaseline = 'middle';
    drawSpaced(ctx, label, px + 28 * dk, py + ph / 2 + 1, 2.5 * dk);
    ctx.textBaseline = 'alphabetic';
  }

  noShadow();
}

/* --------------------------- 个人信息卡片 --------------------------- */

/* 卡片图内缩系数：绘制时按中心放大 2.5%，把图源最外圈的杂边（顶边深色/彩色像素）
   裁出圆角之外。只影响绘制，不动 fit 状态；换的图内容多样，这个内缩对谁都够用 */
const CARD_IMG_INSET = 1.025;

function drawProfileCard(ctx, L) {
  const c = L.card;

  ctx.save();
  roundRect(ctx, c.x, c.y, c.w, c.h, 18);
  ctx.shadowColor = 'rgba(4,10,22,0.42)';
  ctx.shadowBlur = 46;
  ctx.shadowOffsetY = 20;
  ctx.fillStyle = PAL().profileBg;
  ctx.fill();
  ctx.restore();

  /* 卡内图片走 fit 模型（等比，可被手动调整），不再把识别矩形拉伸填满。
     ⚠ 绘制时按**窗口中心**放大 CARD_IMG_INSET 做微小内缩：fit 的「面积相当」缩放
     会让窗口比识别矩形各边多露出 2~4 图源像素，模板截图白卡上沿的深色杂边
     （2026-09-24 用户真机在浅色主题看到卡片上缘一条黑边）就是这么漏进来的。
     锚点必须是**窗口中心** —— 图比窗口高得多且偏上，按图中心放大反而会让可见
     切片上移、露出更多杂边（实测踩过：2px 杂边变 5px）。窗口中心取样范围向
     中心对称收缩，四边杂边同时被裁掉；只影响海报绘制，不动 fit 状态。 */
  const q = currentFitDraw('card', L);
  if (q) {
    ctx.save();
    roundRect(ctx, c.x, c.y, c.w, c.h, 18);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    const k2 = q.k * CARD_IMG_INSET;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const srcCx = (cx - q.x) / q.k, srcCy = (cy - q.y) / q.k;
    ctx.drawImage(q.base.im, cx - srcCx * k2, cy - srcCy * k2,
      q.base.im.width * k2, q.base.im.height * k2);
    ctx.restore();
  }
}

/* ---------------------- 手动调整（模式与反馈） ---------------------- */

/**
 * 进入手动调整模式：换完图就立刻进来，默认什么都不动
 * ——「当前展示的比例及位置」就是 `fits[target] = {1,0,0}`。
 * 调整期间其它手势全部让路（长按保存 / 下拉更新 / 点句子 / 双击删除），
 * 退出方式只有一个：点被调区域以外的地方。
 */
function startEdit(target) {
  if (target === 'img' && !state.bgImage) return;
  if (target === 'card' && !state.template) return;
  state.edit = { target, moved: false };
  const what = target === 'img' ? '图片' : '卡片';
  /* 换行位置写死在前半句之后（样式是 pre-line），免得窄屏把「换一张」拦腰断 */
  showHint('调' + what + '：双指缩放 · 单指拖动\n点' + what + '换一张 · 点别处完成', true);
  scheduleRender();
}

/** 退出调整模式并收起常驻提示 */
function finishEdit() {
  if (!state.edit) return;
  state.edit = null;
  hideHint(true);
  scheduleRender();
}

const EDIT_DIM = 'rgba(6, 10, 18, 0.62)';   /* 窗口外的压暗（与用户选定的 62% 一致） */
const EDIT_RADIUS_U = 18;                    /* 窗口圆角（设计值）= 海报里信息卡的圆角 */
let editWin = null;      /* 本次调整的窗口（层内 CSS px）：{ x, y, w, h, r }，命中判定与回归都用它 */

/**
 * 换图调整层：**原海报完全不动**，弹出的不透明层里只有居中的换图区与这张图。
 *
 * 窗口内清晰、窗口外是同一张图半透明压暗后的其余部分（拖动 / 缩放的引导）；
 * 窗口与压暗都由本函数画在 #editCvs 上，**没有任何描边 / 虚线** ——
 * 亮暗交界就是这块区域的边界（用户明确要求）。
 *
 * 为什么窗口尺寸 = 该区设计尺寸 × 海报显示比例 s：
 *   ① 于是窗口在屏幕上的大小与海报里那块一模一样（用户要的「尺寸不变」）；
 *   ② pxToCanvas()（= CW / posterRect.width）的手势灵敏度自动保持正确；
 *   ③ fit 数学与 commitFit() 一行都不用改。
 *
 * 由 render() 末尾调用（沿用「单一落点 render()」）；海报照常渲染在弹层后面，
 * 不可见但保证 inspect() / bgDraw 状态永远最新，退出时无需补画。
 */
function drawEditPreview(L) {
  const layer = $('editLayer');
  const ecvs = $('editCvs');
  if (!layer || !ecvs) return;

  if (!state.edit) {
    editWin = null;
    if (!layer.hidden) {
      /* 退出硬切：留着淡出会与底层海报的切换打架 */
      layer.classList.remove('on');
      layer.hidden = true;
    }
    return;
  }

  /* 弹层是 inset:0 的 fixed，尺寸就是视口；不能量 layer.clientWidth ——
     它是 hidden（display:none）时恒为 0，会变成「量不到尺寸就不显示」的自锁 */
  const W = document.documentElement.clientWidth || window.innerWidth;
  const H = document.documentElement.clientHeight || window.innerHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(W * dpr);
  const bh = Math.round(H * dpr);
  if (ecvs.width !== bw || ecvs.height !== bh) {
    ecvs.width = bw;          /* 赋值会重置上下文状态，所以缩放变换下面才设 */
    ecvs.height = bh;
  }
  const ctx = ecvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   /* 之后的坐标就是 CSS px */
  ctx.clearRect(0, 0, W, H);

  /* 窗口：该区设计尺寸 × s，在层里水平 / 垂直都居中；圆角与信息卡一致 */
  const box = fitBox(state.edit.target, L);
  const s = cvs.getBoundingClientRect().width / CW;
  const winW = box.w * s;
  const winH = box.h * s;
  const winX = (W - winW) / 2;
  const winY = (H - winH) / 2;
  const R = EDIT_RADIUS_U * s;
  editWin = { x: winX, y: winY, w: winW, h: winH, r: R };

  /* 整幅不裁切地画这张图：窗口内外都看得见（窗口外那一圈就是拖动 / 缩放的引导） */
  const base = fitBase(state.edit.target, L);
  if (base) {
    const d = fitDraw(base, state.fits[state.edit.target]);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base.im,
      winX + (d.x - box.x) * s, winY + (d.y - box.y) * s, d.w * s, d.h * s);
  }

  /* 压暗：整层矩形 + 窗口圆角矩形 一起 evenodd 填充 → 窗口内清晰、窗口外半透明 */
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  roundRectPath(ctx, winX, winY, winW, winH, R);
  ctx.fillStyle = EDIT_DIM;
  ctx.fill('evenodd');

  if (layer.hidden) {
    layer.hidden = false;
    /* 下一帧再加 .on：否则首帧就带着终态，看不到淡入 */
    requestAnimationFrame(() => layer.classList.add('on'));
  } else {
    layer.classList.add('on');
  }
}

/* --------------------------- 单词卡片 --------------------------- */

function drawWordCard(ctx, L) {
  const P = L.panel;
  if (P.hidden || P.h <= 0) return;
  const C = PAL();           /* 卡面各色随主题（卡底四套都近白，词性色标共用不变） */
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
  ctx.fillStyle = C.cardBg;
  ctx.fillRect(P.x, P.y, P.w, P.h);
  ctx.restore();

  ctx.save();
  roundRect(ctx, P.x, P.y, P.w, P.h, R);
  ctx.shadowColor = 'rgba(4,10,22,0.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.strokeStyle = C.cardBd;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  /* 左侧强调竖条 */
  ctx.save();
  const barH = Math.min(P.h - P.padY * 2, P.row1H + 22);
  const g = ctx.createLinearGradient(0, P.y + P.padY, 0, P.y + P.padY + barH);
  g.addColorStop(0, C.accentA);
  g.addColorStop(1, C.accentB);
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
  ctx.fillStyle = C.cardWord;
  const baseline1 = y + P.wordSize * 0.94;
  ctx.fillText(word, x0, baseline1);
  const ww = ctx.measureText(word).width;

  const phs = phoneticList();
  if (phs.length) {
    ctx.font = T(P.phDrawSize || P.phSize, 400, F_MONO);
    ctx.fillStyle = C.cardPh;
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
      const col = POS_COLOR[it.pos] || C.cardChip;
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
    ctx.fillStyle = C.cardDef;
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
      ctx.fillStyle = C.cardExBar;
      roundRect(ctx, x0, y + 6, 4, ex.h - 14, 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.font = T(ex.enSize, 400, F_SANS);
      ctx.fillStyle = C.cardExEn;
      ex.enLines.forEach((ln, i) => ctx.fillText(ln, x0 + 24, y + i * ex.enSize * 1.5 + ex.enSize * 0.86));
      let yy = y + ex.enLines.length * ex.enSize * 1.5;
      ctx.font = T(ex.cnSize, 400, F_SANS);
      ctx.fillStyle = C.cardExCn;
      ex.cnLines.forEach((ln, i) => ctx.fillText(ln, x0 + 24, yy + i * ex.cnSize * 1.55 + ex.cnSize * 0.86));
      ctx.restore();
      y += ex.h + 16;
    }
  }

  drawBadge(ctx, P);
}

/** 卡片右下角的小圆标：一个加圈的字，说明关键词 / 释义不是上游今天给的内容 */
function drawBadge(ctx, P) {
  const b = P.badge;
  if (!b) return;
  const cx = Math.round(P.x + P.w - BADGE_MX - BADGE_D / 2);
  const cy = Math.round(P.y + P.h - BADGE_MY - BADGE_D / 2);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, BADGE_D / 2, 0, Math.PI * 2);
  ctx.fillStyle = b.bg;
  ctx.fill();
  ctx.strokeStyle = b.bd;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = T(BADGE_FS, 600, F_SANS);
  ctx.fillStyle = b.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.ch, cx, cy + 1);
  ctx.restore();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ============================== 交互 ================================ */

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = requestAnimationFrame(() => {
    renderTimer = null;
    render();
  });
}

/** 进入页面时的背景比例：?bg= 优先，其次按版本取默认（标准版铺满，长版维持原比例） */
function initialBgStyle() {
  const bg = QS.get('bg');
  if (bg === 'cover') return 'cover';
  if (bg === 'natural' || bg === 'band' || bg === 'card') return 'natural';  /* 旧参数归入原比例 */
  return state.opts.longPoster ? 'natural' : DEFAULT_BG;
}

/** 昨天（本地时区）—— 用于「日期胶囊单击切到昨日存档」 */
function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 今日 ⇄ 昨日（服务端存档）来回切。
 * 昨日没抓过存档时 loadDaily 会 toast 报错并保持原内容，
 * 所以这里用「apiData 是否换了引用」判断有没有切成功，再补一句人话。
 */
async function toggleDay() {
  state.lastToggleAt = Date.now();     /* 回归可断言「这次点击确实被识别成单击」 */
  const iso = yesterdayISO();
  if (state.viewDate) {                 /* 正在看往日 → 回今天 */
    await loadDaily(false);
    toast('已回到今天');
    return;
  }
  const before = state.apiData;
  await loadDaily(false, iso);
  if (state.apiData === before) return; /* 没换成：loadDaily 已经提示过原因 */
  if (state.viewDate === iso) toast('正在看 ' + dateLabel(iso) + ' 的存档');
  else toast('还没有 ' + dateLabel(iso) + ' 的存档');
}

/**
 * 回到「刚打开这个页面」的状态：隐藏清空、缩放归位、背景比例回默认、
 * 配图与信息卡模板恢复默认，再重新取一次当日内容。
 *
 * 顶栏「重新获取」与首次启动（boot）走同一条路径 —— 免得两套初始化逻辑各自演化。
 * refetch = true 时跳过缓存重新抓上游。
 */
async function resetToInitial(refetch) {
  closeSaveSheet();                         /* 保存浮层不算「初始状态」，一并收起 */
  stopVoice('reset');                       /* 播放态也一样：停播 + 收波形 */
  state.edit = null;                        /* 调整模式也不是「初始状态」 */
  state.fits = { img: { scale: 1, ox: 0, oy: 0 }, card: { scale: 1, ox: 0, oy: 0 } };
  state.hidden = { date: false, en: false, cn: false, source: false };
  state.fx = defaultFx();                   /* 四个文字区都回到设计基准字号 */
  _fitCacheKey = '';                        /* 让保底倍率重新量测 */
  state.opts.bgStyle = initialBgStyle();
  state.ratios = { ...DEFAULT_RATIOS };
  try {
    await loadTemplate('assets/template.jpg');
  } catch (e) { /* 模板加载失败就沿用默认比例 */ }
  await loadDaily(!!refetch);
  scheduleRender();
}

/* ===================== 摇一摇换配色（2026-09-24） =====================
   四套主题循环切换的**唯一入口**（桌面没有加速度计摇不了，预览与回归走 ?theme=）。
   iOS 规则：未授权时 devicemotion 事件一个都收不到，且 requestPermission 必须由
   用户手势触发 —— 「首次摇 → 提示」在授权前根本探测不到，所以收敛为：
   第一次按下海报时顺带请求权限（系统弹窗），拒绝就静默放弃，绝不反复打扰。
   摇动判定：先对加速度做**低通估计重力向量**，取线性加速度（加速度 − 重力）的幅值，
   > SHAKE_LIN_G 记一次「越峰」，SHAKE_PEAK_MS 内累计两次越峰才算一次摇（单次挥手/
   走路的抖动不够）。用线性加速度而不是「含重力幅值的差」是刻意取舍：摇动主要是
   **方向翻转**（+x 推 / −x 拉），含重力的总幅值对两者几乎一样大，判不出来；
   而低通让缓慢的倾斜 / 走路被滤掉，只有真甩动才有大的线性加速度。
   触发后 SHAKE_COOLDOWN_MS 冷却，防止一次长摇连切好几档。
   只在空闲态生效：语音播放独占态 / 编辑调整态 / 导出页一律忽略 —— 不打断进行中的交互。 */

const SHAKE_LIN_G = 12;        // 线性加速度幅值阈值（m/s²）：真甩动 15~30，走路 <3
const SHAKE_PEAK_MS = 600;     // 两次越峰的最大间隔
const SHAKE_COOLDOWN_MS = 900; // 触发一次后的冷却
const SHAKE_G_ALPHA = 0.15;    // 重力低通系数：越小越「信历史」，甩动越容易被当作线性加速度
const SHAKE_PERM_RETRY_MS = 60000; // 授权未拿到 granted 时的重试冷却（iOS 对已拒站点静默返回，不刷弹窗）

let shakePermAsked = false;    // iOS 授权是否已经**拿到 granted**（拿到就不再问）
let shakePermLastTry = 0;      // 上一次请求尝试的时间戳：非 granted 时 60s 冷却后再试
/* 授权自证（2026-09-24 真机踩坑后加）：真机「弹窗不出现」不用再猜 ——
   state 记录请求结果（granted / denied / error / 空串 = 还没问过），
   errName 是被拒/出错时的异常名。inspect().shakeDiag 与 ?diag=1 都透出。 */
const shakeDiag = { asked: false, state: '', errName: '', at: 0 };
let shakeG = { x: 0, y: 0, z: 0 };  // 重力估计（低通）
let shakeGInit = false;        // 首个采样直接当重力（不做低通），避免开机误判
let shakeLastPeakAt = 0;       // 上一次越峰时间
let shakePeaks = 0;            // 窗口内累计越峰数
let shakeLastFireAt = 0;       // 上一次真正切换主题的时间
let shakeBound = false;

/** 摇一摇只认空闲态：任何独占/调整流程都不被打断 */
function shakeIdle() {
  return !state.voice && !state.edit && !document.body.classList.contains('raw');
}

function onShake() {
  if (!shakeIdle()) return;
  const now = Date.now();
  if (now - shakeLastFireAt < SHAKE_COOLDOWN_MS) return;
  const i = THEME_ORDER.indexOf(state.theme);
  const next = THEME_ORDER[(i + 1) % THEME_ORDER.length];
  shakeLastFireAt = now;
  applyTheme(next);            // save 默认 true：摇出来的选择写入 localStorage 记忆
  toast('配色 · ' + THEMES[next].name);
}

function bindShake() {
  if (shakeBound) return;
  shakeBound = true;
  /* iOS：requestPermission 必须发生在**用户手势**里。
     ⚠ 必须挂在**收尾事件**（pointerup）上 —— 真机踩过的坑：挂在 pointerdown（手势
     开始）时 iOS 不认它是有效手势，Promise 直接 reject（NotAllowedError），系统弹窗
     一次都不会出现。桌面 Chrome 的 DeviceMotionEvent 没有 requestPermission，
     走不到这支；结果无论成败都落 shakeDiag（真机 ?diag=1 可读）。 */
  window.addEventListener('pointerup', (e) => {
    if (shakePermAsked) return;
    if (Date.now() - shakePermLastTry < SHAKE_PERM_RETRY_MS) return;   // 未授权时的重试冷却
    if (e.pointerType && e.pointerType !== 'touch') return;   /* 桌面鼠标/触控板不触发授权 */
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      shakePermLastTry = Date.now();
      DME.requestPermission().then((res) => {
        shakeDiag.asked = true;
        shakeDiag.state = res === 'granted' ? 'granted' : 'denied';
        shakeDiag.at = Date.now();
        if (res === 'granted') {
          shakePermAsked = true;   // 只有拿到授权才停止请求；「弹窗未选而消失」可在下次点击自愈
        } else {
          toast('摇一摇未获权限，将无法换配色');   // 拒绝也不再无声；60s 后的点按仍可再试（iOS 静默返回，不会反复弹）
        }
      }).catch((err) => {
        shakeDiag.asked = true;
        shakeDiag.state = 'error';
        shakeDiag.errName = (err && err.name) || String(err);
        shakeDiag.at = Date.now();
        toast('摇一摇未获权限，将无法换配色');
      });
    }
  }, { capture: true });
  window.addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (!shakeGInit) {         // 首个采样直接当重力
      shakeG = { x: a.x, y: a.y, z: a.z };
      shakeGInit = true;
      return;
    }
    const g = shakeG;
    g.x = g.x * (1 - SHAKE_G_ALPHA) + a.x * SHAKE_G_ALPHA;
    g.y = g.y * (1 - SHAKE_G_ALPHA) + a.y * SHAKE_G_ALPHA;
    g.z = g.z * (1 - SHAKE_G_ALPHA) + a.z * SHAKE_G_ALPHA;
    const lx = a.x - g.x, ly = a.y - g.y, lz = a.z - g.z;
    const mag = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (mag <= SHAKE_LIN_G) return;
    const now = Date.now();
    if (now - shakeLastPeakAt <= SHAKE_PEAK_MS) shakePeaks += 1;
    else shakePeaks = 1;
    shakeLastPeakAt = now;
    if (shakePeaks >= 2) {
      shakePeaks = 0;
      onShake();
    }
  });
}

/** 两个相册选图入口（界面上没有按钮了，都靠单击海报上的图片 / 卡片触发） */
function bindInputs() {
  /* 相册选图：顶部图片。换完立刻进调整模式（默认比例与位置 = 刚换上的样子） */
  $('fBgImage').addEventListener('change', async (e) => {
    const im = await readPickedImage(e);
    if (!im) return;
    state.bgImage = im;
    state.fits.img = { scale: 1, ox: 0, oy: 0 };
    scheduleRender();
    startEdit('img');
  });

  /* 相册选图：信息卡（自动识别只决定从这张图里抠哪一块） */
  $('fCardImage').addEventListener('change', async (e) => {
    const im = await readPickedImage(e);
    if (!im) return;
    state.template = im;
    try {
      detectCard(im);
    } catch (err) {
      state.ratios = { ...DEFAULT_RATIOS };
      toast('信息卡识别失败，已按默认比例裁切');
    }
    state.fits.card = { scale: 1, ox: 0, oy: 0 };
    scheduleRender();
    startEdit('card');
  });

  bindGestures();
}

/* ===================== 语音独占层（波形即停止按钮，2026-09-22） =====================
   点 3 区（英文句 en）朗读后，在 3 区「升起」一段波形动画 —— 播放期间**只有它可点**，
   点它就停、波形消失、交互恢复。中英文句子透过波形仍要能读出来，所以：
     ① **只有竖条、没有任何底板**（2026-09-22 去掉原来的 34% 深色底），且绝不 backdrop-filter
        （一模糊就把字糊掉了，见 styles.css）；竖条自带极淡投影，亮背景上也看得见；
     ② 竖条细、间距大、振幅收在 45%–85%（约 20% 横向覆盖率），不横穿字形；
     ③ **宽度固定 = 正文列宽 × 90%**（不随句子长短变，每天都一样宽），在正文列内水平居中。
   波形层是 DOM 浮层，**绝不画进 canvas** —— 否则长按另存的 1080×1920 成品会被污染。

   ⚠ 「波形何时升降」只听**音频元素自己的事件**（playing / pause / ended / error / emptied）
   + 进度看门狗，**绝不再听 `play()` 的 Promise**：iOS 上那个 Promise 有不 settle 的情形，
   靠它把关就会出现「有声音没波形」；反过来它先 resolve 而真出声被吞掉，就出现「有波形没声音」。 */

let activeAudio = null;      // 当前播放的音频元素（旧实现不留引用 → 根本停不下来）
let voiceTimer = null;       // 硬上限计时器：min(20s, 时长 + 1500ms)
let voiceWatch = null;       // 进度看门狗：500ms 一跳，paused 或 currentTime 停滞即收
let voiceHooks = null;       // 挂在音频上的事件回调集合（停止时整体摘掉，避免复用元素时串场）
let waveHideTimer = null;    // 退场淡出后再真正 hidden

const WAVE_W_RATIO = 0.9;    // 波形宽度 = 正文列宽 × 90%（用户定：比文字区域窄 10%）
const WAVE_ALIGN_LIMIT = 0.1; // 波形中心相对列中心的最大偏移（列宽的 10%）：按 3 区文字框居中，但不许偏出
const WAVE_PAD_Y = 12;       // 竖向相对 3 区框的外扩上限（设计值）
const WAVE_BAR_W = 9;        // 竖条宽（设计值）
const WAVE_BAR_GAP = 36;     // 竖条间距（设计值）→ 横向覆盖率约 20%，不遮笔画
const VOICE_STALL_MS = 1500; // 看门狗判定「卡死」的阈值：这么久 currentTime 不前进就收
const VOICE_TICK_MS = 500;   // 看门狗检查间隔
const VOICE_KICK_MS = 1500;  // play() 迟迟没换来 playing 时「踢一下」的等待（见 speak）
const VOICE_RETRY_MS = 400;  // play() 被拒 / 被打断后自动重试一次前的等待

/** 波形横向基准：正文列宽（左右各 TEXT_X 的正文区）。列宽天天一样，波形宽度也就天天一样 */
function waveColumnW() {
  return CW - 2 * TEXT_X;
}

/**
 * 波形层要盖的画布框（设计坐标）。3 区被删掉 / 还没渲染时返回 null（那就不显示波形）。
 *
 * 横向：宽度恒为**正文列宽 × 90%**（不跟着 `en.w` 变 —— 句子短的时候那样会缩成一小截，
 * 竖条数量都不够）；居中基准是 **3 区文字框的中心**（不是整列）—— 正文是左对齐、右侧参差，
 * 按整列居中会「左边空得多、右边空得少」（2026-09-22 用户指出，实测 49 对 24）。
 * 为避免短句时波形被推得偏出正文列，中心相对列中心的偏移**夹在 ±10% 列宽内**：
 * 正常句子完全按文字框对称，句子很短时才退化成列居中。
 * 竖向：以 3 区框为准，上下各外扩最多 12 设计值，但还要再受「邻居留给我的空间」约束
 * （最多各吃 40%）—— 英文句与中文句 / 日期胶囊的间距随当天内容变化，固定外扩在某些天会顶到
 * 它们，而「波形只盖 3 区」是硬要求（回归里钉着）。
 */
function voiceBox() {
  const regions = state.regions || [];
  const en = regions.find((it) => it.id === 'en');
  if (!en) return null;
  const cn = regions.find((it) => it.id === 'cn');
  const date = regions.find((it) => it.id === 'badge-date');
  const roomBelow = cn ? Math.max(0, cn.y - (en.y + en.h)) : WAVE_PAD_Y * 4;
  const roomAbove = date ? Math.max(0, en.y - (date.y + date.h)) : WAVE_PAD_Y * 4;
  const padTop = Math.min(WAVE_PAD_Y, roomAbove * 0.4);
  const padBottom = Math.min(WAVE_PAD_Y, roomBelow * 0.4);
  const colW = waveColumnW();
  const w = colW * WAVE_W_RATIO;
  const limit = colW * WAVE_ALIGN_LIMIT;                 /* 允许偏离列中心的最大量 */
  const colCenter = TEXT_X + colW / 2;
  const inkCenter = en.x + en.w / 2;                     /* 3 区文字框（就是句子最长那行）的中心 */
  const center = Math.min(colCenter + limit, Math.max(colCenter - limit, inkCenter));
  return {
    x: center - w / 2,
    y: en.y - padTop,
    w,
    h: en.h + padTop + padBottom,
  };
}

/**
 * 建竖条：数量按**波形宽度**（正文列宽 × 90%）定，高低 / 周期 / 相位用**确定性函数**算
 * —— 每次播放长得一样，截图与回归可复现，也不用 Math.random。
 */
function buildWaveBars(box) {
  const host = $('waveBars');
  if (!host || host.childElementCount) return;
  const n = Math.max(8, Math.round(box.w / (WAVE_BAR_W + WAVE_BAR_GAP)));
  for (let i = 0; i < n; i++) {
    const bar = document.createElement('i');
    /* 两条不同频率的正弦叠加 → 高低错落但不重复；振幅压在 0.45–0.85（用户要求「不可太突兀」） */
    const k = (Math.sin(i * 1.7) + 0.7 * Math.sin(i * 0.63 + 1.1)) / 1.7;     /* -1 … 1 */
    const h1 = Math.min(0.85, Math.max(0.45, 0.62 + 0.22 * k));
    const h0 = 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(i * 2.3 + 0.4));
    bar.style.setProperty('--h1', h1.toFixed(3));
    bar.style.setProperty('--h0', h0.toFixed(3));
    bar.style.setProperty('--t', (900 + Math.round(520 * (0.5 + 0.5 * Math.sin(i * 1.13)))) + 'ms');
    bar.style.setProperty('--d', Math.round(680 * (0.5 + 0.5 * Math.sin(i * 0.87 + 2))) + 'ms');
    host.appendChild(bar);
  }
}

/** 把波形层钉到 3 区上（画布框 → 屏幕坐标）；显示时与视口变化后各调一次，稳态零开销 */
function layoutWave() {
  const el = $('wave');
  const box = voiceBox();
  if (!el || !box) return;
  const rect = cvs.getBoundingClientRect();
  const s = rect.width / CW;
  el.style.left = Math.round(rect.left + box.x * s) + 'px';
  el.style.top = Math.round(rect.top + box.y * s) + 'px';
  el.style.width = Math.round(box.w * s) + 'px';
  el.style.height = Math.round(box.h * s) + 'px';
  /* 条宽与间距也跟着显示比例缩放，换屏幕 / 换方向都不会变形 */
  el.style.setProperty('--wave-w', Math.max(2, WAVE_BAR_W * s).toFixed(2) + 'px');
  el.style.setProperty('--wave-gap', Math.max(6, WAVE_BAR_GAP * s).toFixed(2) + 'px');
  buildWaveBars(box);
}

/** 屏幕坐标是否落在波形框内（用面板自身的 rect，与看到的完全一致） */
function inWave(clientX, clientY) {
  const el = $('wave');
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function showWave() {
  const el = $('wave');
  if (!el) return;
  clearTimeout(waveHideTimer);
  layoutWave();
  el.hidden = false;
  /* 下一帧再加 .show：否则首帧就带着终态，看不到「由下升起」那一下 */
  requestAnimationFrame(() => el.classList.add('show'));
}

/** 收起波形：先淡出（CSS transition），淡完再 hidden，避免占位与误判命中 */
function hideWave() {
  const el = $('wave');
  if (!el || el.hidden) return;
  el.classList.remove('show');
  clearTimeout(waveHideTimer);
  waveHideTimer = setTimeout(() => { el.hidden = true; }, 260);
}

/**
 * 开始独占：建立播放态、升起波形、装进度看门狗。
 * **只在音频真的开始出声时调用**（由 `playing` 事件触发，见 speak()）；
 * 回归与截图也可以直接调它 —— 不传 audio 就只显示波形（不装看门狗）。
 */
function playVoice(audio) {
  const box = voiceBox();
  if (!box) return;                          /* 3 区不在了，没有可盖的地方 */
  state.voice = { target: 'en', style: 'bars', startedAt: Date.now() };
  state.voiceDiag.playedFrom = state.voice.startedAt;
  showWave();
  clearTimeout(voiceTimer);
  clearInterval(voiceWatch);
  /* 硬上限：就算所有事件都没来（元素被系统吞掉），也不会把人困在独占态太久 */
  const dur = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  voiceTimer = setTimeout(() => stopVoice('timeout'), Math.min(20000, (dur ? dur * 1000 : 6000) + 1500));
  /* 进度看门狗：音频「被暂停 / 卡死」时不一定会派发 ended，靠它兜住 ——
     这正是「播一会儿就停了、波形还挂着」的根因（旧实现只有兜底计时器，最长要等 20s）。 */
  if (audio) {
    let lastT = -1;
    let lastAt = Date.now();
    voiceWatch = setInterval(() => {
      let t = -1;
      let paused = true;
      try { t = audio.currentTime; paused = !!audio.paused; } catch (e) { paused = true; }
      if (paused) { stopVoice('paused'); return; }                    /* 停了却没事件：收 */
      if (t > lastT + 0.05) { lastT = t; lastAt = Date.now(); return; } /* 还在走：续命 */
      if (Date.now() - lastAt > VOICE_STALL_MS) stopVoice('stalled');   /* 时间不走了：收 */
    }, VOICE_TICK_MS);
  }
}

/**
 * 停止播放并收掉波形 —— 唯一出口（点波形 / 播完 / 被暂停 / 出错 / 卡死 / 超时 / 复位都走这里）。
 * reason 只用于自查与回归（落进 `state.voiceDiag.lastReason`），不参与任何逻辑。
 */
function stopVoice(reason) {
  clearTimeout(voiceTimer);
  voiceTimer = null;
  clearTimeout(voiceRetryTimer);       /* 收尾时连带取消「自动重试 / 踢一下」，免得复位后又冒一次播放 */
  voiceRetryTimer = null;
  clearInterval(voiceWatch);
  voiceWatch = null;
  const a = activeAudio;
  if (a) {
    /* ⚠ 先摘监听、再 pause：否则自己这一次 pause 会再触发一遍收尾（虽然幂等，但会写脏 reason） */
    if (voiceHooks) {
      try {
        for (const [ev, fn] of voiceHooks) a.removeEventListener(ev, fn);
      } catch (e) { /* 老元素已释放，忽略 */ }
      voiceHooks = null;
    }
    try { a.pause(); a.currentTime = 0; } catch (e) { /* 同上 */ }
  }
  if (!state.voice) { hideWave(); return; }   /* 幂等：没在独占时被调用也无害 */
  const now = Date.now();
  state.voiceDiag.lastReason = reason || 'stop';
  state.voiceDiag.lastAt = now;
  state.voiceDiag.playedMs = Math.max(0, now - (state.voiceDiag.playedFrom || now));
  state.voice = null;
  state.lastVoiceStopAt = now;
  hideWave();
}

/** 今天有没有可用的发音文件（没有就别解锁、别出波形） */
function hasAudio() {
  return !!(state.apiData && state.apiData.audio && state.apiData.audio.normal);
}

let preloadEl = null;        // 预热用的音频元素（留引用，别让 GC 提前回收它）
let primeSilent = null;      // 手势解锁用的静音元素（同上）
let silentUri = '';          // 静音 WAV 的 data URI（懒生成一次）
let voiceRetryTimer = null;  // 「自动重试一次」的定时器（stopVoice 里必清）

/**
 * 造一个 0.1 秒静音 WAV 的 data URI（运行时生成，不塞一长串 base64）。
 * 用途见 primeAudio()：**在用户手势里播一段本地静音片段**，无网络、瞬间可播，
 * 保证「手势里确实播过东西」这一步必定成功 —— 老 WebView 对这一步很挑剔，
 * 拿远端 mp3 去解锁会被网络拖住。
 */
function silentAudioUri() {
  if (silentUri) return silentUri;
  const rate = 8000;
  const n = Math.round(rate * 0.1);            /* 0.1 秒足够，别做长了白占内存 */
  const b = new Uint8Array(44 + n);
  const dv = new DataView(b.buffer);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  put(36, 'data'); dv.setUint32(40, n, true); b.fill(0x80, 44);   /* 8bit 无符号，0x80 = 静音 */
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  silentUri = 'data:audio/wav;base64,' + btoa(s);
  return silentUri;
}

/**
 * 预热发音文件（daily 数据一到手就调，见 loadDaily）：只是把 mp3 提前抓进 HTTP 缓存，
 * 不播、不出波形。**冷启动第一次点英文句失败的主因就是它没预热**：
 * primeAudio 那次 play() 要等网络，而 300ms 后的 speak() 又会去打断它（AbortError）。
 *
 * ⚠ 用媒体元素自身的加载器（`preload` + `load()`），**不要用 fetch** ——
 * 跨域音频用 fetch 会被 CORS 拦下，媒体元素不受这个限制。
 */
function preloadAudio() {
  const url = state.apiData && state.apiData.audio && state.apiData.audio.normal;
  if (!url) { preloadEl = null; return; }
  try {
    if (preloadEl && preloadEl.src === url) return;   /* 同一份音频已在预热 */
    const a = new Audio(url);
    a.preload = 'auto';
    a.volume = 0;                                     /* 保险：万一被播到也不出声 */
    try { a.load(); } catch (e) { /* 忽略 */ }
    preloadEl = a;
  } catch (e) { /* 预热失败不影响点读，只是首点可能慢一点 */ }
}

/**
 * 朗读今日句子；audio 传进来时复用它（iOS 必须在手势调用栈里先解锁）。
 *
 * ⚠ **波形只由音频事件驱动**：`playing` 才升起（真出声才升）、
 * `pause` / `ended` / `error` / `emptied` 立刻收起。`play()` 返回的 Promise
 * 只用来报「播不出来」，**绝不用来决定波形出现** —— iOS 上那个 Promise 有
 * 迟迟不 settle 的情形（音频会话被抢 / 被系统中断），靠它把关就会出现
 * 「听到声音没波形」；反过来它先 resolve 而真出声被吞掉，就会出现「有波形没声音」。
 */
function speak(audio) {
  const url = state.apiData && state.apiData.audio && state.apiData.audio.normal;
  if (!url) {
    toast('没有可用发音');                 /* 没有音频文件：不出波形、不留任何播放态 */
    return null;
  }
  stopVoice('restart');                    /* 上一次没停就先停，绝不叠加播放 */
  const a = audio && audio.src ? audio : new Audio(url);
  a.__dsTaken = true;                      /* 接管：primeAudio 的复位逻辑从此不再碰这个元素 */
  activeAudio = a;
  state.lastSpeakAt = Date.now();
  state.voiceDiag = {
    lastReason: '', lastAt: 0, playedMs: 0, dur: 0, url, playedFrom: 0, errName: '', retries: 0,
  };

  /* ⚠ **绝不打断「还挂着的 play」**：prime 那次 play() 要等网络把 mp3 抓够才 settle，
     此时对它 pause 会被浏览器以 `AbortError: The play() request was interrupted by a call
     to pause()` 打断 —— 这正是「冷启动第一次点总失败、等一会儿再点就行」的根因
     （那时 mp3 已进 HTTP 缓存、play 立刻 settle）。所以按「是否已在播 / play 是否还没 settle」
     分两条路：挂着就只 seek（seek 不会打断 play），确实停了才 pause + 重播。
     音量复位两条路都要做 —— 少了它就是「有波形没声音」。 */
  const pending = !!a.__dsPlayPending || a.paused === false;
  try {
    a.muted = false;
    a.volume = 1;
    if (pending) {
      try { a.currentTime = 0; } catch (e) { /* 数据还没到就设不动，无妨（本来也是从头播） */ }
    } else {
      try { a.pause(); a.currentTime = 0; } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }

  const hooks = [
    ['playing', () => { state.voiceDiag.dur = isFinite(a.duration) ? a.duration : 0; playVoice(a); }],
    ['ended', () => stopVoice('ended')],
    ['error', () => { toast('发音播放失败'); stopVoice('error'); }],
    ['emptied', () => stopVoice('emptied')],
    ['pause', () => stopVoice('pause')],
  ];
  voiceHooks = hooks;
  for (const h of hooks) a.addEventListener(h[0], h[1]);

  /** 这次播放彻底失败：记下错误名（真机自证用）后收尾 */
  const fail = (err) => {
    state.voiceDiag.errName = (err && err.name) || 'Error';
    toast('发音播放失败');
    stopVoice('play-rejected');
  };
  /** 再 play 一次（自动重试 / 「踢一下」共用）：已经出声或已收尾就不动，幂等无害 */
  const kick = () => {
    if (state.voice || state.voiceDiag.lastReason) return;
    const p2 = a.play();
    if (p2 && p2.catch) p2.catch(fail);
  };

  if (pending) {
    /* 复用的 prime 元素已经 play 过了，只等它出声；但有些环境 play() 的 Promise 迟迟不 settle，
       1.5s 后「踢一下」（再调一次 play()）能把它唤醒 —— 幂等，不会叠加播放 */
    voiceRetryTimer = setTimeout(kick, VOICE_KICK_MS);
  } else {
    const p = a.play();
    if (p && p.then) {
      p.catch((err) => {
        /* 被拒（NotAllowedError）/ 被中断（AbortError）：自动重试一次 —— 此时预热多半已就绪、
           页面也已有用户手势激活，八成就起来了；仍失败才提示并收尾 */
        if (state.voiceDiag.retries < 1) {
          state.voiceDiag.retries = 1;
          voiceRetryTimer = setTimeout(kick, VOICE_RETRY_MS);
          return;
        }
        fail(err);
      });
    } else {
      voiceRetryTimer = setTimeout(kick, VOICE_KICK_MS);   /* 老浏览器不返回 Promise */
    }
  }
  return a;
}

/**
 * 在用户手势的同步调用栈里解锁音频元素（iOS 只认这一步）。
 * 先静音播一下就暂停 —— 既完成解锁，又不会真的发出声音；
 * 300ms 后确认是单击时再由 speak() 接管这个元素正式播放。
 *
 * ⚠ 复位（restore）**必须在元素被正式播放接管后放弃动手**：旧实现把 restore 挂在
 * play() 的 Promise 上，Promise 一 reject 就完全跳过 → 元素停不下来、volume 留在 0，
 * 于是复用它的正式播放「有波形没声音」；反过来 restore 晚到，又会把刚起播的音频按停 ——
 * 即「播一会儿就停了，但波形还在显示」。用 `__dsTaken` 标记一次解决两条路径。
 */
function primeAudio() {
  if (!hasAudio()) return null;
  /* ① 本地静音片段：无网络、瞬间起播 → 保证「手势里确实播过东西」这一步必定成功。
        老 WebView 对这一步很挑剔，而拿远端 mp3 去解锁会被网络拖住（那正是首点失败的土壤）。 */
  try {
    const s = new Audio(silentAudioUri());
    s.volume = 0;
    const ps = s.play();
    if (ps && ps.catch) ps.catch(() => {});
    primeSilent = s;
  } catch (e) { /* 忽略：这只是保底，失败也不影响下面那条正路 */ }
  try {
    const a = new Audio(state.apiData.audio.normal);
    a.preload = 'auto';
    a.volume = 0;
    a.__dsPlayPending = true;               /* 记下「这次 play 还挂着」——speak() 靠它决定别打断 */
    const p = a.play();
    const settle = () => { a.__dsPlayPending = false; };
    const restore = () => {
      if (a.__dsTaken) return;              /* 已被正式播放接管：绝不插手 */
      try { a.pause(); a.currentTime = 0; a.volume = 1; } catch (e) { /* 忽略 */ }
    };
    if (p && p.then) p.then(settle, settle).then(restore, () => {});
    else { settle(); restore(); }
    return a;
  } catch (e) {
    return null;
  }
}

/** 读取相册选中的图片；解码完立刻释放 objectURL，多次换图也不积累内存 */
async function readPickedImage(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return null;
  const url = URL.createObjectURL(f);
  try {
    return await loadImage(url);
  } catch (err) {
    toast('图片读取失败');
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ==================== 手势：单击选图 / 双击隐藏 / 长按保存 ==================== */

/** 可点区域表：坐标是画布坐标，id 与标注表一致（这样双击时能直接对上元素） */
function buildHitRegions(L) {
  const R = [];
  const tx = L.textX;
  const maxW = CW - 2 * tx;
  const push = (id, x, y, w, h) => {
    if (w > 0 && h > 0) R.push({ id, x, y, w, h });
  };

  /* 标准版：文字元素各自成区，双击各自隐藏、上下拖动即缩放 */
  if (L.source.on) {
    push('source', tx - 16, L.textTop + L.source.y - 12, maxW * 0.72, L.source.size * 1.4 + 20);
  }
  if (L.cn && L.cn.on) {
    push('cn', tx - 16, L.textTop + L.cn.y - 14, maxW + 32,
      L.cn.lines.length * L.cn.lh + 20);
  }
  if (L.en && L.en.on) {
    push('en', tx - 16, L.textTop + L.en.y - 14, maxW + 32,
      L.en.lines.length * L.en.lh + 20);
  }
  if (L.date.on) {
    push('badge-date', L.date.x - 6, L.date.y - 6, L.date.w + 12, L.date.h + 12);
  }

  /* 长版：单词卡按「关键词行 / 释义区」分开命中 */
  if (L.panel && !L.panel.hidden && L.panel.h > 0) {
    const P = L.panel;
    const rowH = P.padY + P.row1H + 12;
    push('word', P.x, P.y, P.w, Math.min(P.h, rowH));
    push('defs', P.x, P.y + rowH, P.w, Math.max(0, P.h - rowH));
  }
  if (L.title) {
    push('word', tx - 16, L.textTop - 12, Math.min(maxW + 32, L.title.size * 6.2), L.title.h + 24);
  }

  /* 信息卡与顶部图片区：单击 = 从相册选图（放最后，别挡住上面的具体元素） */
  push('card', L.card.x, L.card.y, L.card.w, L.card.h);
  if (L.imgBlock) push('img', 0, L.imgBlock.y, CW, L.imgBlock.h);
  return R;
}

/** 画布坐标 → 命中的区域（都没中就是「配图 / 空白」） */
function hitTest(x, y) {
  const regions = state.regions || [];
  for (const r of regions) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

/** 画布坐标 → 屏幕坐标（用于给浮框和引导框定位） */
function toClient(x, y) {
  const rect = cvs.getBoundingClientRect();
  const s = rect.width / CW;
  return { x: rect.left + x * s, y: rect.top + y * s };
}

/* ------------------------------ 手势 ------------------------------ */

const PRESS = { moved: 8, maxMs: 620, holdMs: 520 };

/** 双击能删掉的区域 → 隐藏状态里的键 */
const HIDE_MAP = { 'badge-date': 'date', en: 'en', cn: 'cn', source: 'source' };

/** 上下拖动 = 缩放字号：2/3/4/5 四个文字区都可以（3/4/5 一组联动、2 区独立，见 ZOOM_GROUP） */
const ZOOM_REGIONS = new Set(Object.keys(ZOOM_GROUP));

/** 单击有动作、同时又要保留双击删除的区域 —— 单击要等 300ms 确认不是双击 */
const SINGLE_TAP_REGIONS = new Set(['en', 'cn', 'source', 'badge-date']);

const PULL_MIN = 90;      /* 下拉更新的触发距离（CSS px） */

/**
 * stage 上的手势（界面上没有按钮，全部由这里承载）：
 *   长按任意位置        = 保存到相册
 *   图片 / 信息卡单击   = 从手机相册选图（不定义双击，所以立即响应）
 *   句子 / 日期单击     = 朗读 / 今日⇄昨日切换（等 300ms 确认不是双击）
 *   句子 / 日期双击     = 从海报上删掉它（不可逆，刷新恢复）
 *   句子上上下拖动      = 实时缩放中部字号（上滑放大、下滑缩小）
 *   非句子区向下拉 ≥90  = 回到初始状态（等同重启 App）
 *
 * 调整模式（`state.edit`，换图后自动进入）：上面这些手势**全部让路**，只剩
 *   单指拖动            = 在展示窗口里挪图（把想要的区域露出来）
 *   双指捏合            = 缩放（中点位移同时当平移）
 *   点被调区域以外      = 完成 / 退出
 */
function bindGestures() {
  const stage = $('stage');
  let start = null;
  let holdTimer = null;
  let longFired = false;
  let pickerAt = 0;          /* 刚开过相册的防抖时间戳 */
  let zoomDrag = null;       /* { id, startY, startZoom, active } —— id = 被拖的那个文字区 */
  let pullDrag = null;       /* { startY, armed } */
  let pendingTap = null;     /* { id, timer, audio } —— 单击要等双击确认，只留一个槽 */
  const ptrs = new Map();    /* 调整模式下按下的指针：pointerId → 最新坐标 */
  let pinch = null;          /* { d0, mid0, fit0 } —— 双指捏合的基准 */
  let panLast = null;        /* 单指拖动的上一个位置 */
  let editStart = null;      /* 调整模式下这一下的起点 { x, y, moved } */

  /* 双指扩/捏切版（常态手势）：与调整模式的 ptrs/pinch 完全独立 ——
     调整模式里 pointerdown 提前 return，modePtrs 根本不会记录，互不干扰 */
  const modePtrs = new Map();   /* pointerId → { x, y } */
  let modePinch0 = 0;           /* 两指按下时的初始距离 */
  let modeSwitchFired = false;  /* 这组两指是否已经触发过切换（一组只切一次） */
  let modeSwitchAt = 0;         /* 上一次切换时间（冷却） */

  const clear = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    start = null;
    longFired = false;
  };

  /** 丢弃待判定的单击（判定成双击、或开始拖动 / 长按时调用） */
  const dropPendingTap = () => {
    if (!pendingTap) return;
    clearTimeout(pendingTap.timer);
    pendingTap = null;
  };

  /** 单击真正落地：日期切今天/昨天、3 区（英文句）朗读 —— 其余元素单击无动作 */
  const runSingleTap = (id, audio) => {
    if (id === 'badge-date') toggleDay();
    else if (id === 'en') speak(audio);
  };

  /**
   * 单击进槽等待双击确认。
   * 只有一个槽：快速点不同元素时，前一次点击作废（只认最后那一下），
   * 免得连续朗读两次。
   */
  const tapAt = (id, audio) => {
    if (pendingTap && pendingTap.id === id) {
      dropPendingTap();
      hideElement(id);         /* 同区域 300ms 内的第二击 = 双击 */
      return;
    }
    dropPendingTap();
    const timer = setTimeout(() => {
      pendingTap = null;
      runSingleTap(id, audio);
    }, DBL_MS);
    pendingTap = { id, timer, audio };
  };

  /* 缩放写入走模块级的 applyZoom（唯一路径，调试面 __ds.setZoom 也复用它） */

  /** CSS 像素 → 画布像素：手指移动 1px 对应海报上移动多少 */
  const pxToCanvas = () => {
    const rect = cvs.getBoundingClientRect();
    return rect.width ? CW / rect.width : 1;
  };

  /** 提交调整结果：先 clamp 再写回 state.fits，然后重绘 */
  const commitFit = (next) => {
    if (!state.edit) return;
    const target = state.edit.target;
    const base = fitBase(target, state.layout);
    if (!base) return;
    const d = fitDraw(base, next);
    const cur = state.fits[target];
    if (Math.abs(d.scale - cur.scale) < 1e-4 &&
        Math.abs(d.ox - cur.ox) < 0.5 && Math.abs(d.oy - cur.oy) < 0.5) return;
    state.fits[target] = { scale: d.scale, ox: d.ox, oy: d.oy };
    state.edit.moved = true;
    scheduleRender();
  };

  /** 双指基准：两指距离、中点、以及按下那一刻的 fit */
  const beginPinch = () => {
    if (ptrs.size < 2) return;
    const [a, b] = [...ptrs.values()];
    pinch = {
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      fit0: Object.assign({}, state.fits[state.edit.target]),
    };
  };

  /** 调整模式下指针全部抬起 / 被系统打断时的收尾 */
  const resetAdjustPointers = () => {
    ptrs.clear();
    pinch = null;
    panLast = null;
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    hideHint();                /* 一有操作就收起手势提示 */

    /* 播放态独占：除波形区外全部让路 —— 不建 pullDrag / zoomDrag，也不起长按计时器
       （所以播放中按住不放不会保存）。只记下起点，真正的判定放在 pointerup。 */
    if (state.voice) {
      start = { x: e.clientX, y: e.clientY, t: Date.now() };
      return;
    }

    /* 调整模式：只认指针手势，其它一律让路
       —— 不建 pullDrag / zoomDrag，也不起长按（否则调图时会误保存） */
    if (state.edit) {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false });
      if (ptrs.size === 1) {
        panLast = { x: e.clientX, y: e.clientY };
      } else if (ptrs.size === 2) {
        panLast = null;
        beginPinch();
      }
      return;
    }

    start = { x: e.clientX, y: e.clientY, t: Date.now() };
    longFired = false;
    zoomDrag = null;
    pullDrag = null;
    /* 双指扩/捏切版：只在空闲态记录（播放 / 导出页不响应；调整模式在上面已提前 return） */
    if (!state.voice && !document.body.classList.contains('raw')) {
      modePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (modePtrs.size === 2) {
        const [a, b] = [...modePtrs.values()];
        modePinch0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        modeSwitchFired = false;
      }
    }
    /* 按起点元素分流：句子上是缩放，其余地方是下拉更新（长版同语义，2026-09-24 迁移） */
    {
      const hit = hitTestAt(e.clientX, e.clientY);
      if (hit && ZOOM_REGIONS.has(hit.id)) {
        /* 记下拖的是哪一区，以及该区（组）的当前倍率 —— 联动组里三个值本来就相同 */
        zoomDrag = {
          id: hit.id, startY: e.clientY, startZoom: regionFx(hit.id).scale, active: false,
        };
      } else if (!hit || hit.id === 'img' || hit.id === 'card') {
        pullDrag = { startY: e.clientY, moved: false, armed: false };
      }
    }
    clearTimeout(holdTimer);
    /* 长按 = 保存海报。**诊断页例外**（?diag=1）：那时长按要留给系统的「全选 / 拷贝」，
       否则手机上长按弹出的是保存浮层、反而挡掉选择菜单（见 startDiag 的说明） */
    if (DIAG) return;
    holdTimer = setTimeout(() => {
      longFired = true;
      dropPendingTap();
      if (navigator.vibrate) navigator.vibrate(12);
      savePoster();
    }, PRESS.holdMs);
  });

  stage.addEventListener('pointermove', (e) => {
    /* 播放态独占：不缩放、不下拉、不判定长按 —— 一切等 pointerup 看在不在波形区 */
    if (state.voice) return;

    /* 调整模式：双指 = 缩放（中点位移同时当平移，跟手感更好），单指 = 拖动 */
    if (state.edit) {
      const rec = ptrs.get(e.pointerId);
      if (!rec) return;                       /* 没按下的移动（鼠标悬停）不算 */
      rec.x = e.clientX;
      rec.y = e.clientY;
      if (Math.hypot(e.clientX - rec.x0, e.clientY - rec.y0) > PRESS.moved) rec.moved = true;
      const k = pxToCanvas();
      if (ptrs.size >= 2 && pinch) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        commitFit({
          scale: pinch.fit0.scale * (d / pinch.d0),
          ox: pinch.fit0.ox + (mid.x - pinch.mid0.x) * k,
          oy: pinch.fit0.oy + (mid.y - pinch.mid0.y) * k,
        });
      } else if (panLast) {
        const cur = state.fits[state.edit.target];
        commitFit({
          scale: cur.scale,
          ox: cur.ox + (e.clientX - panLast.x) * k,
          oy: cur.oy + (e.clientY - panLast.y) * k,
        });
        panLast = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    /* 双指扩/捏切版判定（常态手势，一组两指只触发一次，冷却防连切） */
    if (modePtrs.has(e.pointerId)) {
      const rec = modePtrs.get(e.pointerId);
      rec.x = e.clientX;
      rec.y = e.clientY;
      if (modePtrs.size >= 2 && modePinch0 && !modeSwitchFired &&
          Date.now() - modeSwitchAt >= MODE_SWITCH_COOLDOWN) {
        const [a, b] = [...modePtrs.values()];
        const ratio = Math.hypot(a.x - b.x, a.y - b.y) / modePinch0;
        if (ratio >= MODE_SWITCH_EXPAND && !state.opts.longPoster) {
          modeSwitchFired = true;
          modeSwitchAt = Date.now();
          applyMode('long');
        } else if (ratio <= MODE_SWITCH_PINCH && state.opts.longPoster) {
          modeSwitchFired = true;
          modeSwitchAt = Date.now();
          applyMode('standard');
        }
      }
    }
    if (zoomDrag) {
      const dy = e.clientY - zoomDrag.startY;
      if (!zoomDrag.active && Math.abs(dy) > PRESS.moved) {
        zoomDrag.active = true;
        clear();                 /* 拖动期间取消长按与点击判定 */
        dropPendingTap();
      }
      if (zoomDrag.active) {
        applyZoom(zoomDrag.id, zoomDrag.startZoom * (1 + (-dy) * ZOOM_PER_PX));
        return;
      }
    }
    if (pullDrag) {
      const dy = e.clientY - pullDrag.startY;
      if (dy > PRESS.moved && !pullDrag.moved) {
        pullDrag.moved = true;
        clear();                 /* 拖起来了：取消长按，也不算点击 */
        dropPendingTap();
      }
      if (pullDrag.moved && !pullDrag.armed && dy >= PULL_MIN) {
        pullDrag.armed = true;
        toast('松手即更新');
      }
      if (pullDrag.moved) return;   /* 下拉期间不再走其它判定 */
    }
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > PRESS.moved) clear();
  });

  stage.addEventListener('pointerup', (e) => {
    /* 双指切版的指针收尾：两指都抬起后重置基准 */
    if (modePtrs.delete(e.pointerId) && !modePtrs.size) modePinch0 = 0;
    /* 播放态独占：只有「按在波形区内、且没拖动」的那一下才停；
       按在别处、或按下后拖走了，都当作没发生（其余区域一律不可操作） */
    if (state.voice) {
      const s = start;
      const inside = s ? inWave(s.x, s.y) : false;      /* 判定按下点 */
      const moved = s ? Math.hypot(e.clientX - s.x, e.clientY - s.y) > PRESS.moved : true;
      clear();
      if (inside && !moved) stopVoice('tap');
      return;
    }

    /* 调整模式：没拖过这一下、且落点在被调区域之外 → 「点别处完成」 */
    if (state.edit) {
      const rec = ptrs.get(e.pointerId);
      ptrs.delete(e.pointerId);
      if (ptrs.size === 1) {
        pinch = null;
        const p = [...ptrs.values()][0];
        panLast = { x: p.x, y: p.y };
      } else if (ptrs.size === 0) {
        resetAdjustPointers();
      }
      if (!rec || rec.moved) return;
      /* 弹层里看不到海报，命中判定不再走命中表，而是直接与窗口 rect 比坐标
         （窗口 rect 就是层内坐标 = client 坐标，因为弹层是 inset:0）：
         点在窗口里 = 换同一张（提示里那句「点图片换一张」），点在窗口外 = 完成。 */
      const W = editWin;
      const inside = !!W &&
        e.clientX >= W.x && e.clientX <= W.x + W.w &&
        e.clientY >= W.y && e.clientY <= W.y + W.h;
      if (inside) {
        if (Date.now() - pickerAt < 400) return;
        pickerAt = Date.now();
        openPicker(state.edit.target);
        return;
      }
      finishEdit();
      return;
    }

    /* 下拉更新优先：够距离就执行（松手瞬间才真正请求） */
    if (pullDrag && pullDrag.armed) {
      pullDrag = null;
      clear();
      resetToInitial(true).then(() => toast('已回到初始状态'));
      return;
    }
    pullDrag = null;

    if (zoomDrag) {
      const dragged = zoomDrag.active;
      zoomDrag = null;
      if (dragged) { clear(); return; }   /* 拖动结束，不算点击 */
    }
    if (!start) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > PRESS.moved;
    const spent = Date.now() - start.t;
    const wasLong = longFired;
    clear();
    if (wasLong || moved || spent > PRESS.maxMs) return;

    const hit = hitTestAt(e.clientX, e.clientY);
    if (!hit) return;

    /* 图片 / 信息卡：单击即开相册（不定义双击，所以立即响应，只防抖一次） */
    if (hit.id === 'img' || hit.id === 'card') {
      if (Date.now() - pickerAt < 400) return;
      pickerAt = Date.now();
      openPicker(hit.id);
      return;
    }

    /* 句子 / 日期：单击有动作、双击是删除 → 进槽等 300ms 确认（长版同语义，2026-09-24 迁移） */
    if (!SINGLE_TAP_REGIONS.has(hit.id)) return;
    /* iOS 只认手势调用栈里的播放：先静音播一下解锁，300ms 后再正式播。
       只有 3 区（en）朗读 —— 中文句 / 出处的单击保留 300ms 判定只为双击删除，不发音。
       **没有音频文件时连解锁都不做**（那句 toast 由 speak() 给，波形结构上不会出现） */
    tapAt(hit.id, hit.id === 'en' && hasAudio() ? primeAudio() : null);
  });

  stage.addEventListener('pointercancel', () => {
    zoomDrag = null;
    pullDrag = null;
    dropPendingTap();
    resetAdjustPointers();
    modePtrs.clear();
    modePinch0 = 0;
    clear();
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  /* 保存浮层：点图片以外的地方关闭。图片本身不拦任何事件（iOS 要能长按出系统菜单）。
     注意这里**只监听 click，不碰 touchstart/pointerdown** —— 否则会把长按菜单也一并掐掉。 */
  const sheet = $('saveSheet');
  if (sheet) {
    sheet.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'saveImg') return;
      closeSaveSheet();
    });
  }
}

/** 屏幕坐标 → 命中的区域（换算成画布坐标再查命中表） */
function hitTestAt(clientX, clientY) {
  const rect = cvs.getBoundingClientRect();
  if (!rect.width) return null;
  const s = rect.width / CW;
  return hitTest((clientX - rect.left) / s, (clientY - rect.top) / s);
}

/** 双击：把这块从海报上删掉，其余内容自动上移补齐 */
function hideElement(regionId) {
  const key = HIDE_MAP[regionId];
  if (!key || state.hidden[key]) return;
  state.hidden[key] = true;
  scheduleRender();
}

/** 唤起相册：顶部图片 / 信息卡各有一个隐藏的 file input */
function openPicker(which) {
  $(which === 'card' ? 'fCardImage' : 'fBgImage').click();
}

/* ------------------------------ 一次性手势提示 ------------------------------ */

let hintTimer = null;
let hintSticky = false;
let hintDefault = '';

/**
 * 手势提示（整屏唯一的文字说明）。两种用法：
 * - 首次进入：3 秒后自动淡出，任意操作立即收起，不做记忆
 * - 调整模式：`sticky = true`，常驻到退出调整模式为止 —— 那行字是调图时唯一的说明
 */
function showHint(text, sticky) {
  const el = $('hint');
  if (!el) return;
  clearTimeout(hintTimer);
  hintSticky = !!sticky;
  /* 常驻（调整模式）的说明更长，允许折行；普通提示保持一行 */
  el.classList.toggle('wrap', hintSticky);
  if (text) el.textContent = text;
  el.hidden = false;
  el.classList.remove('hide');
  if (!sticky) hintTimer = setTimeout(hideHint, 3000);
}

function showHintOnce() {
  const el = $('hint');
  if (el && !hintDefault) hintDefault = el.textContent;
  showHint(hintDefault || '长按保存 · 下拉更新 · 点英文句朗读 · 点日期看昨天');
}

/* =================== 真机诊断页（?diag=1，2026-09-22） ===================
   手机上复现不了的问题（音频会话、装到主屏后的安全区、真机字形）最省钱的报法不是截图，
   而是把关键数字读成**纯文本**：带上 ?diag=1 时页面顶部叠一段只读文本，并放开长按选择
   （手势层里同时让「长按保存」让路），手机长按就能「全选 / 拷贝」贴回来 —— 零截图、零重打字。
   纯文本、**零按钮**；不带参数时 #diag 始终 hidden，平时完全不存在；也绝不参与海报绘制。 */

/** 诊断文本：全部读模块内的既有状态（不依赖 ?debug=1 的 __ds，真机上默认没有 debug） */
function diagText() {
  const L = state.layout || {};
  const safe = readSafeArea();          /* 现测：旋转 / 独立形态切换后要跟着变 */
  const rect = cvs.getBoundingClientRect();
  const r1 = (v) => Math.round(v * 10) / 10;
  const q = (v) => (v == null ? '-' : v);
  const fx = L.fx || {};
  const said = (x) => (x && x.on ? r1(x.size) : '-');
  const dm = window.matchMedia ? window.matchMedia('(display-mode: standalone)').matches : false;
  const d = state.voiceDiag;
  return [
    '每日一句 · 诊断（?diag=1）  长按本段 → 全选 → 拷贝，贴回来即可',
    '形态      standalone=' + (isStandalone() ? 'Y' : 'N') + '   display-mode=' + (dm ? 'standalone' : 'browser'),
    '屏幕      screen ' + screen.width + '×' + screen.height + '   inner ' + window.innerWidth + '×' + window.innerHeight +
      '   dpr ' + r1(window.devicePixelRatio || 1) +
      (window.visualViewport ? '   vv ' + r1(window.visualViewport.height) : ''),
    '安全区    top ' + r1(safe.top) + '   bottom ' + r1(safe.bottom),
    '舞台      standalone=' + (STAGE_INFO.standalone ? 'Y' : 'N') + '   padTop=' + STAGE_INFO.padTop +
      '   screenH=' + STAGE_INFO.screenH + '   frameH=' + STAGE_INFO.frameH,
    '海报      显示 ' + r1(rect.width) + '×' + r1(rect.height) + ' @(' + r1(rect.left) + ', ' + r1(rect.top) + ')' +
      '   圆角 ' + r1(POSTER_RADIUS * (rect.width / CW)) + 'px   位图 ' + PHYS.w + '×' + cvs.height + '   U=' + r1(U),
    '版面      base ' + q(L.base) + '   活动区 ' + (L.band ? r1(L.band.top) + '..' + r1(L.band.bottom) : '-') +
      '   卡片 ' + (L.card ? [L.card.x, Math.round(L.card.y), L.card.w, Math.round(L.card.h)].join(',') : '-') +
      '   顶图 ' + (L.imgBlock ? Math.round(L.imgBlock.h) : '-'),
    '字号      2 日期 ' + said(L.date) + ' (fx ' + q(fx['badge-date']) + ')   3 en ' + said(L.en) +
      ' (fx ' + q(fx.en) + ')   4 cn ' + said(L.cn) + '   5 source ' + said(L.source),
    '音频      hasAudio=' + (hasAudio() ? 'Y' : 'N') + '   正在播放=' + (state.voice ? 'Y' : 'N') +
      '   voiceDiag ' + (d.lastReason || '(还没收尾过)') + ' / errName=' + (d.errName || '-') +
      ' / retries=' + d.retries + ' / 响了 ' + r1(d.playedMs / 1000) + 's / 时长 ' + r1(d.dur) + 's',
    '摇一摇    DeviceMotionEvent=' + (typeof window.DeviceMotionEvent) +
      '   requestPermission=' + (window.DeviceMotionEvent && typeof window.DeviceMotionEvent.requestPermission === 'function' ? 'Y' : 'N') +
      '   theme=' + state.theme +
      '   shakeDiag ' + (shakeDiag.state || '(还没请求过权限)') + ' / errName=' + (shakeDiag.errName || '-') +
      (shakeDiag.state === 'denied' || shakeDiag.state === 'error' ? '（去 设置→Safari→清除网站数据 后重试可再弹授权）' : ''),
    '状态      voice=' + q(state.voice ? state.voice.target : null) +
      '   edit=' + q(state.edit ? state.edit.target : null) + '   hidden=' + JSON.stringify(state.hidden),
    'UA        ' + String(navigator.userAgent || '').slice(0, 80),
  ].join('\n');
}

/** 启动诊断循环（只在 ?diag=1 时调用）：500ms 刷新一次纯文本，只写 textContent，不碰 render */
function startDiag() {
  const el = $('diag');
  if (!el) return;
  el.hidden = false;
  const tick = () => {
    try { el.textContent = diagText(); } catch (e) { el.textContent = '诊断失败：' + (e && e.message); }
  };
  tick();
  setInterval(tick, 500);
}

/** sticky 提示不会被「一操作就收起」收掉，只能显式 force 收起 */
function hideHint(force) {
  const el = $('hint');
  if (!el) return;
  if (hintSticky && !force) return;
  hintSticky = false;
  clearTimeout(hintTimer);
  if (el.hidden) return;
  el.classList.add('hide');
  setTimeout(() => { if (el.classList.contains('hide')) el.hidden = true; }, 400);
}

/* ------------------------------ 保存 ------------------------------- */

/** iOS / iPadOS 判定：只有它需要走「长按预览图 → 存储到照片」这条通道 */
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** 文件名：日期能认出来就规范成 YYYY-MM-DD，方便在相册里按时间排序 */
function posterFileName() {
  const d = state.content.date || '';
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = m
    ? m[3] + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0')
    : d.replace(/\//g, '-');
  return 'dailysentence-' + (iso || 'today') + '.png';
}

/**
 * 保存海报。两条通道按平台分流 —— 这是修掉「长按只弹出文件预览」的关键：
 *
 * - **iOS**：`<a download>` 只会把 PNG 落进「文件」里并弹 Quick Look 预览（存不进相册）；
 *   而 `navigator.share({files})` 是在长按的定时器里调用的，早就脱离用户手势调用栈，
 *   Safari 会直接拒绝（原来就是这么掉进下载兜底的）。唯一稳的路是给一张原图让用户
 *   **长按 → 存储到照片**，所以这里弹浮层。
 * - **桌面 / Android**：能分享就分享（系统分享面板里含「保存图片」），否则直接下载。
 */
async function savePoster() {
  try {
    const blob = await new Promise((res) => cvs.toBlob(res, 'image/png'));
    if (!blob) throw new Error('导出失败');
    const name = posterFileName();
    state.lastSave = { kind: '', name, at: Date.now() };

    if (isIOS()) {
      showSaveSheet(blob, name);
      state.lastSave.kind = 'sheet';
      return;
    }

    try {
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '每日一句' });
        state.lastSave.kind = 'share';
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;   /* 用户自己取消的，不算失败 */
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    state.lastSave.kind = 'download';
    toast('已保存：' + name);
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

let saveSheetUrl = '';

/** iOS 保存浮层：给一张可直接长按的原图；点图以外的地方关闭 */
function showSaveSheet(blob, name) {
  const sheet = $('saveSheet');
  const img = $('saveImg');
  if (!sheet || !img) return;
  if (saveSheetUrl) URL.revokeObjectURL(saveSheetUrl);
  saveSheetUrl = URL.createObjectURL(blob);
  img.src = saveSheetUrl;
  img.alt = name;
  $('saveTip').textContent = '长按图片 → 存储到照片 · 点空白处关闭';
  sheet.hidden = false;
}

function closeSaveSheet() {
  const sheet = $('saveSheet');
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  $('saveImg').removeAttribute('src');
  if (saveSheetUrl) { URL.revokeObjectURL(saveSheetUrl); saveSheetUrl = ''; }
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
  /* longPoster 先定，背景比例的默认值要按版本取（标准版铺满 / 长版原比例） */
  /* 版式先定（URL ?long=1 强制 > localStorage 记忆 > 标准版）—— 同样要在首帧渲染前，
     否则标准版先渲染一帧再切长版会闪一次 */
  initMode();
  state.opts.bgStyle = initialBgStyle();
  /* 主题先定（?theme= 当次生效 / localStorage 读回 / 默认夜空）—— 它只改颜色不改版面，
     放在首帧渲染前是为了避免「先画 night 再换色」的闪变 */
  initTheme();
  /* 先定设备位图与比例单位：后面所有版面尺寸都建立在它上面 */
  computeCanvasSize();
  /* 竖直居中补正：独立全屏下把布局框补回物理屏（浏览器里恒为 0）。
     必须在首屏绘制前算好，免得先闪一下偏上的位置 */
  syncStageCenter();
  watchViewport();
  bindInputs();
  bindShake();        /* 摇一摇换配色：监听与 iOS 授权（pointerup 收尾手势）都在这里挂 */

  /* 字体度量必须先就绪，否则折行与居中会算错 —— 用回退字体的度量算出来的版面，
     和字体到位后重排的结果不一样（刷新前后观感不一致）。
     ⚠ 新增字体时必须同步加到这个列表里（2026-09-24 加的 AppGaramond 就是 3 区那个）。 */
  try {
    await Promise.all([
      document.fonts.load(`700 120px AppSerif`),
      document.fonts.load(`400 40px AppSans`),
      document.fonts.load(`600 40px AppSans`),
      document.fonts.load(`400 50px AppGaramond`),   /* 3 区（英文句） */
    ]);
    if (document.fonts.ready) await document.fonts.ready;
  } catch (e) {}

  /* 与应用初始状态对齐（下拉更新也走同一段代码） */
  await resetToInitial(false);
  if (!state.apiData) {
    setOverlay(false);
    render();
  }
  /* 界面没有按钮，首次进入给一次手势提示 */
  showHintOnce();
  /* 真机诊断页：只在 ?diag=1 时存在（纯文本、可长按复制，见 startDiag） */
  if (DIAG) startDiag();

  /* 调试/回归用具：?debug=1 时把命中表、坐标换算与版面标注暴露出来 */
  if (DEBUG) {
    window.__ds = {
      state, hitTest, toClient, hitTestAt, hideElement,
      inspect,            // 版面清单：inspect.js 靠它导出 JSON 与标注图
      syncStageCenter,    // 独立形态的居中补正：回归可用桩注入 standalone/screen.height 后手动驱动
      playVoice, stopVoice, layoutWave,   // 语音独占层：回归可直接驱动（playVoice 不传参只显示波形）
      /* 字号缩放的**同一条**钳制路径（不是旁路）：回归靠它把 2 区直接放到上限，
         不必在几百像素高的测试视口里反复拖动去累积倍率 */
      setZoom: applyZoom,
      zoomMax: zoomMaxOf,  // 某区的放大上限（2 区 3 倍、其余 1.6），自证用
      /* 摇一摇换配色：回归合成 devicemotion 事件走的就是 bindShake 里那条真监听；
         applyTheme 直接暴露只为截图/自证（与手势同一条 applyTheme 路径，不是旁路） */
      setTheme: applyTheme,
      themeOrder: THEME_ORDER,
      /* 版式切换：回归可直接驱动（与双指手势同一条 applyMode 路径） */
      setMode: applyMode,
      /* 授权重试冷却归零（仅测试用）：60s 冷却对回归太长，请求路径本身不走旁路 */
      permRetryNow: () => { shakePermLastTry = 0; },
      scheduleRender,     // 换图调整层：回归合成纯色图后驱动一次重绘，做像素级判定
      /* 排版中间量：排查「自适应倍率算错」时可以直接在页面里量 */
      textTotalAt: (k) => buildTextBlockStandard(cvs.getContext('2d'), k).total,
      textFit: (bandH) => textFit(cvs.getContext('2d'), bandH),   /* 保底倍率（通常为 1） */
    };
  }
})();
