package main

// BLE: the companion's Nordic UART service (one write = one frame, one notification = one
// frame), through BlueZ. The node asks for a PIN at the first pairing: pair it once with
// bluetoothctl (the Minitel shows the code), after that the bond is reused.

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"tinygo.org/x/bluetooth"
)

var (
	nusService = mustUUID("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
	nusRX      = mustUUID("6e400002-b5a3-f393-e0a9-e50e24dcca9e") // we write
	nusTX      = mustUUID("6e400003-b5a3-f393-e0a9-e50e24dcca9e") // it notifies
)

const (
	cmdAppExt = 0xC0
	extReply  = 0x70
	extPush   = 0xF0
	respErr   = 0x01
)

func mustUUID(s string) bluetooth.UUID {
	u, err := bluetooth.ParseUUID(s)
	if err != nil {
		panic(err)
	}
	return u
}

type BLE struct {
	adapter  *bluetooth.Adapter
	target   bluetooth.Address
	dev      bluetooth.Device
	rx       bluetooth.DeviceCharacteristic
	wmu      sync.Mutex
	seq      byte
	replies  chan []byte
	Pushes   chan []byte // 0xF0 <sub> <payload>: the push counter already taken out
	mu       sync.Mutex
	pushSeen []byte // the last push counters seen (a late copy may come after the next push)
}

// The adapter: -hci, else the first one the system has (hci0 is not always there: a USB
// adapter or a toggled radio comes back as hci1...).
var hciName string

func pickAdapter() *bluetooth.Adapter {
	name := hciName
	if name == "" {
		ents, _ := os.ReadDir("/sys/class/bluetooth")
		for _, e := range ents {
			if n := e.Name(); strings.HasPrefix(n, "hci") && !strings.Contains(n, ":") {
				name = n
				break
			}
		}
	}
	if name == "" || name == "hci0" {
		return bluetooth.DefaultAdapter
	}
	return bluetooth.NewAdapter(name)
}

// ConnectBLE: by address (AA:BB:..), or the first device whose name contains name.
func ConnectBLE(addr, name string, verbose bool) (*BLE, error) {
	adapter := pickAdapter()
	if err := adapter.Enable(); err != nil {
		return nil, fmt.Errorf("bluetooth: %w (rfkill unblock bluetooth? bluetoothd running?)", err)
	}
	b := &BLE{adapter: adapter, replies: make(chan []byte, 32), Pushes: make(chan []byte, 256)}
	if addr != "" {
		mac, err := bluetooth.ParseMAC(addr)
		if err != nil {
			return nil, fmt.Errorf("address %q: %w", addr, err)
		}
		b.target.MACAddress = bluetooth.MACAddress{MAC: mac}
	} else {
		if verbose {
			fmt.Fprintf(os.Stderr, "mtl: scanning for %q...\n", name)
		}
		found := false
		go func() {
			time.Sleep(15 * time.Second)
			adapter.StopScan()
		}()
		err := adapter.Scan(func(a *bluetooth.Adapter, r bluetooth.ScanResult) {
			n := r.LocalName()
			if n != "" && strings.Contains(strings.ToLower(n), strings.ToLower(name)) {
				b.target = r.Address
				found = true
				if verbose {
					fmt.Fprintf(os.Stderr, "mtl: found %s (%s)\n", n, r.Address.String())
				}
				a.StopScan()
			}
		})
		if err != nil {
			return nil, fmt.Errorf("scan: %w (another scan running? give the address with -addr)", err)
		}
		if !found {
			return nil, fmt.Errorf("no device named like %q (is an app connected to it? only one at a time)", name)
		}
	}
	if err := b.connect(); err != nil {
		return nil, err
	}
	return b, nil
}

// connect: to b.target, the UART service, its notifications (again after a lost link)
func (b *BLE) connect() error {
	dev, err := b.adapter.Connect(b.target, bluetooth.ConnectionParams{})
	if err != nil {
		return fmt.Errorf("connect %s: %w", b.target.String(), err)
	}
	svcs, err := dev.DiscoverServices([]bluetooth.UUID{nusService})
	if err != nil || len(svcs) == 0 {
		dev.Disconnect()
		return fmt.Errorf("no UART service: %v", err)
	}
	chars, err := svcs[0].DiscoverCharacteristics([]bluetooth.UUID{nusRX, nusTX})
	if err != nil {
		dev.Disconnect()
		return fmt.Errorf("characteristics: %w", err)
	}
	var rx, tx *bluetooth.DeviceCharacteristic
	for i := range chars {
		switch chars[i].UUID() {
		case nusRX:
			rx = &chars[i]
		case nusTX:
			tx = &chars[i]
		}
	}
	if rx == nil || tx == nil {
		dev.Disconnect()
		return errors.New("UART characteristics missing")
	}
	if err := tx.EnableNotifications(b.notified); err != nil {
		dev.Disconnect()
		return fmt.Errorf("notifications: %w (not paired? bluetoothctl pair %s, PIN on the Minitel)", err, b.target.String())
	}
	b.wmu.Lock()
	b.dev, b.rx = dev, *rx
	b.wmu.Unlock()
	b.mu.Lock()
	b.pushSeen = nil // a rebooted node counts from 0 again
	b.mu.Unlock()
	return nil
}

// Reconnect: drop the link and make it again, to the same device (no scan)
func (b *BLE) Reconnect() error {
	b.dev.Disconnect()
	time.Sleep(500 * time.Millisecond)
	return b.connect()
}

var debugBLE = os.Getenv("MTL_DEBUG") != ""
var t0BLE = time.Now()

func debugFrame(dir string, f []byte) {
	n := len(f)
	if n > 24 {
		n = 24
	}
	fmt.Fprintf(os.Stderr, "[%6dms] %s %3d: % x\n", time.Since(t0BLE).Milliseconds(), dir, len(f), f[:n])
}

// notified: one frame from the node. Replies carry the request's seq (a copy, or a late
// one, is told apart by Request); pushes carry a counter: a counter already seen is a copy
// (BlueZ was seen handing notifications over twice) and is dropped here.
func (b *BLE) notified(buf []byte) {
	f := append([]byte(nil), buf...)
	if len(f) == 0 {
		return
	}
	if debugBLE {
		debugFrame("rx", f)
	}
	switch f[0] {
	case extReply, respErr:
		select {
		case b.replies <- f:
		default:
		}
	case extPush:
		if len(f) < 3 {
			return
		}
		b.mu.Lock()
		dup := false
		for _, s := range b.pushSeen {
			dup = dup || s == f[2]
		}
		if !dup {
			b.pushSeen = append(b.pushSeen, f[2])
			if len(b.pushSeen) > 16 {
				b.pushSeen = b.pushSeen[1:]
			}
		}
		b.mu.Unlock()
		if dup {
			return
		}
		select {
		case b.Pushes <- append([]byte{f[0], f[1]}, f[3:]...):
		default:
		}
	}
}

func (b *BLE) Close() { b.dev.Disconnect() }

func (b *BLE) write(f []byte) error {
	b.wmu.Lock()
	defer b.wmu.Unlock()
	if debugBLE {
		debugFrame("tx", f)
	}
	_, err := b.rx.WriteWithoutResponse(f)
	return err
}

// Request: C0 <sub> <seq> <payload>; returns the reply's fields (after 70 <sub> <seq>).
// Replies to other requests (late ones, copies) are skipped.
func (b *BLE) Request(sub byte, payload []byte, timeout time.Duration) ([]byte, error) {
	for {
		select {
		case <-b.replies: // stale
			continue
		default:
		}
		break
	}
	b.seq++
	seq := b.seq
	if err := b.write(append([]byte{cmdAppExt, sub, seq}, payload...)); err != nil {
		return nil, err
	}
	deadline := time.After(timeout)
	for {
		select {
		case r := <-b.replies:
			if r[0] == respErr {
				return nil, errors.New("the node does not know this command (firmware without the Minitel extensions?)")
			}
			if len(r) >= 3 && r[1] == sub && r[2] == seq {
				return r[3:], nil
			}
		case <-deadline:
			return nil, fmt.Errorf("no reply to %q", sub)
		}
	}
}

// Cli: a USB CLI command run over BLE (slide, saver, hist keep, screen, ui state).
// The reply comes in frames 70 'C' <seq> <more> <text>.
func (b *BLE) Cli(cmd string) (string, error) {
	r, err := b.Request('C', []byte(cmd), 5*time.Second)
	if err != nil {
		return "", err
	}
	seq := b.seq
	var out strings.Builder
	// a late copy of a frame of this reply has the same seq: a frame identical to one already
	// taken is that copy (two real ones never are: all but the last are full, the last ends OK)
	taken := map[string]bool{string(r): true}
	for {
		if len(r) < 1 {
			break
		}
		out.Write(r[1:])
		if r[0] == 0 {
			break
		}
		next := []byte(nil)
		for next == nil {
			select {
			case f := <-b.replies:
				if len(f) >= 4 && f[1] == 'C' && f[2] == seq && !taken[string(f[3:])] {
					next = f[3:]
					taken[string(next)] = true
				}
			case <-time.After(3 * time.Second):
				return out.String(), errors.New("reply cut short")
			}
		}
		r = next
	}
	return out.String(), nil
}
