package deploy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"jsmunro.me/platy/cli/internal/manifest"
)

const stateRelativePath = ".platy/deploy-state.json"

type applicationState struct {
	Hash        string    `json:"hash"`
	SecretsHash string    `json:"secrets_hash,omitempty"`
	DeployedAt  time.Time `json:"deployed_at"`
}

type deployState struct {
	Applications map[string]applicationState `json:"applications"`
}

type stateStore struct {
	mu    sync.Mutex
	path  string
	state deployState
}

func loadState(root string) (*stateStore, error) {
	store := &stateStore{
		path:  filepath.Join(root, filepath.FromSlash(stateRelativePath)),
		state: deployState{Applications: map[string]applicationState{}},
	}
	data, err := os.ReadFile(store.path)
	if os.IsNotExist(err) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &store.state); err != nil {
		return nil, err
	}
	if store.state.Applications == nil {
		store.state.Applications = map[string]applicationState{}
	}
	return store, nil
}

func (s *stateStore) hash(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Applications[name].Hash
}

func (s *stateStore) secretsHash(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Applications[name].SecretsHash
}

func (s *stateStore) recordDeploy(name, hash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.state.Applications[name]
	entry.Hash = hash
	entry.DeployedAt = time.Now().UTC()
	s.state.Applications[name] = entry
	return s.persistLocked()
}

func (s *stateStore) recordSecrets(name, hash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.state.Applications[name]
	entry.SecretsHash = hash
	entry.DeployedAt = time.Now().UTC()
	s.state.Applications[name] = entry
	return s.persistLocked()
}

func (s *stateStore) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, append(encoded, '\n'), 0o644)
}

var hashSkipDirs = map[string]bool{
	"node_modules": true,
	".wrangler":    true,
	".git":         true,
}

// computeDeployHash digests worker code and config inputs: the wrangler
// config, worker source, generated application code, and shared TS SDK.
func computeDeployHash(root, name string, app *manifest.Application) (string, error) {
	digest := sha256.New()

	configPath := filepath.Join(root, filepath.FromSlash(app.Config))
	files := map[string]bool{configPath: true}
	excluded := map[string]bool{
		filepath.Join(root, "infra", "applications", name, "metadata.json"): true,
	}
	dirs := []string{
		filepath.Dir(configPath),
		filepath.Join(root, "infra", "applications", name),
		filepath.Join(root, "infra", "sdk", "ts", "src"),
	}
	for _, dir := range dirs {
		if err := collectFiles(dir, files); err != nil {
			return "", err
		}
	}

	paths := make([]string, 0, len(files))
	for path := range files {
		if excluded[path] || filepath.Base(path) == ".dev.vars" {
			continue
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		relative, err := filepath.Rel(root, path)
		if err != nil {
			relative = path
		}
		writeHashField(digest, "file", filepath.ToSlash(relative))
		file, err := os.Open(path)
		if err != nil {
			return "", err
		}
		_, err = io.Copy(digest, file)
		file.Close()
		if err != nil {
			return "", err
		}
		digest.Write([]byte{0})
	}

	return hex.EncodeToString(digest.Sum(nil)), nil
}

func computeSecretsHash(
	resolvedSecrets map[string]string,
	providerOAuth map[string]string,
	serviceClientID string,
) string {
	digest := sha256.New()
	writeHashMap(digest, "secrets", resolvedSecrets)
	writeHashMap(digest, "provider_oauth", providerOAuth)
	writeHashField(digest, "service_client_id", serviceClientID)
	return hex.EncodeToString(digest.Sum(nil))
}

func collectFiles(dir string, files map[string]bool) error {
	info, err := os.Stat(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		files[dir] = true
		return nil
	}
	return filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if hashSkipDirs[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		files[path] = true
		return nil
	})
}

func writeHashField(digest hash.Hash, kind, value string) {
	digest.Write([]byte(kind))
	digest.Write([]byte{0})
	digest.Write([]byte(value))
	digest.Write([]byte{0})
}

func writeHashMap(digest hash.Hash, kind string, values map[string]string) {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		writeHashField(digest, kind, key+"="+values[key])
	}
}

type prefixWriter struct {
	mu     sync.Mutex
	prefix []byte
	buffer []byte
}

func newPrefixWriter(name string) *prefixWriter {
	return &prefixWriter{prefix: []byte("[" + name + "] ")}
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buffer = append(w.buffer, p...)
	for {
		index := bytes.IndexByte(w.buffer, '\n')
		if index < 0 {
			break
		}
		w.writeLine(w.buffer[:index+1])
		w.buffer = w.buffer[index+1:]
	}
	return len(p), nil
}

func (w *prefixWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buffer) == 0 {
		return
	}
	w.writeLine(append(w.buffer, '\n'))
	w.buffer = nil
}

func (w *prefixWriter) writeLine(line []byte) {
	out := make([]byte, 0, len(w.prefix)+len(line))
	out = append(out, w.prefix...)
	out = append(out, line...)
	os.Stderr.Write(out)
}
