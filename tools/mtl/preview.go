package main

// "mtl slide preview <file>...": a slide on the Minitel now, stored nowhere. It goes
// through the terminal channel (BLE): the node passes the bytes as they are (minus the
// protocol commands, as for stored slides), switches to the slide's mode if needed, and
// puts its own page and the saved 40/80 choice back when the preview ends. A key on the
// Minitel shows the next file; CONNEXION/FIN (or the end of the list) ends it.

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type previewItem struct {
	name string
	cols int
	data []byte
}

func previewItems(files []string, cols string, io ImageOpts) ([]previewItem, error) {
	var items []previewItem
	for _, f := range files {
		switch strings.ToLower(filepath.Ext(f)) {
		case ".vdt", ".mixte":
			data, err := os.ReadFile(f)
			if err != nil {
				return nil, err
			}
			w := 40
			if strings.EqualFold(filepath.Ext(f), ".mixte") {
				w = 80
			}
			items = append(items, previewItem{f, w, data})
			continue
		}
		widths := map[string][]int{"40": {40}, "80": {80}, "both": {40, 80}}[cols]
		if widths == nil {
			return nil, errors.New("-cols: 40, 80 or both")
		}
		for _, w := range widths {
			data, err := slideFile(f, w, io)
			if err != nil {
				return nil, err
			}
			items = append(items, previewItem{fmt.Sprintf("%s (%d col)", f, w), w, data})
		}
	}
	return items, nil
}

func slidePreview(b *BLE, a []string) error {
	fs := flag.NewFlagSet("slide preview", flag.ExitOnError)
	cols := fs.String("cols", "both", "text files: 40, 80 or both")
	hold := fs.Duration("hold", 0, "go on after this long instead of waiting for a key (e.g. 10s)")
	var io ImageOpts
	fs.BoolVar(&io.Dither, "dither", false, "images: error diffusion (photos)")
	fs.BoolVar(&io.Contrast, "contrast", false, "images: stretch to black..white")
	fs.Float64Var(&io.Gamma, "gamma", 1, "images: > 1 brightens the mid tones")
	var files []string
	rest := a
	for len(rest) > 0 {
		fs.Parse(rest)
		rest = fs.Args()
		if len(rest) > 0 {
			files = append(files, rest[0])
			rest = rest[1:]
		}
	}
	if len(files) == 0 {
		return errors.New("usage: slide preview <file.vdt|file.mixte|text>... [-cols 40|80|both] [-hold 10s]")
	}
	items, err := previewItems(files, *cols, io)
	if err != nil {
		return err
	}
	r, err := openTerm(b)
	if err != nil {
		return err
	}
	if len(r) < 4 || r[0] != 0 {
		return errors.New("the Minitel is not ready")
	}
	cur, gen := int(r[1]), r[3]
	defer b.Request('X', nil, 2*time.Second)

	for i, it := range items {
		if len(it.data) > 12288 {
			fmt.Fprintf(os.Stderr, "mtl: note: %s is %d bytes, more than a stored slide may hold (12288)\n", it.name, len(it.data))
		}
		if it.cols != cur { // the slide's mode first
			if _, err := b.Request('M', []byte{byte(it.cols)}, 3*time.Second); err != nil {
				return err
			}
			if gen, err = waitMode(b, it.cols); err != nil {
				return err
			}
			cur = it.cols
		}
		if err := sendGen(b, gen, it.data); err != nil {
			return err
		}
		last := i == len(items)-1
		fmt.Fprintf(os.Stderr, "mtl: %s on the Minitel: %d bytes (%.1f s at 9600 baud); ", it.name, len(it.data), float64(len(it.data))/960)
		if *hold > 0 {
			fmt.Fprintf(os.Stderr, "next in %s\n", *hold)
		} else if last {
			fmt.Fprintln(os.Stderr, "a key on the Minitel ends the preview")
		} else {
			fmt.Fprintln(os.Stderr, "a key on the Minitel for the next one (CONNEXION/FIN ends)")
		}
		ended, err := waitKey(b, *hold)
		if err != nil || ended {
			return err
		}
	}
	return nil
}

// sendGen: all of data, frame by frame, waiting while the Minitel's queue is full
func sendGen(b *BLE, gen byte, data []byte) error {
	for len(data) > 0 {
		n := len(data)
		if n > chunk {
			n = chunk
		}
		f, st, err := sendChunk(b, gen, data[:n])
		if err != nil {
			return err
		}
		if st != 0 {
			return errors.New("the Minitel changed modes during the preview")
		}
		data = data[f.acc:]
		if f.acc == 0 {
			time.Sleep(60 * time.Millisecond)
		}
	}
	return nil
}

func waitMode(b *BLE, cols int) (byte, error) {
	deadline := time.After(8 * time.Second)
	for {
		select {
		case p := <-b.Pushes:
			if len(p) >= 5 && p[1] == 'M' && int(p[2]) == cols {
				return p[4], nil
			}
			if len(p) >= 2 && p[1] == 'X' {
				return 0, errors.New("ended on the Minitel")
			}
		case <-deadline:
			return 0, errors.New("the Minitel did not switch modes")
		}
	}
}

// waitKey: true when the session ended on the Minitel (CONNEXION/FIN)
func waitKey(b *BLE, hold time.Duration) (bool, error) {
	var timeout <-chan time.Time
	if hold > 0 {
		timeout = time.After(hold)
	}
	for {
		select {
		case p := <-b.Pushes:
			if len(p) >= 2 && p[1] == 'X' {
				return true, nil
			}
			if len(p) >= 2 && p[1] == 'K' {
				return false, nil
			}
		case <-timeout:
			return false, nil
		}
	}
}
