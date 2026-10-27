"""样张：A 取色静垫 / B 统一三色家族。不写 hy-*.png。"""
from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
FOOD = Path(r"d:\cursor-projects\Ariadne\图标素材\白底食物")
OUT = ROOT / "preview"
SIZE = 180
PAD = 16
CORNER = int(SIZE * 0.2237)

# 薄荷黑巧纸：薄荷 / 奶油纸 / 浅可可
FAMILY = (
    (200, 224, 214),  # mint
    (247, 241, 232),  # cream
    (214, 196, 178),  # cocoa milk
)


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
    return im


def mean_color(art: Image.Image) -> tuple[int, int, int]:
    opaque = [(r, g, b) for r, g, b, a in art.getdata() if a >= 180]
    if not opaque:
        return (240, 236, 230)
    n = len(opaque)
    return (
        sum(c[0] for c in opaque) // n,
        sum(c[1] for c in opaque) // n,
        sum(c[2] for c in opaque) // n,
    )


def quiet_from(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """抬亮成粉彩静垫，保留色相差。"""
    lift = 0.58
    r, g, b = (int(c * (1 - lift) + 255 * lift) for c in rgb)
    avg = (r + g + b) / 3
    k = 0.18
    return (
        int(r * (1 - k) + avg * k),
        int(g * (1 - k) + avg * k),
        int(b * (1 - k) + avg * k),
    )


def solid_plate(rgb: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGBA", (SIZE, SIZE), (*rgb, 255))


def place_art(plate: Image.Image, art: Image.Image) -> Image.Image:
    bbox = art.split()[-1].getbbox()
    if not bbox:
        return plate
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
    sh.putalpha(alpha.point(lambda v: int(v * 0.38)))
    shadow.alpha_composite(sh, (x0, y0 + 3))
    shadow = shadow.filter(ImageFilter.GaussianBlur(3))
    out = Image.alpha_composite(plate, shadow)
    out.alpha_composite(art, (x0, y0))
    return out


def round_mask() -> Image.Image:
    m = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=CORNER, fill=255)
    return m


def finish(tile: Image.Image, mask: Image.Image) -> Image.Image:
    r, g, b, a = tile.split()
    a = Image.composite(a, Image.new("L", (SIZE, SIZE), 0), mask)
    return Image.merge("RGBA", (r, g, b, a))


def main() -> None:
    foods = sorted(FOOD.glob("*.jpg")) + sorted(FOOD.glob("*.png"))
    pick = foods[:4]  # 同 4 张比两种垫
    OUT.mkdir(exist_ok=True)
    mask = round_mask()
    sheet_a: list[Image.Image] = []
    sheet_b: list[Image.Image] = []

    for i, path in enumerate(pick):
        art = knock_white_flood(Image.open(path))
        # A 取色静垫
        a_plate = solid_plate(quiet_from(mean_color(art)))
        a_tile = finish(place_art(a_plate, art), mask)
        a_name = f"A-sample-{i + 1:02d}.png"
        a_tile.save(OUT / a_name, optimize=True)
        sheet_a.append(a_tile)
        print("ok", a_name, quiet_from(mean_color(art)))

        # B 统一三色轮换
        b_plate = solid_plate(FAMILY[i % 3])
        b_tile = finish(place_art(b_plate, art), mask)
        b_name = f"B-sample-{i + 1:02d}.png"
        b_tile.save(OUT / b_name, optimize=True)
        sheet_b.append(b_tile)
        print("ok", b_name, FAMILY[i % 3])

    gap = 12
    label_h = 28
    w = SIZE * 4 + gap * 5
    h = SIZE * 2 + gap * 3 + label_h * 2
    board = Image.new("RGB", (w, h), (250, 247, 242))
    draw = ImageDraw.Draw(board)
    draw.text((gap, 8), "A  取色静垫（每图标自取色）", fill=(60, 50, 40))
    draw.text((gap, gap + label_h + SIZE + 8), "B  统一三色（薄荷 / 奶油 / 浅可可）", fill=(60, 50, 40))
    y0 = label_h + gap
    y1 = label_h * 2 + SIZE + gap * 2
    for i, tile in enumerate(sheet_a):
        board.paste(tile, (gap + i * (SIZE + gap), y0), tile)
    for i, tile in enumerate(sheet_b):
        board.paste(tile, (gap + i * (SIZE + gap), y1), tile)
    board.save(OUT / "compare-AB.png", optimize=True)
    print("ok compare-AB.png")


if __name__ == "__main__":
    main()
