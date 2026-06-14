package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
)

type envelope struct {
	Data json.RawMessage `json:"data"`
}

type errorEnvelope struct {
	Errors []struct {
		Detail string `json:"detail"`
		Title  string `json:"title"`
	} `json:"errors"`
}

func WrapData(value any) ([]byte, error) {
	if value == nil {
		return []byte(`{"data":{}}`), nil
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var wrapped bytes.Buffer
	wrapped.WriteString(`{"data":`)
	wrapped.Write(payload)
	wrapped.WriteByte('}')
	return wrapped.Bytes(), nil
}

func UnwrapData(body []byte) (json.RawMessage, error) {
	if len(body) == 0 {
		return json.RawMessage("{}"), nil
	}
	var wrapped envelope
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return nil, fmt.Errorf("decode response envelope: %w", err)
	}
	if len(wrapped.Data) == 0 {
		return json.RawMessage("{}"), nil
	}
	return wrapped.Data, nil
}

func ErrorMessage(body []byte, status int) string {
	var wrapped errorEnvelope
	if err := json.Unmarshal(body, &wrapped); err == nil {
		for _, entry := range wrapped.Errors {
			if entry.Detail != "" {
				return entry.Detail
			}
			if entry.Title != "" {
				return entry.Title
			}
		}
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return fmt.Sprintf("request failed with status %d", status)
	}
	return string(trimmed)
}
