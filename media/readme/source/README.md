# README asset sources

Editable sources for the images under `media/readme/`. Nothing here is packaged
into the vsix (`.vscodeignore` excludes this directory); nothing here is
generated art either — every raster layer is a crop of a real screenshot.

## `hero.png`

Composed: `hero-layout.svg` owns the typography, framing and colour, and
`hero-shot.png` supplies the terminal crop.

```sh
python media/readme/source/compose-hero.py          # writes media/readme/hero.png
```

The script needs Python 3.9+, Pillow, and any Chromium-based browser (set
`CHROME_PATH` if it is somewhere unusual). To change what the hero shows,
re-crop `hero-shot.png`; the layout reserves the window it is pasted into.

## `how-it-works.png`

A raster render of `how-it-works.svg`. It is a PNG rather than an SVG because
`vsce package` refuses to package a README that references a local `.svg`
("SVGs are restricted in README.md; please use other file image formats"), and
CI runs `npm run package`.

After editing the SVG:

```sh
chrome --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --default-background-color=00000000 \
  --screenshot=media/readme/how-it-works.png --window-size=1200,420 \
  "file://$PWD/media/readme/source/how-it-works.svg"
```

Any Chromium-based browser works. The `--window-size` must match the SVG's
`width`/`height`, and the device-scale factor of 2 is what keeps the labels
sharp when GitHub scales the image down to its ~900px content column.

## Captures that are not built here

`multi-session.png`, `session-history.png` and `selection-context.png` are
direct crops of captures taken on a real desktop; they have no build step. Two
rules apply to all of them, and both are load-bearing:

- **Nothing outside the terminal panes is ever published.** The captures had
  private editors open; only the terminal is cropped out of them.
- **Anything that names real work is pixelated** — the local workspace path in
  the terminal footer, the project name on the status lines, and the session
  titles in the sidebar. The redaction is deliberate and visible; do not
  "restore" it.
