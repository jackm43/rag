package secrets

import "testing"

func TestWorkerSecretName(t *testing.T) {
	if got := WorkerSecretName("ragbot", "DISCORD_BOT_TOKEN"); got != "platy-ragbot-discord-bot-token" {
		t.Fatalf("WorkerSecretName() = %q", got)
	}
}

func TestParseCFSSReference(t *testing.T) {
	storeID, secretName, ok := ParseCFSSReference("cfss://store123/platy-ragbot-discord-bot-token")
	if !ok || storeID != "store123" || secretName != "platy-ragbot-discord-bot-token" {
		t.Fatalf("ParseCFSSReference() = %q %q %v", storeID, secretName, ok)
	}
}

func TestProviderForReference(t *testing.T) {
	if ProviderForReference("op://vault/item/field") != OnePasswordProvider {
		t.Fatal("expected 1password provider")
	}
	if ProviderForReference("cfss://store/secret") != CloudflareSecretsStoreProvider {
		t.Fatal("expected cloudflare secrets store provider")
	}
}
