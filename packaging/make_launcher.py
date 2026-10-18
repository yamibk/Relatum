"""Build a monochrome launcher icon and reuse the desktop executable's archive."""
import argparse
from pathlib import Path


ICON_SIZES = [(size, size) for size in (16, 24, 32, 48, 64, 128, 256)]


def make_icon(source: Path, target: Path) -> None:
    from PIL import Image, ImageOps

    if source.resolve() == target.resolve():
        raise ValueError("Launcher icon must not replace the application icon")
    frames = []
    with Image.open(source) as image:
        available = image.ico.sizes()
        for size in ICON_SIZES:
            if size in available:
                frame = image.ico.getimage(size).convert("RGBA")
            else:
                frame = image.convert("RGBA").resize(size, Image.Resampling.LANCZOS)
            alpha = frame.getchannel("A")
            # Ignore transparent margins when adjusting contrast. Keep light nodes
            # below white so the monochrome graph remains visible in Explorer.
            visible = alpha.point(lambda value: 255 if value >= 128 else 0)
            gray = ImageOps.autocontrast(ImageOps.grayscale(frame), mask=visible)
            gray = gray.point(lambda value: 24 + round(value * 184 / 255))
            frames.append(Image.merge("RGBA", (gray, gray, gray, alpha)))
    frames[-1].save(target, format="ICO", sizes=ICON_SIZES, append_images=frames[:-1])


def make_exe(source: Path, target: Path, icon: Path) -> None:
    from PyInstaller.archive.readers import CArchiveReader
    from PyInstaller.utils.win32.icon import CopyIcons_FromIco
    from PyInstaller.utils.win32.winutils import update_exe_pe_checksum

    if source.resolve() == target.resolve():
        raise ValueError("Launcher executable must not replace the application executable")
    original = source.read_bytes()
    archive = CArchiveReader(str(source)).raw_pkg_data()
    if not archive or not original.endswith(archive):
        raise ValueError("Expected an unsigned PyInstaller executable with an appended archive")
    # Windows resource updates can discard overlays. Apply the icon to the PE
    # alone, then append the exact original archive, as PyInstaller itself does.
    target.write_bytes(original[:-len(archive)])
    CopyIcons_FromIco(str(target), [str(icon)])
    with target.open("ab") as output:
        output.write(archive)
    update_exe_pe_checksum(str(target))
    if CArchiveReader(str(target)).raw_pkg_data() != archive:
        raise RuntimeError("Launcher archive differs from the application archive")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    icon_parser = commands.add_parser("icon", help="Create the grayscale ICO")
    exe_parser = commands.add_parser("exe", help="Create an EXE with the launcher icon")
    for command in (icon_parser, exe_parser):
        command.add_argument("source", type=Path)
        command.add_argument("target", type=Path)
    exe_parser.add_argument("icon", type=Path)
    args = parser.parse_args()
    if args.command == "icon":
        make_icon(args.source, args.target)
    else:
        make_exe(args.source, args.target, args.icon)
    print(args.target)


if __name__ == "__main__":
    main()
