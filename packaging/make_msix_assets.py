"""Generate the exact PNG asset sizes referenced by AppxManifest.xml."""
from pathlib import Path

from PIL import Image


PACKAGING = Path(__file__).resolve().parent
SOURCE = PACKAGING / "icon-source.png"


def contain(source: Image.Image, size: tuple[int, int], icon_size: int) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    icon = source.copy()
    icon.thumbnail((icon_size, icon_size), Image.Resampling.LANCZOS)
    position = ((size[0] - icon.width) // 2, (size[1] - icon.height) // 2)
    canvas.alpha_composite(icon, position)
    return canvas


def main(output: Path) -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Icon source is missing: {SOURCE}")
    output.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGBA")
    assets = {
        "StoreLogo.png": ((50, 50), 50),
        "Square44x44Logo.png": ((44, 44), 44),
        "Square150x150Logo.png": ((150, 150), 150),
        "Wide310x150Logo.png": ((310, 150), 120),
    }
    for name, (size, icon_size) in assets.items():
        contain(source, size, icon_size).save(output / name, optimize=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    main(args.output)
