# Minitel link test (XIAO nRF52840)

Standalone sketch, no MeshCore. Checks the serial link to a Minitel 2 through
the arduiblog 2N2222A interface board ("Ressuscitez le Minitel"), powered from
the XIAO's **3V3** (not 5 V).

| Board wire | XIAO |
|---|---|
| wire on the transistor's free outer leg (emitter) | D6 (Serial1 TX) |
| wire joined to the 220k and DIN 3 | 9.1k in series → D7 (Serial1 RX) |
| supply (220k + 10k) | 3V3 |
| ground (22k + DIN 2) | GND |

The common-base stage does not invert, so no UART inversion is needed (the
nRF52840 cannot invert anyway). The nRF52840 has no 7-bit mode: the port runs
8N1 and even parity goes in bit 7 in software (same 10 bits on the wire).

Build/flash: `pio run -t upload --upload-port /dev/ttyACM0`. Console on USB at
115200, type `help`.

## Verified 2026-11-06 (Philips Minitel 2, ROM `B v 9`)

- Works at 1200 baud in **Vidéotex** (ENQROM, status, speed query, screen
  text, keyboard: letters, Envoi `13 41`, Retour `13 42`, Sommaire `13 46`).
- Works at **9600 baud, Mixte 80 columns, echo off** (`speed 9600`, `mixte`,
  `echo off`): status `4B`, full 80-column lines and keyboard input clean,
  no parity errors. The speed ack arrives while the UART restarts and loses
  its first bytes, so `speed` confirms with a fresh speed query instead.
- At power-on/wake the Minitel shows the **répertoire**: leave it with
  Fnct+Sommaire. Back to Vidéotex from terminal mode: Fnct+T then V.
- In Téléinformatique mode (Fnct+T, A) the protocol queries get no answer by
  design, and in our test keystrokes did not reach the DIN port.
- D7 idles with noise spikes (hundreds of sub-20 µs glitches per 200 ms,
  likely CRT pickup on the weak 220k pull-up); the UART filters them at 1200.
  If errors appear at 9600, lower the 220k to ~10k.
