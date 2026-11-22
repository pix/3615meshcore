package main

// Round trip: the bytes a frame sends, played into a model of the Minitel (the subset the
// renderer uses), must leave it showing exactly the wanted screen. Covers damage-only
// updates, erase to end of row, REP, attributes, accents and the Mixte DL/IL scrolls.

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/hinshun/vt10x"
)

// minitel: what the terminal shows, cell by cell (bytes of the cell's character, attrs)
type minitel struct {
	wide     bool
	s        *Screen
	row, col int
	cur      Cell
	mosaic   bool
	lastCell Cell
}

func newMinitel(cols int) *minitel {
	return &minitel{wide: cols == 80, s: NewScreen(cols, 24), row: 1, col: 1, cur: blank}
}

func (m *minitel) putCell(c Cell) {
	if m.row >= 1 && m.row <= 24 && m.col >= 1 && m.col <= m.s.cols {
		m.s.c[m.row-1][m.col-1] = c
	}
	m.lastCell = c
	m.col++
	if m.col > m.s.cols {
		m.col = 1
		m.row++
	}
}

func (m *minitel) play(b []byte) error {
	for i := 0; i < len(b); i++ {
		c := b[i]
		if m.wide {
			switch {
			case c == 0x1B && i+1 < len(b) && b[i+1] == '[':
				j := i + 2
				for j < len(b) && (b[j] < 0x40 || b[j] > 0x7E) {
					j++
				}
				if j >= len(b) {
					return fmt.Errorf("cut CSI")
				}
				p, f := string(b[i+2:j]), b[j]
				i = j
				n := 1
				fmt.Sscanf(p, "%d", &n)
				switch f {
				case 'H':
					if p == "" {
						m.row, m.col = 1, 1
					} else {
						fmt.Sscanf(p, "%d;%d", &m.row, &m.col)
					}
				case 'J':
					m.s = NewScreen(m.s.cols, 24)
				case 'K':
					for k := m.col; k <= m.s.cols; k++ {
						m.s.c[m.row-1][k-1] = blank
					}
				case 'M':
					m.s.deleteLines(m.row-1, n)
					m.col = 1
				case 'L':
					m.s.insertLines(m.row-1, n)
					m.col = 1
				case 'm':
					switch p {
					case "0", "":
						m.cur.attr = 0
					case "1":
						m.cur.attr |= aBold
					case "4":
						m.cur.attr |= aUL
					case "5":
						m.cur.attr |= aBlink
					case "7":
						m.cur.attr |= aInv
					default:
						return fmt.Errorf("SGR %q", p)
					}
				default:
					return fmt.Errorf("CSI %q%c", p, f)
				}
			case c == 0x0E: // one French letter, then SI
				if i+2 >= len(b) || b[i+2] != 0x0F {
					return fmt.Errorf("SO without SI")
				}
				cell := Cell{b: [3]byte{0x0E, b[i+1], 0x0F}, n: 3, attr: m.cur.attr, fg: fgDefault}
				m.putCell(cell)
				i += 2
			case c == 0x0F:
			case c >= 0x20 && c < 0x7F:
				m.putCell(Cell{b: [3]byte{c}, n: 1, attr: m.cur.attr, fg: fgDefault})
			default:
				return fmt.Errorf("byte %02X", c)
			}
			continue
		}
		switch {
		case c == 0x1B && i+2 < len(b) && b[i+1] == '[' && (b[i+2] == 'M' || b[i+2] == 'L'):
			if b[i+2] == 'M' {
				m.s.deleteLines(m.row-1, 1)
			} else {
				m.s.insertLines(m.row-1, 1)
			}
			m.col = 1
			i += 2
		case c == 0x0C:
			m.s = NewScreen(m.s.cols, 24)
			m.row, m.col = 1, 1
			m.cur = blank
			m.mosaic = false
		case c == 0x14, c == 0x11:
		case c == 0x1F:
			m.row, m.col = int(b[i+1])-0x40, int(b[i+2])-0x40
			i += 2
		case c == 0x18:
			for k := m.col; k <= m.s.cols; k++ {
				m.s.c[m.row-1][k-1] = blank
			}
		case c == 0x0E:
			m.mosaic = true
			m.cur.attr |= aMosaic
		case c == 0x0F:
			m.mosaic = false
			m.cur.attr &^= aMosaic
		case c == 0x12:
			n := int(b[i+1]) - 0x40
			i++
			for k := 0; k < n; k++ {
				m.putCell(m.lastCell)
			}
		case c == 0x1B:
			d := b[i+1]
			i++
			switch {
			case d >= 0x40 && d <= 0x47:
				m.cur.fg = d - 0x40
			case d == 0x5D:
				m.cur.attr |= aInv
			case d == 0x5C:
				m.cur.attr &^= aInv
			case d == 0x48:
				m.cur.attr |= aBlink
			case d == 0x49:
				m.cur.attr &^= aBlink
			default:
				return fmt.Errorf("ESC %02X", d)
			}
		case c == 0x19:
			if b[i+1] >= 0x41 && b[i+1] <= 0x4B {
				m.putCell(Cell{b: [3]byte{0x19, b[i+1], b[i+2]}, n: 3, attr: m.cur.attr, fg: m.cur.fg})
				i += 2
			} else {
				m.putCell(Cell{b: [3]byte{0x19, b[i+1]}, n: 2, attr: m.cur.attr, fg: m.cur.fg})
				i++
			}
		case c >= 0x20 && c < 0x80:
			m.putCell(Cell{b: [3]byte{c}, n: 1, attr: m.cur.attr, fg: m.cur.fg})
		default:
			return fmt.Errorf("byte %02X", c)
		}
	}
	return nil
}

func same(t *testing.T, step string, m *minitel, want *Screen) {
	t.Helper()
	for r := 0; r < 24; r++ {
		lim := want.cols
		if r == 23 {
			lim--
		}
		for c := 0; c < lim; c++ {
			if m.s.c[r][c] != want.c[r][c] {
				t.Fatalf("%s: row %d col %d: minitel %+v, want %+v", step, r+1, c+1, m.s.c[r][c], want.c[r][c])
			}
		}
	}
}

func roundTrip(t *testing.T, cols int, steps []string) (total int) {
	vt := vt10x.New(vt10x.WithSize(cols, 24))
	rend := NewRenderer(cols, false)
	m := newMinitel(cols)
	for i, s := range steps {
		vt.Write([]byte(s))
		vt.Lock()
		want, cr, cc, vis := Snapshot(vt, cols == 80, false)
		vt.Unlock()
		b := rend.Frame(want, cr, cc, vis)
		total += len(b)
		if err := m.play(b); err != nil {
			t.Fatalf("step %d: %v in % X", i, err, b)
		}
		same(t, fmt.Sprintf("%d col step %d", cols, i), m, want)
	}
	return total
}

func TestRoundTrip(t *testing.T) {
	var lines []string
	for i := 0; i < 60; i++ {
		lines = append(lines, fmt.Sprintf("ligne %d : élève à l'école, ça va ? \x1b[7m inverse \x1b[0m \x1b[1;31mrouge\x1b[0m █▀▄ ─│┌", i))
	}
	steps := []string{"\x1b[2J\x1b[H$ ls -l\r\n"}
	for i := 0; i < 40; i++ { // scrolling output
		steps = append(steps, lines[i]+"\r\n")
	}
	steps = append(steps,
		"\x1b[?1049h\x1b[2J\x1b[1;23r\x1b[24;1H\x1b[7m-- less -- (status line)\x1b[0m\x1b[1;1H", // a pager: scroll region
	)
	for i := 0; i < 20; i++ {
		steps = append(steps, "\x1b[23;1H\n"+lines[i+20]+"\x1b[1;1H") // scrolls the region only
	}
	steps = append(steps, "\x1b[1;1H\x1bM\x1bM\x1bM"+lines[0]) // reverse index: scroll down
	steps = append(steps, "\x1b[r\x1b[?1049l")                 // back
	for _, cols := range []int{40, 80} {
		n := roundTrip(t, cols, steps)
		t.Logf("%d col: %d frames, %d bytes", cols, len(steps), n)
	}
}

func TestRandomDamage(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	words := []string{"a", "é", "ç", "ùè", "  ", "\x1b[5mclignote\x1b[25m", "\x1b[4msouligné\x1b[24m", "\x1b[44mbleu\x1b[0m", "▌▐", "end"}
	var steps []string
	for i := 0; i < 300; i++ {
		var sb strings.Builder
		fmt.Fprintf(&sb, "\x1b[%d;%dH", rnd.Intn(24)+1, rnd.Intn(80)+1)
		for k := rnd.Intn(6); k >= 0; k-- {
			sb.WriteString(words[rnd.Intn(len(words))])
		}
		if rnd.Intn(10) == 0 {
			sb.WriteString("\x1b[K")
		}
		if rnd.Intn(15) == 0 {
			sb.WriteString("\x1b[24;1H\r\n") // a scroll
		}
		steps = append(steps, sb.String())
	}
	for _, cols := range []int{40, 80} {
		roundTrip(t, cols, steps)
	}
}

// a scrolled screen costs far less than a redraw in 80 col
func TestScrollCost(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 23; i++ {
		fmt.Fprintf(&sb, "line %02d the quick brown fox jumps over the lazy dog 0123456789\r\n", i)
	}
	vt := vt10x.New(vt10x.WithSize(80, 24))
	rend := NewRenderer(80, false)
	vt.Write([]byte(sb.String()))
	vt.Lock()
	s, cr, cc, vis := Snapshot(vt, true, false)
	vt.Unlock()
	full := len(rend.Frame(s, cr, cc, vis))
	vt.Write([]byte("one more line\r\n"))
	vt.Lock()
	s, cr, cc, vis = Snapshot(vt, true, false)
	vt.Unlock()
	scrolled := len(rend.Frame(s, cr, cc, vis))
	t.Logf("full screen %d bytes, one line scrolled %d bytes", full, scrolled)
	if scrolled > 80 {
		t.Fatalf("scroll not detected: %d bytes", scrolled)
	}
}

func TestNative(t *testing.T) {
	out, tail := nativeText([]byte("\x1b[1;1Hélève ça─€\xc3"), false)
	if want := "\x1b[1;1H\x19Bel\x19Aeve \x19Kca`E"; string(out) != want || len(tail) != 1 {
		t.Fatalf("40 col: % X tail % X", out, tail)
	}
	out, _ = nativeText([]byte("été|~"), true)
	if want := "\x0e{\x0ft\x0e{\x0f|~"; string(out) != want {
		t.Fatalf("80 col: % X", out)
	}
	if k := unescapeTerminfo(`\E[A^SH\EOl\037@A^?`); k != "\x1b[A\x13H\x1bOl\x1f@A\x7f" {
		t.Fatalf("unescape: % X", k)
	}
	keys := map[string]string{"kpp": "\x13B", "kcuu1": "\x1b[A"}
	if k := translateKeys([]byte("x\x1b[5~\x1b[A"), keys); string(k) != "x\x13B\x1b[A" {
		t.Fatalf("keys: % X", k)
	}
}

func TestScrollCost40(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 23; i++ {
		fmt.Fprintf(&sb, "ligne %02d du texte qui defile ici\r\n", i)
	}
	vt := vt10x.New(vt10x.WithSize(40, 24))
	rend := NewRenderer(40, false)
	vt.Write([]byte(sb.String()))
	vt.Lock()
	s, cr, cc, vis := Snapshot(vt, false, false)
	vt.Unlock()
	full := len(rend.Frame(s, cr, cc, vis))
	vt.Write([]byte("encore une\r\n"))
	vt.Lock()
	s, cr, cc, vis = Snapshot(vt, false, false)
	vt.Unlock()
	scrolled := len(rend.Frame(s, cr, cc, vis))
	t.Logf("40 col: full %d bytes, scrolled %d", full, scrolled)
	if scrolled > 60 {
		t.Fatalf("scroll not used: %d", scrolled)
	}
}
