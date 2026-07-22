#!/usr/bin/env python3
"""
scripts/make_store_assets.py
Generate Chrome Web Store promotional tile images from FakeNewsDetectorCover.jpg.

Source cover: FakeNewsDetectorCover.jpg (1408x704, aspect 2.0)

Outputs written to store_assets/:
  small_promo_440x280.png   — Small promotional tile (440x280)
  marquee_1400x560.png      — Marquee / hero tile (1400x560)
  icon128.png               — Copy of icons/icon128.png

Usage:
  python3 scripts/make_store_assets.py
"""

from pathlib import Path
from PIL import Image

ROOT  = Path(__file__).resolve().parent.parent
COVER = ROOT / "FakeNewsDetectorCover.jpg"
ICON  = ROOT / "icons" / "icon128.png"
OUT   = ROOT / "store_assets"

OUT.mkdir(exist_ok=True)

# (filename, target_width, target_height)
TARGETS = [
    ("small_promo_440x280.png",  440, 280),
    ("marquee_1400x560.png",    1400, 560),
]


def center_crop(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """
    Scale the image to fully cover (target_w x target_h) — no distortion,
    no letterbox — then center-crop to exact dimensions.

    For small_promo 440x280 (aspect 1.571) from cover 1408x704 (aspect 2.0):
      scale = max(440/1408, 280/704) = max(0.3125, 0.3977) = 0.3977
      scaled size -> 560x280; crop 60px from left and right -> 440x280

    For marquee 1400x560 (aspect 2.5) from cover 1408x704 (aspect 2.0):
      scale = max(1400/1408, 560/704) = max(0.9943, 0.7955) = 0.9943
      scaled size -> 1400x700; crop 70px from top and bottom -> 1400x560
    """
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    new_w = round(src_w * scale)
    new_h = round(src_h * scale)
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top  = (new_h - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def main() -> None:
    cover = Image.open(COVER).convert("RGB")
    print(f"Source: {COVER.name}  {cover.size[0]}x{cover.size[1]}")

    for filename, w, h in TARGETS:
        out_path = OUT / filename
        cropped = center_crop(cover, w, h)
        cropped.save(out_path, "PNG", optimize=True)
        # Verify dimensions
        check = Image.open(out_path)
        actual_w, actual_h = check.size
        status = "OK" if (actual_w, actual_h) == (w, h) else "ERROR"
        print(f"  [{status}] {filename}: {actual_w}x{actual_h}  (expected {w}x{h})")
        if status == "ERROR":
            raise AssertionError(
                f"Size mismatch for {filename}: expected {w}x{h}, got {actual_w}x{actual_h}"
            )

    # Copy icon128
    icon_out = OUT / "icon128.png"
    icon = Image.open(ICON)
    icon.save(icon_out, "PNG")
    check_icon = Image.open(icon_out)
    print(f"  [OK] icon128.png: {check_icon.size[0]}x{check_icon.size[1]}")

    print(f"\nDone. Store assets written to: {OUT}")


if __name__ == "__main__":
    main()
