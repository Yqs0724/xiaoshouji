"""白底食物 → iOS 图标：纯抠图 + 轻投影（透明底）。"""
from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
FOOD = Path(r"d:\cursor-projects\Ariadne\图标素材\白底食物")
OUT = ROOT
SIZE = 180
PAD = 14
CORNER = int(SIZE * 0.2237)


def knock_white_flood(im: Image.Image, thr: int = 246) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_bg(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a > 0 and r >= thr and g >= thr and b >= thr

    seen = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()

    def push(x: int, y: int) -> None:
        i = y * w + x
        if seen[i] or not is_bg(x, y):
            return
        seen[i] = 1
        q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        if x:
            push(x - 1, y)
        if x + 1 < w:
            push(x + 1, y)
        if y:
            push(x, y - 1)
        if y + 1 < h:
            push(x, y + 1)

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if r >= thr - 18 and g >= thr - 18 and b >= thr - 18:
                edge = False
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                        edge = True
                        break
                if edge:
                    fade = max(0, min(r, g, b) - (thr - 18))
                    px[x, y] = (r, g, b, max(0, int(a * (1 - fade / 18))))
    return im


def compose(src: Image.Image) -> Image.Image:
    art = knock_white_flood(src)
    bbox = art.split()[-1].getbbox()
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    if not bbox:
        return out
    art = art.crop(bbox)
    aw, ah = art.size
    box = SIZE - PAD * 2
    scale = min(box / aw, box / ah)
    nw, nh = max(1, int(aw * scale)), max(1, int(ah * scale))
    art = art.resize((nw, nh), Image.Resampling.LANCZOS)
    x0, y0 = (SIZE - nw) // 2, (SIZE - nh) // 2

    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    alpha = art.split()[-1]
    sh = Image.new("RGBA", (nw, nh), (40, 30, 20, 100))
    sh.putalpha(alpha.point(lambda v: int(v * 0.35)))
    shadow.alpha_composite(sh, (x0, y0 + 3))
    shadow = shadow.filter(ImageFilter.GaussianBlur(3))

    out = Image.alpha_composite(out, shadow)
    out.alpha_composite(art, (x0, y0))
    return out


def round_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def main() -> None:
    foods = sorted(FOOD.glob("*.jpg")) + sorted(FOOD.glob("*.png"))
    assert foods, "no food in " + str(FOOD)
    mask = round_mask(SIZE, CORNER)
    for i, src in enumerate(foods[:18]):
        tile = compose(Image.open(src))
        r, g, b, a = tile.split()
        a = Image.composite(a, Image.new("L", (SIZE, SIZE), 0), mask)
        tile = Image.merge("RGBA", (r, g, b, a))
        name = f"hy-{i + 1:02d}.png"
        tile.save(OUT / name, optimize=True)
        print("ok", name, "<-", src.name)


if __name__ == "__main__":
    main()
