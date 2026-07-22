#!/usr/bin/env python3
"""
package.py — build store-ready ZIPs for the extension.

Produces two artifacts in dist/:
  - fakenews-detector-chrome-v<version>.zip   → Chrome Web Store AND Edge Add-ons
    (Edge is Chromium; the exact same MV3 package is accepted by both stores —
     there is no separate "Edge build").
  - fakenews-detector-firefox-v<version>.zip  → Firefox AMO
    (built from dist/firefox/, which build_firefox.py generates: MV3 manifest
     adapted for Gecko, offscreen/tabCapture/sidePanel stripped).

Run from the repo root:  python scripts/package.py
Only bundles the runtime extension files — dev/store/doc assets are excluded.
"""

import json
import subprocess
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = REPO_ROOT / "dist"

# Runtime files/dirs that make up the Chromium extension package.
# Everything else in the repo (docs/, store_assets/, scripts/, README, source
# artwork, dist/, .git, .gitignore, STORE_LISTING.md) is intentionally excluded.
CHROME_ITEMS = [
    "manifest.json",
    "background.js",
    "lib",
    "content",
    "popup",
    "options",
    "sidepanel",
    "offscreen",
    "icons",
]


def read_version() -> str:
    manifest = json.loads((REPO_ROOT / "manifest.json").read_text(encoding="utf-8"))
    return manifest.get("version", "0.0.0")


def add_path(zf: zipfile.ZipFile, src: Path, arc_base: Path) -> int:
    """Add a file or directory tree to the zip; return the file count."""
    count = 0
    if src.is_dir():
        for f in sorted(src.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(arc_base).as_posix())
                count += 1
    elif src.is_file():
        zf.write(src, src.relative_to(arc_base).as_posix())
        count += 1
    return count


def zip_dir_contents(zf: zipfile.ZipFile, base: Path) -> int:
    count = 0
    for f in sorted(base.rglob("*")):
        if f.is_file():
            zf.write(f, f.relative_to(base).as_posix())
            count += 1
    return count


def main() -> None:
    version = read_version()
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # --- Chromium package (Chrome + Edge) ---
    chrome_zip = DIST_DIR / f"fakenews-detector-chrome-v{version}.zip"
    total = 0
    with zipfile.ZipFile(chrome_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in CHROME_ITEMS:
            src = REPO_ROOT / item
            if not src.exists():
                print(f"  WARNING: missing {item} — skipped")
                continue
            total += add_path(zf, src, REPO_ROOT)
    print(f"Chrome/Edge: {chrome_zip.relative_to(REPO_ROOT)}  "
          f"({total} files, {chrome_zip.stat().st_size // 1024} KB)")

    # --- Firefox package (AMO) ---
    # Ensure dist/firefox is fresh by running the Firefox build first.
    print("Building Firefox variant (build_firefox.py)...")
    subprocess.run([sys.executable, str(REPO_ROOT / "scripts" / "build_firefox.py")],
                   check=True, cwd=REPO_ROOT)
    ff_src = DIST_DIR / "firefox"
    if not ff_src.is_dir():
        print("  ERROR: dist/firefox not found after build — Firefox zip skipped")
        return
    firefox_zip = DIST_DIR / f"fakenews-detector-firefox-v{version}.zip"
    with zipfile.ZipFile(firefox_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        ff_count = zip_dir_contents(zf, ff_src)
    print(f"Firefox (AMO): {firefox_zip.relative_to(REPO_ROOT)}  "
          f"({ff_count} files, {firefox_zip.stat().st_size // 1024} KB)")

    print("\nDone. Upload the chrome zip to BOTH the Chrome Web Store and Edge "
          "Add-ons; upload the firefox zip to Firefox AMO (addons.mozilla.org).")


if __name__ == "__main__":
    main()
