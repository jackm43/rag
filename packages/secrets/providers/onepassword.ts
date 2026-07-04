import type { Client, Item, ItemField } from "@1password/sdk";

import type { SecretsEnv as Env } from "../env";
import { errorMessage, logger } from "@rag/logger";
import type { SecretsProvider } from "../types";

// onepassword: resolves an "op://<vault>/<item>/<field>" reference via the
// official 1Password JavaScript SDK using a service account token. Everything
// fails closed (unconfigured backend, malformed reference, SDK error, missing
// item/field -> null).
//
// Reads use the SDK's native secret-reference resolver. Writes update the
// existing item: resolve vault title -> vault id, item title -> item id, then
// replace the field value or append a concealed field. The vault/item must
// already exist.

type ParsedRef = { vault: string; item: string; section?: string; field: string };

type OnePasswordSdk = typeof import("@1password/sdk");

const parseRef = (ref: string): ParsedRef | null => {
  if (!ref.startsWith("op://")) {
    return null;
  }
  const parts = ref.slice("op://".length).split("/");
  const [vault, item, ...fieldParts] = parts;
  if (!vault || !item || fieldParts.length === 0) {
    return null;
  }
  const field = fieldParts.at(-1);
  if (!field) {
    return null;
  }
  const section = fieldParts.length > 1 ? fieldParts.slice(0, -1).join("/") : undefined;
  return { vault, item, section, field };
};

const newConcealedField = (title: string, value: string, sectionId?: string): ItemField => ({
  id: "",
  title,
  sectionId,
  fieldType: "Concealed" as ItemField["fieldType"],
  value,
});

export const onepasswordProvider = (env: Env): SecretsProvider => {
  const token = env.OP_SERVICE_ACCOUNT_TOKEN;
  let clientPromise: Promise<Client> | null = null;

  const sdkClient = async (): Promise<Client | null> => {
    if (!token) {
      return null;
    }
    clientPromise ??= import("@1password/sdk").then((sdk: OnePasswordSdk) =>
      sdk.createClient({
        auth: token,
        integrationName: "ragbot",
        integrationVersion: "1.0.0",
      }),
    );
    return clientPromise;
  };

  const resolveItem = async (client: Client, parsed: ParsedRef): Promise<Item | null> => {
    const vaults = await client.vaults.list({ decryptDetails: true });
    const vault = vaults.find((candidate) => candidate.title === parsed.vault);
    if (!vault) {
      return null;
    }
    const items = await client.items.list(vault.id, {
      type: "ByState",
      content: { active: true, archived: false },
    });
    const overview = items.find((candidate) => candidate.title === parsed.item);
    return overview ? client.items.get(vault.id, overview.id) : null;
  };

  const fieldMatches = (item: Item, parsed: ParsedRef, field: ItemField): boolean => {
    if (field.title !== parsed.field && field.id !== parsed.field) {
      return false;
    }
    if (!parsed.section) {
      return true;
    }
    const section = item.sections.find((candidate) => candidate.id === field.sectionId);
    return section?.title === parsed.section || section?.id === parsed.section;
  };

  return {
    get: async (ref) => {
      if (!parseRef(ref)) {
        return null;
      }
      const client = await sdkClient();
      if (!client) {
        return null;
      }
      try {
        const value = await client.secrets.resolve(ref);
        return value.length > 0 ? value : null;
      } catch (error) {
        logger.warn("onepassword_read_failed", { error: errorMessage(error) });
        return null;
      }
    },
    set: async (ref, value) => {
      const parsed = parseRef(ref);
      if (!parsed) {
        throw new Error("onepassword_set_misconfigured");
      }
      const client = await sdkClient();
      if (!client) {
        throw new Error("onepassword_set_misconfigured");
      }
      const item = await resolveItem(client, parsed);
      if (!item) {
        throw new Error("onepassword_set_item_unresolved");
      }
      const sectionId = parsed.section
        ? item.sections.find((section) => section.title === parsed.section || section.id === parsed.section)?.id
        : undefined;
      const existing = item.fields.find((field) => fieldMatches(item, parsed, field));
      const fields = existing
        ? item.fields.map((field) => (field === existing ? { ...field, value } : field))
        : [...item.fields, newConcealedField(parsed.field, value, sectionId)];
      await client.items.put({ ...item, fields });
    },
    configured: () => Boolean(token),
  };
};
