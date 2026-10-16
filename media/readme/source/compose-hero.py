#!/usr/bin/env python3
"""Compose media/readme/hero.png from the layout SVG plus a real screenshot.

The hero is a hybrid: hero-layout.svg owns every pixel of typography, framing
and colour, and hero-shot.png supplies the only raster material — a real crop
of a real VS Code window. Nothing here is generated art, so the screenshot can
be replaced at any time without touching the layout.

The SVG is the editable source, the PNG is what the README embeds. Chromium is
used as the rasteriser because it is the renderer the published asset is judged
in, and GitHub will draw the same file the same way.

    python media/readme/source/compose-hero.py [output.png]

Requirements: Python 3.9+, Pillow (`pip install Pillow`), and any Chromium-based
browser. Nothing else in the repository needs Pillow; this build script is the
only consumer.

Environment:
    CHROME_PATH  override the browser executable
"""

from __future__ import annotations

import base64
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
from uuid import uuid4
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
ICON = REPO / "media" / "icon.svg"

# Canvas and the reserved screenshot window, in SVG units. Keep in step with
# the geometry in hero-layout.svg.
WIDTH, HEIGHT = 1200, 400
SHOT_X, SHOT_Y, SHOT_W, SHOT_H = 594, 75, 537, 279
SCALE = 2  # render at 2x so the PNG stays crisp on high-DPI displays

CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


def find_chrome() -> str:
    override = os.environ.get("CHROME_PATH")
    if override:
        return override
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in CHROME_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    raise SystemExit("no Chromium found; set CHROME_PATH to a chrome/msedge executable")


def cover_crop(image: Image.Image, width: int, height: int) -> Image.Image:
    """Centre-crop to the target aspect ratio, then resize.

    The screenshot is captured at whatever size the window happened to be; the
    layout owns the aspect ratio, so the crop happens here rather than in the
    capture. Crop the source around its subject first if the interesting part
    is not centred.
    """
    target = width / height
    sw, sh = image.size
    if sw / sh > target:
        keep = round(sh * target)
        left = (sw - keep) // 2
        image = image.crop((left, 0, left + keep, sh))
    else:
        keep = round(sw / target)
        top = (sh - keep) // 2
        image = image.crop((0, top, sw, top + keep))
    return image.resize((width, height), Image.LANCZOS)


def data_uri(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def whale_path() -> str:
    match = re.search(r'<path[^>]*\sd="([^"]+)"', ICON.read_text(encoding="utf-8"))
    if not match:
        raise SystemExit(f"no <path d=...> found in {ICON}")
    return match.group(1)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "media" / "readme" / "hero.png"

    shot = Image.open(HERE / "hero-shot.png").convert("RGB")
    shot = cover_crop(shot, SHOT_W * SCALE, SHOT_H * SCALE)

    svg = (HERE / "hero-layout.svg").read_text(encoding="utf-8")
    for token, value in (
        ("{{WHALE}}", whale_path()),
        ("{{SHOT_DATA}}", data_uri(shot)),
    ):
        svg = svg.replace(token, value)

    # Unique staging paths, and a temp output replaced into place atomically:
    # two overlapping runs must not share the SVG one of them is still handing
    # to Chromium, or the PNG the other is halfway through writing. The temp
    # output has to sit beside the destination — os.replace cannot cross
    # filesystems, and the system temp directory is often on another drive.
    out.parent.mkdir(parents=True, exist_ok=True)
    pending = out.with_name(f".{out.stem}-{uuid4().hex}.png")
    try:
        with tempfile.TemporaryDirectory(prefix="hero-render-") as work:
            work_dir = Path(work)
            staged = work_dir / "hero-render.svg"
            staged.write_text(svg, encoding="utf-8")
            subprocess.run(
                [
                    find_chrome(),
                    "--headless",
                    "--disable-gpu",
                    "--hide-scrollbars",
                    f"--force-device-scale-factor={SCALE}",
                    "--default-background-color=00000000",
                    f"--user-data-dir={work_dir / 'profile'}",
                    f"--screenshot={pending}",
                    f"--window-size={WIDTH},{HEIGHT}",
                    staged.as_uri(),
                ],
                check=True,
                capture_output=True,
            )
        os.replace(pending, out)
    finally:
        pending.unlink(missing_ok=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
