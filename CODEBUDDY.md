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

## 界面原则（2026-09-21 标准版重构后）

- **不加常驻冗余信息**。整屏只有海报；除顶栏四个按钮（3 秒无操作淡出）外没有任何浮层。
- **没有浮框、没有控件仓库 `#kit`、没有引导动画** —— 三者已彻底移除
  （`#pop` / `#kit` / `#frames` / `#tip` / `#mark` 在 HTML、CSS、JS 三层都不存在了），
  不要再往「点哪改哪就地弹框」的方向设计。
- 交互只有四种手势：
  - **单击顶部图片 / 信息卡 = 从手机相册选图**（列表类元素不定义双击，避免连开两次相册）
  - **双击日期 / 英文 / 中文 / 出处 = 从海报删除该元素**（不可逆，刷新恢复；300ms 内同区域两次点击判定）
  - **在英文 / 中文 / 出处上上下滑动 = 实时缩放中部字号**（0.6–1.6 倍，叠在自适应倍率上）
  - **长按海报 = 保存**
- **标准版画布恒 1080×1920**：句子装不下靠**改字号**适配 —— 在中部活动区里二分求解
  「尽量铺满」的倍率（0.5–2.0），再叠手动缩放系数，最后在活动区里垂直居中；
  正文与信息卡统一 48px 边距，顶部图片默认铺满裁切。长版（`?long=1`）保持旧版面与长高逻辑。
- **顶栏「重新获取」= 回到初始状态**（等同重启 App），它和 boot 共用 `resetToInitial()`：
  要让某个状态也能被重置，就把它加进那个函数，别在按钮里另写一份。
- `state.regions` 的 id、`window.__ds.inspect()` 的字段形状（含 `text.autoScale/zoom/K`），
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

## 环境说明（CodeBuddy 与 WorkBuddy 并存）

代码可自由在两个环境里开发（纯本地 git 仓库、零依赖 Node，无平台私有 SDK）。

**但部署只能在 WorkBuddy 里做**：CodeBuddy 侧只有静态托管技能
（EdgeOne Pages / GitHub Pages / Netlify / Vercel / html-deploy），跑不了
Node 服务端；而本项目的抓取、解析、图片代理、存档全在 `server.js` 里。
所以默认分工是：CodeBuddy 写代码，WorkBuddy 点发布。
