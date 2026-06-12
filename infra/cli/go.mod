module jsmunro.me/platy/cli

go 1.25.0

require (
	connectrpc.com/connect v1.20.0
	github.com/cloudflare/cloudflare-go/v6 v6.10.0
	github.com/spf13/cobra v1.10.2
	golang.org/x/sync v0.21.0
	google.golang.org/protobuf v1.36.11
	gopkg.in/yaml.v3 v3.0.1
	jsmunro.me/platy/applications v0.0.0
	jsmunro.me/platy/sdk v0.0.0
)

require (
	github.com/1password/onepassword-sdk-go v0.4.0 // indirect
	github.com/dylibso/observe-sdk/go v0.0.0-20240828172851-9145d8ad07e1 // indirect
	github.com/extism/go-sdk v1.7.1 // indirect
	github.com/gobwas/glob v0.2.3 // indirect
	github.com/ianlancetaylor/demangle v0.0.0-20251118225945-96ee0021ea0f // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	github.com/tetratelabs/wabin v0.0.0-20230304001439-f6f874872834 // indirect
	github.com/tetratelabs/wazero v1.11.0 // indirect
	github.com/tidwall/gjson v1.14.4 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
	go.opentelemetry.io/proto/otlp v1.9.0 // indirect
	golang.org/x/oauth2 v0.30.0 // indirect
	golang.org/x/sys v0.40.0 // indirect
)

replace (
	jsmunro.me/platy/applications => ../applications
	jsmunro.me/platy/sdk => ../sdk/go
)
