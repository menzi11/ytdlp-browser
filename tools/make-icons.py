"""生成扩展图标：深色圆角底 + 蓝色下载箭头，16~128px 各一份。"""
import os
from PIL import Image, ImageDraw

S = 512
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
os.makedirs(OUT, exist_ok=True)

bg = (16, 19, 24, 255)
fg = (59, 130, 246, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)

cx = S / 2
shaft_w = S * 0.17
top = S * 0.17
shaft_h = S * 0.30
d.rectangle([cx - shaft_w / 2, top, cx + shaft_w / 2, top + shaft_h], fill=fg)

head_w = S * 0.48
head_h = S * 0.27
d.polygon(
    [
        (cx - head_w / 2, top + shaft_h - 2),
        (cx + head_w / 2, top + shaft_h - 2),
        (cx, top + shaft_h + head_h),
    ],
    fill=fg,
)

base_y = S * 0.79
base_w = S * 0.54
d.rounded_rectangle(
    [cx - base_w / 2, base_y, cx + base_w / 2, base_y + S * 0.065],
    radius=S * 0.033,
    fill=fg,
)

for size in (128, 48, 32, 16):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))

print("icons written to", OUT)
