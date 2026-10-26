# -*- coding: utf-8 -*-
"""生成 VESPER 扩展图标套 + 社媒宣传海报（极简黑白主题）。

品牌依据：src/ui/global.css 2026-10-25 黑白重构（深空蓝/星芒橙弃用，星号 ✳ 仍作品牌符号）。
旧蓝橙版本留档：assets/poster_1080_color.png 与 assets/icon_color_backup/。
"""
import os, math
from PIL import Image, ImageDraw, ImageFont

ASSETS = "/Users/ricklee/code/Vesper/assets"
ICON_DIR = "/Users/ricklee/code/Vesper/public/icon"
os.makedirs(ICON_DIR, exist_ok=True)

# ---- 品牌色（极简黑白，与 global.css 一致）----
INK    = (17, 17, 17)     # #111111 主色 / 文本
DIM    = (107, 114, 128)  # #6b7280 次级文本
BORDER = (229, 229, 229)  # #e5e5e5 边框
PAPER  = (255, 255, 255)  # #ffffff 背景
CARD   = (250, 250, 250)  # #fafafa 胶囊底
TAGG   = (156, 163, 175)  # #9ca3af 页脚次级

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
def font(sz):
    return ImageFont.truetype(FONT, sz)

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

# ---------- 徽标：星号 ✳（6 臂圆头，扁平纯色） ----------
def draw_emblem(size, arm_ratio=0.40, width_ratio=0.17, points=6, color=INK):
    cx = cy = size / 2.0
    L = size * arm_ratio
    w = max(2, int(size * width_ratio))
    sil = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(sil)
    for i in range(points):
        ang = -math.pi / 2 + i * (2 * math.pi / points)
        ex, ey = cx + L * math.cos(ang), cy + L * math.sin(ang)
        d.line([(cx, cy), (ex, ey)], fill=color + (255,), width=w, joint="curve")
        d.ellipse([ex - w / 2, ey - w / 2, ex + w / 2, ey + w / 2], fill=color + (255,))
    d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=color + (255,))
    return sil

# ---------- 图标：白底圆角方块 + 黑色星号 + 浅灰描边 ----------
def make_icon(S):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=PAPER + (255,))
    bw = max(1, round(S * 0.025))
    d.rounded_rectangle([bw // 2, bw // 2, S - 1 - bw // 2, S - 1 - bw // 2],
                        radius=int(S * 0.22), outline=BORDER + (255,), width=bw)
    img.alpha_composite(draw_emblem(S))
    return img

for S in (16, 32, 48, 96, 128, 512):
    make_icon(S).save(os.path.join(ICON_DIR, f"{S}.png"))
    print("icon", S)

# ---------- 文本工具 ----------
def text_w(draw, s, f):
    return sum(draw.textlength(ch, font=f) for ch in s)

def draw_centered(draw, cx, y, s, f, fill, spacing=0):
    total = text_w(draw, s, f) + spacing * max(0, len(s) - 1)
    x = cx - total / 2.0
    for ch in s:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + spacing

def draw_pill(draw, box, text, f):
    draw.rounded_rectangle(box, radius=18, fill=CARD + (255,), outline=BORDER + (255,), width=2)
    x0, y0, x1, y1 = box
    ty = y0 + (y1 - y0 - f.size) / 2.0 - 4
    draw_centered(draw, (x0 + x1) / 2.0, ty, text, f, INK)

# ---------- 海报（1080×1080，全矢量极简黑白） ----------
W = H = 1080
canvas = Image.new("RGBA", (W, H), PAPER + (255,))
d = ImageDraw.Draw(canvas)

# 徽标
canvas.alpha_composite(draw_emblem(230), ((W - 230) // 2, 106))

draw_centered(d, 540, 372, "VESPER", font(52), INK, spacing=20)
draw_centered(d, 540, 442, "粘贴之前，先过一遍暮星。", font(58), INK)
draw_centered(d, 540, 532, "把敏感信息挡在 AI 门外，全程在你的设备本地完成", font(30), DIM)

pills = [
    "纯本地处理 · 零服务器零上传",
    "多套脱敏方案 · 一键切换",
    "中文优先 · 身份证/手机号/IP/密钥",
    "免费使用 · 不限次数",
]
cw, ch, gx, gy = 470, 116, 30, 26
x0 = (W - (2 * cw + gx)) / 2.0
y0 = 606
fp = font(27)
for i, txt in enumerate(pills):
    bx = x0 + (i % 2) * (cw + gx)
    by = y0 + (i // 2) * (ch + gy)
    draw_pill(d, [bx, by, bx + cw, by + ch], txt, fp)

# 页脚黑带：Slogan + 平台标签
d.rectangle([0, 924, W, H], fill=INK + (255,))
draw_centered(d, 540, 968, "Your words pass. Your secrets don't.", font(26), PAPER)
draw_centered(d, 540, 1018, "Chrome / Edge 浏览器扩展", font(22), TAGG)

out = os.path.join(ASSETS, "poster_1080.png")
canvas.convert("RGB").save(out)
print("poster ->", out)
print("DONE")
