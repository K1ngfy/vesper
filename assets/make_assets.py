# -*- coding: utf-8 -*-
"""生成 VESPER 扩展图标套 + 社媒宣传海报（极简黑白 · 半阖之瞳 Veiled Eye）。

品牌依据：极简黑白主题（#111111 / #ffffff），使用「半阖之瞳」纯矢量徽标（无星号），
8× 超采样抗锯齿输出标准 8-bit RGBA PNG（透明圆角，兼容各版本 Chrome / Edge）。
旧版本留档：assets/poster_1080_color.png 与 assets/icon_color_backup/。
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
ICON_DIR = os.path.join(ROOT, "public", "icon")
os.makedirs(ICON_DIR, exist_ok=True)

# ---- 品牌色（极简黑白，与 global.css 一致）----
INK = (17, 17, 17)         # #111111 主色 / 文本
DIM = (107, 114, 128)      # #6b7280 次级文本
BORDER = (229, 229, 229)   # #e5e5e5 海报边框
ICON_BORDER = (212, 212, 216)  # #d4d4d8 图标描边（浅色工具栏清晰可见）
PAPER = (255, 255, 255)    # #ffffff 背景
CARD = (250, 250, 250)     # #fafafa 胶囊底
TAGG = (156, 163, 175)     # #9ca3af 页脚次级

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def font(sz):
    return ImageFont.truetype(FONT, sz)


def sample_quad(p0, p1, p2, steps=96):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
        y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


def sample_arc(cx, cy, r, a0, a1, steps=64):
    return [
        (cx + r * math.cos(a0 + (a1 - a0) * i / steps),
         cy + r * math.sin(a0 + (a1 - a0) * i / steps))
        for i in range(steps + 1)
    ]


# ---------- 徽标：半阖之瞳 Veiled Eye（viewBox 0..100，8× 超采样抗锯齿） ----------
def draw_emblem(size, color=INK, pad_ratio=0.0, supersample=8):
    hi = size * supersample
    img = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = hi * pad_ratio
    span = hi - 2.0 * pad

    def pt(x, y):
        return (pad + (x / 100.0) * span, pad + (y / 100.0) * span)

    fill = color + (255,)

    # 1) 上半实心黑幕上睑：M 4 45.5 Q 50 -11.5 96 45.5 Z
    upper = [pt(x, y) for x, y in sample_quad((4.0, 45.5), (50.0, -11.5), (96.0, 45.5))]
    d.polygon(upper, fill=fill)

    # 2) 半隐瞳孔：M 36.5 52.5 A 13.5 13.5 0 0 0 63.5 52.5 Z（下半圆，角度 π → 0）
    pupil = [pt(x, y) for x, y in sample_arc(50.0, 52.5, 13.5, math.pi, 0.0)]
    d.polygon(pupil, fill=fill)

    # 3) 下半弧形眼廓：M 4 53 Q 50 113 96 53 L 81.5 53 Q 50 95 18.5 53 Z
    lower_outer = sample_quad((4.0, 53.0), (50.0, 113.0), (96.0, 53.0))
    lower_inner = sample_quad((81.5, 53.0), (50.0, 95.0), (18.5, 53.0))
    lower = [pt(x, y) for x, y in (lower_outer + lower_inner)]
    d.polygon(lower, fill=fill)

    return img.resize((size, size), Image.Resampling.LANCZOS)


# ---------- 扩展图标：透明圆角白底 + 浅灰描边 + 放大版半阖之瞳（标准 RGBA PNG） ----------
def make_icon(size):
    ss = 8 if size <= 128 else 4
    hi = size * ss
    img = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = hi * 0.22
    # 小尺寸保证至少 ~1px 清晰描边，大尺寸 ~2.5% 优雅细边（Pillow outline 严格向内绘制，无需额外 inset）
    bw = max(ss, round(hi * (0.045 if size <= 32 else 0.024)))
    d.rounded_rectangle(
        [0, 0, hi - 1, hi - 1],
        radius=radius,
        fill=PAPER + (255,),
        outline=ICON_BORDER + (255,),
        width=bw,
    )

    # 放大占比：外留仅 6% 呼吸边，使半阖之瞳在 16px~512px 均醒目饱满
    emblem = draw_emblem(hi, color=INK, pad_ratio=0.06, supersample=2)
    img.alpha_composite(emblem)
    return img.resize((size, size), Image.Resampling.LANCZOS)


for S in (16, 32, 48, 96, 128, 512):
    out_path = os.path.join(ICON_DIR, f"{S}.png")
    make_icon(S).save(out_path, format="PNG", optimize=True)
    print("icon", S, "->", out_path)


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

# 徽标（半阖之瞳，略放大居中）
emblem_sz = 264
canvas.alpha_composite(draw_emblem(emblem_sz, color=INK, pad_ratio=0.0, supersample=4), ((W - emblem_sz) // 2, 92))

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
