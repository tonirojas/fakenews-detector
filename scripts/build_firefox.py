#!/usr/bin/env python3
"""
scripts/build_firefox.py
Builds a Firefox-compatible distribution of the FakeNews Detector extension.

Usage (from repo root):
    python scripts/build_firefox.py

Output:
    dist/firefox/  — ready to load from about:debugging → This Firefox → Load Temporary Add-on

Differences from the Chrome source:
  - background: service_worker → scripts array (MV3 Firefox format)
  - permissions: tabCapture, offscreen, sidePanel removed
  - side_panel key removed; sidebar_action added
  - options_page → options_ui (open_in_tab: true)
  - browser_specific_settings (Gecko) added
  - offscreen/ directory excluded (tabCapture/offscreen APIs unavailable on Firefox)
"""

import json
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
OUTPUT_DIR = REPO_ROOT / "dist" / "firefox"

# Directories and files to copy from repo root (relative paths)
# offscreen/ is intentionally excluded — those APIs do not exist in Firefox.
COPY_ITEMS = [
    "background.js",
    "lib",
    "content",
    "popup",
    "options",
    "sidepanel",
    "icons",
]

# Permissions that exist only in Chrome/Edge and must be stripped for Firefox
REMOVE_PERMISSIONS = {"tabCapture", "offscreen", "sidePanel"}


def main():
    # Clean and recreate output directory
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True)

    # Copy source files
    for item in COPY_ITEMS:
        src = REPO_ROOT / item
        dst = OUTPUT_DIR / item
        if src.is_dir():
            shutil.copytree(src, dst)
        elif src.is_file():
            shutil.copy2(src, dst)
        else:
            print(f"  WARNING: {src} not found — skipping", file=sys.stderr)

    # Read and patch manifest.json
    manifest_src = REPO_ROOT / "manifest.json"
    with open(manifest_src, encoding="utf-8") as f:
        manifest = json.load(f)

    # 1. Replace service_worker background with scripts array (Firefox MV3 format)
    manifest["background"] = {
        "scripts": ["background.js"],
        "type": "module",
    }

    # 2. Remove Chrome-only permissions
    manifest["permissions"] = [
        p for p in manifest.get("permissions", [])
        if p not in REMOVE_PERMISSIONS
    ]

    # 3. Remove Chrome side_panel key
    manifest.pop("side_panel", None)

    # 4. Add Firefox sidebar_action
    manifest["sidebar_action"] = {
        "default_panel": "sidepanel/sidepanel.html",
        "default_title": "FakeNews Detector",
        "default_icon": "icons/icon48.png",
    }

    # 5. Replace options_page with options_ui
    manifest.pop("options_page", None)
    manifest["options_ui"] = {
        "page": "options/options.html",
        "open_in_tab": True,
    }

    # 6. Add browser_specific_settings for Gecko
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": "fakenews-detector@tonirojas.github.io",
            "strict_min_version": "128.0",  # type:"module" background requires Firefox 128+
        },
        "gecko_android": {
            "strict_min_version": "128.0",  # same requirement on Android
        },
    }

    # Write patched manifest
    manifest_dst = OUTPUT_DIR / "manifest.json"
    with open(manifest_dst, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Summary
    print(f"Firefox build written to: {OUTPUT_DIR}")
    print("Manifest changes applied:")
    print("  background: service_worker -> scripts array (MV3 Firefox)")
    print(f"  permissions removed: {', '.join(sorted(REMOVE_PERMISSIONS))}")
    print("  side_panel key removed")
    print("  sidebar_action added")
    print("  options_page -> options_ui (open_in_tab: true)")
    print("  browser_specific_settings (Gecko / gecko_android) added")
    print("  offscreen/ directory excluded")


if __name__ == "__main__":
    main()
