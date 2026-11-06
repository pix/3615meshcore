#!/usr/bin/env python3
"""Generate minitel_if.kicad_pcb as a stripboard layout.

Strips run along X (one per row).  B.Cu tracks join consecutive pads of a row
unless a cut lies between them, so DRC checks that every strip segment carries
a single net.  The full stripboard (holes, strips) is drawn on Dwgs.User and
the cuts as crosses on B.Silkscreen.
"""
import os
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_sch  # noqa: E402

FP_ROOT = "/usr/share/kicad/footprints"
FP_LOCAL = {"stripboard": os.path.join(os.path.dirname(os.path.abspath(__file__)), "stripboard.pretty")}
HERE = os.path.dirname(os.path.abspath(__file__))
PITCH = 2.54
ORIGIN = (100.0, 100.0)
COLS = range(-1, 15)  # holes on the board
ROWS = range(-1, 6)
STRIP_W = 1.5

# ref -> (hole of pad 1, orientation in degrees)
PLACE = {
    "J1": ((0, 0), 0), "J3": ((0, 1), 0), "J4": ((0, 3), 0), "J2": ((0, 4), 0),
    "R3": ((7, 0), -90),
    "R4": ((5, 1), 180),
    "R1": ((2, 3), 0),
    "R2": ((7, 3), -90),
    "Q1": ((10, 4), 90),
    "J7": ((13, 1), 0), "J5": ((13, 2), 0), "J6": ((13, 4), 0),
}
CUTS = [(3, 1), (3, 3)]
# silkscreen label beside each wire pad (column -1 or 14)
WIRE_LABELS = {"J1": "3V3", "J3": "IO47", "J4": "IO48", "J2": "GND",
               "J7": "TX3", "J5": "RX1", "J6": "GND2"}


def mm(v):
    return pcbnew.FromMM(v)


def hole(c, r):
    return pcbnew.VECTOR2I(mm(ORIGIN[0] + c * PITCH), mm(ORIGIN[1] + r * PITCH))


def to_hole(pos):
    c = (pcbnew.ToMM(pos.x) - ORIGIN[0]) / PITCH
    r = (pcbnew.ToMM(pos.y) - ORIGIN[1]) / PITCH
    rc, rr = round(c), round(r)
    assert abs(c - rc) < 1e-3 and abs(r - rr) < 1e-3, f"pad off grid at {c},{r}"
    return rc, rr


def seg(board, layer, a, b, width):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetLayer(layer)
    s.SetStart(a)
    s.SetEnd(b)
    s.SetWidth(mm(width))
    board.Add(s)


def main():
    board = pcbnew.BOARD()
    nets = {}
    for ref, part in gen_sch.PARTS.items():
        for net in part[3].values():
            if net not in nets:
                nets[net] = pcbnew.NETINFO_ITEM(board, "/" + net)
                board.Add(nets[net])

    pads = {}  # (c, r) -> net
    for ref, (lid, val, fpid, netmap, _, desc) in gen_sch.PARTS.items():
        lib, name = fpid.split(":")
        fp = pcbnew.FootprintLoad(FP_LOCAL.get(lib, f"{FP_ROOT}/{lib}.pretty"), name)
        fp.SetReference(ref)
        fp.SetValue(val)
        fp.SetFPID(pcbnew.LIB_ID(lib, name))
        fp.SetPath(pcbnew.KIID_PATH(f"/{gen_sch.SYM_UUID[ref]}"))
        (c, r), rot = PLACE[ref]
        fp.SetPosition(hole(c, r))
        fp.GetField(pcbnew.FIELD_T_DESCRIPTION).SetText(desc) if hasattr(pcbnew, "FIELD_T_DESCRIPTION") else None
        fp.SetOrientationDegrees(rot)
        board.Add(fp)
        for pad in fp.Pads():
            num = pad.GetNumber()
            pad.SetNet(nets[netmap[num]])
            h = to_hole(pad.GetPosition())
            assert h not in pads, f"{ref}.{num} lands on occupied hole {h}"
            assert h[0] in COLS and h[1] in ROWS, f"{ref}.{num} off board {h}"
            pads[h] = netmap[num]
        if "Horizontal" in name:
            ps = [pd.GetPosition() for pd in fp.Pads()]
            fp.Reference().SetPosition(pcbnew.VECTOR2I((ps[0].x + ps[1].x) // 2, ps[0].y - mm(2.4)))
            fp.Reference().SetTextAngleDegrees(0)
        if ref.startswith("J"):
            fp.Value().SetVisible(False)

    # strip segments between consecutive pads of each row
    for r in ROWS:
        row = sorted(c for (c, rr) in pads if rr == r)
        for a, b in zip(row, row[1:]):
            if any(rr == r and a < c < b for (c, rr) in CUTS):
                continue
            na, nb = pads[(a, r)], pads[(b, r)]
            assert na == nb, f"row {r}: strip joins {na} (col {a}) and {nb} (col {b}) - add a cut"
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(hole(a, r))
            t.SetEnd(hole(b, r))
            t.SetWidth(mm(STRIP_W))
            t.SetLayer(pcbnew.B_Cu)
            t.SetNet(nets[na])
            board.Add(t)

    # stripboard drawing: strips and holes on Dwgs.User, cuts on B.Silkscreen
    x0, x1 = COLS[0] - 0.5, COLS[-1] + 0.5
    for r in ROWS:
        seg(board, pcbnew.Dwgs_User, hole(x0 + 0.15, r), hole(x1 - 0.15, r), 2.0)
    for c in COLS:
        for r in ROWS:
            ci = pcbnew.PCB_SHAPE(board)
            ci.SetShape(pcbnew.SHAPE_T_CIRCLE)
            ci.SetLayer(pcbnew.Cmts_User)
            ci.SetCenter(hole(c, r))
            ci.SetEnd(hole(c, r) + pcbnew.VECTOR2I(mm(0.5), 0))
            ci.SetWidth(mm(0.1))
            board.Add(ci)
    d = 0.35
    for c, r in CUTS:
        assert (c, r) not in pads, f"cut on a used hole {c},{r}"
        seg(board, pcbnew.B_SilkS, hole(c - d, r - d), hole(c + d, r + d), 0.25)
        seg(board, pcbnew.B_SilkS, hole(c - d, r + d), hole(c + d, r - d), 0.25)

    # column / row index for the build sheet
    for c in COLS:
        t = pcbnew.PCB_TEXT(board)
        t.SetText(chr(ord("A") + c - COLS[0]))
        t.SetPosition(hole(c, ROWS[0] - 0.9))
        t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(mm(1), mm(1)))
        t.SetTextThickness(mm(0.15))
        board.Add(t)
    for r in ROWS:
        t = pcbnew.PCB_TEXT(board)
        t.SetText(str(r - ROWS[0] + 1))
        t.SetPosition(hole(COLS[0] - 0.9, r))
        t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(mm(1), mm(1)))
        t.SetTextThickness(mm(0.15))
        board.Add(t)

    for ref, txt in WIRE_LABELS.items():
        (c, r), _ = PLACE[ref]
        t = pcbnew.PCB_TEXT(board)
        t.SetText(txt)
        t.SetPosition(hole(c - 1 if c == 0 else c + 1, r))
        t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(mm(0.6), mm(0.8)))
        t.SetTextThickness(mm(0.12))
        board.Add(t)

    # outline
    tl = hole(COLS[0] - 1.6, ROWS[0] - 1.6)
    br = hole(COLS[-1] + 0.6, ROWS[-1] + 0.6)
    rect = pcbnew.PCB_SHAPE(board)
    rect.SetShape(pcbnew.SHAPE_T_RECT)
    rect.SetLayer(pcbnew.Edge_Cuts)
    rect.SetStart(tl)
    rect.SetEnd(br)
    rect.SetWidth(mm(0.1))
    board.Add(rect)

    out = os.path.join(HERE, "minitel_if.kicad_pcb")
    pcbnew.SaveBoard(out, board)
    print(f"saved {out}: {len(pads)} pads, {len(CUTS)} cuts")


if __name__ == "__main__":
    main()
