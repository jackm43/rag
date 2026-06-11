.PHONY: help install generate platy check test vet build-go d1-migrate-local deploy bootstrap app-sync

OP ?= op run --env-file=.env --
APPS ?= idp ragbot deploy
GO_PACKAGES := jsmunro.me/platy/cli/... jsmunro.me/platy/sdk/... jsmunro.me/platy/applications/...

help:
	@echo "Targets:"
	@echo "  install             npm install (via op run)"
	@echo "  generate            regenerate protobuf code for all apps"
	@echo "  generate-<app>      regenerate protobuf code for one app"
	@echo "  platy               build ./platy CLI binary"
	@echo "  check               TypeScript check, go vet, and go build"
	@echo "  test                npm and Go tests"
	@echo "  vet                 go vet on CLI, SDK, and application clients"
	@echo "  build-go            go build on CLI, SDK, and application clients"
	@echo "  d1-migrate-local    apply ragbot and gateway D1 schemas locally"
	@echo "  bootstrap           run platy bootstrap"
	@echo "  app-sync            run platy app sync"
	@echo "  deploy              build platy and deploy all workers"

install:
	$(OP) npm install

generate:
	./infra/scripts/generate.sh $(APPS)

generate-%:
	./infra/scripts/generate.sh $*

platy:
	go build -o platy jsmunro.me/platy/cli

check: vet build-go
	npm run check

test:
	npm test
	go test ./infra/cli/internal/provider/...

vet:
	go vet $(GO_PACKAGES)

build-go:
	go build $(GO_PACKAGES)

d1-migrate-local:
	$(OP) npm run d1:migrate:local
	$(OP) npm run gw:d1:migrate:local

bootstrap: platy
	$(OP) ./platy bootstrap

app-sync: platy
	$(OP) ./platy app sync

deploy: platy
	$(OP) ./platy deploy
