package main

// USB: the node's local CLI on its USB serial port (/dev/ttyACM0 for the XIAO), for the
// commands that do not need BLE (slides, saver, hist keep). Each command ends with a line
// "  OK" or "  ERR ...". The node echoes what it is sent.

import (
	"errors"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type USB struct{ f *os.File }

func OpenUSB(path string) (*USB, error) {
	f, err := os.OpenFile(path, os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return nil, err
	}
	t, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	if err != nil {
		f.Close()
		return nil, err
	}
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB | unix.CBAUD
	t.Cflag |= unix.CS8 | unix.B115200 | unix.CLOCAL | unix.CREAD
	t.Cc[unix.VMIN] = 0
	t.Cc[unix.VTIME] = 1 // reads return after 100 ms
	if err := unix.IoctlSetTermios(int(f.Fd()), unix.TCSETS, t); err != nil {
		f.Close()
		return nil, err
	}
	u := &USB{f: f}
	u.drain()
	return u, nil
}

func (u *USB) drain() {
	buf := make([]byte, 4096)
	for {
		n, _ := u.f.Read(buf)
		if n <= 0 {
			return
		}
	}
}

func (u *USB) Close() { u.f.Close() }

func (u *USB) Cli(cmd string) (string, error) {
	u.drain()
	if _, err := u.f.Write([]byte(cmd + "\r")); err != nil {
		return "", err
	}
	var got strings.Builder
	buf := make([]byte, 4096)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		n, _ := u.f.Read(buf)
		got.Write(buf[:n])
		s := got.String()
		if i := strings.Index(s, "  OK\r\n"); i >= 0 || strings.Contains(s, "  ERR") && strings.HasSuffix(s, "\n") {
			s = strings.TrimPrefix(s, cmd) // the echo
			return strings.ReplaceAll(s, "\r", ""), nil
		}
	}
	return got.String(), errors.New("no OK from the node")
}
