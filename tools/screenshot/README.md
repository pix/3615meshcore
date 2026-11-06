# 3615 MESHCORE screenshots: a Minitel 2 photo from a screen dump

These tools turn the companion firmware's `screen` dump into a photo-realistic picture of a
Minitel 2 showing that page, as a PNG or an animated GIF. They can also render the CRT face alone.

| File | What it does |
|---|---|
| `minitel_dump.py` | Fetches a dump from the XIAO over USB, or reads one from a file or stdin. |
| `minitel_render.py` | Renders the photo, the screen-only view and the GIFs. |
| `minitel_screen.py` | Holds the dump parser, the Minitel font and the dot raster. It also makes a flat 1:1 image (debug). |
| `make_samples.py` | Writes the synthetic dumps in `samples/`. These cover the Sommaire, a 40-col page and the four splash scenes, with their animation. |
| `font/` | Holds the Minitel font, downloaded unmodified, with its licence. |
| `samples/`, `renders/` | Hold the example inputs and outputs. |

Only Python 3 with numpy and Pillow is required. scipy is used when present (it is installed
system-wide here); OpenCV is used if importable, for speed. Run the scripts with `python3 -I`.
No Blender or GPU is needed.

## Quick start

```sh
# grab the current page from the XIAO and render it
python3 -I minitel_dump.py -o page.dump
python3 -I minitel_render.py page.dump                      # page.png, 1920x1440, straight on
python3 -I minitel_render.py page.dump --angle -o a.png     # 3/4 view
python3 -I minitel_render.py page.dump --size 4k            # 3840x2880
python3 -I minitel_render.py page.dump --screen-only        # the CRT face only, 1280x960
python3 -I minitel_render.py page.dump -o page.gif          # blinking cells and cursor, animated

# several dumps make an animation (e.g. the splash reveal, 130 ms per frame like the firmware)
python3 -I minitel_render.py samples/splash40-anim/f*.dump --frame-ms 130 -o splash.gif
python3 -I minitel_render.py samples/splash40-anim/f*.dump --screen-only --frame-ms 130 -o s.gif

# fetch and render in one go (extra renderer options after --)
python3 -I minitel_dump.py --render -- --angle 25 --style night
```

## `minitel_dump.py`

- **Port.** It finds the XIAO by serial number, `/dev/serial/by-id/*3C0B547619DCA64A*`. Pass `--port` to override. It refuses any `ttyUSB*` device, because the repeater there resets when its tty is opened.
- **Protocol.** It works at 115200 baud and sends `screen\r`. It reads until a line that is exactly `OK` (or one starting with `ERR`), with a `--timeout` of 8 s.
- **Serial access.** It uses pyserial if it can be imported; otherwise it falls back to raw termios, so no install is needed.
- **Output.** The file keeps only the `SCREEN`, `ROW`, `CURSOR` and `OK` lines, each indented by two spaces. `--raw` keeps the reply as received.
- **Other inputs.** `--from-file log.txt` cleans up an existing capture or terminal log, and `-` reads stdin.

## Dump format (v1)

```
screen                                   <- CLI echo (ignored; may share a line with SCREEN)
  SCREEN v1 cols=<40|80> rows=25 mode=<mixte|videotex> page=<id>
  ROW <r> <text_hex> <attr_hex>          r = 0..24, row 0 = status row
  CURSOR <r> <c> <0|1>
  OK
```

- **text_hex** is the row as displayed, in UTF-8, written as hex. It holds one character per cell, `cols` cells per row. A mosaic cell carries its G1 code (0x20–0x7F) as its character.
- **attr_hex** has 4 hex digits (16 bits) per cell:

  | bit | meaning |
  |---|---|
  | 0 | inverse |
  | 1 | blink |
  | 2 | underline; on a mosaic cell, separated (lining) |
  | 3 | bold |
  | 4 | double height |
  | 5 | double width |
  | 6 | mosaic G1 |
  | 7 | concealed |
  | 8–10 | foreground colour 0–7 |
  | 11–13 | background colour 0–7 |
  | 14 | continuation (covered by a double-width or double-height neighbour) |

- **Double height.** The glyph sits on the row where it was written, and the row above is the continuation. `--dh-down` selects the opposite convention.

**Robust parsing.** The keywords are found anywhere in a line, so indents, the CLI echo and log lines don't matter. Malformed lines are skipped. Short rows are padded. A blank dump, such as the 40-col `page=splash-raw` (the raw splash bypasses the screen model), renders as an empty screen and prints a note.

## How each attribute is drawn

- **Character set.** Characters are drawn from the Minitel ROM font (see the font section). Accented capitals don't exist on a Minitel, so they fall back to the bare letter, as on the terminal. `·` is drawn as `.`, as `MinitelCharset.cpp` does.
- **Cell sizes.** 40-col and Vidéotex cells are 8×10 dots, giving 320×250. 80-col cells are 6×10 dots, giving 480×250 at the same physical width; the glyph is the font's columns 1–6.
- **G1 mosaic.** It is a 2×3 block grid: bits 0–4 and 6 map to TL, TR, ML, MR, BL, BR. Separated mosaic leaves a 1-dot gap on each block.
- **Text attributes.** Inverse swaps foreground and background. Underline uses the 10th dot line. Bold is a 1-dot horizontal smear. Double height, double width and double size are pixel-doubled. Concealed cells render blank.
- **Grey levels.** Each colour index maps to a Minitel 2 grey, in luminance order: black 0, blue .30, red .45, magenta .55, green .65, cyan .75, yellow .87, white 1.
- **Blink and cursor.** In a still, blink is shown "on". In a GIF it alternates: in the off phase, a blinking cell (inverse included) shows only its paper colour. A visible cursor is drawn as an inverted cell and blinks with the same phase.

## Font

The font is `font/Minitel.sfd` / `Minitel.ttf` from **[Zigazou/Minitel-Canvas](https://github.com/zigazou/minitel-canvas)**, by Frédéric Bisson, under the **CC0 1.0 Universal** licence (`font/LICENSE`, public domain dedication). Bisson also wrote PyMinitel and the miedit Minitel page editor. The font redraws the Minitel ROM characters as pixel outlines on an exact 8×10 grid at 128 units per dot. It covers the full G0 set plus the G2 accents, arrows, £, §, ¼ ½ ¾, ° and ±.

The renderer reads the `.sfd` as text with its own small parser and rasterises it to bitmaps at load time. The font files were downloaded into an empty `font/` directory, are unchanged, and are only read as data. The G1 mosaics are generated, not taken from the font.

## Options of `minitel_render.py`

| option | |
|---|---|
| `dumps…` | One or more dump files; `-` reads stdin. Several dumps make an animation. |
| `-o out.png / out.gif` | Output file. A `.gif`, or several dumps, gives an animated GIF. Several dumps to a `.png` give numbered PNGs. |
| `--size WxH`, `4k`, `hd` | Output size. The default is 1920x1440; GIFs default to 960x720 and `--screen-only` to 1280x960. |
| `--angle [deg]` | Camera yaw for a 3/4 view. A bare `--angle` means 28°. |
| `--elev deg` | Camera elevation. The default is 13° straight on and 17° angled. |
| `--framing full\|front\|screen` | `full` shows the whole terminal and keyboard (default), `front` fills the frame with the bezel, `screen` is a close-up of the tube. |
| `--screen-only` | Draws only the CRT face on black: curved raster, glow, rounded glass edge and sheen. It does no ray tracing, so it takes about 2 s. |
| `--style desk\|night\|studio` | Lighting preset. `desk` is a daylight room with a window and a wooden desk. `night` is a dark room lit mostly by the screen. `studio` is a grey seamless backdrop. |
| `--zoom`, `--aperture mm` | Extra zoom, and the lens aperture for depth of field. The default aperture is 14 mm at `full` framing and 10 mm otherwise. |
| `--blink on\|off\|animate` | Blinking cells and cursor. The default is `animate` for GIFs and `on` for PNGs. |
| `--frame-ms`, `--blink-ms`, `--hold-ms` | GIF timing: time per dump (default 500), blink half-period (default 500) and hold on the last dump (default 3000). |
| `--grain x`, `--live-grain` | Film grain amount; the default is 1, or 0.5 for GIFs. `--live-grain` gives new grain on every GIF frame, which makes a bigger file. |
| `--dh-down` | Double height extends downward from the written row. |

## How the realism is done

Everything is computed in linear light and tone-mapped once, with a filmic (ACES-like) curve, then encoded to sRGB.

**The terminal.** Its shape is modelled on a Philips Minitel 2 (ROM Bv9) and kept unbranded, with no wordmark or logos. The scene is a signed-distance-field model, ray-marched in numpy across forked worker processes. The flat face and the open part of the glass are intersected analytically, which is about a third of the hits.
- **Case.** The body is a near-square charcoal box with rounded edges, a raised hump on top, side vents and a parting seam. The front bezel has two moulded grooves and a red power LED.
- **Screen recess.** It is deep and tapered, with equal left and right borders.
- **Keyboard.** It is a pull-out tray under the screen with light-grey keys. The legends are printed with the same Minitel font. The function keys sit in two staggered rows (Sommaire … Envoi, with Envoi green), plus a numeric keypad.
- **Shading.** The plastic gets ambient occlusion, a fine moulded bump, dust-like tone variation and a rough Fresnel specular that reflects the room.

**Room.** The room has a window to the left, a ceiling light, a second window behind the photographer and the lit room behind the camera. The desk is wood with a soft shadow and contact occlusion. The background wall carries a pool of window light. Depth of field focuses on the tube and blurs the desk and wall by their real distance. The terminal is kept out of the background blur so its edges don't smear.

**CRT.**
- **Glass.** The glass is a sphere with a 560 mm radius, 9 mm thick, set deep in the recess.
- **Refraction.** Each camera ray is refracted through the faceplate (n = 1.52) onto the phosphor on its inner surface. The refraction offset is therefore real and changes with viewing angle.
- **Raster.** The raster has barrel distortion from the deflection. It is drawn at 2–4 texels per output pixel from the dot image.
  - Horizontally, a box dot is convolved with the video bandwidth, plus slight amplifier peaking.
  - Vertically, each line is a Gaussian beam spot, and spots widen slightly when bright. Faint scanlines appear when a line covers more than about 3 px; they are suppressed below that to avoid moiré.
  - Each output pixel takes 2×2 samples, averaged in perceptual space so that 1-dot dark strokes of inverse video survive.
- **Optics.**
  - The beam defocuses and dims toward the edges and corners.
  - Halation in the glass gives three tight, gentle halos.
  - The P4 phosphor colour is slightly blue-white.
  - The black level isn't black: the grey phosphor is seen through a tinted faceplate (62 % transmission), plus a little internal scatter.
  - The bezel's inner shadow falls on the glass edge.
  - Reflections are environment reflections with Fresnel that follow the curved normal, so the small mullioned window reflects in the upper left. A faint smudge texture sits on the glass.
  - The screen's light spills onto the recess walls, the keys and the desk.

**Lens and sensor.** Bloom is kept gentle on purpose. Vignetting and a 0.3 px optical softness (which also anti-aliases edges) follow, then luminance-dependent grain plus a little chroma noise and dither.

## Speed

Timings are on this machine (12 cores, under load from other jobs; they vary about ±30 %):

| output | time |
|---|---|
| 1920x1440 photo | 8–11 s |
| 3840x2880 (4k) | about 40 s, 5.5 GB peak RAM |
| `--screen-only` 1280x960 | about 2 s |
| GIF frames | about 0.5–1 s each; the scene is traced once and only the glass is re-shaded per frame |

The 36-frame splash GIF takes about 35 s.

## Samples (`make_samples.py`)

- `sommaire80.dump` is an 80-col Mixte Sommaire, using inverse, bold and underline, with the cursor.
- `messages40.dump` is a 40-col Vidéotex page. It has a double-size title, a double-height label, a mosaic logo, contiguous and separated mosaic rules, grey levels, inverse bars and a blinking cell.
- `splash{40,80}-scene{1..4}.dump` are the four splash scenes (logo, radio, identity, network), complete. They are a Python port of `UITaskSplash.cpp`, with plausible values in the live fields. The firmware's own splash dump is blank: the splash is written raw, outside the screen model.
- `splash{40,80}-anim/fNN.dump` is the 36-frame reveal of scene 1, for GIFs.
- `convlist80-real.dump` is a real capture from the device (the conversation list).

The firmware's own samples live in `meshcore-observer-minitel/examples/companion_radio/ui-minitel/tools/samples/`.
