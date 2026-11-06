## Minitel 2 in 80-column ASCII mode: technical brief for ESP32 firmware

**Main finding:** the 80-column screen is the same in Mixte and Téléinformatique. In both, rows 01–24 use ISO 6429 codes. What differs is that **Téléinformatique switches the Protocol off**. The host then gets no status replies, cannot change the speed, and cannot switch echo with PRO commands. Mixte keeps the Protocol running. Both open ESP32 SSH projects (iodeo, 3615_SSH) use **Mixte + `echo(false)`** for that reason. I recommend Mixte; the details are in section 1.

### Sources (page numbers below are the printed page numbers of STUM 1B)
- **[STUM1B]** Spécifications Techniques d'Utilisation du Minitel 1B, 1986: http://543210.free.fr/TV/stum1b.pdf. It is a scanned PDF; I read the pages as images. Printed page N is PDF page N+3.
- **[PRO1B]** "Minitel 1B usage professionnel": https://archive.org/details/minitel-1b-usage-professionnel
- **[M2G]** Minitel 2 Philips user guide: https://www.goto10.fr/minitel/notices/minitel_2_philips.pdf
- **[1982]** CNET interface spec, edition 3: https://www.histelfrance.fr/storage/2025/07/1982SpecificationsTechniquesInterfacePeriInformatiqueTerminalMinitel.pdf
- **[TI]** ncurses `terminfo.src`, Minitel section: https://github.com/ThomasDickey/ncurses-snapshots/blob/master/misc/terminfo.src
  - Entries `m2-nam` (Igor Tamitegama, 1997) and `minitel1b-80`, `minitel12-80`, `minitel2-80` (Alexandre Montaron, 1998–2016).
  - The same entries are installed locally; `infocmp minitel2-80` shows them.
- **[LIB]** eserandour/Minitel1B_Hard (GPL-3.0): https://github.com/eserandour/Minitel1B_Hard
- **[PYM]** Zigazou/PyMinitel (GPL-3.0): https://github.com/Zigazou/PyMinitel
- **[IOD]** iodeo/Minitel-ESP32 (code GPL-3.0, hardware CC-BY-SA 4.0): https://github.com/iodeo/Minitel-ESP32

**No Minitel 2 STUM was found online.** Every Minitel-2-specific item below comes from [M2G], [TI], [LIB] or [PYM]. Items marked **UNVERIFIED** need a test on the real terminal.

---

### 1. Mode switching

All values in hex. PRO1 = `1B 39`, PRO2 = `1B 3A`, PRO3 = `1B 3B`, SEP = `13`.

| From → To | Host sends | Ack the Minitel returns | Source |
|---|---|---|---|
| Vidéotex → Mixte (US set) | `1B 3A 32 7D` | `13 70` | STUM1B p.144, LIB, PYM |
| Mixte → Vidéotex | `1B 3A 32 7E` | `13 71` | same |
| Vidéotex or Mixte → Téléinfo (US set) | `1B 3A 31 7D` | `1B 5B 3F 7A` (CSI ?z) | same |
| Téléinfo → Vidéotex | `1B 5B 3F 7B` (CSI ?{) | `13 5E` (same as the reset ack) | same |
| Téléinfo → Mixte | No direct command: send CSI ?{, then PRO2 MIXTE1 | | PYM |
| Reset to Vidéotex (Télétel only) | `1B 39 7F` | `13 5E` | STUM1B p.145 |

- **The CSI ?z ack is not sent** when the Minitel is "connected" (modem online) and the command came from the DIN port.
- **SO (`0E`) selects the French set, SI (`0F`) the US set**, in both 80-column modes.

**Keyboard commands** (press Fnct with the letter, release both, then press the parameter key) [STUM1B p.181, PRO1B]:

| Keys | Effect |
|---|---|
| Fnct T + A | Téléinfo, US set |
| Fnct T + F | Téléinfo, French set |
| Fnct T + V | Back to Vidéotex |
| Fnct T + E | Local echo flip-flop |
| Fnct E + F | 80/40 columns flip-flop |
| Fnct E + P / Fnct E + R | Page mode / scroll ("rouleau") mode |
| Fnct C + M | Lower/upper case flip-flop |
| Fnct P + 3 / 1 / 4 / 9 | 300 / 1200 / 4800 / 9600 baud (9 is Minitel 2 only [M2G]) |

- **Mixte cannot be entered from the keyboard**, only by host command [PRO1B].
- **The DIN port reports mode changes made on the keyboard:**
  - Fnct T+A or T+F sends CSI ?z to the port when the Minitel is local.
  - Fnct T+V is equivalent to a reset, so `13 5E` is sent. Watch for these to track the mode.

**Mixte compared with Téléinformatique**

| | Mixte | Téléinformatique |
|---|---|---|
| Screen | Row 00 is Vidéotex-coded; rows 01–24 are ISO 6429, 80 columns | Same [STUM1B p.105, 160] |
| Protocol (PRO1/2/3) | Active: status, ENQROM, speed change, echo control | **Off**: "aucun status et aucune réponse" [STUM1B p.156] |
| Function keys | Télétel codes `13 4x` | `1B 4F xx` (VT-style application keys) |
| Filtered (ignored) sequences | CSI 2h, CSI 2l, CSI i, CSI ?{ [p.106] | None of these |
| Turning local echo off | PRO3 aiguillage command (reliable) | Fnct T+E by the user only. Minitel 2 may accept `CSI 12 h` (**UNVERIFIED**) |
| Speed change by the host | Yes | **No** [STUM1B p.70]. Set the speed before switching; the speed survives the switch [p.158] |

**Recommendation:** use Mixte at 9600 baud with echo turned off by PRO3. In Mixte, any `1B 39`/`1B 3A`/`1B 3B` reaching the Minitel is executed as a Protocol command, so strip all C0 control bytes from message text.

---

### 2. The 80-column screen (Téléinfo; rows 01–24 in Mixte)

**Size and state on entry**
- 25 rows × 80 columns. Row 00 is a separate status row, so the ANSI area is 80×24 [STUM1B p.160].
- On entry to Téléinfo [p.158, 160]:
  - screen cleared, cursor at row 01 / column 01;
  - scroll mode on, US set, attributes reset;
  - keyboard in lower case and not locked; echo set back to the local/connected default.
- Entering Mixte gives the same screen state [p.105].

**Supported controls** [STUM1B p.165–169]

| Function | Bytes | Notes |
|---|---|---|
| CUP | `1B 5B r 3B c 48` | Default 1;1 |
| CUU / CUD / CUF / CUB | `1B 5B n 41/42/43/44` | Stops at the screen edge |
| ED | `1B 5B Ps 4A` | 0 = to end, 1 = from start, 2 = whole screen; cursor does not move |
| EL | `1B 5B Ps 4B` | Same 0/1/2 |
| IL / DL | `1B 5B n 4C` / `1B 5B n 4D` | Cursor goes to column 1 |
| DCH | `1B 5B n 50` | |
| ICH | `1B 5B n 40` | RTIC-built 1B only; Minitel 2 unknown |
| Insert mode on / off | `1B 5B 34 68` / `1B 5B 34 6C` | |
| SGR | `1B 5B Ps 6D` | Ps = 0 none, 1 bold, 4 underline, 5 blink, 7 inverse, 22/24/25/27 turn them off. No colour; not applied in 40-column mode |
| IND / NEL / RI | `1B 44` / `1B 45` / `1B 4D` | |
| Save / restore cursor | `1B 37` / `1B 38` | Saves position, attributes and character set |
| Full reset (RIS) | `1B 63` | Clears screen and row 00, 80 columns, US set |
| Keyboard lock / unlock | `1B 5B 32 68` / `1B 5B 32 6C` | Téléinfo only |
| Status row 00 | `1F 40 41` + text, then `0A` to return | Row 00 is Vidéotex-coded, no attributes. Beyond column 63 move with HT/BS |

**Parameter limit**
- STUM 1B: at most 2 parameters per CSI on RTIC-built units, 1 on TELIC/MATRA-built units; CUP always takes 2 [p.162].
- **Send one SGR per sequence**, e.g. `ESC[1m ESC[7m`, not `ESC[1;7m`.

**Not supported**
- **DECSTBM (scroll region)** is not in STUM 1B; unknown sequences are silently dropped [p.169].
  - Only the 1997 `m2-nam` terminfo entry claims it for the Minitel 2 (**UNVERIFIED**).
  - To scroll a message pane without it: put the cursor on the pane's top row and send DL `ESC[M`, then on the pane's bottom row send IL `ESC[L`. Rows below the pane stay where they are.
- **Cursor hiding:** impossible on the 1B (in both modes).
  - Minitel 2 and 12: `1B 5B 3C 31 68` hides it, `…6C` shows it [TI].

**Minitel 2 extras, per [TI] only (UNVERIFIED)**
- `ESC[12h` turns local echo off; `ESC[?3l` selects 80 columns; `ESC[?4l` turns scrolling on.
- `ESC[6n` asks for the cursor position (reply `ESC[r;cR`). This would be the only way to detect that the terminal is alive while in Téléinfo.
- `ESC ) 0` makes G1 the DEC line-drawing set (selected with SO/SI). This takes the place of the French set on SO.

**C0 control bytes** [p.165, 169]

| Byte | Effect |
|---|---|
| CR `0D` | Column 1 |
| LF `0A` | Down one row; at row 24 it scrolls in scroll mode, or wraps to row 1 in page mode |
| VT `0B`, FF `0C` | Same as LF. **FF does not clear the screen** |
| HT `09` | Next 8-column tab stop |
| BS `08` | Left one column, stops at column 1 |
| BEL `07` | Beep |
| CAN `18`, SUB `1A` | **Displays the error block** (unlike Vidéotex, where CAN clears to end of line) |
| XON / XOFF `11` / `13` | Only used during screen copy |

- A byte with a parity error is displayed as a solid block.

**Line wrap**
- Behaviour at column 80 is not documented, and neither Montaron entry sets auto-margins.
- Wrap lines in firmware, always send an explicit CR LF, and avoid writing row 24 column 80 (**uncertain**).

**Character sets** (ISO 646; tables in STUM1B p.163–164)
- The French set changes 9 code points:

| Code | `23` | `40` | `5B` | `5C` | `5D` | `7B` | `7C` | `7D` | `7E` |
|---|---|---|---|---|---|---|---|---|---|
| French set | £ | à | ° | ç | § | é | ù | è | ¨ |

- Not available: ê â î ô û ë ï and capital accented letters.
- **Best practice:** stay in the US set (`0F`) and wrap single accented characters, e.g. é = `0E 7B 0F`. Map anything else to the plain letter.
- Minitel 2 only, per the `minitel2-80` translation table in [TI] (**UNVERIFIED, single source**): `ESC ( 3` plus a letter, then `ESC ( B`, gives more accents.
  - à=A, â=B, ä=C, é=D, è=E, ê=F, ë=G, î=H, ï=I, ô=J, ö=K, ù=L, û=M, ü=N
  - Example: ê = `1B 28 33 46 1B 28 42`.

---

### 3. Keys in Téléinformatique [STUM1B p.174–180]

| Key | Bytes |
|---|---|
| ENVOI | `1B 4F 4D` |
| SOMMAIRE | `1B 4F 50` |
| ANNULATION | `1B 4F 51` |
| RETOUR | `1B 4F 52` |
| RÉPÉTITION | `1B 4F 53` |
| CORRECTION | `1B 4F 6C` |
| GUIDE | `1B 4F 6D` |
| SUITE | `1B 4F 6E` |
| Fnct 0 … 9 | `1B 4F 70` … `1B 4F 79` |
| Shift + CONNEXION/FIN (local) | `1B 29 34 0D` to the DIN port. Without Shift, in local, nothing is sent to the port |
| Ctrl + CONNEXION/FIN | Break |
| ↑ ↓ → ← | `1B 5B 41` / `42` / `43` / `44` |
| Shift↑ / Shift↓ | `1B 5B 4D` (DL) / `1B 5B 4C` (IL) |
| Shift→ | `1B 5B 34 68`, then `…6C` on the next press |
| Shift← | `1B 5B 50` |
| Ctrl← | `7F` |
| ↵ | `0D` |
| Shift↵ / Ctrl↵ | `1B 5B 48` / `1B 5B 32 4A` |
| Ctrl A … Z | `01` … `1A` |
| Esc key | `1B` alone. Use about a 20 ms timeout to tell it from a sequence, as LIB does |

**Accented characters typed on the keyboard** arrive as the ISO 646 byte. The screen shows it according to the selected set.

| Keys | Byte | French set | US set |
|---|---|---|---|
| Ctrl 1 or Shift+RÉPÉTITION | `7B` | é | { |
| Ctrl 2 | `7C` | ù | \| |
| Ctrl 3 or Shift+ENVOI | `7D` | è | } |
| Ctrl 4 or Shift+GUIDE | `7E` | ¨ | ~ |
| Shift+' | `40` | à | @ |
| Ctrl 0 or Shift+* | `5B` | ° | [ |
| Shift+ANNULATION or Ctrl+CORRECTION | `5C` | ç | \ |
| Ctrl+ANNULATION | `23` | £ | # |

- Letters are lower case by default; Shift gives capitals.
- STUM 1B lists no dead-key or SS2 sequences in this mode. Minitel 2 accent-key behaviour is untested.

**Mixte keys** [STUM1B p.123–124]
- ENVOI `13 41`, RETOUR `13 42`, RÉPÉTITION `13 43`, GUIDE `13 44`, ANNULATION `13 45`, SOMMAIRE `13 46`, CORRECTION `13 47`, SUITE `13 48`.
- CONNEXION/FIN: `13 49` per STUM 1B. LIB defines `13 59` as "non documenté", so **accept both**.
- Cursor and Ctrl keys send the same bytes as in Téléinfo.

---

### 4. Speed, data format, identification

**Data format:** always 7 data bits + even parity (7E1), at every speed [STUM1B p.69; 1982 spec]. ESP32: `SERIAL_7E1`.

**Speeds**
- 300, 1200, 4800, plus 9600 on the Minitel 2 [M2G p.24].
- **After power-on: 1200 baud, Vidéotex, 40 columns** [STUM1B p.145; LIB].

**Setting the speed from the host** (Télétel modes only) [STUM1B p.141]
- Send `1B 3A 6B <byte>`. The byte layout is `P 1 E2E1E0 R2R1R0`:

| Speed | Byte |
|---|---|
| 300 | `52` |
| 1200 | `64` |
| 4800 | `76` |
| 9600 | `7F` (Minitel 2; LIB, PYM) |

- The ack `1B 3A 75 <byte>` comes back **at the new speed**: flush the UART and change the baud rate immediately.
- Status query: send `1B 39 74`, get `1B 3A 75 <byte>`.
- Probe for the current speed by trying 1200/4800/9600/300 with that query. If nothing answers at any speed, the terminal is probably in Téléinfo: send CSI ?{ at each speed and wait for `13 5E`.

**Identification (ENQROM)**
- Send `1B 39 7B`, get `01 <maker> <type> <version> 04`.
- Type `76` ('v') = Minitel 2. Maker `42` + `76` = Philips; `43` = Telic-Alcatel [LIB, PYM].

**Operating status**
- Send `1B 39 72`, get `1B 3A 73 <byte>`. Bit 0 = 80 columns (Mixte), bit 1 = scroll mode, bit 2 = error correction (PCE), bit 3 = lower case [LIB, PYM].
- No answer means Téléinfo (PyMinitel's rule).

**Local echo off in Télétel/Mixte**
- Send `1B 3B 60 5A 51` (PRO3, OFF, receiver = modem, sender = keyboard), get `1B 3B 63 5A <status>`. `61` instead of `60` turns it back on [LIB `echo()`].
- In local state the echo runs keyboard → modem (looped back) → screen [STUM1B p.80–81].

**Suggested start-up sequence**
1. Open the UART at 1200 7E1 and probe the speed.
2. Send ENQROM to identify the terminal.
3. Send `1B 3A 6B 7F`, flush, switch to 9600, wait for the ack.
4. Send `1B 3A 32 7D` (Mixte), then `1B 3B 60 5A 51` (echo off). Optionally send `0F`.

**Minitel 2 standby (veille)** [M2G p.16]
- After 3 hours with no keyboard use the terminal goes to standby, and on wake-up it **reinitialises to Vidéotex**, so the mode is lost.
- On CV1–CV2/BV1–BV6 firmware this cannot be disabled.
- From CV3/BV9: Fnct E+A disables it, and automatic standby only triggers when both keyboard and DIN port are idle.
- So send periodic traffic, and re-initialise when `13 5E` arrives or a probe fails.

---

### 5. Electrical (DIN port)

**Pinout** (STUM 1B p.68)

| Pin | Function |
|---|---|
| 1 | RX (Minitel input) |
| 2 | GND |
| 3 | TX (Minitel output) |
| 4 | PT (ignored in Téléinfo [p.70]; leave unconnected) |
| 5 | Power out |

- In 1982 pin 5 was "TP / terminal prêt", a low-when-on signal, not power [1982]. It is also absent on Cu2–Cu4 units.

**Signal levels** [STUM1B p.68–69; 1982 spec]
- TTL open-collector. Input high is ≥2.5 V, input low is ≤0.4 V.
- Each line is pulled up **by the receiving side**, to somewhere between 5 and 15 V.
- **Minitel TX (pin 3):** needs a pull-up on the ESP side.
  - The spec guarantees a low below 0.4 V into 2.3 kΩ to 5 V, and a high above 2.5 V into 200 kΩ.
  - In practice: 10 kΩ to 5 V [LIB], or 56 kΩ to 3.3 V on GPIO16 [IOD].
- **Minitel RX (pin 1):** pulled up inside the Minitel.
  - The ESP must sink it below 0.4 V (spec test: 800 Ω to ground).
  - **Do not drive it push-pull from 3.3 V**, because the internal pull-up can exceed 3.6 V.
  - Use an NPN, as iodeo does: emitter to GPIO17; base to 3.3 V through 10 kΩ and to GND through 20 kΩ; collector to DIN 1. A BSS138 works too.
- Inputs tolerate ±18 V [STUM1B p.69]. I found no published measurement of the actual Minitel 2 pull-up voltage, so measure it.

**Power on pin 5**
- STUM 1B: 8.5 V minimum at 1 A maximum. The "5 V maximum à vide" it prints for the no-load voltage is clearly a typo, probably 15 V. Choose a regulator rated for 15 V or more.
- The Minitel 2 guide says power is available but gives no figures.
- In the field: a 5 V regulator from pin 5 [LIB]; a buck converter rated 6–15 V in, 1 A or more [IOD]. The iodeo/Tindie board runs entirely from the Minitel.
- iodeo warns not to power from the Minitel and USB at the same time without isolation.

---

### 6. Reusable open-source code
- **eserandour/Minitel1B_Hard (GPL-3.0), ESP32-ready.** Useful functions:
  - `changeSpeed`, `searchSpeed`, `identifyDevice`
  - `modeMixte`, `standardTeleinformatique`, `standardTeletel`
  - `echo(bool)`, `aiguillage`, `getKeyCode`, and the ack parsers (`working*`)
  - **Caveat:** it is written for Vidéotex. `print()`, the cursor functions and `newScreen` emit Vidéotex codes, so use raw CSI in 80-column mode.
- **iodeo/Minitel-ESP32 (GPL-3.0):** `Minitel1B_Telnet_Pro.ino` and `Minitel1B_SSH_Client` show the Mixte + echo-off + 4800 pattern; there is also a MicroPython port.
- **jbellue/3615_SSH:** ESP32 SSH client using Mixte + `echo(false)`. **No licence file, so treat as all rights reserved.**
- **Zigazou/PyMinitel (GPL-3.0):** the clearest mode-transition logic (`definir_mode`, `identifier`, `deviner_vitesse`).
- **ncurses terminfo `minitel2-80` / `minitel1b-80`:** a practical list of supported escape sequences and key codes.
- **assoRED/MinitelLinuxTerminal:** an agetty wrapper confirming 4800 7E1 with Fnct T+A, T+E, P+4.
- **Not reviewed:** MiniPavi and Minimit (both are Vidéotex servers).

---

**Unresolved:**
- No Minitel 2 STUM is online, so these Minitel 2 items rest only on terminfo or a single source:
  - `CSI 12h` echo-off, `ESC[6n` and `CSI <1h`
  - the `ESC ( 3` accent set
  - DECSTBM support
  - autowrap behaviour
  - whether the Minitel 2 extras also work in Mixte
- Speed retention across power cycles on the Minitel 2's EEPROM-equipped unit is unknown.

Downloaded STUM 1B and page renders are in `/tmp/claude-1000/-home-pix-claude-lora/6344e1cc-56fc-4683-a703-d0cec995bdf6/scratchpad/dl/` (`stum1b.pdf`; `pg/p-NNN.png` = PDF page NNN).