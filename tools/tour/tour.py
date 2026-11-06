#!/usr/bin/env python3
"""tour.py - walk every 3615 MESHCORE page over USB and build the screen gallery.

    python3 -I tools/tour/tour.py run                 # 40 and 80 col, render, build the site
    python3 -I tools/tour/tour.py run --modes 80 --only home,convlist --no-site
    python3 -I tools/tour/tour.py simulate            # offline test against a fake device
    python3 -I tools/tour/tour.py import x.dump       # add a real dump taken by hand
    python3 -I tools/tour/tour.py render              # optional photo renders of the dumps

`run` drives the companion firmware's USB local CLI (115200 baud, CR line ends) with
`ui reset`, `type`, `key`, `wait idle`, `ui state`, `screen`, `screen watch` and `splash scene`. For each
mode (Réglages 10 switches 40/80 columns) it walks the pages below from the Sommaire,
saves each `screen` dump to gallery/dumps/<mode>/<shot>.dump, writes gallery/manifest.json
(page, mode, title, description), then runs site/build.py, which draws the dumps as text.
`--render` also makes photo-realistic PNGs with tools/screenshot/minitel_render.py (optional). The original 40/80 mode is
restored at the end and the UI is left on the Sommaire.

Safety: the tour only VISITS pages.
  - It never sends on the radio: no ENVOI in a compose line or question, no advert, no
    flood confirmation, no login (room conversations, repeater login), no trace, no share,
    no channel or contact removal. Every ENVOI is checked against `ui state` first (page,
    open question, typed text) and an allow-list of pure navigation choices; anything else
    stops the tour (SafetyStop) and returns to the Sommaire.
  - A conversation's Actions page is opened with ENVOI on the EMPTY input line, only after
    `ui state` shows page=conv, no question, input=- and nothing pending. On that page only
    "Détails" (a page) and "Rechercher un mot" (a question, closed by SOMMAIRE) are chosen,
    found by their label on the screen; never Répondre, Renvoyer, Effacer, Silence, Tout
    marquer lu or Supprimer. The arrow key is only pressed in a conversation (it picks a
    message).
  - Only these CLI commands are ever sent: ui reset, ui state, type <1-2 letters or
    digits>, key <navigation key>, wait idle, screen, screen watch, splash scene.
  - It never opens /dev/ttyUSB* (a repeater on a ttyUSB resets when its tty is opened):
    the XIAO is found as /dev/serial/by-id/*3C0B547619DCA64A* and the resolved device must
    not be a ttyUSB.
  - The Minitel keyboard keeps working while the tour runs; don't type on it meanwhile.
Visiting a conversation marks it read, like opening it on the Minitel.

Pages not visited: the remote console and the trace (both transmit), prompts that edit
settings, and the GUIDE screens of pages other than the Sommaire. On "Bluetooth et
alimentation" (Réglages 15: Bluetooth off, reboot, power off) nothing is ever pressed.
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SCREENSHOT = os.path.join(ROOT, "tools", "screenshot")
SITE = os.path.join(ROOT, "site")
GALLERY = os.path.join(ROOT, "gallery")
sys.path.insert(0, SITE)
import mtscreen  # noqa: E402  (pure-Python dump parser, shared with the site build)

SERIAL_GLOB = "/dev/serial/by-id/*3C0B547619DCA64A*"
BAUD = 115200


class SafetyStop(Exception):
    """A step would do something other than visit a page."""


class TourError(Exception):
    """The UI did not land where expected."""


# ------------------------------------------------------------------ the pages to visit

class Step:
    """One navigation step. kind: menu (type + ENVOI), key, pick_conv, pick_contact,
    pick_public, splash."""

    def __init__(self, kind, arg=None):
        self.kind, self.arg = kind, arg

    def __repr__(self):
        return f"{self.kind}({self.arg})"


def M(choice):          # type a menu choice, then ENVOI
    return Step("menu", choice)


def K(key):             # a navigation key
    return Step("key", key)


class Shot:
    def __init__(self, sid, group, title, desc, steps, page, guide=False):
        self.id, self.group, self.title, self.desc = sid, group, title, desc
        self.steps, self.page, self.guide = steps, page, guide


G_SPLASH = "Accueil"
G_HOME = "Sommaire"
G_CONV = "Conversations"
G_CONTACTS = "Contacts et stations"
G_SETTINGS = "Réglages"
G_GRAPHS = "Graphiques"

GRAPHS = [
    "SNR des paquets reçus : barre min–max et moyenne par minute, sur 2 h.",
    "RSSI des paquets reçus : barre min–max et moyenne par minute, sur 2 h.",
    "Bruit de fond, minute par minute, sur 2 h.",
    "Trafic radio : paquets reçus par minute (barres) et émis, sur 2 h.",
    "Temps d'émission par tranche de 10 min, avec la limite de la sous-bande en pointillé.",
    "Tension de la batterie, toutes les 5 min, sur 10 h.",
    "Les mieux entendus : les stations reçues en direct, classées par le SNR de leur dernière annonce.",
    "Nombre de sauts des paquets reçus en diffusion depuis le démarrage.",
    "Messages reçus par canal depuis le démarrage.",
]
GRAPH_TITLES = ["SNR", "RSSI", "Bruit de fond", "Trafic radio", "Temps d'émission", "Batterie",
                "Les mieux entendus", "Nombre de sauts", "Messages par canal"]

SHOTS = [
    Shot("splash-1", G_SPLASH, "Accueil 1/4 : le logo",
         "La page d'accueil animée, scène 1 : le maillage se dessine, nœuds puis liens, puis 3615 MESHCORE.",
         [Step("splash", 0)], "splash"),
    Shot("splash-2", G_SPLASH, "Accueil 2/4 : la radio",
         "Scène 2 : l'antenne et ses ondes, fréquence, BW/SF/CR, puissance, bruit de fond, SNR moyen, paquets.",
         [Step("splash", 1)], "splash"),
    Shot("splash-3", G_SPLASH, "Accueil 3/4 : l'identité",
         "Scène 3 : nom du nœud, début de la clé publique, position, département et région, Bluetooth, batterie.",
         [Step("splash", 2)], "splash"),
    Shot("splash-4", G_SPLASH, "Accueil 4/4 : le réseau",
         "Scène 4 : contacts, stations entendues, conversations et non-lus qui défilent, le dernier message.",
         [Step("splash", 3)], "splash"),
    Shot("home", G_HOME, "Sommaire",
         "Le menu principal : nœud, batterie, Bluetooth, les huit rubriques, la dernière touche et l'état de la liaison.",
         [], "home"),
    Shot("home-guide", G_HOME, "Guide",
         "GUIDE pressé deux fois : l'écran d'aide de la page, ses touches et la saisie des accents dans ce mode.",
         [K("guide"), K("guide")], "home", guide=True),
    Shot("convlist", G_CONV, "Conversations",
         "Sommaire 1. Canaux, messages privés et salons, les plus récents en tête, avec les non-lus.",
         [M("1")], "convlist"),
    Shot("conv-channel", G_CONV, "Une conversation de canal",
         "L'historique d'un canal, le plus récent en bas, avec les répétitions entendues de vos messages ; "
         "la ligne de saisie en rangée 24.",
         [M("1"), Step("pick_conv", "channel")], "conv"),
    Shot("conv-actions", G_CONV, "Actions",
         "ENVOI sur une ligne vide, après avoir choisi un message avec la flèche : répondre, effacer, détails, "
         "rechercher, réponses rapides, silence, fiche, suppression.",
         [M("1"), Step("pick_conv", "channel"), K("haut"), Step("actions")], "actions"),
    Shot("msginfo", G_CONV, "Détails d'un message",
         "Tout ce qui est gardé d'un message : sens, auteur, date à la seconde, sauts et SNR, accusé, "
         "répétitions entendues, taille, texte entier.",
         [M("1"), Step("pick_conv", "channel"), K("haut"), Step("actions"), Step("pick_action", "Détails")], "msginfo"),
    Shot("conv-search", G_CONV, "Rechercher un mot",
         "Actions, Rechercher un mot : la question s'affiche en bas de page.",
         [M("1"), Step("pick_conv", "channel"), Step("actions"), Step("pick_action", "Rechercher")], "actions"),
    Shot("conv-dm", G_CONV, "Une conversation privée",
         "Un échange en message privé, avec les marques de remise : (...), (reçu), (échec ?).",
         [M("1"), Step("pick_conv", "dm")], "conv"),
    Shot("news", G_CONV, "Dernières nouvelles",
         "Sommaire 2. Les derniers messages de toutes les conversations, fusionnés par heure ; les non-lus clignotent.",
         [M("2")], "news"),
    Shot("contacts", G_CONTACTS, "Contacts",
         "Sommaire 3. Les contacts par dernière annonce : type, nom, sauts, dernière annonce, début de clé ; "
         "les favoris en tête.",
         [M("3")], "contacts"),
    Shot("heard", G_CONTACTS, "Stations entendues",
         "Contacts, puis E : toutes les stations entendues depuis le démarrage, contacts ou non.",
         [M("3"), M("E")], "contacts"),
    Shot("nearby", G_CONTACTS, "Stations proches",
         "Contacts, puis P : les stations qui annoncent une position, la plus proche en tête, avec distance et cap.",
         [M("3"), M("P")], "nearby"),
    Shot("contact", G_CONTACTS, "Fiche contact",
         "Une fiche : nom, clé, chemin, dernière annonce, position, courbe du SNR, et les actions.",
         [M("3"), Step("pick_contact", "any")], "contact"),
    Shot("admin", G_CONTACTS, "Administration d'un relais",
         "Fiche, action 7, sur un relais : connexion, état, voisins, télémesure, console à distance "
         "(rien n'est envoyé ici).",
         [M("3"), Step("pick_contact", "repeater"), M("7")], "admin"),
    Shot("advert", G_CONTACTS, "Envoyer une annonce",
         "Sommaire 5. Annonce locale ou à tout le réseau, et l'heure de la dernière (simple visite).",
         [M("5")], "advert"),
    Shot("settings", G_SETTINGS, "Réglages et identité",
         "Sommaire 4. Les quinze réglages : nom, position, heure, canaux, régions, ajout des contacts, "
         "répétition, sonnerie, 40/80 colonnes...",
         [M("4")], "settings"),
    Shot("channels", G_SETTINGS, "Canaux",
         "Réglages 4. Chaque canal avec son numéro et sa région d'envoi ; H et P en ajoutent.",
         [M("4"), M("4")], "channels"),
    Shot("channel", G_SETTINGS, "Fiche canal (Public)",
         "La fiche d'un canal : région d'envoi, masquage dans les nouvelles, clé en hexadécimal et en base64.",
         [M("4"), M("4"), Step("pick_public")], "channel"),
    Shot("regionpick", G_SETTINGS, "Choix de la région",
         "Réglages 5. eu, fr, les régions puis leurs départements, selon le nommage Gaulix.",
         [M("4"), M("5")], "regionpick"),
    Shot("autoreg", G_SETTINGS, "Régions automatiques",
         "Réglages 6. La région suggérée d'après la position ou le département saisi, et une région par canal.",
         [M("4"), M("6")], "autoreg"),
    Shot("autoadd", G_SETTINGS, "Ajout automatique des contacts",
         "Réglages 7. Les réglages d'ajout de l'appli, et qui peut lire la télémesure du nœud.",
         [M("4"), M("7")], "autoadd"),
    Shot("status", G_SETTINGS, "État et statistiques",
         "Réglages 11. Batterie, radio, compteurs de paquets, stockage, liaison, pile et tas, dernier redémarrage.",
         [M("4"), M("11")], "status"),
    Shot("quick", G_SETTINGS, "Réponses rapides",
         "Réglages 12. Dix textes modifiables, à insérer depuis la page Actions d'une conversation.",
         [M("4"), M("12")], "quick"),
    Shot("mykey", G_SETTINGS, "Mon identité",
         "Réglages 13. Le nom et la clé publique à donner à vos correspondants.",
         [M("4"), M("13")], "mykey"),
    Shot("device", G_SETTINGS, "Bluetooth et alimentation",
         "Réglages 15. État du Bluetooth, code d'appairage, batterie ; couper le Bluetooth, redémarrer, éteindre "
         "(jamais pressé par la visite).",
         [M("4"), M("15")], "device"),
    Shot("clock", G_SETTINGS, "Date et heure",
         "Sommaire 6. L'heure locale, réglée à la main, par l'appli, par USB ou par l'accord de deux nœuds ; "
         "le fuseau horaire.",
         [M("6")], "clock"),
    Shot("graphs", G_GRAPHS, "Graphiques",
         "Sommaire 8. Les statistiques radio gardées en mémoire depuis le démarrage.",
         [M("8")], "graphs"),
] + [
    Shot(f"graph-{n}", G_GRAPHS, f"Graphique {n} : {GRAPH_TITLES[n - 1]}", GRAPHS[n - 1],
         [M("8"), M(str(n))], "graph")
    for n in range(1, 10)
]
SHOT_IDS = [s.id for s in SHOTS]

# ------------------------------------------------------------------ safety rules

NAV_KEYS = {"retour", "sommaire", "guide", "suite", "connexion", "annulation", "correction", "repetition", "haut"}
ARROW_OK = {"conv"}   # "haut" only picks a message in a conversation
# entries of a conversation's Actions page the tour may open: Détails is a page, Rechercher
# a question (closed by SOMMAIRE). Never Répondre/Renvoyer/Effacer/Silence/Supprimer...
ACTION_OK = ("Détails", "Rechercher")
# ENVOI is only ever pressed on these pages, with these inputs (pure navigation)
ENVOI_OK = {
    "home": {str(n) for n in range(1, 9)},                    # the 8 services (5 = advert PAGE)
    "settings": {"3", "4", "5", "6", "7", "11", "12", "13", "15"},  # pages only; 10 = mode, see below
    "contacts": {"E", "C", "P"},                              # + a list number (contact sheet)
    "contact": {"7"},                                         # administration page (no login)
    "graphs": {str(n) for n in range(1, 10)},
    "channels": set(),                                        # + "0" once checked to be Public
    "convlist": set(),                                        # + a number checked not to be a room
    "actions": set(),                                         # + Détails / Rechercher, read on the screen
    # "settings" + "10" (the 40/80 switch) only from set_mode()
}
SUITE_OK = {"convlist", "conv", "news", "contacts", "graph", "nearby", "autoreg", "quick", "regionpick"}
TYPE_OK = re.compile(r"^[0-9A-Za-z]{1,2}$")
CMD_OK = re.compile(r"^(ui reset|ui state|screen|screen watch \d{1,3} \d{2,4}|wait idle( \d+)?|splash scene ([0-3]|off)|"
                    r"key [a-z]+|type [0-9A-Za-z]{1,2})$")


def parse_state(lines):
    """`ui state` reply -> dict (page, mode, link, prompt, input (decoded), guide, help...)."""
    for line in lines:
        m = re.search(r"\bUI (page=.*)", line)
        if not m:
            continue
        st = {}
        for tok in m.group(1).split():
            if "=" in tok:
                k, v = tok.split("=", 1)
                st[k] = v
        raw = st.get("input", "-")
        if raw in ("-", "*"):
            st["text"] = "" if raw == "-" else "*"
        else:
            try:
                st["text"] = bytes.fromhex(raw).decode("utf-8", "replace")
            except ValueError:
                st["text"] = "?"
        return st
    raise TourError(f"no UI line in the `ui state` reply: {lines!r}")


def list_rows(scr, first=3, last=21):
    """Numbered list rows of a page: [(number, type token, row text)]."""
    rows = []
    for r in range(first, min(last + 1, scr.rows)):
        m = re.match(r"^\s*(\d+)\s+(\S+)", scr.row_text(r))
        if m:
            rows.append((int(m.group(1)), m.group(2), scr.row_text(r).rstrip()))
    return rows


CONV_TYPES = {"channel": {"canal", "#"}, "dm": {"privé", "@"}, "room": {"salon", "&"}}
CONTACT_TYPES = {"person": {"perso", "@"}, "repeater": {"relais", "R"}, "room": {"salon", "&"},
                 "sensor": {"capteur", "C"}}


def pick_conv(scr, kind):
    """List number of the first conversation of this kind; never a room (opening a room
    conversation logs in, which transmits)."""
    for n, tok, _ in list_rows(scr):
        if tok in CONV_TYPES["room"]:
            continue
        if tok in CONV_TYPES[kind]:
            return n
    return None


def pick_contact(scr, kind):
    for n, tok, _ in list_rows(scr):
        if kind == "any" or tok in CONTACT_TYPES[kind]:
            return n
    return None


def pick_action(scr, label):
    """Number of the Actions entry whose label starts with `label` (from the screen)."""
    for r in range(3, min(22, scr.rows)):
        m = re.match(r"^\s*(\d+)\s+(\S.*)$", scr.row_text(r))
        if m and m.group(2).startswith(label):
            return int(m.group(1))
    return None


def public_channel_listed(scr):
    """True if channel index 0 is listed as Public (its key is the well-known one)."""
    for r in range(3, min(22, scr.rows)):
        if re.match(r"^\s*0\s+.*\bPublic\b", scr.row_text(r)):
            return True
    return False


# ------------------------------------------------------------------ device links

def find_port(pattern=SERIAL_GLOB):
    hits = sorted(glob.glob(pattern))
    if not hits:
        raise SystemExit(f"no device matches {pattern} (is the XIAO plugged in?)")
    real = os.path.realpath(hits[0])
    if os.path.basename(real).startswith("ttyUSB"):
        raise SystemExit(f"{hits[0]} -> {real}: refusing to open a ttyUSB device")
    return hits[0]


class SerialDevice:
    """The USB local CLI. Replies end with a line that is exactly OK, or starts with ERR."""

    def __init__(self, path, baud=BAUD, log=None):
        if os.path.basename(os.path.realpath(path)).startswith("ttyUSB"):
            raise SystemExit(f"{path}: refusing to open a ttyUSB device")
        sys.path.insert(0, SCREENSHOT)
        import minitel_dump   # pyserial when importable, else raw termios
        self.port = minitel_dump.open_port(path, baud)
        self.log = log
        end = time.time() + 0.5
        while time.time() < end and self.port.read(0.05):
            pass   # drop the boot banner / log lines

    def cmd(self, line, timeout=8.0):
        if not CMD_OK.match(line):
            raise SafetyStop(f"command not allowed: {line!r}")
        self.port.write(line.encode() + b"\r")
        buf, lines = b"", []
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = self.port.read(0.2)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                text = raw.decode("utf-8", "replace").replace("\r", "")
                if text.startswith(line):   # the echo can share a line with the reply
                    text = text[len(line):]
                if self.log:
                    self.log.write(text + "\n")
                t = text.strip()
                if not t:
                    continue
                lines.append(text)
                if t == "OK" or t.startswith("ERR"):
                    return lines
        raise TourError(f"no OK after {timeout}s for {line!r} ({len(lines)} lines)")

    def close(self):
        self.port.close()


# ------------------------------------------------------------------ the tour

class Tour:
    def __init__(self, dev, out=GALLERY, verbose=True):
        self.dev, self.out, self.verbose = dev, out, verbose

    def say(self, msg):
        if self.verbose:
            print(msg, flush=True)

    def send(self, line, timeout=8.0):
        if not CMD_OK.match(line):
            raise SafetyStop(f"command not allowed: {line!r}")
        lines = self.dev.cmd(line, timeout)
        last = lines[-1].strip() if lines else ""
        if last.startswith("ERR"):
            raise TourError(f"{line!r}: {last}")
        return lines

    def state(self):
        return parse_state(self.send("ui state"))

    def idle(self, ms=10000):
        self.send(f"wait idle {ms}", timeout=ms / 1000 + 5)

    def screen(self):
        lines = self.send("screen", timeout=10)
        return "\n".join(lines), mtscreen.parse_dump("\n".join(lines))

    def key(self, name, st=None):
        name = name.lower()
        if name == "envoi":
            raise SafetyStop("ENVOI only goes through menu()")
        if name not in NAV_KEYS:
            raise SafetyStop(f"key not allowed: {name}")
        if name == "suite":
            st = st or self.state()
            if st.get("page") not in SUITE_OK:
                raise SafetyStop(f"SUITE not allowed on page {st.get('page')}")
        if name == "haut":
            st = st or self.state()
            if st.get("page") not in ARROW_OK or st.get("prompt") != "none":
                raise SafetyStop(f"arrow not allowed on page {st.get('page')}")
        self.send(f"key {name}")
        self.idle()

    def envoi_allowed(self, st, choice, also=None):
        """May ENVOI be pressed now? `also` = (page, choice): one extra navigation choice the
        caller has checked on the screen (a list number that is not a room, Public...)."""
        page = st.get("page")
        if st.get("prompt") != "none":
            return False, f"a question is open ({st.get('prompt')})"
        if st.get("text") != choice:
            return False, f"the input line holds {st.get('text')!r}, not {choice!r}"
        if also and also == (page, choice):
            return True, ""
        ok = ENVOI_OK.get(page)
        if ok is None:
            return False, f"no ENVOI on page {page}"
        if choice in ok or choice.upper() in ok:
            return True, ""
        return False, f"choice {choice!r} not allowed on page {page}"

    def menu(self, choice, also=None):
        """Type a choice and press ENVOI, after checking that it only navigates."""
        if not TYPE_OK.match(choice):
            raise SafetyStop(f"refusing to type {choice!r}")
        st = self.state()
        if st.get("page") not in ENVOI_OK:
            raise SafetyStop(f"no typing on page {st.get('page')}")
        if st.get("prompt") != "none":
            raise SafetyStop(f"a question is open ({st.get('prompt')})")
        if st.get("text"):
            self.send("key annulation")
        self.send(f"type {choice}")
        st = self.state()
        ok, why = self.envoi_allowed(st, choice, also)
        if not ok:
            self.send("key annulation")
            raise SafetyStop(why)
        self.dev.cmd("key envoi")   # the only ENVOI, checked just above
        self.idle()

    def actions(self):
        """ENVOI on an EMPTY conversation line opens the Actions page; with text it would send.
        Checked with `ui state` just before: page conv, no question, empty input, nothing pending."""
        st = self.state()
        if st.get("page") != "conv":
            raise SafetyStop(f"Actions only from a conversation, not {st.get('page')}")
        if st.get("prompt") != "none":
            raise SafetyStop(f"a question is open ({st.get('prompt')})")
        if st.get("input") != "-" or st.get("text"):
            raise SafetyStop("the conversation line is not empty: ENVOI would send it")
        if st.get("pending", "-") != "-":
            raise SafetyStop("an accent sequence is pending on the line")
        self.dev.cmd("key envoi")   # empty line: opens Actions, sends nothing
        self.idle()
        st = self.state()
        if st.get("page") != "actions":
            raise TourError(f"ENVOI on the empty line led to {st.get('page')}, not actions")

    def reset(self):
        self.send("ui reset")
        self.idle()

    def set_mode(self, cols):
        st = self.state()
        if st.get("mode") == str(cols):
            return
        self.say(f"switching to {cols} columns (Réglages 10)")
        self.reset()
        self.menu("4")
        if self.state().get("page") != "settings":
            raise TourError("Réglages did not open")
        self.menu("10", also=("settings", "10"))
        deadline = time.time() + 30
        while time.time() < deadline:
            time.sleep(1.0)
            st = self.state()
            if st.get("mode") == str(cols):
                break
        else:
            raise TourError(f"the mode did not change to {cols}")
        time.sleep(3.0)   # the terminal re-initialises and shows the welcome page
        self.reset()

    def run_step(self, step):
        if step.kind == "menu":
            self.menu(step.arg)
        elif step.kind == "key":
            self.key(step.arg)
        elif step.kind == "splash":
            self.send(f"splash scene {int(step.arg)}")
            self.idle()
        elif step.kind == "pick_conv":
            _, scr = self.screen()
            n = pick_conv(scr, step.arg)
            if n is None:
                raise TourError(f"no {step.arg} conversation in the list")
            self.menu(str(n), also=("convlist", str(n)))
        elif step.kind == "pick_contact":
            _, scr = self.screen()
            n = pick_contact(scr, step.arg)
            if n is None:
                raise TourError(f"no {step.arg} contact in the list")
            self.menu(str(n), also=("contacts", str(n)))
        elif step.kind == "actions":
            self.actions()
        elif step.kind == "pick_action":
            if step.arg not in ACTION_OK:
                raise SafetyStop(f"action {step.arg!r} is not on the allow-list")
            _, scr = self.screen()
            n = pick_action(scr, step.arg)
            if n is None:
                raise TourError(f"no {step.arg!r} entry on the Actions page")
            self.menu(str(n), also=("actions", str(n)))
        elif step.kind == "pick_public":
            _, scr = self.screen()
            if not public_channel_listed(scr):
                raise TourError("channel 0 is not Public: its sheet would show a private key")
            self.menu("0", also=("channels", "0"))
        else:
            raise SafetyStop(f"unknown step {step!r}")

    def capture(self, shot, cols):
        self.reset()
        for step in shot.steps:
            self.run_step(step)
        self.idle()
        st = self.state()
        if st.get("page") != shot.page:
            raise TourError(f"landed on {st.get('page')}, expected {shot.page}")
        if shot.guide and st.get("guide") != "1":
            raise TourError("the Guide screen did not open")
        text, scr = self.screen()
        if scr.cols != cols:
            raise TourError(f"dump is {scr.cols} columns, expected {cols}")
        rel = os.path.join("dumps", str(cols), f"{shot.id}.dump")
        path = os.path.join(self.out, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(normalise(text))
        if shot.steps and shot.steps[0].kind == "splash":
            self.send("splash scene off")
        return entry(shot, cols, rel, scr)

    def splash_anim(self, cols, frames=60, ms=130):
        """Record the welcome page's reveal: Sommaire 7, then `screen watch` (one dump every
        `ms`, with the firmware's own timing)."""
        self.reset()
        self.send("splash scene off")
        self.reset()
        self.menu("7")
        lines = self.send(f"screen watch {frames} {ms}", timeout=frames * ms / 1000 + 30)
        dumps, cur = [], []
        for ln in lines:
            if re.search(r"\bSCREEN\b", ln) and cur:
                dumps.append(cur)
                cur = []
            cur.append(ln)
        if cur:
            dumps.append(cur)
        frames_out, last = [], None
        for d in dumps:
            body = normalise("\n".join(d))
            key = re.sub(r" t=\d+", "", body)
            if key != last:   # keep the changes only
                frames_out.append(body)
                last = key
        self.reset()
        d = os.path.join(self.out, "dumps", str(cols), "splash-anim")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        rels = []
        for i, body in enumerate(frames_out):
            rel = os.path.join("dumps", str(cols), "splash-anim", f"f{i:02d}.dump")
            with open(os.path.join(self.out, rel), "w", encoding="utf-8") as f:
                f.write(body)
            rels.append(rel)
        return {"id": f"splash-anim-{cols}", "group": G_SPLASH, "mode": cols,
                "title": "Accueil animé",
                "description": "La page d'accueil qui se dessine, enregistrée image par image sur l'appareil "
                               "(screen watch, au rythme du micrologiciel).",
                "frames": rels, "frame_ms": ms, "image": f"renders/{cols}/splash-anim.gif",
                "synthetic": False}


def normalise(text):
    """Keep the SCREEN/ROW/CURSOR lines, two-space indented, then OK."""
    out = []
    for raw in text.replace("\r", "\n").split("\n"):
        m = re.search(r"\b(SCREEN|ROW|CURSOR)\b", raw)
        if m:
            out.append("  " + raw[m.start():].strip())
    return "\n".join(out + ["  OK"]) + "\n"


def entry(shot, cols, rel, scr=None):
    return {
        "id": f"{shot.id}-{cols}", "shot": shot.id, "group": shot.group, "mode": cols,
        "page": scr.page if scr else shot.page, "title": shot.title, "description": shot.desc,
        "dump": rel, "image": f"renders/{cols}/{shot.id}.png", "synthetic": False,
    }


def walk(tour, modes, only=None, splash_anim=False, stop_on_error=False):
    """Visit every shot in every mode; returns (screens, animations, failures)."""
    screens, anims, failures = [], [], []
    start_mode = tour.state().get("mode")
    try:
        for cols in modes:
            tour.set_mode(cols)
            for shot in SHOTS:
                if only and shot.id not in only:
                    continue
                tour.say(f"[{cols}] {shot.id}")
                try:
                    screens.append(tour.capture(shot, cols))
                except TourError as e:
                    tour.say(f"  skipped: {e}")
                    failures.append((cols, shot.id, str(e)))
                    tour.send("splash scene off")
                    tour.reset()
                    if stop_on_error:
                        raise
            if splash_anim:
                anims.append(tour.splash_anim(cols))
    except SafetyStop as e:
        tour.say(f"SAFETY STOP: {e}")
        failures.append(("-", "safety", str(e)))
        try:
            tour.send("ui reset")
        except Exception:
            pass
        raise
    finally:
        try:
            if start_mode and tour.state().get("mode") != start_mode:
                tour.set_mode(int(start_mode))
            tour.reset()
        except Exception as e:   # leave the device usable even if this fails
            print(f"could not restore the UI: {e}", file=sys.stderr)
    return screens, anims, failures


# ------------------------------------------------------------------ manifest, renders, site

def manifest_path(out=GALLERY):
    return os.path.join(out, "manifest.json")


def load_manifest(out=GALLERY):
    try:
        with open(manifest_path(out), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"version": 1, "screens": [], "animations": []}


def write_manifest(screens, anims, source, out=GALLERY, keep_synthetic_anims=False, note="", firmware=None):
    old = load_manifest(out)
    if keep_synthetic_anims and not anims:
        anims = [a for a in old.get("animations", []) if a.get("synthetic")]
    order = {sid: i for i, sid in enumerate(SHOT_IDS)}
    screens = sorted(screens, key=lambda e: (order.get(e.get("shot"), 999), e["mode"]))
    m = {
        "version": 1,
        "generated": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": source,
        "note": note,
        "firmware": firmware or old.get("firmware"),
        "screens": screens,
        "animations": anims,
    }
    os.makedirs(out, exist_ok=True)
    tmp = manifest_path(out) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, manifest_path(out))
    return m


def render_missing(m, out=GALLERY, force=False, dry_run=False):
    """Render each manifest dump to its PNG (and animation GIFs) with minitel_render.py."""
    renderer = os.path.join(SCREENSHOT, "minitel_render.py")
    jobs = []
    for e in m.get("screens", []):
        img = os.path.join(out, e["image"])
        if force or not os.path.exists(img):
            jobs.append(([os.path.join(out, e["dump"])], img, []))
    for a in m.get("animations", []):
        img = os.path.join(out, a["image"])
        if force or not os.path.exists(img):
            jobs.append(([os.path.join(out, f) for f in a["frames"]], img,
                         ["--frame-ms", str(a.get("frame_ms", 130))]))
    for dumps, img, extra in jobs:
        cmd = [sys.executable, "-I", renderer] + dumps + ["--screen-only", "-o", img] + extra
        print("render", os.path.relpath(img, ROOT), flush=True)
        if dry_run:
            continue
        os.makedirs(os.path.dirname(img), exist_ok=True)
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    return jobs


def build_site():
    subprocess.run([sys.executable, "-I", os.path.join(SITE, "build.py")], check=True)


# ------------------------------------------------------------------ importing real dumps

FW_SAMPLES = os.path.normpath(os.path.join(ROOT, "..", "meshcore-observer-minitel", "examples",
                                           "companion_radio", "ui-minitel", "tools", "samples"))
PAGE_TO_SHOT = {"home": "home", "convlist": "convlist", "conv": "conv-channel", "news": "news", "contacts": "contacts",
                "contact": "contact", "settings": "settings", "status": "status", "graphs": "graphs", "clock": "clock",
                "actions": "conv-actions", "msginfo": "msginfo", "device": "device", "mykey": "mykey"}


def import_real(out=GALLERY, real=()):
    """Gallery entries from real dumps captured by hand (minitel_dump.py), for pages the tour
    has not captured yet. Only real device captures: never synthetic samples."""
    by_id = {s.id: s for s in SHOTS}
    old = load_manifest(out)
    screens = [e for e in old.get("screens", []) if not e.get("synthetic")]
    anims = [x for x in old.get("animations", []) if not x.get("synthetic")]
    for p in real:
        with open(p, encoding="utf-8", errors="replace") as f:
            text = f.read()
        scr = mtscreen.parse_dump(text)
        sid = PAGE_TO_SHOT.get(scr.page, scr.page)
        shot = by_id.get(sid) or Shot(sid, "Autres", sid, "", [], sid)
        rel = os.path.join("dumps", str(scr.cols), f"{sid}.dump")
        os.makedirs(os.path.join(out, os.path.dirname(rel)), exist_ok=True)
        with open(os.path.join(out, rel), "w", encoding="utf-8") as f:
            f.write(normalise(text))
        e = entry(shot, scr.cols, rel, scr)
        e["captured"] = datetime.datetime.fromtimestamp(os.path.getmtime(p)).astimezone().isoformat(timespec="minutes")
        screens = [x for x in screens if x["id"] != e["id"]] + [e]
    return write_manifest(screens, anims, old.get("source") or "import", out)


# ------------------------------------------------------------------ offline simulation

class FakeDevice:
    """Enough of the firmware's UI to test the tour offline: page transitions for the
    navigation the tour uses, `ui state`, and `screen` from the sample dumps (or a
    generated page). Records every command, and fails loudly on a forbidden ENVOI."""

    MENU = {
        "home": {"1": "convlist", "2": "news", "3": "contacts", "4": "settings", "5": "advert", "6": "clock",
                 "7": "splash", "8": "graphs"},
        "settings": {"3": "clock", "4": "channels", "5": "regionpick", "6": "autoreg", "7": "autoadd",
                     "11": "status", "12": "quick", "13": "mykey", "15": "device"},
        "contacts": {"E": "contacts", "C": "contacts", "P": "nearby", "A": "advert"},
        "contact": {"7": "admin"},
        "graphs": {str(n): "graph" for n in range(1, 10)},
    }
    TRANSMITS = {("advert", "1"), ("advert", "2"), ("contact", "3"), ("contact", "6"), ("contact", "8"),
                 ("contact", "9"), ("admin", "1"), ("conv", ""), ("device", "1"), ("device", "3"), ("device", "4")}

    def __init__(self, samples=None, mode=80):
        self.page, self.mode, self.text, self.prompt, self.guide, self.gcount = "home", mode, "", "none", 0, 0
        self.samples = samples or {}
        self.log = []
        self.empty_envois = []
        self.sent_on_radio = []
        self.scene = None

    def dump(self):
        key = (self.page, self.mode)
        if key in self.samples:
            with open(self.samples[key], encoding="utf-8") as f:
                return f.read()
        lines = [f"FAKE {self.page.upper()}", ""]
        if self.page == "actions":
            lines += [" Message choisi ", "  12:00 Quelqu'un > bonjour", "", "  1 Répondre", "  2 Effacer ce message",
                      "  3 Détails", " Ce canal ", "  4 Rechercher un mot", "  5 Réponses rapides", "  6 Silence",
                      "  7 Tout marquer lu", "  8 Fiche du canal", "  9 Supprimer la conversation"]
        elif self.page == "convlist":   # a room first: the tour must skip it
            lines += [" 1  & Le salon", " 2  # rennes", " 3  @ Quelqu'un"]
        elif self.page == "channels":
            lines += [" 0  Public    défaut", " 1  #rennes   fr-35"]
        elif self.page == "contacts":
            lines += [" 1  salon   Le salon", " 2  relais  FR35-Relais", " 3  perso   Quelqu'un"]
        else:
            lines += [" 1  premier", " 2  second"]
        return make_dump(self.mode, self.page, lines)

    def cmd(self, line, timeout=8.0):
        if not CMD_OK.match(line) and line != "key envoi":
            raise SafetyStop(f"fake device got a forbidden command {line!r}")
        self.log.append(line)
        ok = ["  OK"]
        if line == "ui reset":
            self.page, self.text, self.prompt, self.guide, self.gcount = "home", "", "none", 0, 0
        elif line == "ui state":
            inp = self.text.encode().hex().upper() or "-"
            return [f"  UI page={self.page} mode={self.mode} link=ok prompt={self.prompt} input={inp} pending=- "
                    f"guide={self.guide} help=0 notice=0 idle=1", "  OK"]
        elif line.startswith("wait idle"):
            pass
        elif line == "screen":
            return [ln for ln in self.dump().splitlines() if ln.strip()]
        elif line.startswith("screen watch"):
            out = []
            for i in range(3):   # identical frames: the tour keeps one
                d = [ln for ln in self.dump().splitlines() if ln.strip() and ln.strip() != "OK"]
                d[0] += f" t={i * 130}"
                out += d
            return out + ["  OK"]
        elif line.startswith("splash scene"):
            arg = line.split()[-1]
            if arg != "off":
                self.page, self.scene = "splash", int(arg)
        elif line.startswith("type "):
            self.text += line[5:]
        elif line == "key envoi":
            choice, self.text = self.text, ""
            if self.page == "conv" and choice == "":
                self.empty_envois.append(len(self.log) - 1)
                self.page = "actions"
                return ok
            if self.page == "actions":
                label = {"1": "reply", "2": "delete", "3": "details", "4": "search"}.get(choice, "other")
                if label == "details":
                    self.page = "msginfo"
                elif label == "search":
                    self.prompt = "search"
                else:
                    self.sent_on_radio.append(("actions", label))
                    raise AssertionError(f"Actions entry {label} must never be chosen")
                return ok
            if (self.page, choice) in self.TRANSMITS or self.page in ("conv", "advert", "admin", "console", "trace",
                                                                      "device"):
                self.sent_on_radio.append((self.page, choice))
                raise AssertionError(f"ENVOI on {self.page} with {choice!r} would transmit")
            if self.page == "settings" and choice == "10":
                self.mode = 40 if self.mode == 80 else 80
            elif self.page == "convlist":
                self.page = "conv"
            elif self.page == "contacts" and choice.isdigit():
                self.page = "contact"
            elif self.page == "channels" and choice.isdigit():
                self.page = "channel"
            else:
                self.page = self.MENU.get(self.page, {}).get(choice.upper(), self.page)
        elif line.startswith("key "):
            k = line[4:]
            if k == "guide":   # once: the help line; twice: the Guide screen
                self.gcount += 1
                self.guide = 1 if self.gcount >= 2 else 0
            elif k == "sommaire":
                self.page, self.prompt = "home", "none"
            elif k == "haut" and self.page != "conv":
                raise AssertionError("arrow outside a conversation")
            elif k == "annulation":
                self.text = ""
        return ok


def make_dump(cols, page, lines):
    rows = []
    for r in range(25):
        text = lines[r - 1] if 1 <= r <= len(lines) else ""
        text = (text + " " * cols)[:cols]
        attr = "0700" * cols
        rows.append(f"  ROW {r} {text.encode('utf-8').hex()} {attr}")
    mode = "mixte" if cols == 80 else "videotex"
    return "\n".join([f"  SCREEN v1 cols={cols} rows=25 mode={mode} page={page}"] + rows +
                     ["  CURSOR 24 15 1", "  OK"]) + "\n"


def simulate(out, real=()):
    """Offline test: parsing, the safety rules, the walk and the manifest, with a fake device."""
    samples = {}
    fw = os.path.join(FW_SAMPLES, "sommaire80.txt")
    if os.path.exists(fw):
        samples[("home", 80)] = fw
    fw40 = os.path.join(FW_SAMPLES, "sommaire40.txt")
    if os.path.exists(fw40):
        samples[("home", 40)] = fw40
    for p in real:
        scr = mtscreen.load_dump(p)
        samples[(scr.page, scr.cols)] = p
    conv40 = os.path.join(SCREENSHOT, "samples", "messages40.dump")
    if os.path.exists(conv40):
        samples[("conv", 40)] = conv40
    dev = FakeDevice(samples, mode=80)
    tour = Tour(dev, out=out)
    screens, anims, failures = walk(tour, [40, 80], splash_anim=True)
    assert len(anims) == 2 and all(len(a["frames"]) == 1 for a in anims), anims
    # checks
    assert not dev.sent_on_radio, dev.sent_on_radio
    assert dev.mode == 80, "the original mode was not restored"
    assert dev.page == "home", "the UI was not left on the Sommaire"
    envois = [i for i, c in enumerate(dev.log) if c == "key envoi"]
    for i in envois:   # every ENVOI follows a ui state, and a typed choice unless it opens Actions
        assert dev.log[i - 1] == "ui state", dev.log[i - 3:i + 1]
        assert dev.log[i - 2].startswith("type ") or i in dev.empty_envois, dev.log[i - 3:i + 1]
    assert dev.empty_envois, "the Actions page was never visited"
    got = {(e["shot"], e["mode"]) for e in screens}
    print(f"simulate: {len(screens)} screens, {len(failures)} failures, {len(envois)} ENVOI, "
          f"{len(dev.log)} commands")
    for f in failures:
        print("  failure:", f)
    missing = [(s.id, c) for s in SHOTS for c in (40, 80) if (s.id, c) not in got]
    assert not missing, missing
    m = write_manifest(screens, anims, "simulate", out, keep_synthetic_anims=False)
    # the manifest must round-trip and every dump must parse with the expected size
    for e in m["screens"]:
        scr = mtscreen.load_dump(os.path.join(out, e["dump"]))
        assert scr.cols == e["mode"], e
    # unsafe requests must be refused
    for bad in (lambda: tour.key("envoi"), lambda: tour.menu("hello world"), lambda: tour.send("set name x"),
                lambda: tour.send("link try 1b 39 7f")):
        try:
            bad()
        except SafetyStop:
            continue
        raise AssertionError("an unsafe request was not refused")
    dev.cmd("ui reset")
    dev.page, dev.text = "conv", "coucou"   # a message on the line: Actions must refuse
    try:
        tour.actions()
        raise AssertionError("ENVOI with text on the line was not refused")
    except SafetyStop:
        pass
    for bad in ("Effacer", "Supprimer", "Répondre", "Silence"):
        try:
            tour.run_step(Step("pick_action", bad))
            raise AssertionError(f"Actions entry {bad} was not refused")
        except SafetyStop:
            pass
    dev.cmd("ui reset")
    dev.page = "advert"
    try:
        tour.menu("1")
        raise AssertionError("ENVOI on the advert page was not refused")
    except SafetyStop:
        pass
    # the real conversation list: first channel and first DM, never a room
    for p in real:
        scr = mtscreen.load_dump(p)
        if scr.page == "convlist":
            print(f"  {os.path.basename(p)}: channel -> {pick_conv(scr, 'channel')}, dm -> {pick_conv(scr, 'dm')}")
    print("simulate: OK")
    return m


# ------------------------------------------------------------------ main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="walk the device's pages (USB) and build the gallery")
    r.add_argument("--port", help=f"serial device (default {SERIAL_GLOB})")
    r.add_argument("--modes", default="40,80", help="column modes to visit, e.g. 80 or 40,80")
    r.add_argument("--only", help="comma-separated shot ids: " + ",".join(SHOT_IDS))
    r.add_argument("--no-splash-anim", action="store_true",
                   help="don't record the welcome page animation (screen watch)")
    r.add_argument("--render", action="store_true",
                   help="also make photo-realistic PNG/GIF renders (minitel_render.py; not used by the site)")
    r.add_argument("--no-site", action="store_true")
    r.add_argument("--yes", action="store_true", help="don't ask before starting")
    r.add_argument("--log", help="write the raw CLI replies to this file")
    r.add_argument("--out", default=GALLERY)
    r.add_argument("--firmware", help="firmware commit flashed on the device, shown in the gallery (e.g. 1017dacf)")
    s = sub.add_parser("simulate", help="offline test against a fake device")
    s.add_argument("--out", help="output directory (default: a temporary one)")
    s.add_argument("--real", action="append", default=[], help="a real dump to serve (repeatable)")
    p = sub.add_parser("import", help="add real dumps captured by hand to the gallery (no synthetic samples)")
    p.add_argument("real", nargs="+", help="dump files from the device")
    p.add_argument("--out", default=GALLERY)
    p.add_argument("--no-site", action="store_true")
    rd = sub.add_parser("render", help="photo-realistic renders of the manifest's dumps (optional, not used by the site)")
    rd.add_argument("--force", action="store_true")
    rd.add_argument("--out", default=GALLERY)
    sub.add_parser("list", help="list the shots")
    a = ap.parse_args(argv)

    if a.cmd == "list":
        for sh in SHOTS:
            print(f"{sh.id:14} {sh.page:11} {sh.steps!r:40} {sh.title}")
        return
    if a.cmd == "simulate":
        import tempfile
        out = a.out or tempfile.mkdtemp(prefix="tour-sim-")
        simulate(out, a.real)
        print(f"manifest: {manifest_path(out)}")
        return
    if a.cmd == "import":
        m = import_real(a.out, a.real)
        print(f"{len(m['screens'])} screens, {len(m['animations'])} animations -> {manifest_path(a.out)}")
        if not a.no_site:
            build_site()
        return
    if a.cmd == "render":
        render_missing(load_manifest(a.out), a.out, force=a.force)
        return

    # run
    modes = [int(x) for x in a.modes.split(",") if x.strip()]
    if any(m not in (40, 80) for m in modes):
        raise SystemExit("--modes takes 40 and/or 80")
    only = set(a.only.split(",")) if a.only else None
    if only and only - set(SHOT_IDS):
        raise SystemExit(f"unknown shots: {', '.join(sorted(only - set(SHOT_IDS)))}")
    port = a.port or find_port()
    print(f"device: {port} -> {os.path.realpath(port)}")
    print("The tour drives the Minitel UI: don't type on the Minitel until it is done.")
    if not a.yes:
        input("Press Enter to start (Ctrl-C to cancel) ")
    log = open(a.log, "w", encoding="utf-8") if a.log else None
    dev = SerialDevice(port, log=log)
    try:
        tour = Tour(dev, out=a.out)
        screens, anims, failures = walk(tour, modes, only, not a.no_splash_anim and not only)
    finally:
        dev.close()
        if log:
            log.close()
    if only:   # keep the other shots' earlier captures
        old = load_manifest(a.out)
        got = {e["id"] for e in screens}
        screens = [e for e in old.get("screens", []) if e["id"] not in got and not e.get("synthetic")] + screens
        anims = anims or [x for x in old.get("animations", []) if not x.get("synthetic")]
    m = write_manifest(screens, anims, "tour", a.out, firmware=a.firmware)
    print(f"{len(m['screens'])} screens, {len(m['animations'])} animations -> {manifest_path(a.out)}")
    for f in failures:
        print("  not captured:", f)
    if a.render:
        render_missing(m, a.out, force=not only)
    if not a.no_site:
        build_site()


if __name__ == "__main__":
    main()
