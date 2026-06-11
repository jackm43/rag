#!/bin/sh
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"
apps="${*:-idp ragbot deploy}"
export PATH="$root/node_modules/.bin:$(go env GOPATH)/bin:$PATH"

for app in $apps; do
  rm -rf "$root/infra/applications/$app/client" "$root/infra/applications/$app/server"
  template=$(cat <<EOF
{
  "version": "v2",
  "managed": {
    "enabled": true,
    "override": [
      {"file_option": "go_package_prefix", "value": "jsmunro.me/platy/applications/$app/client"}
    ]
  },
  "plugins": [
    {"local": "protoc-gen-go", "out": "infra/applications/$app/client", "opt": ["paths=source_relative"]},
    {"local": "protoc-gen-connect-go", "out": "infra/applications/$app/client", "opt": ["paths=source_relative"]},
    {"local": "protoc-gen-es", "out": "infra/applications/$app/server", "opt": ["target=ts"]}
  ]
}
EOF
)
  (cd "$root" && buf generate infra/proto --template "$template" --path "infra/proto/$app")
done
