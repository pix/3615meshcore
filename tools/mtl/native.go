package main

// "mtl term -native": no emulator. The program gets the Minitel's own terminfo entry
// (minitel1b in 40 col, minitel1b-80 in 80 col, or -term) and writes for it; its bytes go
// to the Minitel as they are, with only its UTF-8 text turned into the Minitel's
// characters (SS2 accents in 40 col, SO..SI French letters in 80 col, folds otherwise).
// Keys are translated to that entry's key strings. The pty is read only as fast as the
// Minitel takes it, so a program blocks instead of piling output up. The width is fixed
// for the session (TERM cannot change under a running program): RÉPÉTITION is undone.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// terminfo key strings of an entry, from infocmp
func terminfoKeys(term string) map[string]string {
	out, err := exec.Command("infocmp", "-1", "-x", term).Output()
	if err != nil {
		return nil
	}
	keys := map[string]string{}
	for _, l := range strings.Split(string(out), "\n") {
		l = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(l), ","))
		i := strings.IndexByte(l, '=')
		if i <= 0 || !strings.HasPrefix(l, "k") {
			continue
		}
		keys[l[:i]] = unescapeTerminfo(l[i+1:])
	}
	return keys
}

func unescapeTerminfo(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			i++
			switch d := s[i]; d {
			case 'E', 'e':
				b.WriteByte(0x1B)
			case 'n', 'l':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 's':
				b.WriteByte(' ')
			case '0', '1', '2', '3':
				j := i
				for j < len(s) && j < i+3 && s[j] >= '0' && s[j] <= '7' {
					j++
				}
				v, _ := strconv.ParseUint(s[i:j], 8, 8)
				if v == 0 {
					v = 0x80 // \0 is NUL written as 0200
				}
				b.WriteByte(byte(v & 0x7F))
				i = j - 1
			default:
				b.WriteByte(d)
			}
		case c == '^' && i+1 < len(s):
			i++
			if s[i] == '?' {
				b.WriteByte(0x7F)
			} else {
				b.WriteByte(s[i] & 0x1F)
			}
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// the node's key sequences (xterm style) -> the entry's
func translateKeys(k []byte, keys map[string]string) []byte {
	if keys == nil {
		return k
	}
	pairs := []struct{ from, cap string }{
		{"\x1b[A", "kcuu1"}, {"\x1b[B", "kcud1"}, {"\x1b[C", "kcuf1"}, {"\x1b[D", "kcub1"},
		{"\x1b[5~", "kpp"}, {"\x1b[6~", "knp"},
	}
	s := string(k)
	for _, p := range pairs {
		if to, ok := keys[p.cap]; ok && to != "" {
			s = strings.ReplaceAll(s, p.from, to)
		}
	}
	return []byte(s)
}

// nativeText: the program's bytes with UTF-8 characters made Minitel ones. Returns the
// converted bytes and the undecoded tail (a character cut by the read).
func nativeText(in []byte, wide bool) ([]byte, []byte) {
	out := make([]byte, 0, len(in)+16)
	for i := 0; i < len(in); {
		c := in[i]
		if c < 0x80 {
			out = append(out, c)
			i++
			continue
		}
		if !utf8.FullRune(in[i:]) {
			return out, append([]byte(nil), in[i:]...)
		}
		r, n := utf8.DecodeRune(in[i:])
		i += n
		cell := charCell(r, wide)
		if cell.attr&(aMosaic|aInv) != 0 { // no mosaic / inverse in a stream we do not own
			out = append(out, fold(r))
			continue
		}
		out = append(out, cell.b[:cell.n]...)
	}
	return out, nil
}

func RunNative(b *BLE, o TermOpts) error {
	r, err := openTerm(b)
	if err != nil {
		return err
	}
	if len(r) < 4 || r[0] != 0 {
		return errors.New("the Minitel is not ready (switched off? not found by the node?)")
	}
	cols, gen := int(r[1]), r[3]
	defer b.Request('X', nil, 2*time.Second)
	if o.Cols != 0 && o.Cols != cols { // switch first, wait until it is done
		if _, err := b.Request('M', []byte{byte(o.Cols)}, 3*time.Second); err != nil {
			return err
		}
		deadline := time.After(8 * time.Second)
	wait:
		for {
			select {
			case p := <-b.Pushes:
				if len(p) >= 5 && p[1] == 'M' && int(p[2]) == o.Cols {
					cols, gen = o.Cols, p[4]
					break wait
				}
			case <-deadline:
				return errors.New("the Minitel did not switch modes")
			}
		}
	}
	wide := cols == 80
	term := o.TermEnv
	if term == "" {
		term = "minitel1b"
		if wide {
			term = "minitel1b-80"
		}
	}
	keys := terminfoKeys(term)
	if keys == nil {
		fmt.Fprintf(os.Stderr, "mtl: no terminfo entry %q here (infocmp): keys untranslated\n", term)
	}

	argv := o.Argv
	if len(argv) == 0 {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/sh"
		}
		argv = []string{sh, "-l"}
	}
	c := exec.Command(argv[0], argv[1:]...)
	c.Env = append(os.Environ(), "TERM="+term, "MINITEL=1", "COLORTERM=")
	ptmx, err := pty.StartWithSize(c, &pty.Winsize{Rows: 24, Cols: uint16(cols)})
	if err != nil {
		return err
	}
	defer ptmx.Close()
	// tabs as spaces: a Vidéotex HT moves one column only, and programs such as ls write tabs
	// whatever the entry says
	if t, err := unix.IoctlGetTermios(int(ptmx.Fd()), unix.TCGETS); err == nil {
		t.Oflag = t.Oflag&^unix.TABDLY | unix.TAB3
		unix.IoctlSetTermios(int(ptmx.Fd()), unix.TCSETS, t)
	}
	if o.Verbose {
		fmt.Fprintf(os.Stderr, "mtl: %s on the Minitel, TERM=%s (%d col, native); CONNEXION/FIN or Ctrl-C ends it\n", argv[0], term, cols)
	}

	out := make(chan []byte) // unbuffered: the reader waits until the sender takes its data
	exited := make(chan error, 1)
	go func() {
		buf := make([]byte, 1024)
		var tail []byte
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				conv, rest := nativeText(append(tail, buf[:n]...), wide)
				tail = rest
				if len(conv) > 0 {
					out <- conv
				}
			}
			if err != nil {
				close(out)
				return
			}
		}
	}()
	go func() { exited <- c.Wait() }()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)

	var pending []byte
	ready := true
	outCh := out
	lastReq := time.Now()
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	// the link lost: reconnect and open again (the program keeps running); its width is the
	// session's, then ^L redraws. false: stop (the program ended, or Ctrl-C)
	relinkNow := func() (bool, error) {
		nc, ng, stop, perr := relink(b, o.Verbose, exited, sig)
		if stop {
			c.Process.Signal(syscall.SIGHUP)
			return false, perr
		}
		gen, pending, lastReq = ng, nil, time.Now()
		if nc != cols {
			b.Request('M', []byte{byte(cols)}, 3*time.Second)
			ready = false // the 'M' push puts it back, and sends ^L
		} else {
			ready = true
			ptmx.Write([]byte{0x0C})
		}
		return true, nil
	}
	for {
		var in chan []byte
		if len(pending) == 0 && ready {
			in = outCh
		}
		select {
		case data, ok := <-in:
			if !ok {
				outCh = nil
				continue
			}
			pending = data
		case p := <-b.Pushes:
			if len(p) < 2 {
				continue
			}
			switch p[1] {
			case 'K':
				ptmx.Write(translateKeys(p[2:], keys))
			case 'M':
				if len(p) >= 5 {
					gen = p[4]
					pending = nil
					if int(p[2]) != cols { // RÉPÉTITION: this session keeps its width
						b.Request('M', []byte{byte(cols)}, 3*time.Second)
						ready = false
					} else {
						ready = true
						ptmx.Write([]byte{0x0C}) // the screen was cleared: ^L redraws (shell, curses)
					}
				}
			case 'X':
				c.Process.Signal(syscall.SIGHUP)
				return nil
			}
		case <-tick.C:
		case err := <-exited:
			if pending != nil {
				sendAll(b, gen, pending)
			}
			if err != nil {
				return fmt.Errorf("%s: %w", argv[0], err)
			}
			return nil
		case <-sig:
			c.Process.Signal(syscall.SIGHUP)
			return nil
		}
		if len(pending) == 0 && ready && time.Since(lastReq) > 5*time.Second { // keepalive
			lastReq = time.Now()
			if _, _, err := sendChunk(b, gen, nil); err != nil {
				if ok, perr := relinkNow(); !ok {
					return perr
				}
				continue
			}
		}
		for len(pending) > 0 && ready {
			n := len(pending)
			if n > chunk {
				n = chunk
			}
			lastReq = time.Now()
			f, st, err := sendChunk(b, gen, pending[:n])
			if err != nil {
				if ok, perr := relinkNow(); !ok {
					return perr
				}
				break
			}
			if st != 0 {
				pending = nil
				break
			}
			pending = pending[f.acc:]
			if f.acc == 0 {
				time.Sleep(40 * time.Millisecond)
				break // pushes (keys) get a look in between
			}
		}
	}
}
