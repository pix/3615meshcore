package main

// Images to Minitel slides.
//
// 40 col: Vidéotex G1 mosaics. The screen is 80 x 72 blocks (each cell 2 x 3), in the
// Minitel's 8 grey levels: its colours, shown on a black and white tube in the order of
// their brightness: black, blue, red, magenta, green, cyan, yellow, white. Each cell has
// one ink and one background colour (ESC 4x / ESC 5x before its mosaic character): the
// pair that draws its six blocks best, preferring the previous cell's pair when it is as
// good (fewer bytes). The picture is fitted in the screen's 4:3 (a block is 4 x 3.33 dots).
// Pixel art reads best without dithering; photos with -dither.
//
// 80 col: no mosaics nor colours in Mixte: characters by brightness, inverse blanks for
// the brightest, 80 x 24 cells (a cell is 6 x 10 dots: the picture fitted in 2:1).

import (
	"bytes"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
)

type ImageOpts struct {
	Dither   bool
	Contrast bool    // stretch the picture's darkest..brightest to black..white
	Gamma    float64 // > 1 brightens the mid tones
}

func isImage(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".gif", ".jpg", ".jpeg":
		return true
	}
	return false
}

func loadImage(name string) (image.Image, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

// greyGrid: the picture as w x h values 0..1, fitted (letterboxed, black) in a box of
// aspect boxW:boxH where each value covers cellW x cellH of that box.
func greyGrid(img image.Image, w, h int, boxW, boxH float64, o ImageOpts) [][]float64 {
	b := img.Bounds()
	iw, ih := float64(b.Dx()), float64(b.Dy())
	scale := math.Min(boxW/iw, boxH/ih) // box units per image pixel
	offX, offY := (boxW-iw*scale)/2, (boxH-ih*scale)/2
	cw, ch := boxW/float64(w), boxH/float64(h)
	g := make([][]float64, h)
	lo, hi := 1.0, 0.0
	for y := 0; y < h; y++ {
		g[y] = make([]float64, w)
		for x := 0; x < w; x++ {
			// the image pixels under this cell: area average (a few samples per pixel)
			x0, x1 := (float64(x)*cw-offX)/scale, (float64(x+1)*cw-offX)/scale
			y0, y1 := (float64(y)*ch-offY)/scale, (float64(y+1)*ch-offY)/scale
			sum, n := 0.0, 0.0
			const S = 4
			for sy := 0; sy < S; sy++ {
				for sx := 0; sx < S; sx++ {
					px := x0 + (x1-x0)*(float64(sx)+0.5)/S
					py := y0 + (y1-y0)*(float64(sy)+0.5)/S
					n++
					if px < 0 || py < 0 || px >= iw || py >= ih {
						continue // letterbox: black
					}
					c := color.NRGBAModel.Convert(img.At(b.Min.X+int(px), b.Min.Y+int(py))).(color.NRGBA)
					a := float64(c.A) / 255
					sum += a * (0.299*float64(c.R) + 0.587*float64(c.G) + 0.114*float64(c.B)) / 255
				}
			}
			v := sum / n
			g[y][x] = v
			lo, hi = math.Min(lo, v), math.Max(hi, v)
		}
	}
	for y := range g {
		for x := range g[y] {
			v := g[y][x]
			if o.Contrast && hi > lo {
				v = (v - lo) / (hi - lo)
			}
			if o.Gamma > 0 && o.Gamma != 1 {
				v = math.Pow(v, 1/o.Gamma)
			}
			g[y][x] = v
		}
	}
	return g
}

// the Minitel colour codes by brightness, and their grey level
var greyCodes = [8]byte{0, 4, 1, 5, 2, 6, 3, 7}

func level(i int) float64 { return float64(i) / 7 }

// ImageVideotex: a 40 col slide (bytes for the Minitel, clear included)
func ImageVideotex(img image.Image, o ImageOpts) []byte {
	const W, H = 80, 72
	g := greyGrid(img, W, H, 320, 240, o)
	var out bytes.Buffer
	out.Write([]byte{0x0C, 0x14})
	// sub-pixel bits: TL, TR, ML, MR, BL, BR
	bitOf := [6]byte{1, 2, 4, 8, 16, 64}
	for row := 0; row < 24; row++ {
		type cell struct {
			ch     byte
			fg, bg int
		}
		cells := make([]cell, 40)
		pf, pb := 7, 0 // what the terminal has after a move: white ink, black background
		for col := 0; col < 40; col++ {
			var v [6]float64
			for k := 0; k < 6; k++ {
				v[k] = g[row*3+k/2][col*2+k%2]
			}
			best, bf, bb := math.Inf(1), 7, 0
			for f := 0; f < 8; f++ {
				for bg := 0; bg <= f; bg++ {
					e := 0.0
					for k := 0; k < 6; k++ {
						df, db := v[k]-level(f), v[k]-level(bg)
						e += math.Min(df*df, db*db)
					}
					if f != pf { // an attribute costs 2 bytes: a slight bias to keep them
						e += 0.004
					}
					if bg != pb {
						e += 0.004
					}
					if e < best {
						best, bf, bb = e, f, bg
					}
				}
			}
			var bits byte
			for k := 0; k < 6; k++ {
				df, db := v[k]-level(bf), v[k]-level(bb)
				on := df*df < db*db
				if on {
					bits |= bitOf[k]
				}
				if o.Dither { // the error of this block to its right and lower neighbours
					q := level(bb)
					if on {
						q = level(bf)
					}
					e := v[k] - q
					x, y := col*2+k%2, row*3+k/2
					spread := func(dx, dy int, w float64) {
						xx, yy := x+dx, y+dy
						// only blocks not decided yet: the next cell, or rows below
						if xx < 0 || xx >= W || yy >= H || (yy/3 == row && xx/2 == col) || (yy/3 == row && xx/2 < col) {
							return
						}
						g[yy][xx] = math.Max(0, math.Min(1, g[yy][xx]+e*w))
					}
					spread(1, 0, 7.0/16)
					spread(-1, 1, 3.0/16)
					spread(0, 1, 5.0/16)
					spread(1, 1, 1.0/16)
				}
			}
			if bits == 0 { // a plain background: keep the ink as it is
				bf = pf
			} else if bits == 0x5F { // a full block: keep the background as it is
				bb = pb
			}
			cells[col] = cell{0x20 | bits, bf, bb}
			pf, pb = bf, bb
		}
		last := 39
		if row == 23 {
			last = 38 // never the last cell of the screen
		}
		for last >= 0 && cells[last].ch == 0x20 && cells[last].bg == 0 {
			last-- // a black tail: the clear already did it
		}
		if last < 0 {
			continue
		}
		out.Write([]byte{0x1F, byte(0x41 + row), 0x41, 0x0E})
		fg, bg := 7, 0
		for c := 0; c <= last; c++ {
			cl := cells[c]
			if cl.fg != fg {
				out.Write([]byte{0x1B, 0x40 + greyCodes[cl.fg]})
				fg = cl.fg
			}
			if cl.bg != bg {
				out.Write([]byte{0x1B, 0x50 + greyCodes[cl.bg]})
				bg = cl.bg
			}
			out.WriteByte(cl.ch)
			run := 0 // REP: the same cell again
			for c+run < last && cells[c+run+1] == cl {
				run++
			}
			for run > 2 {
				n := run
				if n > 63 {
					n = 63
				}
				out.Write([]byte{0x12, byte(0x40 + n)})
				c += n
				run -= n
			}
		}
	}
	out.WriteByte(0x0F)
	return out.Bytes()
}

// ImageMixte: an 80 col slide, characters by brightness
func ImageMixte(img image.Image, o ImageOpts) []byte {
	const W, H = 80, 24
	g := greyGrid(img, W, H, 480, 240, o)
	ramp := " .:-=+*#%@"
	var out bytes.Buffer
	out.WriteString("\x0f\x1b[0m\x1b[2J\x1b[H")
	for y := 0; y < H; y++ {
		line := make([]byte, 0, W)
		inv := make([]bool, W)
		last := -1
		for x := 0; x < W; x++ {
			v := g[y][x]
			if o.Dither {
				q := math.Round(v*float64(len(ramp))) / float64(len(ramp))
				e := v - q
				if x+1 < W {
					g[y][x+1] = math.Max(0, math.Min(1, g[y][x+1]+e*7/16))
				}
				if y+1 < H {
					g[y+1][x] = math.Max(0, math.Min(1, g[y+1][x]+e*5/16))
				}
			}
			var c byte = ' '
			if v > 0.9 {
				inv[x] = true
			} else {
				i := int(v * float64(len(ramp)))
				if i >= len(ramp) {
					i = len(ramp) - 1
				}
				c = ramp[i]
			}
			line = append(line, c)
			if c != ' ' || inv[x] {
				last = x
			}
		}
		if y == H-1 && last == W-1 {
			last = W - 2
		}
		if last < 0 {
			continue
		}
		out.WriteString("\x1b[" + itoa(y+1) + ";1H")
		on := false
		for x := 0; x <= last; x++ {
			if inv[x] != on {
				if inv[x] {
					out.WriteString("\x1b[7m")
				} else {
					out.WriteString("\x1b[0m")
				}
				on = inv[x]
			}
			out.WriteByte(line[x])
		}
		if on {
			out.WriteString("\x1b[0m")
		}
	}
	return out.Bytes()
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}

// slideFile: a file's bytes for one mode: raw .vdt / .mixte, an image, or text
func slideFile(name string, cols int, o ImageOpts) ([]byte, error) {
	if isImage(name) {
		img, err := loadImage(name)
		if err != nil {
			return nil, err
		}
		if cols == 80 {
			return ImageMixte(img, o), nil
		}
		return ImageVideotex(img, o), nil
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	return layoutText(data, cols), nil
}
