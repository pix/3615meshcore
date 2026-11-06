#!/usr/bin/env python3
"""Generate minitel_if.kicad_sch: Minitel DIN-5 <-> Heltec V3 level interface.

Every pin gets a net label at its connection point, so the netlist is defined
by NETS below.  Re-run after editing; KiCad files are regenerated from scratch.
"""
import os
import re
import uuid

KICAD_SYM = "/usr/share/kicad/symbols"
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = "minitel_if"

# ref -> (lib_id, value, footprint, {pin: net}, (x, y) mm, description)
WIRE = "stripboard:WirePad"

PARTS = {
    "R1": ("Device:R", "1k", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal",
           {"1": "GPIO48", "2": "Q1_B"}, (60, 60), "Q1 base"),
    "R2": ("Device:R", "10k", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P2.54mm_Vertical",
           {"1": "Q1_B", "2": "GND"}, (75, 60), "Q1 base pull-down (line idle while the ESP boots)"),
    "Q1": ("Transistor_BJT:PN2222A", "2N2222", "Package_TO_SOT_THT:TO-92_Inline_Wide",
           {"1": "GND", "2": "Q1_B", "3": "MT_RX"}, (105, 60), "sinks Minitel RX (UART TX inverted)"),
    "R3": ("Device:R", "10k", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P2.54mm_Vertical",
           {"1": "+3V3", "2": "MT_TX"}, (60, 100), "pull-up for the Minitel open-collector TX"),
    "R4": ("Device:R", "10k", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal",
           {"1": "MT_TX", "2": "GPIO47"}, (75, 100), "series protection"),
    # wire pads: Heltec V3 side
    "J1": ("Connector_Generic:Conn_01x01", "V3 3V3 (J3.2)", WIRE, {"1": "+3V3"}, (160, 55), ""),
    "J2": ("Connector_Generic:Conn_01x01", "V3 GND (J3.1)", WIRE, {"1": "GND"}, (160, 65), ""),
    "J3": ("Connector_Generic:Conn_01x01", "V3 GPIO47 (J2.13)", WIRE, {"1": "GPIO47"}, (160, 75), ""),
    "J4": ("Connector_Generic:Conn_01x01", "V3 GPIO48 (J2.14)", WIRE, {"1": "GPIO48"}, (160, 85), ""),
    # wire pads: Minitel DIN-5 male plug
    "J5": ("Connector_Generic:Conn_01x01", "DIN1 RX", WIRE, {"1": "MT_RX"}, (160, 110), ""),
    "J6": ("Connector_Generic:Conn_01x01", "DIN2 GND", WIRE, {"1": "GND"}, (160, 120), ""),
    "J7": ("Connector_Generic:Conn_01x01", "DIN3 TX", WIRE, {"1": "MT_TX"}, (160, 130), ""),
}

NOTES = [
    ((40, 30), "Minitel 2 <-> Heltec WiFi LoRa 32 V3 interface (stripboard)"),
    ((40, 36), "Minitel DIN-5: open-collector TTL, receiver supplies the pull-up. 1200/4800/9600 bd 7E1."),
    ((40, 42), "GPIO48 = UART TX with output inversion (Q1 inverts). GPIO47 = UART RX, not inverted."),
    ((40, 125), "DIN4 (PT) and DIN5 are left unconnected: PT is ignored in 80-col modes,"),
    ((40, 131), "and pin 5 is a supply output (8.5-15 V) on the Minitel 2 - never wire it to the ESP."),
    ((40, 137), "Power: Heltec V3 from USB 5 V. Only GND is shared with the Minitel."),
    ((140, 45), "Wire pads to the Heltec V3"),
    ((140, 100), "Wire pads to the DIN-5 male plug"),
]


def tokenize(s):
    return re.findall(r'"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+', s)


def parse(tokens, i=0):
    out = []
    while i < len(tokens):
        t = tokens[i]
        if t == "(":
            sub, i = parse(tokens, i + 1)
            out.append(sub)
        elif t == ")":
            return out, i + 1
        else:
            out.append(t)
            i += 1
    return out, i


def dump(node, ind=0):
    if not isinstance(node, list):
        return node
    if not any(isinstance(c, list) for c in node):
        return "(" + " ".join(node) + ")"
    pad = "\t" * (ind + 1)
    head = [c for c in node if not isinstance(c, list)]
    body = "".join("\n" + pad + dump(c, ind + 1) for c in node if isinstance(c, list))
    return "(" + " ".join(head) + body + "\n" + "\t" * ind + ")"


_libs = {}


def lib_symbols(lib):
    if lib not in _libs:
        tree, _ = parse(tokenize(open(f"{KICAD_SYM}/{lib}.kicad_sym").read()))
        _libs[lib] = {c[1].strip('"'): c for c in tree[0] if isinstance(c, list) and c[0] == "symbol"}
    return _libs[lib]


def flat_symbol(lib_id):
    """Library symbol with `extends` resolved, renamed to lib_id."""
    lib, name = lib_id.split(":")
    syms = lib_symbols(lib)
    sym = syms[name]
    ext = next((c for c in sym if isinstance(c, list) and c[0] == "extends"), None)
    if ext:
        parent = flat_symbol(f"{lib}:{ext[1].strip(chr(34))}")
        pname = ext[1].strip('"')
        own = {c[1]: c for c in sym if isinstance(c, list) and c[0] == "property"}
        body = []
        for c in parent[2:]:
            if isinstance(c, list) and c[0] == "property":
                c = own.pop(c[1], c)
            elif isinstance(c, list) and c[0] == "symbol":
                c = [c[0], c[1].replace(pname, name, 1)] + c[2:]
            body.append(c)
        sym = ["symbol", f'"{name}"'] + body + list(own.values())
    return ["symbol", f'"{lib_id}"'] + [c for c in sym[2:]]


def pins(sym):
    res = {}
    for unit in sym:
        if isinstance(unit, list) and unit[0] == "symbol":
            for p in unit:
                if isinstance(p, list) and p[0] == "pin":
                    at = next(c for c in p if isinstance(c, list) and c[0] == "at")
                    num = next(c for c in p if isinstance(c, list) and c[0] == "number")[1].strip('"')
                    res[num] = (float(at[1]), float(at[2]), int(at[3]))
    return res


def u():
    return str(uuid.uuid4())


def fnum(v):
    return f"{v:.4f}".rstrip("0").rstrip(".")


def eff(size=1.27, justify=None, hide=False):
    s = f"(effects (font (size {size} {size}))"
    if justify:
        s += f" (justify {justify})"
    if hide:
        s += " (hide yes)"
    return s + ")"


def main():
    root = str(uuid.uuid5(uuid.NAMESPACE_URL, "minitel_if/root"))
    lib_ids = sorted({p[0] for p in PARTS.values()})
    flats = {lid: flat_symbol(lid) for lid in lib_ids}
    out = [f'(kicad_sch (version 20250114) (generator "eeschema") (generator_version "10.0")',
           f'(uuid "{root}") (paper "A4")',
           '(title_block (title "Minitel companion - DIN-5 interface") (rev "1"))',
           "(lib_symbols"]
    for lid in lib_ids:
        out.append(dump(flats[lid], 1))
    out.append(")")
    for ref, (lid, val, fp, netmap, (x, y), desc) in PARTS.items():
        pp = pins(flats[lid])
        x, y = round(x / 2.54) * 2.54, round(y / 2.54) * 2.54
        out.append(f'(symbol (lib_id "{lid}") (at {fnum(x)} {fnum(y)} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "{SYM_UUID[ref]}")')
        out.append(f'(property "Reference" "{ref}" (at {fnum(x + 3)} {fnum(y - 2)} 0) {eff(justify="left")})')
        out.append(f'(property "Value" "{val}" (at {fnum(x + 3)} {fnum(y + 2)} 0) {eff(justify="left")})')
        out.append(f'(property "Footprint" "{fp}" (at {fnum(x)} {fnum(y)} 0) {eff(hide=True)})')
        out.append(f'(property "Datasheet" "" (at {fnum(x)} {fnum(y)} 0) {eff(hide=True)})')
        out.append(f'(property "Description" "{desc}" (at {fnum(x)} {fnum(y)} 0) {eff(hide=True)})')
        for num in sorted(pp):
            out.append(f'(pin "{num}" (uuid "{u()}"))')
        out.append(f'(instances (project "{PROJECT}" (path "/{root}" (reference "{ref}") (unit 1)))))')
        for num, net in netmap.items():
            px, py, ang = pp[num]
            lx, ly = x + px, y - py
            lang = {0: 180, 180: 0, 90: 270, 270: 90}[ang]
            just = "right bottom" if lang in (180, 270) else "left bottom"
            out.append(f'(label "{net}" (at {fnum(lx)} {fnum(ly)} {lang}) {eff(justify=just)} (uuid "{u()}"))')
    for (x, y), txt in NOTES:
        out.append(f'(text "{txt}" (exclude_from_sim no) (at {x} {y} 0) {eff(1.5, "left bottom")} (uuid "{u()}"))')
    out.append(f'(sheet_instances (path "/" (page "1")))')
    out.append("(embedded_fonts no))")
    open(os.path.join(HERE, f"{PROJECT}.kicad_sch"), "w").write("\n".join(out) + "\n")
    with open(os.path.join(HERE, "symbol_uuids.txt"), "w") as f:
        f.write(f"root {root}\n")
        for ref in PARTS:
            f.write(f"{ref} {SYM_UUID[ref]}\n")


SYM_UUID = {ref: str(uuid.uuid5(uuid.NAMESPACE_URL, f"minitel_if/{ref}")) for ref in PARTS}

if __name__ == "__main__":
    main()
