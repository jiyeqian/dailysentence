#!/usr/bin/env python3
"""生成 dailysentence 的 App 图标三件套（512 / 192 / 180）。

图标构成（自上而下）：蓝色渐变圆角底 + 大写 D + 一条白色横杠 + 底部英文 dailysentence。
本脚本只重画「横杠 + 英文」这两层，D 与底色、圆角一概不动。

特性：
- **幂等**：先扫描并清除底部已有的横杠 / 文字，再重绘，所以可以反复运行调参，
  不会像硬编码清除区那样因为上一次画得更宽而残留出重影。
- 英文宽度自适应字号（不超过目标宽度）；横杠长度**对齐英文宽度**。
- 输出三档，192 / 180 由 512 缩放而来，保证视觉一致。
- 自动校验 PWA maskable 安全区（关键内容须落在画布中心 80% 直径的圆内）。

依赖 Pillow（woff2 也能直接读）：
    ~/.workbuddy/binaries/python/envs/default/bin/pip install pillow

用法：
    ~/.workbuddy/binaries/python/envs/default/bin/python tools/make-icons.py [目标宽度] [文字中心Y]
    # 例：python tools/make-icons.py 240 403
    # 想恢复原始图标后重来：git checkout -- app/public/icons/
"""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
ICONS = PROJECT_ROOT / 'app' / 'public' / 'icons'
FONT = PROJECT_ROOT / 'app' / 'public' / 'fonts' / 'Inter.woff2'

TEXT = 'dailysentence'
TARGET_W = int(sys.argv[1]) if len(sys.argv) > 1 else 240   # 英文目标宽度
TEXT_CY = int(sys.argv[2]) if len(sys.argv) > 2 else 403    # 英文垂直中心
BAR_CY = 371          # 横杠垂直中心（原图标位置）
BAR_H = 11            # 横杠高度（与原图标一致）
TOP_SCAN = 320        # 只扫 D 以下，避免误伤大写 D
PAD = 6               # 清除时向外扩的边量
SAFE_R = 0.4 * 512    # maskable 安全区半径（画布 80% 直径）

im = Image.open(ICONS / 'icon-512.png').convert('RGBA')
W, H = im.size
px = im.load()


def is_fg(c):
    """白色前景（文字 / 横杠 / D）。"""
    return c[3] > 40 and c[0] > 170 and c[1] > 170 and c[2] > 170


# 1) 扫描 D 以下的白色前景行段 —— 通常是「横杠」与「英文」两段
segs, start = [], None
for y in range(TOP_SCAN, H):
    n = sum(1 for x in range(0, W, 2) if is_fg(px[x, y]))
    if n > 0 and start is None:
        start = y
    elif n == 0 and start is not None:
        segs.append((start, y - 1))
        start = None
if start is not None:
    segs.append((start, H - 1))
print(f'检测到底部前景段: {segs}')


def seg_bbox(y0, y1):
    mnx, mxx = W, -1
    for y in range(y0, y1 + 1):
        for x in range(W):
            if is_fg(px[x, y]):
                mnx = min(mnx, x)
                mxx = max(mxx, x)
    return mnx, mxx


# 2) 逐段清除：按行取左右两侧真实背景色做水平插值，保持蓝色渐变不断裂
for (s0, s1) in segs:
    bx0, bx1 = seg_bbox(s0, s1)
    x0, x1 = max(1, bx0 - PAD), min(W - 2, bx1 + PAD)
    y0, y1 = max(0, s0 - PAD), min(H - 1, s1 + PAD)
    for y in range(y0, y1 + 1):
        lc, rc = px[x0 - 1, y], px[x1 + 1, y]
        span = (x1 + 1) - (x0 - 1)
        for x in range(x0, x1 + 1):
            t = (x - (x0 - 1)) / span
            c = tuple(int(round(lc[i] + (rc[i] - lc[i]) * t)) for i in range(4))
            px[x, y] = c
    print(f'  清除 y{s0}-{s1} / x{bx0}-{bx1}')

# 3) 自适应字号：从大到小取宽度不超标的那一档
draw = ImageDraw.Draw(im)
for size in range(80, 10, -1):
    f = ImageFont.truetype(str(FONT), size)
    bb = draw.textbbox((0, 0), TEXT, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    if tw <= TARGET_W:
        break

# 4) 英文：居中绘制（先画字，下一步才能量到它「可见笔画」的真实宽度）
draw.text((W // 2, TEXT_CY), TEXT, font=f, fill=(255, 255, 255, 255), anchor='mm')

# 5) 量英文实际可见笔画宽度
#    textbbox 报的是排版包围盒（含字体左右侧边留白），直接拿它当横杠长度会让
#    横杠比字形宽出几个像素；所以扫描真实白色像素来取值。
px = im.load()
ty0, ty1 = TEXT_CY - th // 2 - 2, TEXT_CY + th // 2 + 2
tx0, tx1 = W, -1
for y in range(ty0, ty1 + 1):
    for x in range(W):
        if is_fg(px[x, y]):
            tx0 = min(tx0, x)
            tx1 = max(tx1, x)
real_w = tx1 - tx0 + 1

# 6) 横杠：长度对齐英文可见笔画宽度
left = W // 2 - real_w / 2
right = W // 2 + real_w / 2
draw.rectangle([left, BAR_CY - BAR_H / 2, right, BAR_CY + BAR_H / 2],
               fill=(255, 255, 255, 255))

# 7) maskable 安全区校验：英文与横杠的包围盒四角都要落在中心圆内
boxes = {
    '英文': (tx0, TEXT_CY - th / 2, tx1, TEXT_CY + th / 2),
    '横杠': (left, BAR_CY - BAR_H / 2, right, BAR_CY + BAR_H / 2),
}
print(f'字号={size} 英文排版宽={tw} 可见宽={real_w} 高={th} 横杠宽={int(right - left)}')
ok = True
for name, (bx0, by0, bx1, by1) in boxes.items():
    worst = max(((x - W / 2) ** 2 + (y - H / 2) ** 2) ** 0.5
                for x in (bx0, bx1) for y in (by0, by1))
    good = worst <= SAFE_R
    ok = ok and good
    print(f'  maskable {name}: 最远角={worst:.1f} / 安全半径={SAFE_R:.1f} -> '
          f'{"OK" if good else "超出"}')
if not ok:
    print('!! 内容超出 maskable 安全区，请调小 TARGET_W 或把 TEXT_CY 上移')

# 7) 落盘：512 存原件，192 / 180 由它缩放
im.save(ICONS / 'icon-512.png')
for s in (192, 180):
    im.resize((s, s), Image.LANCZOS).save(ICONS / f'icon-{s}.png')
print('已写入 icon-512 / 192 / 180')
