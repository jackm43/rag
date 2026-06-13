GOBIN ?= $(shell go env GOPATH)/bin

.PHONY: all platy roo install clean init

all: platy roo

platy:
	go build -o platy jsmunro.me/platy/cli

roo:
	go build -o roo jsmunro.me/platy/roo

install:
	go install jsmunro.me/platy/roo
	go install jsmunro.me/platy/cli
	mv $(GOBIN)/cli $(GOBIN)/platy

clean:
	rm -f platy roo

init:
	npm install
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
	go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.20.0
	./infra/scripts/generate.sh
