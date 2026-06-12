package output

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
)

var Logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

func Fail(format string, args ...any) {
	Logger.Error(fmt.Sprintf(format, args...))
	os.Exit(1)
}

func PrintJSON(value any) {
	if err := EncodeJSON(os.Stdout, value); err != nil {
		Fail("encode output: %v", err)
	}
}

func WriteJSONFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	return EncodeJSON(file, value)
}

func EncodeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func PrintLines(lines ...string) {
	for _, line := range lines {
		fmt.Fprintln(os.Stdout, line)
	}
}

func PrintStreamText(text string) {
	if text == "" {
		return
	}
	if _, err := os.Stdout.WriteString(text); err != nil {
		Fail("write output: %v", err)
	}
}
