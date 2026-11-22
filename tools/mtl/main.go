// mtl: the PC side of the 3615 MESHCORE Minitel companion.
//
//	mtl term [-cols 40|80] [-term xterm] [-mono] [-- program args...]
//	                               a shell (or any program: w3m, lynx, mutt...) on the Minitel
//	mtl slide list
//	mtl slide add <n> <file> [-cols 40|80|both] [-raw]
//	                               .vdt: Vidéotex bytes as they are (40 col); any other file is
//	                               text (UTF-8, ANSI colours and moves allowed), laid out by the
//	                               emulator and encoded for 40 col, 80 col or both
//	mtl slide get <n> [-cols 40|80|both] [-o file]   read back (.vdt / raw Mixte)
//	mtl slide preview <file>... [-cols ..] [-hold 10s]   on the Minitel now, not stored
//	mtl slide del <n|all> [40|80]
//	mtl slide show <n>
//	mtl slide encode <file> -cols 40|80 -o out   the bytes a slide would get (preview, .vdt)
//	mtl saver [<splash> <off>]     back to the welcome page / blank screen after (10m, 30s, 1h, 0 = never)
//	mtl keep [<n>]                 messages kept per conversation (10-160)
//	mtl cli <command...>           any of: slide, saver, hist keep, screen, ui state
//
// Transport: BLE (-addr AA:BB:CC:DD:EE:FF, or the first device named like -name), or the
// node's USB CLI with -usb /dev/ttyACM0 (everything but term).
package main

import (
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hinshun/vt10x"
)

type Cli interface {
	Cli(cmd string) (string, error)
	Close()
}

func usage() {
	fmt.Fprint(os.Stderr, `mtl: the PC side of the 3615 MESHCORE Minitel companion

  mtl [-addr MAC | -name NAME] [-usb /dev/ttyACM0] <command>

  term [-cols 40|80] [-term xterm] [-mono] [-noscroll] [-native] [-- program args]
                     a shell (default $SHELL -l) or a program on the Minitel, over BLE;
                     -native: no emulator, TERM=minitel1b / minitel1b-80 (the device's termcap)
                     Minitel keys: ENVOI=Enter CORRECTION=Backspace ANNULATION=^U GUIDE=Tab
                     SOMMAIRE=Esc RETOUR/SUITE=PgUp/PgDn RÉPÉTITION=40/80 col CONNEXION/FIN=quit
  slide list | add <n> <file> [-cols 40|80|both] [-raw] | get <n> [-cols ..] [-o file]
        | del <n|all> [40|80] | show <n>
  slide preview <file>... [-cols 40|80|both] [-hold 10s]
                     shown on the Minitel now, stored nowhere (BLE); a key: the next one
  slide encode [-cols 40|80] -o <out> <file>
  text files and images (.png .gif .jpg: G1 mosaics in 40 col, 8 grey levels; ASCII art in
  80 col) take -dither, -contrast, -gamma 1.5 with add, preview and encode
  saver [<splash> <off>]   e.g. "saver 10m 1h"; 0 = never
  keep [<n>]               messages kept per conversation (10-160)
  cli <command...>
`)
}

func main() {
	addr := flag.String("addr", "", "BLE address of the node")
	name := flag.String("name", "MeshCore", "BLE name to look for (substring)")
	usb := flag.String("usb", "", "USB CLI port instead of BLE (not for term)")
	quiet := flag.Bool("q", false, "no progress messages")
	flag.StringVar(&hciName, "hci", "", "Bluetooth adapter (default: the first one, hci0, hci1...)")
	flag.Usage = usage
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	if err := run(args, *addr, *name, *usb, !*quiet); err != nil {
		fmt.Fprintln(os.Stderr, "mtl:", err)
		os.Exit(1)
	}
}

func connect(addr, name, usb string, verbose bool) (Cli, *BLE, error) {
	if usb != "" {
		u, err := OpenUSB(usb)
		return u, nil, err
	}
	b, err := ConnectBLE(addr, name, verbose)
	return b, b, err
}

func run(args []string, addr, name, usb string, verbose bool) error {
	switch args[0] {
	case "term":
		fs := flag.NewFlagSet("term", flag.ExitOnError)
		cols := fs.Int("cols", 0, "40 or 80 (default: as the Minitel is)")
		term := fs.String("term", "", "TERM for the program (default xterm; -native: minitel1b or minitel1b-80)")
		mono := fs.Bool("mono", false, "no colours as grey levels in 40 col")
		native := fs.Bool("native", false, "no emulator: the program uses the Minitel's own terminfo, bytes pass through")
		noScroll := fs.Bool("noscroll", false, "never let the Minitel shift rows (DL/IL)")
		trace := fs.String("trace", "", "write every byte sent to the Minitel to this file")
		fs.Parse(args[1:])
		if *trace != "" {
			f, err := os.Create(*trace)
			if err != nil {
				return err
			}
			defer f.Close()
			traceFile = f
		}
		if *cols != 0 && *cols != 40 && *cols != 80 {
			return errors.New("-cols: 40 or 80")
		}
		if usb != "" {
			return errors.New("term needs BLE")
		}
		b, err := ConnectBLE(addr, name, verbose)
		if err != nil {
			return err
		}
		defer b.Close()
		o := TermOpts{Argv: fs.Args(), TermEnv: *term, Mono: *mono, Verbose: verbose, Cols: *cols, NoScroll: *noScroll}
		if *native {
			return RunNative(b, o)
		}
		if o.TermEnv == "" {
			o.TermEnv = "xterm"
		}
		return RunTerm(b, o)
	case "slide":
		if len(args) >= 2 && args[1] == "encode" {
			return slideEncode(args[2:])
		}
		if len(args) >= 2 && args[1] == "preview" {
			if usb != "" {
				return errors.New("preview needs BLE (the terminal channel)")
			}
			if len(args) < 3 {
				return errors.New("usage: slide preview <file.vdt|file.mixte|text>... [-cols 40|80|both] [-hold 10s]")
			}
			b, err := ConnectBLE(addr, name, verbose)
			if err != nil {
				return err
			}
			defer b.Close()
			return slidePreview(b, args[2:])
		}
		c, _, err := connect(addr, name, usb, verbose)
		if err != nil {
			return err
		}
		defer c.Close()
		return slideCmd(c, args[1:], verbose)
	case "saver", "keep", "cli":
		c, _, err := connect(addr, name, usb, verbose)
		if err != nil {
			return err
		}
		defer c.Close()
		cmd := strings.Join(args[1:], " ")
		switch args[0] {
		case "saver":
			cmd = strings.TrimSpace("saver " + cmd)
		case "keep":
			cmd = strings.TrimSpace("hist keep " + cmd)
		}
		out, err := c.Cli(cmd)
		fmt.Print(out)
		return err
	}
	usage()
	return fmt.Errorf("unknown command %q", args[0])
}

// ---- slides -------------------------------------------------------------------------------

func slideCmd(c Cli, a []string, verbose bool) error {
	if len(a) == 0 || a[0] == "list" {
		out, err := c.Cli("slide list")
		fmt.Print(out)
		return err
	}
	switch a[0] {
	case "del", "show":
		out, err := c.Cli("slide " + strings.Join(a, " "))
		fmt.Print(out)
		return err
	case "get":
		return slideGet(c, a[1:], verbose)
	case "add":
		fs := flag.NewFlagSet("slide add", flag.ExitOnError)
		cols := fs.String("cols", "", "40, 80 or both (default: 40 for .vdt, both for text)")
		raw := fs.Bool("raw", false, "send the file's bytes as they are (with -cols 40 or 80)")
		var io ImageOpts
		fs.BoolVar(&io.Dither, "dither", false, "images: error diffusion (photos)")
		fs.BoolVar(&io.Contrast, "contrast", false, "images: stretch to black..white")
		fs.Float64Var(&io.Gamma, "gamma", 1, "images: > 1 brightens the mid tones")
		pos := []string{}
		rest := a[1:]
		for len(rest) > 0 { // flags and positionals in any order
			fs.Parse(rest)
			rest = fs.Args()
			if len(rest) > 0 {
				pos = append(pos, rest[0])
				rest = rest[1:]
			}
		}
		if len(pos) != 2 {
			return errors.New("usage: slide add <n> <file> [-cols 40|80|both] [-raw]")
		}
		var n int
		if _, err := fmt.Sscanf(pos[0], "%d", &n); err != nil || n < 1 || n > 8 {
			return errors.New("slide number: 1 to 8")
		}
		isVdt := strings.EqualFold(filepath.Ext(pos[1]), ".vdt")
		mode := *cols
		if mode == "" {
			if isVdt || *raw {
				mode = "40"
			} else {
				mode = "both"
			}
		}
		var widths []int
		switch mode {
		case "40":
			widths = []int{40}
		case "80":
			widths = []int{80}
		case "both":
			widths = []int{40, 80}
		default:
			return errors.New("-cols: 40, 80 or both")
		}
		for _, w := range widths {
			var bytes []byte
			var err error
			if isVdt || *raw {
				if len(widths) > 1 {
					return errors.New("raw bytes are for one mode: -cols 40 or 80")
				}
				bytes, err = os.ReadFile(pos[1])
			} else {
				bytes, err = slideFile(pos[1], w, io)
			}
			if err != nil {
				return err
			}
			if err := upload(c, n, w, bytes, verbose); err != nil {
				return err
			}
		}
		return nil
	}
	return errors.New("slide: list, add, get, del, show, encode")
}

// slideGet: a slide's version read back from the node into a file (.vdt for 40 col, raw
// Mixte bytes for 80 col); "both" (the default) gets every version there is.
func slideGet(c Cli, a []string, verbose bool) error {
	fs := flag.NewFlagSet("slide get", flag.ExitOnError)
	cols := fs.String("cols", "both", "40, 80 or both")
	outName := fs.String("o", "", "output file (default slide<n>.40.vdt / slide<n>.80.mixte)")
	pos := []string{}
	rest := a
	for len(rest) > 0 {
		fs.Parse(rest)
		rest = fs.Args()
		if len(rest) > 0 {
			pos = append(pos, rest[0])
			rest = rest[1:]
		}
	}
	var n int
	if len(pos) != 1 {
		return errors.New("usage: slide get <n> [-cols 40|80|both] [-o file]")
	}
	if _, err := fmt.Sscanf(pos[0], "%d", &n); err != nil || n < 1 || n > 8 {
		return errors.New("slide number: 1 to 8")
	}
	widths := map[string][]int{"40": {40}, "80": {80}, "both": {40, 80}}[*cols]
	if widths == nil {
		return errors.New("-cols: 40, 80 or both")
	}
	got := 0
	for _, w := range widths {
		data, err := slideRead(c, n, w, verbose)
		if err != nil {
			if *cols == "both" && strings.Contains(err.Error(), "no such slide") {
				continue
			}
			return err
		}
		name := *outName
		if name == "" || len(widths) > 1 {
			ext := ".vdt"
			if w == 80 {
				ext = ".mixte"
			}
			if name == "" {
				name = fmt.Sprintf("slide%d.%d%s", n, w, ext)
			} else {
				name = strings.TrimSuffix(name, filepath.Ext(name)) + fmt.Sprintf(".%d%s", w, ext)
			}
		}
		if err := os.WriteFile(name, data, 0644); err != nil {
			return err
		}
		fmt.Printf("slide %d, %d col: %d bytes -> %s\n", n, w, len(data), name)
		got++
	}
	if got == 0 {
		return fmt.Errorf("slide %d: nothing stored", n)
	}
	return nil
}

func slideRead(c Cli, n, cols int, verbose bool) ([]byte, error) {
	var data []byte
	size := -1
	for size < 0 || len(data) < size {
		out, err := c.Cli(fmt.Sprintf("slide read %d %d %d 240", n, cols, len(data)))
		if err != nil {
			return nil, err
		}
		i := strings.Index(out, "size ")
		if i < 0 || strings.Contains(out, "ERR") {
			return nil, fmt.Errorf("node: %s", strings.TrimSpace(out))
		}
		var s, off int
		var hexs string
		if _, err := fmt.Sscanf(out[i:], "size %d offset %d data %s", &s, &off, &hexs); err != nil || off != len(data) {
			return nil, fmt.Errorf("bad reply: %q", strings.TrimSpace(out))
		}
		chunk, err := hex.DecodeString(hexs)
		if err != nil || len(chunk) == 0 {
			return nil, fmt.Errorf("bad data in reply")
		}
		size = s
		data = append(data, chunk...)
		if verbose {
			fmt.Fprintf(os.Stderr, "\rmtl: slide %d (%d col): %d / %d bytes", n, cols, len(data), size)
		}
	}
	if verbose {
		fmt.Fprintln(os.Stderr)
	}
	return data, nil
}

// layoutText: a text / ANSI file drawn by the emulator, then encoded as a full screen.
func layoutText(data []byte, cols int) []byte {
	vt := vt10x.New(vt10x.WithSize(cols, 24))
	s := strings.ReplaceAll(string(data), "\r\n", "\n")
	s = strings.TrimRight(s, "\n")
	vt.Write([]byte(strings.ReplaceAll(s, "\n", "\r\n")))
	vt.Lock()
	scr, _, _, _ := Snapshot(vt, cols == 80, false)
	vt.Unlock()
	r := NewRenderer(cols, false)
	b := r.Frame(scr, 24, 1, false)
	return b
}

func slideEncode(a []string) error {
	fs := flag.NewFlagSet("slide encode", flag.ExitOnError)
	cols := fs.Int("cols", 40, "40 or 80")
	out := fs.String("o", "", "output file")
	var io ImageOpts
	fs.BoolVar(&io.Dither, "dither", false, "images: error diffusion (photos)")
	fs.BoolVar(&io.Contrast, "contrast", false, "images: stretch to black..white")
	fs.Float64Var(&io.Gamma, "gamma", 1, "images: > 1 brightens the mid tones")
	fs.Parse(a)
	if fs.NArg() != 1 || *out == "" {
		return errors.New("usage: slide encode [-cols 40|80] [-dither] -o <out> <text or image file>")
	}
	data, err := slideFile(fs.Arg(0), *cols, io)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %d bytes (%.1f s at 9600 baud)\n", *out, len(data), float64(len(data))/960)
	return os.WriteFile(*out, data, 0644)
}

func upload(c Cli, n, cols int, data []byte, verbose bool) error {
	if len(data) == 0 || len(data) > 12288 {
		return fmt.Errorf("slide of %d bytes (1 to 12288)", len(data))
	}
	ok := func(out string, err error) error {
		if err != nil {
			return err
		}
		if !strings.Contains(out, "OK") || strings.Contains(out, "ERR") {
			return fmt.Errorf("node: %s", strings.TrimSpace(out))
		}
		return nil
	}
	if err := ok(c.Cli(fmt.Sprintf("slide begin %d %d %d", n, cols, len(data)))); err != nil {
		return err
	}
	t0 := time.Now()
	for i := 0; i < len(data); i += 70 {
		j := i + 70
		if j > len(data) {
			j = len(data)
		}
		if err := ok(c.Cli(fmt.Sprintf("slide data %x", data[i:j]))); err != nil {
			return err
		}
		if verbose {
			fmt.Fprintf(os.Stderr, "\rmtl: slide %d (%d col): %d / %d bytes", n, cols, j, len(data))
		}
	}
	if err := ok(c.Cli("slide end")); err != nil {
		return err
	}
	if verbose {
		fmt.Fprintf(os.Stderr, " ok (%.1f s)\n", time.Since(t0).Seconds())
	}
	return nil
}
