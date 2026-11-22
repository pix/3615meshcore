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
	dev     bluetooth.Device
	rx      bluetooth.DeviceCharacteristic
	wmu     sync.Mutex
	replies chan []byte
	Pushes  chan []byte
}

// ConnectBLE: by address (AA:BB:..), or the first device whose name contains name.
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

func ConnectBLE(addr, name string, verbose bool) (*BLE, error) {
	adapter := pickAdapter()
	if err := adapter.Enable(); err != nil {
		return nil, fmt.Errorf("bluetooth: %w (rfkill unblock bluetooth? bluetoothd running?)", err)
	}
	var target bluetooth.Address
	found := false
	if addr != "" {
		mac, err := bluetooth.ParseMAC(addr)
		if err != nil {
			return nil, fmt.Errorf("address %q: %w", addr, err)
		}
		target.MACAddress = bluetooth.MACAddress{MAC: mac}
		found = true
	} else {
		if verbose {
			fmt.Fprintf(os.Stderr, "mtl: scanning for %q...\n", name)
		}
		done := make(chan struct{})
		go func() {
			time.Sleep(15 * time.Second)
			adapter.StopScan()
		}()
		err := adapter.Scan(func(a *bluetooth.Adapter, r bluetooth.ScanResult) {
			n := r.LocalName()
			if n != "" && strings.Contains(strings.ToLower(n), strings.ToLower(name)) {
				target = r.Address
				found = true
				if verbose {
					fmt.Fprintf(os.Stderr, "mtl: found %s (%s)\n", n, r.Address.String())
				}
				a.StopScan()
			}
		})
		close(done)
		if err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		if !found {
			return nil, fmt.Errorf("no device named like %q (is an app connected to it? only one at a time)", name)
		}
	}
	dev, err := adapter.Connect(target, bluetooth.ConnectionParams{})
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", target.String(), err)
	}
	svcs, err := dev.DiscoverServices([]bluetooth.UUID{nusService})
	if err != nil || len(svcs) == 0 {
		dev.Disconnect()
		return nil, fmt.Errorf("no UART service: %v", err)
	}
	chars, err := svcs[0].DiscoverCharacteristics([]bluetooth.UUID{nusRX, nusTX})
	if err != nil {
		dev.Disconnect()
		return nil, fmt.Errorf("characteristics: %w", err)
	}
	b := &BLE{dev: dev, replies: make(chan []byte, 32), Pushes: make(chan []byte, 256)}
	var tx bluetooth.DeviceCharacteristic
	nrx, ntx := 0, 0
	for _, c := range chars {
		switch c.UUID() {
		case nusRX:
			b.rx = c
			nrx++
		case nusTX:
			tx = c
			ntx++
		}
	}
	if nrx == 0 || ntx == 0 {
		dev.Disconnect()
		return nil, errors.New("UART characteristics missing")
	}
	debug := os.Getenv("MTL_DEBUG") != ""
	t0 := time.Now()
	var prev []byte
	var prevAt time.Time
	err = tx.EnableNotifications(func(buf []byte) {
		f := append([]byte(nil), buf...)
		if len(f) == 0 {
			return
		}
		// BlueZ over D-Bus can hand the same notification over twice, back to back: one
		// frame identical to the one before it within a few ms is that copy (the node never
		// sends two identical frames so close: one reply per request, keys tens of ms apart)
		if prev != nil && time.Since(prevAt) < 5*time.Millisecond && string(prev) == string(f) {
			if debug {
				fmt.Fprintf(os.Stderr, "[%6dms] rx %3d: duplicate dropped\n", time.Since(t0).Milliseconds(), len(f))
			}
			return
		}
		prev, prevAt = f, time.Now()
		if debug {
			n := len(f)
			if n > 24 {
				n = 24
			}
			fmt.Fprintf(os.Stderr, "[%6dms] rx %3d: % x\n", time.Since(t0).Milliseconds(), len(f), f[:n])
		}
		switch f[0] {
		case extReply, respErr:
			select {
			case b.replies <- f:
			default:
			}
		case extPush:
			select {
			case b.Pushes <- f:
			default:
			}
		}
	})
	if err != nil {
		dev.Disconnect()
		return nil, fmt.Errorf("notifications: %w (not paired? bluetoothctl pair %s, PIN on the Minitel)", err, target.String())
	}
	return b, nil
}

func (b *BLE) Close() { b.dev.Disconnect() }

func (b *BLE) write(f []byte) error {
	b.wmu.Lock()
	defer b.wmu.Unlock()
	if os.Getenv("MTL_DEBUG") != "" {
		n := len(f)
		if n > 24 {
			n = 24
		}
		fmt.Fprintf(os.Stderr, "          tx %3d: % x\n", len(f), f[:n])
	}
	_, err := b.rx.WriteWithoutResponse(f)
	return err
}

// Request: one 0xC0 sub frame, then the reply frames of that sub (more: wait for the rest
// while the reply's "more" byte says so, CLI only).
func (b *BLE) Request(sub byte, payload []byte, timeout time.Duration) ([]byte, error) {
	for {
		select {
		case <-b.replies: // stale
			continue
		default:
		}
		break
	}
	f := append([]byte{cmdAppExt, sub}, payload...)
	if err := b.write(f); err != nil {
		return nil, err
	}
	deadline := time.After(timeout)
	for {
		select {
		case r := <-b.replies:
			if r[0] == respErr {
				return nil, errors.New("the node does not know this command (firmware without the Minitel extensions?)")
			}
			if len(r) >= 2 && r[1] == sub {
				return r[2:], nil
			}
		case <-deadline:
			return nil, fmt.Errorf("no reply to %q", sub)
		}
	}
}

// Cli: a USB CLI command run over BLE (slide, saver, hist keep, screen, ui state).
func (b *BLE) Cli(cmd string) (string, error) {
	r, err := b.Request('C', []byte(cmd), 5*time.Second)
	if err != nil {
		return "", err
	}
	var out strings.Builder
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
				if len(f) >= 3 && f[1] == 'C' {
					next = f[2:]
				}
			case <-time.After(3 * time.Second):
				return out.String(), errors.New("reply cut short")
			}
		}
		r = next
	}
	return out.String(), nil
}
