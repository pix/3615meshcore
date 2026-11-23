package main

// "mtl vtx": a Vidéotex service (the 3615 revivals: MiniPavi, 3611, ...) on the Minitel, as it
// was on the telephone line. No emulator, no pty: the service's bytes go to the Minitel as they
// are (the node still drops PRO1/2/3: the service must not reconfigure the link), and the keys
// come back as the Minitel sends them (ENVOI = 13 41 ... the node is told with the 'O' flag),
// with the node's UTF-8 accents turned back into Vidéotex (SS2). Always 40 columns.
// The node paces the output to the line speed (1200 baud by default): faster, the Minitel
// loses characters while it clears or scrolls, and animations run too fast.
// CONNEXION/FIN or Ctrl-C ends it. A lost BLE link is reconnected, the service stays connected
// and the Minitel keeps its page.
//
// The service: host:port over TCP (telnet options refused), or a ws:// / wss:// URL.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const vtxDefault = "go.minipavi.fr:516"

// openFlags: sent with 'O' (bit 0: Vidéotex session)
var openFlags []byte

type vtxConn interface {
	Read() ([]byte, error)
	Write([]byte) error
	Close() error
}

func dialVtx(target string) (vtxConn, error) {
	if strings.HasPrefix(target, "ws://") || strings.HasPrefix(target, "wss://") {
		ctx := context.Background()
		dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(dctx, target, nil)
		if err != nil {
			return nil, err
		}
		c.SetReadLimit(1 << 20)
		return &wsVtx{c: c, ctx: ctx}, nil
	}
	if _, _, err := net.SplitHostPort(target); err != nil {
		return nil, fmt.Errorf("%q: host:port, ws://... or wss://...", target)
	}
	c, err := net.DialTimeout("tcp", target, 15*time.Second)
	if err != nil {
		return nil, err
	}
	return &tcpVtx{c: c}, nil
}

// TCP, with telnet's IAC commands taken out (every option refused)
type tcpVtx struct {
	c   net.Conn
	st  int
	cmd byte
	buf [2048]byte
}

func (t *tcpVtx) Read() ([]byte, error) {
	n, err := t.c.Read(t.buf[:])
	out := make([]byte, 0, n)
	for _, c := range t.buf[:n] {
		switch t.st {
		case 0:
			if c == 0xFF {
				t.st = 1
			} else {
				out = append(out, c)
			}
		case 1: // after IAC
			switch c {
			case 251, 252, 253, 254: // WILL WONT DO DONT <option>
				t.cmd, t.st = c, 2
			case 250: // SB ... IAC SE
				t.st = 3
			default: // IAC IAC (not Vidéotex), NOP, GA...
				t.st = 0
			}
		case 2:
			switch t.cmd {
			case 251:
				t.c.Write([]byte{0xFF, 254, c}) // WILL x -> DONT x
			case 253:
				t.c.Write([]byte{0xFF, 252, c}) // DO x -> WONT x
			}
			t.st = 0
		case 3:
			if c == 0xFF {
				t.st = 4
			}
		case 4:
			if c == 240 {
				t.st = 0
			} else {
				t.st = 3
			}
		}
	}
	return out, err
}

func (t *tcpVtx) Write(b []byte) error { _, err := t.c.Write(b); return err }
func (t *tcpVtx) Close() error         { return t.c.Close() }

type wsVtx struct {
	c   *websocket.Conn
	ctx context.Context
}

func (w *wsVtx) Read() ([]byte, error) {
	typ, data, err := w.c.Read(w.ctx)
	if err != nil {
		return nil, err
	}
	if typ == websocket.MessageText && !isASCII(data) { // bytes sent as characters
		out := make([]byte, 0, len(data))
		for len(data) > 0 {
			r, n := utf8.DecodeRune(data)
			data = data[n:]
			if r < 0x100 {
				out = append(out, byte(r))
			}
		}
		data = out
	}
	return data, nil
}

func (w *wsVtx) Write(b []byte) error { return w.c.Write(w.ctx, websocket.MessageText, b) }
func (w *wsVtx) Close() error         { return w.c.Close(websocket.StatusNormalClosure, "") }

func isASCII(b []byte) bool {
	for _, c := range b {
		if c >= 0x80 {
			return false
		}
	}
	return true
}

// setCols: the Minitel switched to that width; returns the new generation
func setCols(b *BLE, want int) (byte, error) {
	if _, err := b.Request('M', []byte{byte(want)}, 3*time.Second); err != nil {
		return 0, err
	}
	deadline := time.After(8 * time.Second)
	for {
		select {
		case p := <-b.Pushes:
			if len(p) >= 5 && p[1] == 'M' && int(p[2]) == want {
				return p[4], nil
			}
		case <-deadline:
			return 0, errors.New("the Minitel did not switch modes")
		}
	}
}

func RunVtx(b *BLE, target string, speed int, verbose bool) error {
	openFlags = []byte{1, byte(speed / 100)} // Vidéotex session, paced to that speed
	r, err := openTerm(b)
	if err != nil {
		return err
	}
	if len(r) < 4 || r[0] != 0 {
		return errors.New("the Minitel is not ready (switched off? not found by the node?)")
	}
	gen := r[3]
	defer b.Request('X', nil, 2*time.Second)
	if r[1] != 40 {
		if gen, err = setCols(b, 40); err != nil {
			return err
		}
	}
	conn, err := dialVtx(target)
	if err != nil {
		return err
	}
	defer conn.Close()
	if verbose {
		fmt.Fprintf(os.Stderr, "mtl: %s on the Minitel; CONNEXION/FIN or Ctrl-C ends it\n", target)
	}

	out := make(chan []byte) // unbuffered: the service waits (TCP) while the Minitel is busy
	var readErr error
	go func() {
		for {
			d, err := conn.Read()
			if len(d) > 0 {
				out <- d
			}
			if err != nil {
				readErr = err
				close(out)
				return
			}
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)

	var pending []byte
	ready := true
	outCh := out
	lastReq := time.Now()
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	// the BLE link lost: reconnect, open again (the node keeps the page). false: Ctrl-C
	relinkNow := func() bool {
		nc, ng, stop, _ := relink(b, verbose, nil, sig)
		if stop {
			return false
		}
		gen, lastReq, ready = ng, time.Now(), true
		if nc != 40 {
			b.Request('M', []byte{40}, 3*time.Second)
			ready = false
		}
		return true
	}
	for {
		var in chan []byte
		if len(pending) == 0 && ready && outCh != nil {
			in = outCh
		}
		if outCh == nil && len(pending) == 0 { // the service hung up, all shown
			if verbose {
				fmt.Fprintf(os.Stderr, "mtl: the service closed the connection (%v)\n", readErr)
			}
			time.Sleep(2 * time.Second) // its last page, a moment
			return nil
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
				k, _ := nativeText(p[2:], false)
				if err := conn.Write(k); err != nil {
					return fmt.Errorf("the service: %w", err)
				}
			case 'M':
				if len(p) >= 5 {
					gen = p[4]
					pending = nil
					if p[2] != 40 {
						b.Request('M', []byte{40}, 3*time.Second)
						ready = false
					} else {
						ready = true
					}
				}
			case 'X':
				return nil
			}
		case <-tick.C:
		case <-sig:
			return nil
		}
		if len(pending) == 0 && ready && time.Since(lastReq) > 5*time.Second { // keepalive
			lastReq = time.Now()
			if _, _, err := sendChunk(b, gen, nil); err != nil {
				if !relinkNow() {
					return nil
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
				if !relinkNow() {
					return nil
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
				break
			}
		}
	}
}
