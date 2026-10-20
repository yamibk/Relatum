"""Convert the checked-in icon source PNG into a transparent Windows icon."""
from pathlib import Path
import sys
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(__file__).resolve().parent / "icon-source.png"
TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets" / "app-icon.ico"

SIZE = 256

# 1. Load the enlarged preview image
if not SOURCE.is_file():
    raise FileNotFoundError(f"Icon source is missing: {SOURCE}")
img = Image.open(SOURCE).convert("RGBA")
pixels = img.load()
width, height = img.size

# 2. Make all white background pixels transparent, preserving the lines and nodes.
# The background is white (255, 255, 255).
for y in range(height):
    for x in range(width):
        r, g, b, a = pixels[x, y]
        # Check if the pixel is very light (background)
        if r > 230 and g > 230 and b > 230:
            min_c = min(r, g, b)
            # Soft transparency gradient for anti-aliasing edges
            if min_c >= 250:
                pixels[x, y] = (r, g, b, 0)
            else:
                alpha = int(255 * (250 - min_c) / 20)
                pixels[x, y] = (r, g, b, alpha)

# 3. Crop tightly to remove any completely transparent margins
bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)

# 4. Paste into a square canvas with a little bit of padding
final_size = max(img.width, img.height)
final_size = int(final_size * 1.05) # 5% padding so it doesn't touch the edge of the icon bounds
square = Image.new('RGBA', (final_size, final_size), (0,0,0,0))
square.paste(img, ((final_size - img.width)//2, (final_size - img.height)//2))

# 5. Resize and save
final_img = square.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
final_img.save(
    TARGET,
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print(TARGET)
