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

for app in $apps; do
  if [ -d "$root/infra/proto/$app" ]; then
    generate_app_tree "$app"
  fi
  (cd "$root/infra/cli" && go run ./cmd/bffgen "$app")
done

if [ $# -eq 0 ]; then
  (cd "$root/infra/cli" && go run ./cmd/bffgen --all)
fi
