# mtl: the PC side of 3615 MESHCORE

`mtl` talks to the Minitel companion (XIAO nRF52840, firmware `companion-minitel`) over BLE, or over its USB CLI. It does three things:

- **A terminal on the Minitel.** It runs a shell, or any program (w3m, lynx, mutt, htop…), in a pty through a VT emulator. Only what changed on screen is sent, encoded for the Minitel's mode (Vidéotex 40 col or Mixte 80 col).
- **Welcome-page slides.** It uploads slides made on the PC.
- **Settings.** It sets the screen saver delays and how many messages are kept per conversation.

```sh
go build -o mtl .            # Go 1.26+; BlueZ for BLE (Linux)
./mtl term                   # $SHELL on the Minitel
./mtl term -- w3m https://example.org
./mtl term -cols 40 -- htop  # forces 40 columns first
./mtl term -native           # no emulator: TERM=minitel1b (40 col) / minitel1b-80 (80 col), the device's own termcap

./mtl slide add 3 page.vdt               # a Vidéotex page (e.g. from MiEdit): slide 3, 40 col
./mtl slide add 4 hello.txt              # text / ANSI art, laid out and encoded for 40 AND 80 col
./mtl slide add 4 wide.txt -cols 80      # only the 80 col version
./mtl slide list | del 4 [40|80] | show 3
./mtl slide get 4                        # read back: slide4.40.vdt and slide4.80.mixte (what exists)
./mtl slide preview page.vdt hello.txt   # on the Minitel now, nothing stored: a key shows the next one
                                         # (switches to each one's mode, puts everything back after)
./mtl slide encode -cols 40 -o hello.vdt hello.txt   # what the Minitel would get
./mtl slide preview samples/relais-iso.png           # an image: mosaics in 40 col, ASCII art in 80
./mtl slide add 5 photo.jpg -cols 40 -dither -contrast

./mtl saver 10m 1h           # welcome page after 10 min without a key, blank screen after 1 h (0 = never)
./mtl keep 80                # messages kept per conversation (10-160)
./mtl -usb /dev/ttyACM0 slide list       # the same over USB (all but term)
```

## BLE

The node is a MeshCore companion: one BLE client at a time, so close the phone app first. Pair once with BlueZ. The node asks for a PIN, and the Minitel shows it:

```sh
rfkill unblock bluetooth
bluetoothctl            # scan on, then: pair <MAC>, enter the PIN shown on the Minitel; trust <MAC>
./mtl -addr <MAC> term  # or let it scan for a name containing "MeshCore" (-name to change)
```

The same documentation, in French, with pairing and troubleshooting: https://pix.github.io/3615meshcore/terminal.html

## Terminal keys

| Minitel | Program gets |
|---|---|
| ENVOI | Enter (CR) |
| CORRECTION | Backspace (DEL) |
| ANNULATION | ^U (kill line) |
| GUIDE | Tab (completion) |
| SOMMAIRE | Esc |
| RETOUR / SUITE | Page Up / Page Down |
| arrows, Ctrl+letter | the same (arrows in application mode when the program asks) |
| RÉPÉTITION | switches 40 ↔ 80 columns: the program is resized (SIGWINCH) and the screen redrawn |
| CONNEXION/FIN | ends the session; the Minitel goes back to its own pages |

The keyboard reaches the program as it is: no accent composition with `*`, and in 80 col `^ ~ `` ` `` are not dead keys. The Minitel's é ù è ç keys send `{ | } \` there (ISO 646), which is what a shell needs. In 40 col the accent keys (SS2) still give é, à, ç…

`TERM` is `xterm` by default, because the emulator speaks xterm (change it with `-term`). In 40 col, colours become the Minitel's grey levels (`-mono` turns this off) and block characters become G1 mosaics. In 80 col, coloured text is bold, and a coloured background becomes inverse.

## Images

`.png`, `.gif` (first frame) and `.jpg` work with `slide add`, `slide preview` and `slide encode`.

- **40 col:** the picture becomes 80×72 G1 mosaic blocks (2×3 per cell) in the Minitel's 8 grey levels. Those are its 8 colours, shown by brightness on a black-and-white tube. Each cell gets the ink and background pair that draws its six blocks best, and keeps the previous cell's pair when that is as good, to save bytes. The image is fitted into the screen's 4:3 frame.
- **80 col:** Mixte has neither mosaics nor colours, so the picture becomes characters by brightness, with inverse blanks for the brightest parts.

Flat-colour pixel art with hard edges (isometric scenes, icons) converts best, and needs no dithering. For photos, use `-dither` (error diffusion), `-contrast` (stretch to black…white) and `-gamma 1.4` (brighter mid tones). A full screen is about 1–3 KB, so 1–3 s at 9600 baud. `samples/relais-iso.png` is an original test scene drawn for this.

## Native mode (`-native`)

There is no emulator. The program gets the Minitel's own terminfo entry: `minitel1b` in 40 col (Vidéotex), `minitel1b-80` in 80 col, or the one you name with `-term`. Its bytes go through as they are. Only UTF-8 text is converted to Minitel characters (SS2 accents in 40 col, SO…SI French letters in 80 col, the rest folded). The pty expands tabs, because a Vidéotex tab moves one column. Arrow and page keys are translated to the entry's key strings. The program is read only as fast as the Minitel draws, so it blocks rather than piling up output. The width is fixed for the session: RÉPÉTITION is undone, and ^L redraws.

## Why it keeps up at 9600 baud

The Minitel takes about 960 characters a second. `mtl` keeps a model of what the Minitel shows and sends the difference:

- changed spans only, with short unchanged gaps re-sent when that costs less than a cursor move;
- erase-to-end-of-row for blank tails, and Vidéotex REP for runs of the same cell;
- the terminal's own delete/insert line (DL/IL) when the screen (or a scroll region, as in a pager) moved up or down: a scrolled line costs about 50 bytes instead of about 1600 in 80 col, and 30 instead of 800 in 40 col (`-noscroll` turns it off);
- an unchanged frame sends nothing.

The node writes each BLE frame whole. It holds its bell and its status query while the PC is sending, so nothing gets into the middle of a sequence (`-trace file` records what was sent, to compare with the node's `link txlog`). A frame is built only when the Minitel's output queue has room. Faster output is never queued up: the next frame shows the latest screen. `go test` replays each frame into a model of the Minitel and checks that it ends up showing exactly the emulator's screen.

## Protocol

See "BLE extensions" in `docs/companion-minitel.md` of the firmware.
