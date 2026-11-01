"""Generate a deterministic folded-page / M-arrow icon without font dependencies."""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 24, 32, 48, 64, 128, 256)


def draw_icon(size):
    scale = 4
    image = Image.new('RGBA', (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = size * scale / 256
    points = lambda items: [(round(x * unit), round(y * unit)) for x, y in items]
    ink = (20, 20, 20, 255)
    stroke = max(4, round(10 * unit))
    page = points([(38, 12), (166, 12), (218, 64), (218, 242), (38, 242), (38, 12)])
    draw.polygon(page, fill=(255, 255, 255, 255))
    draw.line(page, fill=ink, width=stroke, joint='curve')
    draw.line(points([(166, 12), (166, 64), (218, 64)]), fill=ink, width=stroke, joint='curve')
    draw.line(points([(68, 177), (68, 123), (92, 151), (116, 123), (116, 177)]), fill=ink, width=stroke, joint='curve')
    draw.line(points([(164, 121), (164, 176)]), fill=ink, width=stroke)
    draw.line(points([(145, 157), (164, 177), (183, 157)]), fill=ink, width=stroke, joint='curve')
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    image.putalpha(image.getchannel('A').point(lambda value: 0 if value <= 2 else value))
    return image


def make_icon(target):
    frames = [draw_icon(size) for size in SIZES]
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    frames[-1].save(target, format='ICO', sizes=[(size, size) for size in SIZES], append_images=frames[:-1])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', type=Path)
    parser.add_argument('--preview', type=Path)
    args = parser.parse_args()
    make_icon(args.target)
    if args.preview:
        preview = Image.new('RGBA', (448, 280), (238, 238, 238, 255))
        preview.alpha_composite(draw_icon(256), (176, 12))
        for index, size in enumerate(SIZES[:5]):
            preview.alpha_composite(draw_icon(size), (16, 12 + index * 48))
        preview.save(args.preview)
    print(args.target)
