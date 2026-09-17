# 每日一句 · 海报生成器

把 [欧路词典「英语每日一句」](https://dict.eudic.net/home/dailysentence) 的当日内容，
和乐词 App 的「个人信息卡片」模板合成为一张竖版手机海报
（标准版 **1080 × 1920**，需要时自动加高）。

一句话概括：**打开网页 → 自动抓取今日金句 → 一键生成可发朋友圈的打卡长图**。

| 线上地址（手机可直接打开） | 在线体验 |
| --- | --- |
| <https://dailysentence-poster.app.workbuddy.host/> | 支持「添加到主屏幕」当 App 用 |

<img src="docs/preview.png" width="360" alt="生成效果预览">

---

## 效果

| 输入模板 | 参考样式 | 生成结果 |
| :---: | :---: | :---: |
| <img src="docs/reference/input.jpg" width="200"> | <img src="docs/reference/output.png" width="200"> | <img src="docs/preview.png" width="200"> |

- `docs/reference/input.jpg` —— 乐词打卡图模板（提供头像 / 昵称 / 坚持天数 / 学习统计卡片）
- `docs/reference/output.png` —— 目标版式：文字位置参照
- `docs/reference/dailysentence.png` —— 数据来源页面截图
- `docs/preview.png` —— 实际生成结果

---

## 特性

**抓取**

- 中英文句子、关键词、音标（英式 / 美式双音标）、词性释义、例句、常用搭配、出处
- 网页「每日一句」卡片左上角的配图（`static.esdict.cn/MediaPool/daymonthimg/…`，每天轮换）
- 真人发音地址（正常 / 慢速，可试听）

**合成**

- 版面**从上到下**：文字块（句子 + 出处） → 单词卡片 → 个人信息卡片
- 浏览器 Canvas 完成，**模板图不上传**
- 个人信息卡片位置**自动识别**：近纯白二值化 + 连通域，取不接触画布边缘的最大白块，
  按圆角矩形抠出后重新贴上并重绘投影
- 两种背景模式：
  - `原比例` —— 图片宽度铺满、顶端与海报顶端对齐、完整不裁切，下缘渐隐进底色
  - `铺满` —— 等比裁切铺满整张海报
- 版面是**流式**的，各段依次向下排，天生不会互相压盖；不自动缩字，字号完全由滑块决定
- 画布高度 = max(内容高度, 1920)：标准版通常正好 1920，装不下或选「长版海报」时按需要长高
- 中文逐字断行、英文按词断行，并避免行首出现 `，。、；：？！）】》」』` 等标点
- 关键词用 Playfair Display 衬线大标题，正文 Inter + 苹方混排；单词卡片与信息卡均为
  圆角卡片，单词卡片带毛玻璃质感、左侧渐变竖条、等宽音标、词性彩色胶囊（n./v./adj.）

**交互**

- 顶部四个按钮：**更换模板** / **保存海报** / **朗读** / **原文**
- 全部文案可手动改；导入自己的模板图后卡片位置自动识别
- 3 个滑块微调信息卡（上边距 / 卡片高度 / 左右边距），另有全局字号、日期标签、
  标题分隔线、显示出处、长版海报等开关
- PWA，可添加到主屏幕；保存到相册

---

## 快速开始

```bash
cd app
node server.js            # 默认 http://localhost:8787
PORT=3000 node server.js  # 自定义端口
```

要求 **Node.js ≥ 18** —— 只用内置模块，无需 `npm install`。

打开页面后会依次调用 `/api/daily` 取内容、`/api/img` 代理下载配图，然后在浏览器端合成。

| 路径 | 说明 |
| --- | --- |
| `GET /api/daily` | 结构化今日内容（JSON），`?refresh=1` 跳过缓存 |
| `GET /api/img?u=<url>` | 图片代理，仅放行 `static.esdict.cn` 等白名单域名 |
| `GET /api/health` | 健康检查 |

### 调试参数

- `?raw=1` —— 只显示海报本身，便于导出 / 截图
- `?bg=natural|cover` —— 指定背景模式
- `?long=1` —— 长版海报（旧参数 `?ex=1` 同样生效）
- `?word=&en=&cn=&source=` —— 覆盖文案，便于排版测试
- `?ph=ˈɪmpʌls`（单音标）或 `?ph=英:ɪɡˈzæmpl|美:ɪɡˈzɑːmpl`（双音标）—— 覆盖音标，便于测试排版

---

## 目录结构

```
.
├── README.md                  # 本文件
├── app/                       # 应用源码（零依赖 Node）
│   ├── server.js              #   抓取 + 解析 + 图片代理 + 静态托管
│   ├── package.json
│   ├── README.md              #   实现细节、接口示例、合成分层说明
│   └── public/
│       ├── index.html
│       ├── styles.css
│       ├── app.js             #   Canvas 排版与合成
│       ├── manifest.webmanifest
│       ├── icons/             #   PWA 图标
│       ├── fonts/             #   Inter + Playfair Display（OFL 授权）
│       └── assets/template.jpg  # 默认模板
└── docs/
    ├── preview.png            # 成品预览
    └── reference/             # 设计参考素材
```

更细的实现说明（分层结构、自适应规则、接口返回示例）见 [`app/README.md`](app/README.md)。

---

## 部署

任意能跑 Node 的平台均可，只需一条启动命令：

```bash
node server.js          # 监听 process.env.PORT
```

无构建步骤、无 `node_modules`、无外部服务依赖。

---

## 说明

内容版权归欧路词典 / 每日英语听力所有。本项目仅将公开页面内容排版为个人打卡海报，
请勿用于商业用途。字体 Inter、Playfair Display 均为 SIL Open Font License 授权。
