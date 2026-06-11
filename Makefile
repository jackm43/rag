.PHONY: init

init:
	npm install
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
	go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.20.0
	./infra/scripts/generate.sh
