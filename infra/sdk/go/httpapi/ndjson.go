package httpapi

import (
	"bufio"
	"bytes"
	"io"
)

func ReadNDJSON(reader io.Reader, onLine func([]byte) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 10<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if err := onLine(line); err != nil {
			return err
		}
	}
	return scanner.Err()
}
