package client

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const endStreamFlag = 0x2

type StreamError struct {
	Code    string
	Message string
}

func (e *StreamError) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func readConnectEnvelope(reader io.Reader) (payload []byte, endStream bool, err error) {
	var flags [1]byte
	if _, err = io.ReadFull(reader, flags[:]); err != nil {
		return nil, false, err
	}
	var lengthBuf [4]byte
	if _, err = io.ReadFull(reader, lengthBuf[:]); err != nil {
		return nil, false, err
	}
	length := binary.BigEndian.Uint32(lengthBuf[:])
	payload = make([]byte, length)
	if _, err = io.ReadFull(reader, payload); err != nil {
		return nil, false, err
	}
	return payload, flags[0]&endStreamFlag != 0, nil
}

func decodeStreamEnd(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	var end struct {
		Error *StreamError `json:"error"`
	}
	if err := json.Unmarshal(payload, &end); err != nil {
		return fmt.Errorf("decode stream end: %w", err)
	}
	if end.Error != nil {
		return end.Error
	}
	return nil
}

func envelopConnectJSON(payload []byte) []byte {
	buf := make([]byte, 5+len(payload))
	buf[0] = 0
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(payload)))
	copy(buf[5:], payload)
	return buf
}

func readConnectStream(reader io.Reader, onMessage func([]byte) error) error {
	for {
		payload, endStream, err := readConnectEnvelope(reader)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if endStream {
			return decodeStreamEnd(payload)
		}
		if err := onMessage(payload); err != nil {
			return err
		}
	}
}
