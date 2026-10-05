// The admin API client and the shapes it returns.
export type Target = "live" | "sandbox";
export type Page = string;

export type ChatSettings = {
  model: string;
  prompt: string;
  temperature: number;
  historyLimit: number;
  reasoningEffort?: string;
  [key: string]: unknown;
};
export type ImageProfile = { model: string; gatewayId?: string; parameters: Record<string, string> };
export type Settings = {
  revision: string;
  updatedAt?: string;
  chat: ChatSettings;
  image: { activeProfile: string; profiles: Record<string, ImageProfile> };
};
export type Draft = Pick<Settings, "chat" | "image">;
export type Saved = { target: Target; revision: string; settings: Settings };

export type CommandOption = { type: number; name: string; description: string; required?: boolean; min_length?: number; max_length?: number };
export type Command = { name: string; description: string; options: CommandOption[]; adminOnly: boolean; requiredRoleId: string | null };
export type Meta = {
  user: string;
  defaults: { userId: string; username: string; globalName: string; channelId: string };
  applicationId: string;
  guildId: string;
  commands: Command[];
};

type Range = { minimum: number; maximum: number };
export type ParameterSpec = { enum?: string[]; default?: string; type?: string };
export type ChatModel = { id: string; name: string; provider: string; temperature: Range | null };
export type ImageModel = { id: string; name: string; provider: string; parameters: Record<string, ParameterSpec> };
export type Catalog = { chat: ChatModel[]; image: ImageModel[]; checkedAt: number };

export type Attachment = { name: string; contentType: string; bytes: number; dataUrl?: string };
export type Reply = { id: string; content: string; attachments: Attachment[] };
export type Exchange = { model: string; settingsRevision: string | null; request: unknown; response?: unknown; error?: string; durationMs: number };
export type Result = {
  durationMs: number;
  ai: Exchange[];
  calls: unknown[];
  logs: { level: string; message: string }[];
  db: unknown;
  message?: { id: string; content: string };
  interaction?: unknown;
  replies?: Reply[];
  edits?: Reply[];
  followUps?: Reply[];
  channelMessages?: Reply[];
};
export type HistoryEntry = {
  id: number;
  kind: string;
  prompt: string;
  response_text: string | null;
  model: string;
  status: string;
  requester_username: string | null;
  created_at: string;
};

export const targetName = (target: Target) => (target === "live" ? "Live bot" : "Sandbox");

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `/api/${path}`,
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json", "x-ragbot-ui": "1" }, body: JSON.stringify(body) },
    );
  } catch {
    // An expired Access session redirects the request to the sign-in page, which fetch cannot follow.
    throw new Error("Lost the connection or the Access session expired. Reload the page to sign in again.");
  }
  if (response.status === 403 && !response.headers.get("content-type")?.includes("json")) {
    throw new Error("Cloudflare Access did not accept this session. Reload the page to sign in again.");
  }
  const result: any = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error ?? `The admin API returned HTTP ${response.status}.`);
  return result;
}

export const snowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) | BigInt(Math.floor(Math.random() * 4096)));

// Small per-browser conveniences: the simulated identity, conversations and unsent text.
export function remembered<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(`ragbot-admin:${key}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(`ragbot-admin:${key}`, JSON.stringify(value));
  } catch {
    // Storage is optional.
  }
}
