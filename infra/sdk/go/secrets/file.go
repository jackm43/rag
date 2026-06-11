package secrets

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	FileProvider        = "file"
	fileReferencePrefix = "file://"
)

type File struct {
	Root string
}

func DefaultFile() (*File, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return &File{Root: filepath.Join(home, ".config", "platy", "secrets")}, nil
}

func (f *File) Name() string {
	return FileProvider
}

func (f *File) Reference(name string) string {
	return fileReferencePrefix + name
}

func (f *File) Store(ctx context.Context, name, body string) (string, error) {
	path, err := f.path(name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	return f.Reference(name), nil
}

func (f *File) Resolve(ctx context.Context, reference string) (string, error) {
	name, ok := strings.CutPrefix(reference, fileReferencePrefix)
	if !ok {
		return "", fmt.Errorf("reference %q is not a %s reference", reference, fileReferencePrefix)
	}
	path, err := f.path(name)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", reference, err)
	}
	return string(data), nil
}

func (f *File) path(name string) (string, error) {
	cleaned := filepath.Clean(filepath.FromSlash(name))
	if cleaned == "." || strings.HasPrefix(cleaned, "..") || filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("invalid secret name %q", name)
	}
	return filepath.Join(f.Root, cleaned), nil
}
