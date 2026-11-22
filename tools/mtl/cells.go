package main

// Emulator glyphs to Minitel cells, per mode. Characters the Minitel has are kept (French
// accents included); others fold to what reads closest (box drawing to - | +, quotes,
// dashes); blocks become G1 mosaics in 40 col, inverse blanks in 80 col.

import (
	"github.com/hinshun/vt10x"
)

const (
	vtReverse = 1 << iota
	vtUnderline
	vtBold
	vtGfx
	vtItalic
	vtBlink
)

// Latin-1 0xC0-0xFF: base letter (as the firmware's kLatinBase)
const latinBase = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo/ouuuuypy"

func latinDiacritic(c rune) byte {
	switch c {
	case 0xE0, 0xE8, 0xEC, 0xF2, 0xF9:
		return 0x41 // grave
	case 0xE1, 0xE9, 0xED, 0xF3, 0xFA:
		return 0x42 // acute
	case 0xE2, 0xEA, 0xEE, 0xF4, 0xFB:
		return 0x43 // circumflex
	case 0xE4, 0xEB, 0xEF, 0xF6, 0xFC:
		return 0x48 // diaeresis
	case 0xE7:
		return 0x4B // cedilla
	}
	return 0
}

// fold: a character the Minitel lacks -> printable ASCII (one cell)
func fold(c rune) byte {
	switch {
	case c >= 0x20 && c < 0x7F:
		return byte(c)
	case c >= 0xC0 && c <= 0xFF:
		return latinBase[c-0xC0]
	}
	switch c {
	case '‘', '’', '‚', '′', 'ʼ':
		return '\''
	case '“', '”', '„', '″', '«', '»':
		return '"'
	case '‐', '‑', '‒', '–', '—', '―', '−', '─', '━', '┄', '┅', '┈', '┉', '╌', '╍', '═', '⎺', '⎻', '⎼', '⎽':
		return '-'
	case '│', '┃', '┆', '┇', '┊', '┋', '╎', '╏', '║':
		return '|'
	case '…':
		return '.'
	case '•', '●', '◦', '∙', '·', '⋅', '*':
		return '*'
	case '→', '▶', '►', '⇒', '›':
		return '>'
	case '←', '◀', '◄', '⇐', '‹':
		return '<'
	case '↑', '▲':
		return '^'
	case '↓', '▼':
		return 'v'
	case '≤':
		return '<'
	case '≥':
		return '>'
	case '≠':
		return '#'
	case '×':
		return 'x'
	case '÷':
		return '/'
	case '€':
		return 'E'
	case ' ':
		return ' '
	case '✓', '✔':
		return 'v'
	case '✗', '✘':
		return 'x'
	}
	if c >= 0x2500 && c <= 0x257F { // the other box drawing pieces: corners, tees, crosses
		return '+'
	}
	if c >= 0x2580 && c <= 0x259F {
		return '#'
	}
	if c == 0 {
		return ' '
	}
	return '?'
}

// 40 col G1 mosaic for block elements (sextants: TL 1, TR 2, ML 4, MR 8, BL 16, BR 64)
func mosaicFor(c rune) (byte, bool) {
	switch c {
	case '█':
		return 0x7F, true
	case '▀':
		return 0x20 | 1 | 2 | 4 | 8, true
	case '▄':
		return 0x20 | 16 | 64, true
	case '▌':
		return 0x20 | 1 | 4 | 16, true
	case '▐':
		return 0x20 | 2 | 8 | 64, true
	case '░':
		return 0x20 | 1 | 8 | 16, true
	case '▒':
		return 0x20 | 2 | 4 | 64, true
	case '▓':
		return 0x20 | 1 | 2 | 8 | 16 | 64, true
	case '▘':
		return 0x20 | 1, true
	case '▝':
		return 0x20 | 2, true
	case '▖':
		return 0x20 | 16, true
	case '▗':
		return 0x20 | 64, true
	}
	return 0, false
}

// charCell: a code point as the Minitel draws it in that mode (content only)
func charCell(c rune, wide bool) Cell {
	cell := Cell{n: 1, fg: fgDefault}
	if c == 0 {
		c = ' '
	}
	if !wide {
		if m, ok := mosaicFor(c); ok {
			cell.b[0] = m
			cell.attr |= aMosaic
			return cell
		}
		if c == '`' {
			c = '\''
		}
		switch c { // Vidéotex G0 0x60 is a long horizontal bar: the box drawing line
		case '─', '━', '═', '⎯', '―', '—':
			cell.b[0] = 0x60
			return cell
		}
		if c >= 0x20 && c < 0x7F {
			cell.b[0] = byte(c)
			return cell
		}
		if d := latinDiacritic(c); d != 0 {
			cell.b = [3]byte{0x19, d, latinBase[c-0xC0]}
			cell.n = 3
			return cell
		}
		var g2 byte
		switch c {
		case '£':
			g2 = 0x23
		case '§':
			g2 = 0x27
		case '°':
			g2 = 0x30
		case '±':
			g2 = 0x31
		case '¼':
			g2 = 0x3C
		case '½':
			g2 = 0x3D
		case '¾':
			g2 = 0x3E
		case 'ß':
			g2 = 0x7B
		case '÷':
			g2 = 0x38
		}
		if g2 != 0 {
			cell.b = [3]byte{0x19, g2}
			cell.n = 2
			return cell
		}
		cell.b[0] = fold(c)
		return cell
	}
	if c == '█' {
		cell.b[0] = ' '
		cell.attr |= aInv
		return cell
	}
	var fr byte
	switch c {
	case '£':
		fr = 0x23
	case 'à':
		fr = 0x40
	case '°':
		fr = 0x5B
	case 'ç':
		fr = 0x5C
	case '§':
		fr = 0x5D
	case 'é':
		fr = 0x7B
	case 'ù':
		fr = 0x7C
	case 'è':
		fr = 0x7D
	}
	if fr != 0 {
		cell.b = [3]byte{0x0E, fr, 0x0F}
		cell.n = 3
		return cell
	}
	cell.b[0] = fold(c)
	return cell
}

// glyphCell: an emulator cell with its attributes
func glyphCell(g vt10x.Glyph, wide, mono bool) Cell {
	cell := charCell(g.Char, wide)
	mode := int(g.Mode)
	fg, bg := g.FG, g.BG
	inv := mode&vtReverse != 0
	if inv { // vt10x already swapped the colours of a reverse cell
		fg, bg = bg, fg
	} else if bg != vt10x.DefaultBG && bg != vt10x.Black && bg != 16 {
		inv = true // a coloured background (selection bars, menus): inverse
	}
	if inv {
		cell.attr ^= aInv
	}
	if mode&vtBlink != 0 {
		cell.attr |= aBlink
	}
	if wide {
		if mode&vtBold != 0 {
			cell.attr |= aBold
		}
		if mode&vtUnderline != 0 {
			cell.attr |= aUL
		}
		if fg != vt10x.DefaultFG && fg%8 != 7 && fg%8 != 0 && fg < 16 && mode&vtBold == 0 {
			cell.attr |= aBold // a coloured word stands out: bold
		}
		return cell
	}
	// 40 col: the colour as a Minitel grey level (same 0-7 order as ANSI)
	if !mono && fg < 16 && fg != vt10x.DefaultFG {
		c := uint8(fg % 8)
		if c == 0 && !inv {
			c = 7 // black on black reads as nothing
		}
		cell.fg = c
	}
	if cell.b[0] == ' ' && cell.n == 1 && cell.attr&aInv == 0 && cell.attr&aMosaic == 0 {
		cell.fg = fgDefault // a blank's colour shows nothing: keep it plain
		cell.attr &^= aBlink
	}
	return cell
}

// Snapshot: the emulator's screen as Minitel cells (call with vt locked)
func Snapshot(vt vt10x.Terminal, wide, mono bool) (*Screen, int, int, bool) {
	cols, rows := vt.Size()
	if rows > 24 {
		rows = 24
	}
	s := NewScreen(cols, 24)
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			s.c[y][x] = glyphCell(vt.Cell(x, y), wide, mono)
		}
	}
	cur := vt.Cursor()
	return s, cur.Y + 1, cur.X + 1, vt.CursorVisible()
}
