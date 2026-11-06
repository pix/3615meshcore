#!/usr/bin/env python3
"""Write synthetic `screen` dumps (format v1) for testing minitel_render.py.

    python3 -I make_samples.py [outdir]      # default: ./samples

samples/sommaire80.dump  80 col Mixte Sommaire (inverse/bold/underline, cursor)
samples/messages40.dump  40 col Vidéotex page: double-height/-size titles, inverse bars,
                         contiguous and separated mosaic rules, a mosaic logo, grey levels
"""
import os
import sys

INV, BLINK, LINE, BOLD, DBLH, DBLW, MOS, CONC = 1, 2, 4, 8, 16, 32, 64, 128
CONT = 0x4000


class Buf:
    def __init__(self, cols, mode, page):
        self.cols, self.rows, self.mode, self.page = cols, 25, mode, page
        self.ch = [[" "] * cols for _ in range(25)]
        self.at = [[0x0700] * cols for _ in range(25)]
        self.cursor = (1, 1, 0)

    def attr(self, flags=0, fg=7, bg=0):
        return flags | (fg << 8) | (bg << 11)

    def text(self, r, c, s, flags=0, fg=7, bg=0):
        """Write text at row r, col c (0-based col). Double height marks the row above,
        double width marks the next cell, as continuation."""
        a = self.attr(flags, fg, bg)
        step = 2 if flags & DBLW else 1
        for i, ch in enumerate(s):
            cc = c + i * step
            if cc >= self.cols:
                break
            self.ch[r][cc] = ch
            self.at[r][cc] = a
            cont = (a & ~0x00FF) | CONT | (flags & (INV | MOS))
            if flags & DBLW and cc + 1 < self.cols:
                self.ch[r][cc + 1] = " "
                self.at[r][cc + 1] = cont
            if flags & DBLH and r > 0:
                for k in range(step):
                    if cc + k < self.cols:
                        self.ch[r - 1][cc + k] = " "
                        self.at[r - 1][cc + k] = cont
        return len(s) * step

    def fill(self, r, c, n, ch=" ", flags=0, fg=7, bg=0):
        self.text(r, c, ch * n, flags, fg, bg)

    def mosaic(self, r, c, codes, fg=7, bg=0, separated=False):
        a = MOS | (LINE if separated else 0)
        for i, code in enumerate(codes):
            if c + i < self.cols:
                self.ch[r][c + i] = chr(code)
                self.at[r][c + i] = self.attr(a, fg, bg)

    def dump(self):
        out = ["screen", f"  SCREEN v1 cols={self.cols} rows=25 mode={self.mode} page={self.page}"]
        for r in range(25):
            th = "".join(self.ch[r]).encode("utf-8").hex().upper()
            ah = "".join("%04X" % a for a in self.at[r])
            out.append(f"  ROW {r} {th} {ah}")
        out.append("  CURSOR %d %d %d" % self.cursor)
        out.append("  OK")
        return "\n".join(out) + "\n"


def sommaire80():
    s = Buf(80, "mixte", "home")
    s.fill(1, 0, 80, " ", INV)
    s.text(1, 1, "3615 MESHCORE", INV | BOLD)
    st = "3 non lus  BLE connecté  4.08 V  21:37 "
    s.text(1, 80 - len(st), st, INV)
    s.fill(2, 0, 80, " ", LINE)
    s.text(2, 0, " Sommaire ", INV | BOLD)
    s.text(2, 80 - 16, "Messagerie LoRa", LINE)
    s.text(4, 1, "Noeud     : FR35-Minitel-PiX                 Fréquence : 869.618 MHz  SF8 BW62")
    s.text(5, 1, "Batterie  : 4082 mV        Bluetooth : connecté        Voisins : 14 entendus")
    labels = ["Conversations  (3 non lus)", "Dernières nouvelles", "Contacts et stations entendues",
              "Réglages et identité", "Envoyer une annonce", "Date et heure",
              "Passer en 40 colonnes", "Page d'accueil 3615 MESHCORE"]
    for i, lab in enumerate(labels):
        row = 8 + (i % 4) * 2
        col = 3 if i < 4 else 43
        s.text(row, col, f" {i + 1} ", INV)
        s.text(row, col + 4, lab, BOLD if i == 0 else 0)
    s.text(17, 1, "Dernier message : ", 0)
    s.text(17, 19, "#rennes", BOLD)
    s.text(17, 27, "35THOR-COMP : on se retrouve au relais de la Croix-Rouge ?")
    s.text(19, 1, "Clavier : Envoi")
    s.text(20, 1, "          [13 41]")
    s.text(21, 1, "Minitel : 9600 bauds, Mixte 80 col, ROM Bv9, statut 4B, réinit 0, err 0")
    col = 0
    for i, part in enumerate(["Votre choix puis ", " ENVOI ", "   ", " GUIDE ", " aide   ", " SOMMAIRE ", " ce menu"]):
        col += s.text(23, col, part, INV if i % 2 else 0)
    n = s.text(24, 0, "Votre choix : ")
    s.text(24, n, "..")
    s.cursor = (24, n, 1)
    return s


def messages40():
    s = Buf(40, "videotex", "conv")
    # status row (inverse)
    s.fill(1, 0, 40, " ", INV)
    s.text(1, 1, "3615 MESHCORE", INV)
    s.text(1, 27, "3 msg 21:37", INV)
    # double-size title with a mosaic logo on the left
    logo_top = [0x60, 0x7C, 0x7F, 0x7C, 0x30]
    logo_bot = [0x22, 0x2F, 0x7F, 0x2F, 0x21]
    s.mosaic(2, 1, logo_top, fg=6)
    s.mosaic(3, 1, logo_bot, fg=6)
    s.text(3, 8, "#rennes", DBLH | DBLW, fg=7)
    s.text(3, 24, "canal", DBLH, fg=5)
    # contiguous mosaic rule
    s.mosaic(4, 0, [0x23] * 40, fg=7)
    msgs = [
        ("21:02", "35THOR-COMP", "relais Croix-Rouge ok ?"),
        ("21:05", "FR35-PiX", "oui, j'y serai vers 22h"),
        ("21:11", "LLX-BRIDGE", "pont 868 en ligne, 3 sauts"),
        ("21:19", "35CESS-molus", "test à l'antenne : RSSI -97"),
        ("21:30", "FR35-RNS-BAUD", "Hello depuis Saint-Malo !"),
    ]
    r = 6
    for t, who, txt in msgs:
        s.text(r, 0, t, 0, fg=3)
        s.text(r, 6, who, BOLD, fg=7)
        s.text(r + 1, 2, txt, 0, fg=6)
        r += 2
    # separated mosaic rule
    s.mosaic(r, 0, [0x2C] * 40, fg=4, separated=True)
    r += 1
    s.text(r + 1, 1, "Nouveau message :", 0, fg=5)
    s.fill(r + 2, 1, 38, ".", 0, fg=2)
    # inverse bar with hints
    col = 0
    for i, part in enumerate(["Texte + ", " ENVOI ", "  ", " SUITE ", " ", " RETOUR "]):
        col += s.text(23, col, part, INV if i % 2 else 0)
    s.fill(24, 0, 40, " ", INV, fg=7)
    s.text(24, 1, "SOMMAIRE", INV | BLINK)
    s.text(24, 12, "menu      GUIDE aide", INV)
    s.cursor = (r + 2, 1, 1)
    return s


# ---------------------------------------------------------------- splash (port of UITaskSplash.cpp)
# The firmware's raw splash dump is blank (it bypasses the screen model), so the four scenes
# are rebuilt here from the firmware source, with plausible values for the live fields.

class Scr(Buf):
    """ScreenBuf-like helpers with the firmware's 1-based columns."""

    def t(self, r, c, s, attr=0):
        f = attr
        if attr & DBLH and attr & DBLW:
            pass
        return self.text(r, c - 1, s, f)

    def centered(self, r, s, attr=0):
        c = 1 + (self.cols - len(s)) // 2
        self.text(r, c - 1, s, attr)
        return c

    def set_attr(self, r, c, n, attr):
        for k in range(n):
            if 0 <= c - 1 + k < self.cols:
                self.at[r][c - 1 + k] = self.attr(attr)

    def mos(self, r, c, n, code):
        self.mosaic(r, c - 1, [code] * n)

    def fil(self, r, c, n, ch, attr=0):
        self.text(r, c - 1, ch * n, attr)


NODES = [(30, 1), (6, 9), (54, 9), (14, 21), (46, 21), (30, 12)]
LINKS = [(0, 1), (0, 2), (1, 3), (2, 4), (3, 4), (5, 0), (5, 1), (5, 2), (5, 3), (5, 4)]
GLYPHS = {'3': [0x1E, 0x01, 0x0E, 0x01, 0x1E], '6': [0x0E, 0x10, 0x1E, 0x11, 0x0E],
          '1': [0x04, 0x0C, 0x04, 0x04, 0x0E], '5': [0x1F, 0x10, 0x1E, 0x01, 0x1E],
          'M': [0x11, 0x1B, 0x15, 0x11, 0x11], 'E': [0x1F, 0x10, 0x1E, 0x10, 0x1F],
          'S': [0x0F, 0x10, 0x0E, 0x01, 0x1E], 'H': [0x11, 0x11, 0x1F, 0x11, 0x11],
          'C': [0x0F, 0x10, 0x10, 0x10, 0x0F], 'O': [0x0E, 0x11, 0x11, 0x11, 0x0E],
          'R': [0x1E, 0x11, 0x1E, 0x14, 0x13]}
TITLE = "3615 MESHCORE"


def splash_logo(s, wide, reveal):
    nodes = reveal + 1 if reveal < 6 else 6
    links = 0 if reveal < 6 else min(10, reveal - 5)
    if not wide:
        W_, H_ = 30, 8
        cells = [0] * (W_ * H_)

        def mset(x, y):
            if 0 <= x < 2 * W_ and 0 <= y < 3 * H_:
                bit = [1, 2, 4, 8, 16, 64][(y % 3) * 2 + (x % 2)]
                cells[(y // 3) * W_ + x // 2] |= 0x20 | bit
        for l in range(links):
            (x0, y0), (x1, y1) = NODES[LINKS[l][0]], NODES[LINKS[l][1]]
            dx, dy = abs(x1 - x0), -abs(y1 - y0)
            sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
            err = dx + dy
            while True:
                mset(x0, y0)
                if x0 == x1 and y0 == y1:
                    break
                e2 = 2 * err
                if e2 >= dy:
                    err += dy
                    x0 += sx
                if e2 <= dx:
                    err += dx
                    y0 += sy
        for n in range(nodes):
            for y in (-1, 0, 1):
                for x in (-1, 0, 1, 2):
                    mset(NODES[n][0] + x, NODES[n][1] + y)
        for r in range(H_):
            for c in range(W_):
                if cells[r * W_ + c]:
                    s.mos(4 + r, 6 + c, 1, cells[r * W_ + c])
        return
    CW, CH, C0, R0 = 36, 8, 22, 3
    cells = {}
    for l in range(links):
        (x0, y0), (x1, y1) = NODES[LINKS[l][0]], NODES[LINKS[l][1]]
        adx, ady = abs(x1 - x0), abs(y1 - y0)
        ch = '-' if ady * 5 < adx * 2 else '|' if ady * 2 > adx * 5 else ('\\' if (x1 - x0) * (y1 - y0) > 0 else '/')
        steps = max(adx, ady)
        for i in range(steps + 1):
            x = x0 + (x1 - x0) * i // (steps or 1) if (x1 - x0) * i >= 0 else -((-(x1 - x0) * i) // (steps or 1)) + x0
            y = y0 + (y1 - y0) * i // (steps or 1) if (y1 - y0) * i >= 0 else -((-(y1 - y0) * i) // (steps or 1)) + y0
            cx, cy = x * (CW - 1) // 60, y * CH // 24
            if 0 <= cx < CW and 0 <= cy < CH:
                cells[(cy, cx)] = ch
    for n in range(nodes):
        cx, cy = NODES[n][0] * (CW - 1) // 60, min(CH - 1, NODES[n][1] * CH // 24)
        cells[(cy, cx)] = 'O'
    for (r, c), ch in cells.items():
        s.fil(R0 + r, C0 + c, 1, ch, BOLD if ch == 'O' else 0)


def splash_banner(s, wide, reveal):
    if not wide:
        s.t(15, 6, " " + TITLE + " ", DBLH | DBLW | INV)   # double size: rows 14-15, cols 6-35
        return
    width = sum(4 if ch == ' ' else (6 if i < len(TITLE) - 1 else 5) for i, ch in enumerate(TITLE))
    col0 = 1 + (s.cols - width) // 2
    for r in range(5):
        col = col0
        for ch in TITLE:
            if ch == ' ':
                col += 4
                continue
            g = GLYPHS.get(ch)
            for b in range(5):
                if g and g[r] & (0x10 >> b) and col + b - col0 < reveal:
                    s.fil(12 + r, col + b, 1, ' ', INV)
            col += 6


def splash(wide, scene, f=35, unread=2):
    W = 80 if wide else 40
    s = Scr(W, "mixte" if wide else "videotex", f"splash{scene + 1}")
    s.fil(1, 1, W, ' ', INV)
    s.t(1, 2, TITLE, INV | BOLD)
    for i in range(4):
        s.t(1, W - 2 * 4 - 1 + 2 * i, str(i + 1), 0 if i == scene else INV)
    if not wide:
        s.mos(2, 1, W, 0x70)
        s.mos(21, 1, W, 0x23)
    else:
        s.fil(2, 1, W, '_')
        s.fil(21, 1, W, '_')
    col = s.centered(22, "Appuyez sur  ENVOI  pour entrer dans le service" if wide else "Appuyez sur  ENVOI ")
    s.set_attr(22, col + 12, 7, INV | BLINK)
    if unread:
        s.centered(23, f" {unread} nouveau{'x' if unread > 1 else ''} message{'s' if unread > 1 else ''} ", INV | BLINK)
    s.cursor = (24, 1, 0)
    if scene == 0:
        splash_logo(s, wide, f)
        if f >= 16:
            splash_banner(s, wide, (f - 15) * 14)
        if f >= 20:
            s.centered(18 if wide else 17, "Messagerie radio LoRa  .  r\u00e9seau maill\u00e9", BOLD if wide else 0)
        if f >= 22:
            s.centered(19, "Sans op\u00e9rateur, sans abonnement, de proche en proche" if wide
                       else "sans op\u00e9rateur, de proche en proche")
        return s
    reveal = f * 2
    lim = 3 + reveal
    if scene == 1:
        if not wide:
            s.t(4, 2, " RADIO ", DBLH | INV)
        else:
            s.t(4, 3, " Radio ", INV | BOLD)
        if reveal >= 2:
            if not wide:
                s.mos(7, 3, 1, 0x7F)
                for r in range(8, 13):
                    s.mos(r, 3, 1, 0x35)
                s.mos(13, 2, 3, 0x7F)
            else:
                s.t(7, 3, "\\|/")
                for r in range(8, 12):
                    s.t(r, 4, "|")
                s.t(12, 3, "/_\\")
            for k in range(1, f % 6 + 1):
                c = 5 + 2 * k
                s.t(8, c, ")")
                s.t(9, c + 1, ")")
                s.t(10, c + 1, ")")
                s.t(11, c, ")")
        tc, r = (26 if wide else 19), 6
        rows = [("Fr\u00e9quence      869.618 MHz" if wide else "869.618 MHz", BOLD),
                ("Bande 62.5 kHz   SF 8   CR 8" if wide else "BW62.5 SF8 CR8", 0),
                ("Puissance      22 dBm" if wide else "TX 22 dBm", 0),
                ("Bruit de fond  -112 dBm" if wide else "Bruit -112 dBm", 0)]
        for txt, at in rows:
            if r <= lim:
                s.t(r, tc, txt, at)
            r += 2
        if r <= lim:
            s.t(r, tc, "SNR moyen      +6.2 dB" if wide else "SNR +6.2 dB")
            ln = min(int((6.2 + 20) / 32 * (30 if wide else 18)) + 1, max(0, f - 8))
            if wide:
                s.fil(r + 1, tc, ln, '=', BOLD)
            else:
                s.mos(r + 1, tc, ln, 0x7F)
        r += 3
        if r <= lim and r <= 20:
            s.t(r, 3 if wide else 2, "Paquets re\u00e7us 1843, \u00e9mis 212 depuis le d\u00e9marrage" if wide
                else "Re\u00e7us 1843  \u00e9mis 212")
        return s
    if scene == 2:
        if not wide:
            s.t(4, 2, " IDENTITE ", DBLH | INV)
        else:
            s.t(4, 3, " Identit\u00e9 ", INV | BOLD)
        if lim >= 7:
            if not wide:
                s.t(7, 2, "FR35-Minitel-PiX", DBLH)
            else:
                s.t(7, 3, "FR35-Minitel-PiX", BOLD | LINE)
        if lim >= 9:
            s.t(9, 2, "Cl\u00e9 publique" if wide else "Cl\u00e9")
            key = [0x3C, 0x0B, 0x54, 0x76, 0x19, 0xDC, 0xA6, 0x4A]
            for i in range(min(8, f - 4)):
                s.t(10, (3 if wide else 2) + i * (5 if wide else 4), " %02X " % key[i], INV)
        if lim >= 12:
            s.t(12, 3 if wide else 2, "Position       48.1173  -1.6778" if wide else "48.1173 -1.6778")
        if lim >= 14:
            s.t(14, 3 if wide else 2, "D\u00e9partement    35 Ille-et-Vilaine  .  Bretagne" if wide
                else "35 Ille-et-Vilaine")
        if lim >= 16:
            s.t(16, 3 if wide else 2, "Bluetooth      appli connect\u00e9e" if wide else "BLE : appli connect\u00e9e", BOLD)
        if lim >= 18:
            s.t(18, 3 if wide else 2, "Batterie       4051 mV" if wide else "Batterie 4051 mV")
        return s
    if not wide:
        s.t(4, 2, " RESEAU ", DBLH | INV)
    else:
        s.t(4, 3, " R\u00e9seau ", INV | BOLD)
    counts = [("Contacts", 37, 0), ("Stations entendues" if wide else "Entendus", 14, 0),
              ("Conversations", 7, 0), ("Non lus", unread, (INV | BLINK) if unread else 0)]
    for i, (lab, v, at) in enumerate(counts):
        r = 7 + 2 * i
        if r > lim:
            break
        roll = v if f >= 12 else min(v, f * v // 12)
        s.t(r, 3 if wide else 2, lab)
        s.t(r, 26 if wide else 18, f" {roll} ", at | (BOLD if wide else 0))
    if lim >= 16:
        s.t(16, 3 if wide else 2, "Dernier message (#rennes) :")
        msg = "35THOR-COMP: on se retrouve au relais de la Croix-Rouge ?"
        w = W - 4
        lines = [msg[:w], msg[w:2 * w]] if len(msg) > w else [msg]
        if len(msg) > w:   # wrap on a space
            cut = msg.rfind(' ', 0, w)
            lines = [msg[:cut], msg[cut + 1:cut + 1 + w]]
        for l, txt in enumerate(lines):
            if 17 + l <= lim:
                s.t(17 + l, 3 if wide else 2, txt, BOLD)
    return s


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
    os.makedirs(out, exist_ok=True)
    files = [("sommaire80.dump", sommaire80()), ("messages40.dump", messages40())]
    for wide in (False, True):
        tag = "80" if wide else "40"
        for sc in range(4):
            files.append((f"splash{tag}-scene{sc + 1}.dump", splash(wide, sc)))
        for f in range(36):   # scene A reveal, frame by frame (firmware: 130 ms per frame)
            files.append((os.path.join(f"splash{tag}-anim", f"f{f:02d}.dump"), splash(wide, 0, f)))
    for name, buf in files:
        p = os.path.join(out, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(buf.dump())
    print(f"{len(files)} dumps in {out}")


if __name__ == "__main__":
    main()
