package main

// "mtl term": a program of this PC (a shell by default) in a pty, run through a VT
// emulator; the emulator's screen goes to the Minitel as damage only, encoded for its
// mode, at the pace the 9600 baud line takes. Output faster than that is not queued:
// the Minitel gets the latest screen once it has drawn the previous one.
// Keys come back as xterm sequences. RÉPÉTITION on the Minitel switches 40/80 columns:
// the pty is resized (SIGWINCH) and the screen redrawn. CONNEXION/FIN ends the session.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/hinshun/vt10x"
)

type TermOpts struct {
	Argv     []string
	TermEnv  string
	Mono     bool
	Verbose  bool
	Cols     int // 0: as the Minitel is
	NoScroll bool
}

const (
	settleMs  = 12  // gather a program's burst before drawing it
	maxWaitMs = 120 // but draw at least this often while it keeps writing
	chunk     = 150 // screen bytes per BLE frame
	lowWater  = 640 // Minitel output queue free bytes before the next frame (of 1023)
)

func RunTerm(b *BLE, o TermOpts) error {
	r, err := openTerm(b)
	if err != nil {
		return err
	}
	if len(r) < 4 || r[0] != 0 {
		return errors.New("the Minitel is not ready (switched off? not found by the node?)")
	}
	cols, gen := int(r[1]), r[3]
	if o.Cols != 0 && o.Cols != cols {
		if _, err := b.Request('M', []byte{byte(o.Cols)}, 3*time.Second); err == nil {
			cols = 0 // wait for the 'M' push
		}
	}
	defer b.Request('X', nil, 2*time.Second)

	argv := o.Argv
	if len(argv) == 0 {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/sh"
		}
		argv = []string{sh, "-l"}
	}
	c := exec.Command(argv[0], argv[1:]...)
	c.Env = append(os.Environ(), "TERM="+o.TermEnv, "MINITEL=1", "COLORTERM=")
	startCols := cols
	if startCols == 0 {
		startCols = o.Cols
	}
	ptmx, err := pty.StartWithSize(c, &pty.Winsize{Rows: 24, Cols: uint16(startCols)})
	if err != nil {
		return err
	}
	defer ptmx.Close()

	vt := vt10x.New(vt10x.WithWriter(ptmx), vt10x.WithSize(startCols, 24))
	rend := NewRenderer(startCols, o.Mono)
	rend.noScroll = o.NoScroll
	ready := cols != 0

	var mu sync.Mutex
	var lastOut, firstDirty time.Time
	dirty := true
	wake := make(chan struct{}, 1)
	exited := make(chan error, 1)
	go func() { // the program's output into the emulator
		buf := make([]byte, 8192)
		var left []byte
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := append(left, buf[:n]...)
				w, _ := vt.Write(data)
				left = append([]byte(nil), data[w:]...)
				mu.Lock()
				if !dirty {
					firstDirty = time.Now()
				}
				dirty = true
				lastOut = time.Now()
				mu.Unlock()
				select {
				case wake <- struct{}{}:
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { exited <- c.Wait() }()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)

	if o.Verbose {
		fmt.Fprintf(os.Stderr, "mtl: %s on the Minitel (%d col); CONNEXION/FIN on the Minitel or Ctrl-C here ends it\n", argv[0], startCols)
	}
	var pending []byte
	free := 1023
	lastReq := time.Now()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	// the link lost or misbehaving: reconnect, open the session again, redraw everything; the
	// program keeps running all along. false: stop (the program ended, or Ctrl-C)
	relinkNow := func() (bool, error) {
		nc, ng, stop, perr := relink(b, o.Verbose, exited, sig)
		if stop {
			c.Process.Signal(syscall.SIGHUP)
			return false, perr
		}
		gen, pending, free, ready, lastReq = ng, nil, 1023, true, time.Now()
		if nc != rend.sent.cols {
			vt.Resize(nc, 24)
			pty.Setsize(ptmx, &pty.Winsize{Rows: 24, Cols: uint16(nc)})
		}
		rend.Reset(nc)
		mu.Lock()
		dirty = true
		firstDirty = time.Now()
		mu.Unlock()
		return true, nil
	}
	for {
		select {
		case p := <-b.Pushes:
			if len(p) < 2 {
				continue
			}
			switch p[1] {
			case 'K':
				keys := p[2:]
				if vt.Mode()&vt10x.ModeAppCursor != 0 { // ESC [ A -> ESC O A
					keys = appCursor(keys)
				}
				ptmx.Write(keys)
			case 'M':
				if len(p) >= 5 {
					nc := int(p[2])
					gen = p[4]
					pending = nil
					free = 1023
					vt.Resize(nc, 24)
					pty.Setsize(ptmx, &pty.Winsize{Rows: 24, Cols: uint16(nc)})
					rend.Reset(nc)
					ready = true
					mu.Lock()
					dirty = true
					firstDirty = time.Now()
					mu.Unlock()
					if o.Verbose {
						fmt.Fprintf(os.Stderr, "mtl: Minitel in %d columns\n", nc)
					}
				}
			case 'X':
				if o.Verbose {
					fmt.Fprintln(os.Stderr, "mtl: ended on the Minitel")
				}
				c.Process.Signal(syscall.SIGHUP)
				return nil
			}
		case err := <-exited:
			// the last screen, then done
			if ready {
				vt.Lock()
				s, cr, cc, vis := Snapshot(vt, rend.wide, o.Mono)
				vt.Unlock()
				sendAll(b, gen, append(pending, rend.Frame(s, cr, cc, vis)...))
			}
			if err != nil {
				return fmt.Errorf("%s: %w", argv[0], err)
			}
			return nil
		case <-sig:
			c.Process.Signal(syscall.SIGHUP)
			return nil
		case <-wake:
		case <-tick.C:
		}
		if !ready {
			continue
		}
		if len(pending) == 0 && time.Since(lastReq) > 5*time.Second { // keepalive: is the link still there?
			lastReq = time.Now()
			if _, _, err := sendChunk(b, gen, nil); err != nil {
				if ok, perr := relinkNow(); !ok {
					return perr
				}
				continue
			}
		}
		// one frame of bytes at a time; the next screen when the Minitel has room for it
		if len(pending) == 0 {
			mu.Lock()
			due := dirty && (time.Since(lastOut) >= settleMs*time.Millisecond || time.Since(firstDirty) >= maxWaitMs*time.Millisecond)
			mu.Unlock()
			if due && free >= lowWater {
				mu.Lock()
				dirty = false
				mu.Unlock()
				vt.Lock()
				s, cr, cc, vis := Snapshot(vt, rend.wide, o.Mono)
				vt.Unlock()
				pending = rend.Frame(s, cr, cc, vis)
			} else if free < lowWater {
				lastReq = time.Now()
				f, st, err := sendChunk(b, gen, nil)
				if err != nil {
					if ok, perr := relinkNow(); !ok {
						return perr
					}
				} else if st == 0 {
					free = f.free
				}
				continue
			} else {
				continue
			}
		}
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
			continue
		}
		if st != 0 { // the Minitel is switching modes: an 'M' push follows
			pending = nil
			ready = false
			continue
		}
		pending = pending[f.acc:]
		free = f.free
		if f.acc == 0 {
			time.Sleep(30 * time.Millisecond)
		}
	}
}

type dataReply struct{ acc, free int }

// relink: the BLE link is gone or misbehaves. Reconnect to the same device and open the
// session again (the node keeps the session's screen 20 s for that, then its pages come back:
// opening again works either way), every 2 s until it works. Returns the Minitel's width and
// the session's gen; stop: the program ended (perr: its error) or Ctrl-C, meanwhile.
func relink(b *BLE, verbose bool, exited <-chan error, sig <-chan os.Signal) (cols int, gen byte, stop bool, perr error) {
	if verbose {
		fmt.Fprintln(os.Stderr, "mtl: link lost, reconnecting (the program keeps running; Ctrl-C to stop)...")
	}
	for attempt := 1; ; attempt++ {
		select {
		case err := <-exited:
			return 0, 0, true, err
		case <-sig:
			return 0, 0, true, nil
		default:
		}
		err := b.Reconnect()
		if err == nil {
			var r []byte
			if r, err = openTerm(b); err == nil {
				if len(r) >= 4 && r[0] == 0 {
					if verbose {
						fmt.Fprintf(os.Stderr, "mtl: reconnected (%d col)\n", r[1])
					}
					return int(r[1]), r[3], false, nil
				}
				err = errors.New("the Minitel is not ready")
			}
		}
		if verbose && (attempt == 1 || attempt%10 == 0) {
			fmt.Fprintf(os.Stderr, "mtl: still trying (%v)\n", err)
		}
		select {
		case err := <-exited:
			return 0, 0, true, err
		case <-sig:
			return 0, 0, true, nil
		case <-time.After(2 * time.Second):
		}
	}
}

// openTerm: 'O', tried again while the node is still busy with a connection just closed
func openTerm(b *BLE) ([]byte, error) {
	var err error
	for i := 0; i < 3; i++ {
		var r []byte
		if r, err = b.Request('O', nil, 3*time.Second); err == nil {
			return r, nil
		}
		time.Sleep(time.Second)
	}
	return nil, err
}

var traceFile *os.File // -trace: every byte the Minitel accepted

func sendChunk(b *BLE, gen byte, data []byte) (dataReply, byte, error) {
	r, err := b.Request('D', append([]byte{gen}, data...), 3*time.Second)
	if err != nil {
		return dataReply{}, 0, err
	}
	if len(r) < 4 {
		return dataReply{}, 1, nil
	}
	d := dataReply{acc: int(r[1]), free: int(r[2]) | int(r[3])<<8}
	if d.acc > len(data) { // not this request's reply
		return dataReply{}, 0, errors.New("BLE replies out of step")
	}
	if traceFile != nil && r[0] == 0 && d.acc > 0 {
		traceFile.Write(data[:d.acc])
	}
	return d, r[0], nil
}

func sendAll(b *BLE, gen byte, data []byte) {
	deadline := time.Now().Add(10 * time.Second)
	for len(data) > 0 && time.Now().Before(deadline) {
		n := len(data)
		if n > chunk {
			n = chunk
		}
		f, st, err := sendChunk(b, gen, data[:n])
		if err != nil || st != 0 {
			return
		}
		data = data[f.acc:]
		if f.acc == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func appCursor(k []byte) []byte {
	out := make([]byte, 0, len(k))
	for i := 0; i < len(k); i++ {
		if k[i] == 0x1B && i+2 < len(k) && k[i+1] == '[' && k[i+2] >= 'A' && k[i+2] <= 'D' {
			out = append(out, 0x1B, 'O', k[i+2])
			i += 2
			continue
		}
		out = append(out, k[i])
	}
	return out
}
