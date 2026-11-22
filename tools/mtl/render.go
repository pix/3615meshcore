package main

// The Minitel side of the screen: what the terminal shows (sent), what it should show
// (want), and the bytes that take it from one to the other, for Vidéotex 40 col or
// Mixte 80 col. Only damaged cells go out: changed spans per row (short unchanged gaps
// are re-sent rather than paying a cursor move), erase-to-end-of-row for blank tails,
// Vidéotex REP for runs, and in Mixte a whole-screen or region scroll done by the
// terminal itself (DL/IL) when the new screen is the old one shifted.
//
// Encodings as the firmware's (MinitelScreen.cpp, MinitelCharset.cpp): Vidéotex US
// moves, SS2 accents, ESC ] / ESC \ inverse, ESC H / ESC I blink, ESC 4x character colour
// (grey levels), SO/SI G1 mosaic; Mixte ISO 6429 with one SGR per sequence, French
// letters through SO .. SI. Row 24 never gets its last cell (it would scroll Mixte).

import (
	"bytes"
	"fmt"
	"hash/fnv"
)

const (
	aInv = 1 << iota
	aBold
	aUL
	aBlink
	aMosaic
)

const fgDefault = 7 // Minitel white

type Cell struct {
	b    [3]byte // the character's bytes in this mode (0x0E..0x0F wrapped for Mixte French)
	n    uint8
	attr uint8
	fg   uint8 // Vidéotex character colour 0-7
}

var blank = Cell{b: [3]byte{' '}, n: 1, fg: fgDefault}

func (c Cell) isBlank() bool { return c.n == 1 && c.b[0] == ' ' && c.attr == 0 && c.fg == fgDefault }

type Screen struct {
	cols, rows int
	c          [][]Cell // [row 0..rows-1][col 0..cols-1]
}

func NewScreen(cols, rows int) *Screen {
	s := &Screen{cols: cols, rows: rows, c: make([][]Cell, rows)}
	for r := range s.c {
		s.c[r] = make([]Cell, cols)
		for i := range s.c[r] {
			s.c[r][i] = blank
		}
	}
	return s
}

func (s *Screen) rowHash(r int) uint64 {
	h := fnv.New64a()
	for _, c := range s.c[r] {
		h.Write(c.b[:c.n])
		h.Write([]byte{c.n, c.attr, c.fg})
	}
	return h.Sum64()
}

func (s *Screen) blankRow(r int) {
	for i := range s.c[r] {
		s.c[r][i] = blank
	}
}

// deleteLines / insertLines as DL / IL do on the terminal (rows 0-based)
func (s *Screen) deleteLines(at, k int) {
	for r := at; r < s.rows; r++ {
		if r+k < s.rows {
			copy(s.c[r], s.c[r+k])
		} else {
			s.blankRow(r)
		}
	}
}

func (s *Screen) insertLines(at, k int) {
	for r := s.rows - 1; r >= at; r-- {
		if r-k >= at {
			copy(s.c[r], s.c[r-k])
		} else {
			s.blankRow(r)
		}
	}
}

type Renderer struct {
	wide     bool // Mixte 80 col
	mono     bool // no Vidéotex colours
	noScroll bool // never let the terminal shift rows (DL/IL)
	sent     *Screen
	valid    bool // sent is what the terminal shows (else: clear first)
	out      bytes.Buffer
	// what the terminal currently has
	row, col int // 1-based; 0 = unknown
	cur      Cell
	curVis   bool
}

func NewRenderer(cols int, mono bool) *Renderer {
	return &Renderer{wide: cols == 80, mono: mono, sent: NewScreen(cols, 24)}
}

// Reset: the terminal was cleared (mode switch) or is unknown; the next frame redraws all.
func (r *Renderer) Reset(cols int) {
	r.wide = cols == 80
	r.sent = NewScreen(cols, 24)
	r.valid = false
}

func (r *Renderer) b(v ...byte) { r.out.Write(v) }

func (r *Renderer) csi(s string) { r.out.WriteString("\x1b[" + s) }

func (r *Renderer) clear() {
	if r.wide {
		r.b(0x0F)
		r.csi("0m")
		r.csi("2J")
		r.csi("H")
	} else {
		r.b(0x0C, 0x14) // FF (clear, home, attributes reset), cursor off
	}
	r.row, r.col = 1, 1
	r.cur = blank
}

func (r *Renderer) move(row, col int) {
	if r.row == row && r.col == col {
		return
	}
	if r.wide {
		r.csi(fmt.Sprintf("%d;%dH", row, col))
	} else {
		r.b(0x1F, byte(0x40+row), byte(0x40+col))
	}
	r.row, r.col = row, col
}

func (r *Renderer) moveCost() int {
	if r.wide {
		return 7
	}
	return 3
}

// attribute change, as the firmware's attrChange (+ Vidéotex colour)
func (r *Renderer) attrs(to Cell) {
	from := r.cur
	if from.attr == to.attr && (r.wide || from.fg == to.fg) {
		return
	}
	if r.wide {
		f, t := from.attr, to.attr
		if f&^t != 0 {
			r.csi("0m")
			f = 0
		}
		if t&aBold != 0 && f&aBold == 0 {
			r.csi("1m")
		}
		if t&aUL != 0 && f&aUL == 0 {
			r.csi("4m")
		}
		if t&aBlink != 0 && f&aBlink == 0 {
			r.csi("5m")
		}
		if t&aInv != 0 && f&aInv == 0 {
			r.csi("7m")
		}
	} else {
		if (from.attr^to.attr)&aMosaic != 0 {
			if to.attr&aMosaic != 0 {
				r.b(0x0E)
			} else {
				r.b(0x0F)
			}
		}
		if from.fg != to.fg {
			r.b(0x1B, byte(0x40+to.fg))
		}
		if (from.attr^to.attr)&aInv != 0 {
			if to.attr&aInv != 0 {
				r.b(0x1B, 0x5D)
			} else {
				r.b(0x1B, 0x5C)
			}
		}
		if (from.attr^to.attr)&aBlink != 0 {
			if to.attr&aBlink != 0 {
				r.b(0x1B, 0x48)
			} else {
				r.b(0x1B, 0x49)
			}
		}
	}
	r.cur.attr, r.cur.fg = to.attr, to.fg
}

func (r *Renderer) put(c Cell) {
	r.attrs(c)
	r.out.Write(c.b[:c.n])
	r.col++
}

func sameLook(a, b Cell) bool { return a == b }

// Frame: the bytes that make the terminal show want, cursor at (crow, ccol) 1-based.
// sent is updated as if they all arrive.
func (r *Renderer) Frame(want *Screen, crow, ccol int, cursor bool) []byte {
	r.out.Reset()
	if !r.valid || want.cols != r.sent.cols {
		r.sent = NewScreen(want.cols, 24)
		r.clear()
		r.valid = true
	} else {
		r.cur = blank
	}
	start := r.out.Len()
	if !r.wide {
		r.b(0x14) // cursor off while drawing (taken back below if nothing changes)
	}
	if !r.noScroll {
		r.scroll(want)
	}
	for row := 0; row < want.rows; row++ {
		r.diffRow(want, row)
	}
	r.attrs(blank)
	if ccol > want.cols {
		ccol = want.cols
	}
	drew := r.out.Len() > start+1 || (r.wide && r.out.Len() > start)
	if !drew && crow == r.row && ccol == r.col && cursor == r.curVis {
		return nil // nothing changed, the cursor is where it should be
	}
	if crow >= 1 && crow <= 24 && ccol >= 1 {
		r.move(crow, ccol)
	}
	if !r.wide && cursor {
		r.b(0x11)
	}
	r.curVis = cursor
	return append([]byte(nil), r.out.Bytes()...)
}

func (r *Renderer) diffRow(want *Screen, row int) {
	lim := want.cols
	if row == want.rows-1 {
		lim-- // never the last cell of the screen
	}
	w, s := want.c[row], r.sent.c[row]
	last := -1 // last cell of want that is not a plain blank
	for c := 0; c < lim; c++ {
		if !w[c].isBlank() {
			last = c
		}
	}
	// a blank tail where the terminal still shows something: erase to end of row
	eraseFrom := -1
	for c := last + 1; c < lim; c++ {
		if !sameLook(w[c], s[c]) {
			eraseFrom = last + 1
			break
		}
	}
	c := 0
	for c <= last {
		if sameLook(w[c], s[c]) {
			c++
			continue
		}
		// a span from c: extend over short unchanged gaps
		end := c
		for k := c + 1; k <= last; k++ {
			if !sameLook(w[k], s[k]) {
				gap := 0
				for g := end + 1; g < k; g++ {
					gap += int(w[g].n)
				}
				if gap <= r.moveCost()+1 {
					end = k
				} else {
					break
				}
			}
		}
		r.span(row, c, end, w)
		for k := c; k <= end; k++ {
			s[k] = w[k]
		}
		c = end + 1
	}
	if eraseFrom >= 0 {
		r.move(row+1, eraseFrom+1)
		r.attrs(blank)
		if r.wide {
			r.csi("K")
		} else {
			r.b(0x18) // CAN: erase to end of row
		}
		for k := eraseFrom; k < want.cols; k++ {
			s[k] = blank
		}
	}
}

func (r *Renderer) span(row, c0, c1 int, w []Cell) {
	r.move(row+1, c0+1)
	for c := c0; c <= c1; c++ {
		r.put(w[c])
		if r.wide {
			continue
		}
		run := 0 // Vidéotex REP: the same cell right after
		for c+run < c1 && w[c+run+1] == w[c] {
			run++
		}
		for run > 0 {
			n := run
			if n > 63 {
				n = 63
			}
			if n*int(w[c].n) <= 2 {
				break
			}
			r.b(0x12, byte(0x40+n))
			c += n
			r.col += n
			run -= n
		}
	}
	if r.col > r.sent.cols {
		r.row, r.col = 0, 0 // wrapped: unknown
	}
	r.attrs(blank)
}

// When a run of rows of want is the terminal's rows shifted by k, let the terminal shift
// them (DL at the top of the region, IL to put back the rows below it). Mixte takes a count
// (CSI k M); Vidéotex (Minitel 1B and later, as terminfo minitel1b) one row per CSI M / CSI L.
func (r *Renderer) scroll(want *Screen) {
	n := want.rows
	wh := make([]uint64, n)
	sh := make([]uint64, n)
	for i := 0; i < n; i++ {
		wh[i] = want.rowHash(i)
		sh[i] = r.sent.rowHash(i)
	}
	blankH := NewScreen(want.cols, 1).rowHash(0)
	bestGain, bestK, bestA, bestB := 0, 0, 0, 0
	for k := -(n - 2); k <= n-2; k++ {
		if k == 0 {
			continue
		}
		for a := 0; a < n; {
			src := a + k
			if src < 0 || src >= n || wh[a] != sh[src] {
				a++
				continue
			}
			b := a
			for b+1 < n && b+1+k >= 0 && b+1+k < n && wh[b+1] == sh[b+1+k] {
				b++
			}
			gain := 0
			for i := a; i <= b; i++ {
				if wh[i] != sh[i] && wh[i] != blankH {
					gain++
				}
			}
			if gain > bestGain {
				bestGain, bestK, bestA, bestB = gain, k, a, b
			}
			a = b + 1
		}
	}
	if bestGain < 3 || (!r.wide && abs(bestK) > 8) {
		return
	}
	k, a, b := bestK, bestA, bestB
	r.attrs(blank)
	if k > 0 { // content moves up: rows a+k..b+k go to a..b
		r.move(a+1, 1)
		r.lines('M', k)
		r.sent.deleteLines(a, k)
		if b+k < n-1 {
			r.move(b+2, 1)
			r.lines('L', k)
			r.sent.insertLines(b+1, k)
		}
	} else { // content moves down by -k: rows a+k..b+k go to a..b
		d := -k
		r.move(a-d+1, 1)
		r.lines('L', d)
		r.sent.insertLines(a-d, d)
		if b < n-1 {
			r.move(b+2, 1)
			r.lines('M', d)
			r.sent.deleteLines(b+1, d)
		}
	}
	r.row, r.col = 0, 0 // DL/IL put the cursor in column 1
}

func (r *Renderer) lines(op byte, k int) {
	if r.wide {
		r.csi(fmt.Sprintf("%d%c", k, op))
		return
	}
	for i := 0; i < k; i++ {
		r.csi(string(op))
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
