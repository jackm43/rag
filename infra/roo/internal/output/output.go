package output

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
)

var Logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

func Fail(format string, args ...any) {
	Logger.Error(fmt.Sprintf(format, args...))
	os.Exit(1)
}

func PrintJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		Fail("encode output: %v", err)
	}
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
