# 每日一句海报（dailysentence）

抓取欧路词典「英语每日一句」，合成 1080 宽海报的 Web 应用。

- 零依赖 Node 服务 `app/server.js`：抓取 + 解析 + 图片代理 + 存档 + 静态托管
- 浏览器 Canvas 排版 `app/public/app.js`
- 线上：https://dailysentence.app.workbuddy.host/
- 代码：https://github.com/jiyeqian/dailysentence

## 运行与验证（改完必跑）

```bash
node app/server.js        # 本地服务，端口 8787
node app/parse-check.js   # 解析 + 存档回归（零依赖断言）
NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
  node app/ui-check.js    # 交互回归（playwright 截图 + 断言，需服务在跑）
```

上游页面快照放 `app/fixtures/`，截图输出 `app/shots/`（已 gitignore）。
排障时也把页面留一份快照 —— 这是解析回归的唯一依据。

## 铁律：上游结构兼容

上游 `dict.eudic.net/home/dailysentence` 会不定期改版。每次改解析都要保证
「新结构能解析」且「老结构不回归」，并把新样本存进 `app/fixtures/`、钉成
`parse-check.js` 里的断言。已知变体见 `app/README.md` 的兼容表。

出现「本该在 A 字段的内容跑到 B」时，几乎都是分隔符 / 小标题识别退化，
先跑解析器打印各字段，别急着怀疑渲染层。

## 界面原则（2026-09-21 无按钮化后）

- **界面上一个按钮都没有**。顶栏已整体删除（`#topbar` 与四个按钮在 HTML / CSS / JS 三层都不存在），
  整屏只有海报本体；`index.html` 里只剩两个隐藏的 `file input`（选图的实现载体，不是界面按钮）。
  → 不要为了「方便」再加回顶栏、图标、角标。
- **没有浮框、没有控件仓库 `#kit`、没有引导动画** —— 都已彻底移除
  （`#pop` / `#kit` / `#frames` / `#tip` / `#mark` 不复存在），不要再往「点哪改哪就地弹框」的方向设计。
- **功能全部由海报上的手势承载**（唯一提示是首次进入 3 秒后自动消失的一行 `#hint`）：

  | 手势 | 作用 |
  | --- | --- |
  | 长按任意位置 | 保存。**iOS 走 `#saveSheet` 浮层**（给一张可长按的原图 → 「存储到照片」）；其余平台直接下载 |
  | 单击顶部图片 / 信息卡 | 从手机相册选图（不定义双击，立即响应，400ms 防抖） |
  | 单击英文 / 中文 / 出处 | 朗读（等 300ms 确认不是双击） |
  | 单击日期胶囊 | 今日 ⇄ 昨日存档切换（等 300ms 确认不是双击） |
  | 双击日期 / 英文 / 中文 / 出处 | 从海报删除该元素（不可逆，刷新恢复） |
  | 在英文 / 中文 / 出处上上下拖动 | 实时缩放中部字号（0.6–1.6 倍，叠在自适应倍率上） |
  | 非句子区向下拉 ≥90px | 回到初始状态（等同重启 App） |

  「同一元素既有单击又有双击」的四类元素（句子三个 + 日期）走**单槽 `pendingTap` + 300ms 确认**；
  图片与信息卡的单击保持零延迟。长按（520ms 静止）与拖动（位移 >8px）优先于点击判定。

- **换图后自动进入「手动调整模式」**（`state.edit = { target: 'img'|'card' }`）：
  默认什么都不动（`state.fits[target] = { scale: 1, ox: 0, oy: 0 }` 必须等于「刚换上的样子」），
  调整期间**上面那一整套手势全部让路**（不保存、不更新、不朗读、不删除，也不开相册），
  只认单指拖动（平移）与双指捏合（缩放，中点位移同时当平移），
  **唯一出口是点被调区域以外的地方**。别给它加按钮，也别改这套退出语义。
- **标准版画布恒 1080×1920**：句子装不下靠**改字号**适配 —— 在中部活动区里二分求解
  「尽量铺满」的倍率（0.5–2.0），再叠手动缩放系数，最后在活动区里垂直居中；
  正文与信息卡统一 48px 边距。
- **顶部图片按宽度铺满 + 硬裁切**：宽度定死 1080、高度按原始比例，超出顶部图片区（648px）
  的部分 `ctx.clip()` 裁掉 —— 竖图只显示最上面一段，宽图下方露底色。
  **绝不能让图片溢出到中部区域**（历史 bug：漏了 clip，竖图一路画到 y≈1285）。
  长版（`?long=1`）继续走 `bgStyle` 的 natural / cover，不受此规则影响。
- **两块可调图片共用一套 `fit` 数学**（`fitBase` / `fitDraw` / `currentFitDraw`），别为某一块另写一份：
  - 基线 `scale = 1` 必须与「刚换完图看到的样子」一致（顶部图片 = 宽度铺满 + 左上角对齐；
    信息卡 = 等比、面积与自动识别矩形相当、中心对准识别中心）
  - 缩放锚点 = 窗口中心；平移限制：某方向图片比窗口大就必须盖满该方向（**不许露底色**），
    比窗口小（如 16:9 宽图铺满宽度后只有 608 高）则锁在基线位置
  - 信息卡**不再把识别矩形拉伸填满**（会变形），改成等比；长版卡片框本就由同一组
    `state.ratios` 推出，所以长版观感不变
  - 换图 / 换模板 / 下拉更新都会把对应那块 `fits` 复位成 `{1,0,0}`
- **「回到初始状态」只有一条路径**：`resetToInitial(refetch)`，下拉更新与 boot 共用：
  要让某个状态也能被重置，就把它加进那个函数，别在别处另写一份。
- **保存必须按平台分流**，别退回单一通道（`savePoster()`）：
  - iOS：`<a download>` 只会把 PNG 丢进「文件」里弹 Quick Look 预览，**存不进相册**；
    `navigator.share({files})` 是在长按的定时器里调的，已脱离用户手势调用栈，Safari 直接拒。
    所以 iOS 只能弹 `#saveSheet`：一张 blob 原图供「长按 → 存储到照片」。
    → 该浮层里的 `<img>` **不能**拦截 touch/pointer 事件，且必须覆盖掉 `#stage` 上的
    `-webkit-touch-callout: none`，否则 iOS 长按菜单出不来。
  - 桌面 / Android：能 `canShare` 就分享，否则 `a[download]`。
  - 文件名统一 `dailysentence-YYYY-MM-DD.png`（`posterFileName()`），别再拼成 `9212026`。
- `state.regions` 的 id、`window.__ds.inspect()` 的字段形状（含 `text.autoScale/zoom/K`、`bg`），
  是 `inspect.js` 与 `ui-check.js` 的契约，改交互时别改这两处的对外形状。

## 存档与部署

- 存档 `app/data/daily/YYYY-MM-DD.json` + `app/data/index.json`（gitignore）。
  线上容器实测留盘、重新部署后仍在；写盘失败必须静默降级，绝不能影响出图。
- 只存抓取到的基础数据，不存用户手改的文案 / 模板图 / 成品图。
- 同日重复抓取按「更完整的那份为主、缺的字段互补」合并，不是覆盖。
- 发布用 WorkBuddy 的 `workbuddy_sites_deploy`（`updateExistingApp: true`
  复用沙箱，链接与存档都延续）。**分享链接绑在应用身份上，不能改名**；
  换链接只能新建应用，存档会归零。
- 部署是**覆盖式上传**：整目录压缩上传，只排除 `node_modules` / `.git` /
  构建产物（`data/` 不在排除之列，本地存档会跟着传上去）。

## 协作约定

- **发布节奏**：只改文档 / 元数据、没动任何程序功能时，只 commit & push，
  不 tag、不 deploy。要上线等明确说「上线」。
- 先给方案与取舍 → 确认后再实施；视觉问题以截图驱动。
- **版式沟通走标注通道**（`app/inspect.js`）：带编号的标注图给人看、`inspect-*.json`
  坐标清单给 AI 读，两边共用一套编号（命名表见 `app/README.md`）；改完用 `--diff`
  自证改动范围。界面改动不靠识图，报编号 + id。
- 优先零依赖方案；涉及云服务 / 计费资源时不擅自开通。

### 提交节奏（2026-09-22 立）：每子任务自动 commit + 即 push

**commit 后立刻 push**，粒度为**子任务级**：一个可验证的功能点一个提交。

动机：git 提交廉价可撤销，真正收益是「精确 revert + bisect 可用」—— 历史上 `5c65503`
一次 +674/−1308（`app.js` 单文件 1089 行）塞了多个逻辑，想只回退其中一个做不到。

三条硬约束，不满足就不提交：

- **A 绿色点**：提交前必跑 `parse-check`（50 项）+ 语法检查：

  ```bash
  node app/parse-check.js                                  # 必须 50 passed, 0 failed
  for f in app/server.js app/public/app.js app/ui-check.js; do node --check $f; done
  ```

  语法检查一律用 `node --check` —— **别用 `new Function(src)`**：`server.js` 首行是
  `#!/usr/bin/env node`，shebang 会让它直接抛 `Invalid or unexpected token`（假警报）。
  界面改动再加 `ui-check`（需服务在跑，见上文「运行与验证」）。半成品允许 WIP，但
  message 以 `wip:` 开头，且下一轮必须重写掉，不让 wip 留在 main 上。
- **B 只提交本次的**：提交前 `git status --short` 逐文件核对，用 `git add <具体文件>`；
  **绝不 `git add -A` 一把梭**（本项目出过「另一会话悄悄把 HEAD 推到 `5c65503`」的事），
  出现不认识的文件就停下报告。
- **C push ≠ 上线**：「只改文档不 tag 不上线」「上线要用户明说」照旧有效；提交后写明
  「已 push，未上线」。

保持现状两点：**文档与代码同批提交**（文档描述的就是这版行为，拆开对不上号）；
判据是「revert 掉它之后应用还能正常跑」→ 就能单独成提交。
安全项：`app/data/`、`app/shots/` 已在 `.gitignore`，自动提交不会把本机存档带进仓库。

### Commit Message 结构（2026-09-22 立）

统一 `<type>(<scope>): <description>`（conventional commits）：

- **type**：`feat` 新功能 / `fix` 修 bug / `refactor` 重构不改行为 / `perf` 性能 /
  `docs` 文档 / `test` 回归脚本 / `chore` 杂项（包名 · gitignore · 部署配置）
- **scope**：`server` 抓取 · 路由 · 存档 / `parse` 上游解析兼容 /
  `ui` Canvas 排版 · 手势 · 版面 / `docs` 文档 /
  `test` parse-check · ui-check · inspect / `infra` 元数据与部署
- **description**：中文祈使句，句末不加句号，50 字内说清「做了什么」
- **body**：结构行之后空一行，继续写要点与「为什么」（原风格不变，只是头上多了结构行）

改写示例：`标准版重构：去掉全部浮层…` → `refactor(ui): 去掉全部浮层改三段式版面`；
`兼容上游「短语型」解析…` → `feat(parse): 兼容上游短语型结构（词与释义同行）`。
2026-09-22 之前的提交仍是纯中文祈使句，不回改。

## 环境说明（CodeBuddy 与 WorkBuddy 并存）

代码可自由在两个环境里开发（纯本地 git 仓库、零依赖 Node，无平台私有 SDK）。

**但部署只能在 WorkBuddy 里做**：CodeBuddy 侧只有静态托管技能
（EdgeOne Pages / GitHub Pages / Netlify / Vercel / html-deploy），跑不了
Node 服务端；而本项目的抓取、解析、图片代理、存档全在 `server.js` 里。
所以默认分工是：CodeBuddy 写代码，WorkBuddy 点发布。
