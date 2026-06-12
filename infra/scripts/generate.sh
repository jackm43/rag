#!/bin/sh
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"
platy_clients_plugin="$root/infra/tools/protoc-gen-platy-clients"
export PATH="$root/node_modules/.bin:$(go env GOPATH)/bin:$PATH"

build_platy_clients_plugin() {
  (cd "$root/infra/cli" && go build -o "$platy_clients_plugin" ./cmd/protoc-gen-platy-clients)
}
build_platy_clients_plugin

proto_apps() {
  find "$root/infra/proto" -mindepth 1 -maxdepth 1 -type d ! -name platy -exec basename {} \; | sort
}

if [ $# -gt 0 ]; then
  apps="$*"
else
  apps="$(proto_apps | tr '\n' ' ')"
fi

generate_sdk_tree() {
  tree_path=$1
  out_client=$2
  out_server=$3
  go_prefix=$4
  rm -rf "$out_client" "$out_server"
  template=$(cat <<EOF
{
  "version": "v2",
  "managed": {
    "enabled": true,
    "override": [
      {"file_option": "go_package_prefix", "value": "$go_prefix"}
    ]
  },
  "plugins": [
    {"local": "protoc-gen-go", "out": "$out_client", "opt": ["paths=source_relative"]},
    {"local": "protoc-gen-connect-go", "out": "$out_client", "opt": ["paths=source_relative"]},
    {"local": "protoc-gen-es", "out": "$out_server", "opt": ["target=ts"]}
  ]
}
EOF
)
  (cd "$root" && buf generate infra/proto --template "$template" --path "$tree_path")
}

generate_app_tree() {
  app=$1
  tree_path="infra/proto/$app"
  out_client="infra/applications/$app/client"
  out_server="infra/applications/$app/server"
  go_prefix="jsmunro.me/platy/applications/$app/client"
  rm -rf "$out_client" "$out_server"
  template=$(cat <<EOF
{
  "version": "v2",
  "managed": {
    "enabled": true,
    "override": [
      {"file_option": "go_package_prefix", "value": "$go_prefix"}
    ]
  },
  "plugins": [
    {"local": "protoc-gen-go", "out": "$out_client", "opt": ["paths=source_relative"]},
    {"local": "protoc-gen-connect-go", "out": "$out_client", "opt": ["paths=source_relative"]},
    {"local": "protoc-gen-es", "out": "$out_server", "opt": ["target=ts"]},
    {"local": "$platy_clients_plugin", "out": "infra/applications/$app", "opt": ["app=$app", "root=$root"]}
  ]
}
EOF
)
  (cd "$root" && buf generate infra/proto --template "$template" --path "$tree_path")
}

sync_idp_oauth() {
  oauth_go="$root/infra/sdk/proto/client/platy/oauth/v1"
  idp_go="$root/infra/applications/idp/client/platy/oauth/v1"
  if [ -d "$oauth_go" ]; then
    mkdir -p "$idp_go"
    cp "$oauth_go"/*.pb.go "$idp_go/"
  fi
  oauth_ts="$root/infra/sdk/proto/server/platy/oauth/v1"
  idp_ts="$root/infra/applications/idp/server/platy/oauth/v1"
  if [ -d "$oauth_ts" ]; then
    mkdir -p "$idp_ts"
    cp "$oauth_ts"/*_pb.ts "$idp_ts/"
  fi
}

generate_sdk_tree \
  "infra/proto/platy" \
  "infra/sdk/proto/client" \
  "infra/sdk/proto/server" \
  "jsmunro.me/platy/sdk/proto/client"

for app in $apps; do
  if [ -d "$root/infra/proto/$app" ]; then
    generate_app_tree "$app"
    if [ "$app" = "idp" ]; then
      sync_idp_oauth
    fi
  fi
  (cd "$root/infra/cli" && go run ./cmd/bffgen "$app")
done

if [ $# -eq 0 ]; then
  (cd "$root/infra/cli" && go run ./cmd/bffgen --all)
fi
