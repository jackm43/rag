package output

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
)

const Usage = `usage: platy <command>

commands:
  login                                     force a fresh browser login and device-bound gateway session
  logout                                    revoke the gateway session and drop cached tokens
  whoami                                    show the identity the gateway sees
  discover                                  refresh local application metadata from the gateway and list methods
  metadata [app]                            list applications and callable methods from local metadata
  fetch <app>.<Service>.<Method> [-d data]   call an application method (platy fetch <app> --help lists methods)

  app register <name> [--endpoint URL]      register an application from applications.yaml and generate code
  app sync [--prune]                        reconcile every application in applications.yaml with the gateway
  app list                                  list registered applications
  app get <name>                            show one application document
  app delete <name>                         remove an application from the registry
  app rotate-client <name>                  issue a new service credential for an application

  deploy [app...]                           deploy workers from applications.yaml with 1Password secrets

  cloudflare login                          authorize the CLI against Cloudflare (delegated token)
  cloudflare logout                         drop the cached Cloudflare delegated token
  bootstrap [flags]                         bootstrap the identity proxy provider and platform access policies
  manage posture [flags]                    enable or disable device posture requirements for a trust boundary
  manage provider sync                      upload local provider config to the gateway registry
  manage organization sync [flags]          provision trust tier policies and enroll app in Cloudflare

  dev generate [app...]                     regenerate protobuf client and server code
  dev platy                                 build ./platy CLI binary
  dev check                                 go vet, go build, and TypeScript check
  dev test                                  npm and Go tests
  dev install                               npm install
  dev migrate                               apply local D1 schemas for ragbot and gateway
  dev vet                                   go vet on CLI, SDK, and application clients
  dev build-go                              go build on CLI, SDK, and application clients

environment:
  PLATY_GATEWAY_URL                         auth gateway base URL
  CF_OAUTH_CLIENT_ID                        Cloudflare OAuth client id used for delegated tokens
  CLOUDFLARE_API_TOKEN                      API token used only by bootstrap (or pass --cf-api-token)
  CLOUDFLARE_ACCOUNT_ID                     optional account override when the token can access multiple accounts
  ACCESS_TEAM_ID                            optional Zero Trust organization uuid
  ACCESS_TEAM_NAME                          optional Zero Trust team name
  ACCESS_TEAM_DOMAIN                        optional Zero Trust team domain

bootstrap flags:
  --provider                                identity proxy provider (default: cloudflare)
  --cf-api-token                            cloudflare api token or op:// secret reference
  --email-allowlist                         comma separated emails allowed to authenticate
  --account-id                              optional account override when the token can access multiple accounts
  --team-id                                 Zero Trust organization uuid
  --team-name                               Zero Trust team name (subdomain before .cloudflareaccess.com)
  --team-domain                             Zero Trust team domain (https://<team>.cloudflareaccess.com)

manage posture flags:
  --provider                                identity proxy provider (default: cloudflare)
  --enabled                                 true or false
  --api-key                                 provider api token or op:// secret reference
  --team-name                               Zero Trust team name
  --team-domain                             Zero Trust team domain
  --team-id                                 Zero Trust organization uuid
  --account-id                              cloudflare account id`

var Logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

func Fail(format string, args ...any) {
	Logger.Error(fmt.Sprintf(format, args...))
	os.Exit(1)
}

func UsageExit() {
	fmt.Fprintln(os.Stderr, Usage)
	os.Exit(2)
}

func PrintJSON(value any) {
	if err := EncodeJSON(os.Stdout, value); err != nil {
		Fail("encode output: %v", err)
	}
}

func WriteJSONFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	return EncodeJSON(file, value)
}

func EncodeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func PrintLines(lines ...string) {
	for _, line := range lines {
		fmt.Fprintln(os.Stdout, line)
	}
}
