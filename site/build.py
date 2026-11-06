#!/usr/bin/env python3
"""Build the 3615 MESHCORE documentation site into site/dist/ (plain files for any web server).

    python3 -I site/build.py            # build
    python3 -I site/build.py --check    # build, then check links and anchors inside dist

Inputs:
  site/templates/base.html     page skeleton ({{title}}, {{nav}}, {{content}}, ...)
  site/content/*.html          page bodies; first line: <!-- title: ... | nav: N | label: ... -->
  site/content/*.svg           drawings included with {{svg:name}}
  site/assets/                 CSS, JS, the Minitel web fonts (site/tools/make_webfont.py)
  gallery/manifest.json        the screens (tools/tour/tour.py), dumps and renders
  docs/img/hero.jpg            the hero picture

Macros in content pages:
  {{shot:ID}}         a screen with its text/image toggle (ID = manifest id like convlist-80,
                      or a shot id like convlist: the 80 col one, else the 40 col one)
  {{see:ID,ID...}}    links to those screens in the gallery
  {{svg:NAME}}        site/content/NAME.svg inline
  {{gallery_status}}  one sentence on how many screens are real captures

Standard library only; Pillow, when importable, converts the renders to WebP (else they are
copied as they are).
"""
import argparse
import html
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import mtscreen  # noqa: E402

DIST = os.path.join(HERE, "dist")
GALLERY = os.path.join(ROOT, "gallery")
CONTENT = os.path.join(HERE, "content")
SITE_TITLE = "3615 MESHCORE"
REPO_URL = "https://github.com/OWNER/3615-meshcore"   # set when the repository is published

GROUP_ORDER = ["Accueil", "Sommaire", "Conversations", "Contacts et stations", "Réglages", "Graphiques", "Autres"]
GROUP_INTRO = {
    "Accueil": "The animated welcome page, shown after boot and whenever the Minitel is switched on or wakes up.",
    "Sommaire": "The main menu, and the Guide screen (GUIDE twice).",
    "Conversations": "Channels, direct messages and rooms, and the merged news page.",
    "Contacts et stations": "Contacts, stations heard on the air, nearby stations, contact sheets, repeater administration, adverts.",
    "Réglages": "Settings, identity, channels and regions, statistics, quick replies, the clock.",
    "Graphiques": "Radio statistics since boot: G1 mosaic plots in 40 columns, text plots in 80.",
    "Autres": "",
}


def slug(s):
    s = s.lower()
    for a, b in (("é", "e"), ("è", "e"), ("ê", "e"), ("à", "a"), ("ç", "c"), ("ô", "o"), ("î", "i"), ("û", "u")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def esc(s):
    return html.escape(str(s), quote=True)


_CAPS = str.maketrans("ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ", "AAACEEEEIIOOUUUY")


def fold_caps(s):
    """The Minitel has no accented capitals (it shows É as E): text set in the Minitel font
    follows it, instead of falling back to another font for those letters."""
    return s.translate(_CAPS)


def fold_headings(page):
    """fold_caps() on the text (not the tags) of h1-h3 and the other Minitel-font labels."""
    def one(m):
        return re.sub(r">([^<]+)<", lambda t: ">" + fold_caps(t.group(1)) + "<", m.group(0))
    page = re.sub(r"<(h[1-3])\b[^>]*>.*?</\1>", one, page, flags=re.S)
    page = re.sub(r'<(ul) class="(?:menu|groups|links)">.*?</\1>', one, page, flags=re.S)
    page = re.sub(r'<div class="svc">.*?</div>', one, page, flags=re.S)
    return page


# ------------------------------------------------------------------ gallery

class Gallery:
    def __init__(self, path=GALLERY):
        self.path = path
        try:
            with open(os.path.join(path, "manifest.json"), encoding="utf-8") as f:
                self.m = json.load(f)
        except (OSError, ValueError):
            self.m = {"screens": [], "animations": []}
        self.screens = self.m.get("screens", [])
        self.anims = self.m.get("animations", [])
        self.by_id = {e["id"]: e for e in self.screens + self.anims}
        self.images = {}   # entry id -> dist-relative image path

    def find(self, key):
        if key in self.by_id:
            return self.by_id[key]
        for cols in (80, 40):
            e = self.by_id.get(f"{key}-{cols}")
            if e:
                return e
        return None

    def all_for(self, shot):
        return [e for e in self.screens if e.get("shot") == shot]


def convert_images(gal, out):
    """Renders -> dist/img/screens/, as WebP when Pillow is there."""
    try:
        from PIL import Image
    except ImportError:
        Image = None
    dst_dir = os.path.join(out, "img", "screens")
    os.makedirs(dst_dir, exist_ok=True)
    for e in gal.screens + gal.anims:
        src = os.path.join(gal.path, e.get("image", ""))
        if not e.get("image") or not os.path.exists(src):
            continue
        anim = src.lower().endswith(".gif")
        if Image is None:
            name = e["id"] + os.path.splitext(src)[1]
            shutil.copyfile(src, os.path.join(dst_dir, name))
        else:
            name = e["id"] + ".webp"
            dst = os.path.join(dst_dir, name)
            if not (os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)):
                im = Image.open(src)
                if anim:
                    frames, durs = [], []
                    try:
                        while True:
                            fr = im.convert("RGB")
                            fr.thumbnail((800, 600))
                            frames.append(fr)
                            durs.append(im.info.get("duration", 130))
                            im.seek(im.tell() + 1)
                    except EOFError:
                        pass
                    try:
                        frames[0].save(dst, save_all=True, append_images=frames[1:], duration=durs, loop=0,
                                       quality=70, method=4)
                    except (OSError, ValueError):   # no animated WebP in this Pillow: a smaller GIF
                        name = e["id"] + ".gif"
                        frames[0].save(os.path.join(dst_dir, name), save_all=True, append_images=frames[1:],
                                       duration=durs, loop=0, optimize=True)
                else:
                    im = im.convert("RGB")
                    im.thumbnail((1280, 960))
                    im.save(dst, quality=82, method=6)
        gal.images[e["id"]] = f"img/screens/{name}"


def mode_tag(e):
    return f'<span class="tag">{e["mode"]} col</span>'


def origin_tag(e):
    if e.get("synthetic"):
        return '<span class="tag synth">synthetic sample</span>'
    return '<span class="tag real">real capture</span>'


def frames_of(gal, e):
    out, last = [], None
    for rel in e["frames"]:
        try:
            with open(os.path.join(gal.path, rel), encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        if text == last:
            continue
        last = text
        out.append(mtscreen.parse_dump(text))
    return out


def shot_html(gal, e, heading="h3", anchor=True):
    """A screen figure: caption, the text/image toggle, the text render and the picture."""
    label = f'{e["title"]}, {e["mode"]} columns'
    if "frames" in e:
        scrs = frames_of(gal, e)
        body = "".join(mtscreen.screen_html(s, label if i == len(scrs) - 1 else "") for i, s in enumerate(scrs))
        text = (f'<div class="anim" data-ms="{int(e.get("frame_ms", 130))}" data-hold="3000">{body}</div>')
        bar = '<div class="animbar"><button type="button" data-play>Pause</button>' \
              f'<span>{len(scrs)} frames, {int(e.get("frame_ms", 130))} ms each</span></div>'
    else:
        try:
            scr = mtscreen.load_dump(os.path.join(gal.path, e["dump"]))
        except (OSError, ValueError) as ex:
            print(f"warning: {e['id']}: {ex}", file=sys.stderr)
            return ""
        text = mtscreen.screen_html(scr, label)
        bar = ""
    img = gal.images.get(e["id"])
    alt = f'Photo-realistic render of the Minitel screen: {e["title"]} ({e["mode"]} columns)'
    if img:
        image = f'<div class="tube iv"><img src="{esc(img)}" alt="{esc(alt)}" loading="lazy" width="1280" height="960"></div>'
        views = ('<div class="views" role="group" aria-label="Render" hidden>'
                 '<button type="button" data-v="text" aria-pressed="true">Texte</button>'
                 '<button type="button" data-v="image" aria-pressed="false">Image</button></div>')
        noscript = f'<noscript><p><a href="{esc(img)}">Image render</a></p></noscript>'
    else:
        image, views, noscript = "", "", ""
    why = f'<p class="why">{esc(e["note"])}</p>' if e.get("synthetic") and e.get("note") else ""
    ida = f' id="{esc(e["id"])}"' if anchor else ""
    link = f'<a href="#{esc(e["id"])}">{esc(e["title"])}</a>' if anchor else esc(e["title"])
    return (f'<figure class="shot"{ida} data-view="text"><figcaption>'
            f'<{heading}>{link}{mode_tag(e)}{origin_tag(e)}</{heading}>'
            f'<p>{esc(e.get("description", ""))}</p>{why}</figcaption>{views}'
            f'<div class="tube tv">{text}</div>{bar}{image}{noscript}</figure>')


def gallery_page(gal):
    groups = {}
    for e in gal.anims + gal.screens:
        groups.setdefault(e.get("group") or "Autres", []).append(e)
    names = [g for g in GROUP_ORDER if g in groups] + [g for g in groups if g not in GROUP_ORDER]
    real = sum(1 for e in gal.screens if not e.get("synthetic"))
    parts = ['<h1>Les écrans</h1>',
             '<p class="lede">Every page of 3615 MESHCORE, as the firmware drew it. Each screen comes from a '
             '<code>screen</code> dump taken over USB, shown two ways: <b>Texte</b> is the dump drawn live '
             'by your browser in the Minitel font (select and copy it), <b>Image</b> is the photo-realistic '
             'render of the same dump by <code>minitel_render.py</code>.</p>',
             f'<p>{gallery_status(gal)}</p>',
             '<div class="allviews" hidden><span>Show every screen as</span>'
             '<div class="views" role="group" aria-label="Render for every screen">'
             '<button type="button" data-all="text" aria-pressed="true">Texte</button>'
             '<button type="button" data-all="image" aria-pressed="false">Image</button></div>'
             '<span class="muted">(remembered on this browser)</span></div>',
             '<ul class="groups">' + "".join(f'<li><a href="#{slug(g)}">{esc(g)}</a></li>' for g in names) + '</ul>']
    if real < len(gal.screens):
        parts.append('<div class="warn"><p><b>Preview.</b> Screens marked <span class="tag synth">synthetic sample</span> '
                     'are placeholders made on the host (the firmware\'s own screen model run natively, or a Python port '
                     'of a page), some from before the Sommaire was renumbered. They are replaced by real captures when '
                     '<code>tools/tour/tour.py run</code> walks the device.</p></div>')
    for g in names:
        parts.append(f'<h2 id="{slug(g)}">{esc(g)}</h2>')
        if GROUP_INTRO.get(g):
            parts.append(f'<p>{esc(GROUP_INTRO[g])}</p>')
        for e in groups[g]:
            parts.append(shot_html(gal, e))
    return "\n".join(parts)


def gallery_status(gal):
    n = len(gal.screens)
    real = sum(1 for e in gal.screens if not e.get("synthetic"))
    if n == 0:
        return "No screens yet: run <code>tools/tour/tour.py</code>."
    if real == n:
        return f"{n} screens, all captured from the device by the tour script."
    return (f"{n} screens so far: {real} captured from the device, {n - real} synthetic samples "
            f"standing in until the tour script runs.")


# ------------------------------------------------------------------ pages

PAGE_HEAD = re.compile(r"^<!--(.*?)-->\s*", re.S)


def read_page(fn):
    with open(os.path.join(CONTENT, fn), encoding="utf-8") as f:
        text = f.read()
    meta = {}
    m = PAGE_HEAD.match(text)
    if m:
        for part in m.group(1).split("|"):
            if ":" in part:
                k, v = part.split(":", 1)
                meta[k.strip()] = v.strip()
        text = text[m.end():]
    return meta, text


def expand(text, gal):
    def shot(m):
        e = gal.find(m.group(1).strip())
        if not e:
            return ('<p class="note">Screen <code>' + esc(m.group(1)) + '</code>: captured by the tour script, '
                    'not available yet.</p>')
        return shot_html(gal, e, anchor=False)

    def see(m):
        links = []
        for key in m.group(1).split(","):
            key = key.strip()
            es = [gal.by_id[key]] if key in gal.by_id else sorted(gal.all_for(key), key=lambda x: -x["mode"])
            for e in es:
                links.append(f'<a href="screens.html#{esc(e["id"])}">{esc(e["title"])} ({e["mode"]} col)</a>')
        if not links:
            return '<span class="muted">Screens: after the tour.</span>'
        return '<span class="muted">Screens:</span> ' + ", ".join(links)

    def svg(m):
        with open(os.path.join(CONTENT, m.group(1).strip() + ".svg"), encoding="utf-8") as f:
            s = f.read()
        return re.sub(r"<\?xml.*?\?>\s*", "", s)

    text = re.sub(r"\{\{shot:([^}]+)\}\}", shot, text)
    text = re.sub(r"\{\{see:([^}]+)\}\}", see, text)
    text = re.sub(r"\{\{svg:([^}]+)\}\}", svg, text)
    text = text.replace("{{gallery_status}}", gallery_status(gal))
    text = text.replace("{{repo}}", REPO_URL)
    return text


def nav_html(pages, current):
    items = []
    for p in pages:
        if p.get("nav") is None:
            continue
        cur = ' aria-current="page"' if p["file"] == current else ""
        n = p["nav"]
        num = f'<span class="n">{esc(n)}</span>' if n != "0" else '<span class="n">SOMMAIRE</span>'
        lab = esc(p["label"]) if n != "0" else ""
        items.append(f'<li><a href="{esc(p["file"])}"{cur}>{num}{lab}</a></li>')
    return '<ul class="menu">' + "".join(items) + "</ul>"


def build(out=DIST):
    gal = Gallery()
    if os.path.isdir(out):
        for name in os.listdir(out):   # keep img/ (converted pictures are cached by mtime)
            p = os.path.join(out, name)
            if name == "img":
                continue
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(out, exist_ok=True)
    shutil.copytree(os.path.join(HERE, "assets"), os.path.join(out, "assets"))
    os.makedirs(os.path.join(out, "img"), exist_ok=True)
    for name in ("hero.jpg",):
        src = os.path.join(ROOT, "docs", "img", name)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(out, "img", name))
    convert_images(gal, out)

    with open(os.path.join(HERE, "templates", "base.html"), encoding="utf-8") as f:
        base = f.read()

    pages = []
    for fn in sorted(os.listdir(CONTENT)):
        if fn.endswith(".html"):
            meta, body = read_page(fn)
            pages.append({"file": fn, "title": meta.get("title", fn), "label": meta.get("label", meta.get("title", fn)),
                          "nav": meta.get("nav"), "desc": meta.get("desc", ""), "body": body})
    pages.append({"file": "screens.html", "title": "Les écrans", "label": "Écrans", "nav": "1",
                  "desc": "Every page of 3615 MESHCORE, as text and as a photo-realistic render.", "body": None})
    pages.sort(key=lambda p: (p["nav"] is None, int(p["nav"]) if p["nav"] and p["nav"].isdigit() else 99))

    sizes = []
    for p in pages:
        body = gallery_page(gal) if p["body"] is None else expand(p["body"], gal)
        title = SITE_TITLE if p["file"] == "index.html" else f'{p["title"]} · {SITE_TITLE}'
        page = (base.replace("{{title}}", esc(title))
                .replace("{{here}}", esc(p["title"] if p["file"] != "index.html" else "Messagerie LoRa sur Minitel"))
                .replace("{{desc}}", esc(p["desc"] or "A MeshCore companion whose screen and keyboard are a French Minitel 2."))
                .replace("{{nav}}", nav_html(pages, p["file"]))
                .replace("{{repo}}", REPO_URL)
                .replace("{{content}}", body))
        page = fold_headings(page)
        with open(os.path.join(out, p["file"]), "w", encoding="utf-8") as f:
            f.write(page)
        sizes.append((p["file"], len(page.encode())))
    for fn, n in sizes:
        print(f"  {fn:22} {n / 1024:7.1f} KB")
    print(f"site: {os.path.relpath(out, ROOT)}/ ({len(gal.screens)} screens, {len(gal.anims)} animations)")
    return out


def check(out=DIST):
    """Every local href/src resolves, every #anchor exists; no forbidden class names."""
    ids, bad = {}, []
    files = [f for f in os.listdir(out) if f.endswith(".html")]
    for fn in files:
        with open(os.path.join(out, fn), encoding="utf-8") as f:
            ids[fn] = set(re.findall(r'\bid="([^"]+)"', f.read()))
    for fn in files:
        with open(os.path.join(out, fn), encoding="utf-8") as f:
            text = f.read()
        for cls in re.findall(r'\bclass="([^"]+)"', text):
            for c in cls.split():
                if c.startswith(("pub", "ad", "banner", "sponsor")):
                    bad.append(f"{fn}: class {c} may be hidden by content blockers")
        for url in re.findall(r'\b(?:href|src)="([^"]+)"', text):
            if re.match(r"^(https?:|mailto:|data:)", url):
                continue
            path, _, frag = url.partition("#")
            target = fn if not path else path
            if path and not os.path.exists(os.path.join(out, path)):
                bad.append(f"{fn}: missing {url}")
            elif frag and target in ids and frag not in ids[target]:
                bad.append(f"{fn}: missing anchor {url}")
    with open(os.path.join(out, "assets", "css", "site.css"), encoding="utf-8") as f:
        css = f.read()
    for c in re.findall(r"\.([a-zA-Z][\w-]*)", css):
        if c.startswith(("pub", "ad", "banner", "sponsor")):
            bad.append(f"site.css: class .{c}")
    for b in bad:
        print("CHECK:", b)
    print(f"check: {len(files)} pages, {len(bad)} problems")
    return not bad


def main():
    ap = argparse.ArgumentParser(description="Build the 3615 MESHCORE site into site/dist/.")
    ap.add_argument("--out", default=DIST)
    ap.add_argument("--check", action="store_true", help="check links and anchors after the build")
    a = ap.parse_args()
    out = build(a.out)
    if a.check and not check(out):
        sys.exit(1)


if __name__ == "__main__":
    main()
