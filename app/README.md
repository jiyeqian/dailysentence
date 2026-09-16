# 每日一句 · 海报生成器

把 [欧路词典「英语每日一句」](https://dict.eudic.net/home/dailysentence) 的当日内容，
和你在乐词 App 里的「个人信息卡片」模板合成为一张 **1080×1920** 的手机海报。

- 自动抓取：中英文句子、关键词、音标、释义、出处、配图、真人发音
- 保留你模板里的头像 / 昵称 / 坚持天数 / 学习统计卡片
- 全流程在浏览器 Canvas 完成，**你的模板图不会被上传**
- 移动端优先的界面，可「添加到主屏幕」当作 App 使用

---

## 快速开始

```bash
cd app
node server.js          # 默认 http://localhost:8787
PORT=3000 node server.js  # 自定义端口
```

要求 Node.js ≥ 18（只用到内置模块，无需 `npm install`）。

打开页面后会：

1. 从 `/api/daily` 拿到今日内容；
2. 从 `/api/img` 代理下载当日配图；
3. 在浏览器里合成海报 —— 点「保存到相册」即可。

---

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/daily` | 返回结构化今日内容（JSON）。`?refresh=1` 跳过缓存 |
| `GET /api/img?u=<url>` | 图片代理，仅放行 `static.esdict.cn` 等白名单域名 |
| `GET /api/health` | 健康检查 |

`/api/daily` 返回示例：

```json
{
  "ok": true,
  "date": "9/16/2026",
  "dateISO": "2026-09-16",
  "en": "Great things are not done by impulse, ...",
  "cn": "伟大的事不是凭一时冲动完成的，……",
  "image": "/api/img?u=http%3A%2F%2Fstatic.esdict.cn%2F...",
  "word": "impulse",
  "phonetic": "ˈɪmpʌls",
  "definitions": [{ "pos": "n.", "text": "冲动；脉冲；心血来潮；一时兴起" }],
  "examples": [{ "en": "...", "cn": "..." }],
  "usages": ["by impulse 凭冲动", "on impulse 一时冲动"],
  "source": { "author": "文森特·威廉·梵高", "desc": "荷兰后印象派画家……" },
  "audio": { "normal": "https://api.frdic.com/...", "slow": "..." },
  "permalink": "https://dict.eudic.net/home/dailysentence/7661b706-..."
}
```

---

## 海报是怎么合成的

画布固定 **1080 × 1920**，自下而上分五层：

1. **背景图** —— 网页「每日一句」卡片左上角的配图（`#showerimg`）。三种模式：
   - `铺满`：等比裁切铺满整张海报
   - `模糊底 + 完整图`：模糊压暗铺底，中间叠一张上下羽化的完整清晰图
   - `模糊底 + 图片卡片`：模糊铺底 + 圆角阴影图片卡片
2. **压暗层** —— 顶部渐变 + 底部渐变 + 四角暗角 + 极轻的胶片噪点，保证白字可读
3. **顶部文字** —— 关键词（Playfair Display 衬线大标题）、装饰分隔线、英文句、中文句，
   带日期胶囊标签；字号会**自动收缩**以避免压到下方卡片
4. **个人信息卡片** —— 从你上传的模板图里**自动识别**白卡位置（近纯白二值化 + 连通域，
   取不接触画布边缘的最大白块），按圆角矩形抠出来重新贴上，并重绘投影
5. **底部解析面板** —— 毛玻璃质感（`ctx.filter = blur()` 自绘实现），含：
   左侧渐变强调竖条、关键词 + 等宽字体音标、词性色块（n./v./adj.…）+ 释义、
   可选例句引用块、出处行、分隔线 + 日期/来源页脚

### 自适应规则

- 顶部文字块会从设定字号起逐档缩小（最低 70%），直到不重叠卡片
- 底部面板高度按内容计算、贴底对齐；若与卡片冲突，卡片自动上移避让
- 中文逐字断行、英文按词断行，并避免行首出现 `，。、；：？！）】》」』` 等标点

### 可调项

| 控件 | 作用 |
| --- | --- |
| 文案 | 关键词 / 英文 / 中文 / 释义 / 出处，可任意改 |
| 背景图 | 三种背景模式 |
| 个人信息卡片 | 更换模板图、重新自动识别、上边距 / 高度 / 左右边距微调 |
| 排版微调 | 全局字号、日期标签、标题分隔线、显示出处、显示例句 |

> 想换模板：在乐词 App 里下载新版打卡图，导入本应用后点「重新识别」即可。

---

## 目录结构

```
app/
├── server.js                  # 零依赖 HTTP 服务：抓取 + 解析 + 图片代理 + 静态托管
├── package.json
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    ├── app.js                 # Canvas 排版与合成
    ├── manifest.webmanifest   # PWA，可添加到主屏幕
    ├── icons/
    ├── fonts/                 # Inter（正文） + Playfair Display（标题），均为 OFL 授权
    └── assets/template.jpg    # 默认模板（你的乐词打卡图）
```

## 调试参数

- `?raw=1` —— 只显示海报本身，便于导出/截图
- `?bg=cover|band|card` —— 指定背景模式
- `?ex=1` —— 打开例句
- `?word=&en=&cn=&source=` —— 覆盖文案（方便排版测试）

## 说明

内容版权归欧路词典 / 每日英语听力所有，本工具仅将公开页面内容排版成个人打卡海报，
请勿用于商业用途。字体 Inter、Playfair Display 均为 SIL Open Font License。
