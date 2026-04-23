import nacl from "tweetnacl";

interface Env {
  DISCORD_PUBLIC_KEY: string;
  DB: D1Database;
  AI: Ai;
}

type DiscordInteraction = {
  type: number;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string | number | boolean }>;
    resolved?: {
      users?: Record<string, { id: string; username: string; global_name?: string | null }>;
      members?: Record<string, { nick?: string | null }>;
    };
  };
  user?: { id: string; username: string; global_name?: string | null };
  member?: {
    nick?: string | null;
    user?: { id: string; username: string; global_name?: string | null };
  };
  resolved?: {
    users?: Record<string, { id: string; username: string; global_name?: string | null }>;
    members?: Record<string, { nick?: string | null }>;
  };
};

type RagRow = {
  rag_count: number;
};

type RagboardRow = {
  ragged_user_id: string;
  ragged_username: string | null;
  rag_count: number;
};

type ReporterRow = {
  report_count: number;
};

type RoastHistoryRow = {
  roast_text: string;
};

type AiTextResponse = {
  response?: string;
};

const PING = 1;
const APPLICATION_COMMAND = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RECENT_ROAST_LOOKBACK = 30;
const ROAST_ATTEMPTS = 1;
const ROAST_TIMEOUT_MS = 1200;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

const verifyDiscordRequest = async (request: Request, publicKey: string) => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return null;
  }

  const rawBody = await request.text();
  const isValid = nacl.sign.detached.verify(
    new TextEncoder().encode(timestamp + rawBody),
    hexToBytes(signature),
    hexToBytes(publicKey),
  );

  if (!isValid) {
    return null;
  }

  return JSON.parse(rawBody) as DiscordInteraction;
};

const getInvoker = (interaction: DiscordInteraction) => {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) {
    throw new Error("missing_invoker");
  }
  return user;
};

const getInvokerDisplayName = (interaction: DiscordInteraction) => {
  const memberNick = interaction.member?.nick;
  if (memberNick) {
    return memberNick;
  }
  const user = interaction.member?.user ?? interaction.user;
  return user?.global_name ?? user?.username ?? "someone";
};

const getTargetDisplayName = (interaction: DiscordInteraction, targetId: string) => {
  const resolvedMembers = interaction.data?.resolved?.members ?? interaction.resolved?.members;
  const resolvedUsers = interaction.data?.resolved?.users ?? interaction.resolved?.users;

  const memberNick = resolvedMembers?.[targetId]?.nick;
  if (memberNick) {
    return memberNick;
  }
  const user = resolvedUsers?.[targetId];
  if (!user) {
    return "someone";
  }
  return user.global_name ?? user.username;
};

const sanitizeDisplayName = (value: string) =>
  value
    .replace(/<@!?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim() || "someone";

const sanitizeRoastLine = (line: string, reporterDisplayName: string, targetDisplayName: string) => {
  const noMentions = line
    .replace(/<@!?\d+>/g, "")
    .replace(/@/g, "")
    .replace(/\d[\d_ -]{5,}\d/g, targetDisplayName)
    .replace(/\b\d{17,20}\b/g, targetDisplayName)
    .replace(/\s+/g, " ")
    .trim();

  if (!noMentions || /\d{6,}/.test(noMentions)) {
    return `${reporterDisplayName} files rag reports like a full-time job, and ${targetDisplayName} keeps giving the leaderboard free content.`;
  }

  if (!noMentions.endsWith(".") && !noMentions.endsWith("!") && !noMentions.endsWith("?")) {
    return `${noMentions}.`;
  }

  return noMentions;
};

const sanitizeAiText = (value: string) =>
  value
    .replace(/<@!?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim();

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};

const normalizeRoastText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

const getDefaultRoastOptions = (reporterDisplayName: string, targetDisplayName: string) => [
  `${reporterDisplayName} files rag reports like a full-time job, and ${targetDisplayName} keeps giving the leaderboard free content.`,
  `${reporterDisplayName} called it in again, and ${targetDisplayName} is farming rag stats like a speedrun.`,
  `${reporterDisplayName} dropped another rag report while ${targetDisplayName} keeps climbing the hall of shame.`,
];

const pickFallbackRoast = (
  reporterDisplayName: string,
  targetDisplayName: string,
  recentRoasts: Set<string>,
) => {
  const options = getDefaultRoastOptions(reporterDisplayName, targetDisplayName);
  for (const option of options) {
    if (!recentRoasts.has(normalizeRoastText(option))) {
      return option;
    }
  }
  return options[0];
};

const getRecentRoasts = async (env: Env) => {
  const result = await env.DB.prepare(
    "SELECT roast_text FROM rag_roasts ORDER BY id DESC LIMIT ?",
  )
    .bind(RECENT_ROAST_LOOKBACK)
    .run<RoastHistoryRow>();
  return (result.results ?? []).map((row) => row.roast_text).filter((text) => text.length > 0);
};

const storeRoast = async (env: Env, roastText: string) => {
  await env.DB.prepare("INSERT OR IGNORE INTO rag_roasts (roast_text) VALUES (?)").bind(roastText).run();
};

const generateRoast = async (
  env: Env,
  reporterDisplayName: string,
  targetDisplayName: string,
  reporterCount: number,
  targetCount: number,
  recentRoasts: Set<string>,
  recentRoastsForPrompt: string[],
) => {
  const blockedList =
    recentRoastsForPrompt.length > 0
      ? recentRoastsForPrompt.map((line, index) => `${index + 1}. ${line}`).join(" ")
      : "none";

  for (let attempt = 0; attempt < ROAST_ATTEMPTS; attempt += 1) {
    const aiResult = await withTimeout(
      env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "You write one short playful roast sentence for a Discord bot. Output exactly one sentence under 140 characters. Do not repeat phrases or restate the same idea twice. Use plain text only. Never include @ mentions, Discord IDs, tags, or handles. Be a little mean.",
          },
          {
            role: "user",
            content: `Reporter display name: ${reporterDisplayName}. Reporter has filed ${reporterCount} rag reports total. Reported user display name: ${targetDisplayName}. Reported user has been ragged ${targetCount} times total. Write one punchy line teasing both by display name only. Do not reuse or closely paraphrase any of these previous roast lines: ${blockedList}.`,
          },
        ],
        max_tokens: 55,
        temperature: 0.45,
      }),
      ROAST_TIMEOUT_MS,
    );

    const text = (aiResult as AiTextResponse).response?.trim();
    if (!text) {
      continue;
    }

    const sanitized = sanitizeRoastLine(text.slice(0, 180), reporterDisplayName, targetDisplayName);
    const normalized = normalizeRoastText(sanitized);
    if (!recentRoasts.has(normalized)) {
      return sanitized;
    }
  }

  return pickFallbackRoast(reporterDisplayName, targetDisplayName, recentRoasts);
};

const handleRagCommand = async (interaction: DiscordInteraction, env: Env) => {
  const invoker = getInvoker(interaction);
  const targetIdValue = interaction.data?.options?.find((opt) => opt.name === "user")?.value;
  const targetId = targetIdValue ? String(targetIdValue) : "";

  if (!targetId) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A user mention is required." },
    });
  }

  const targetUser = interaction.resolved?.users?.[targetId];
  const targetUsername = targetUser?.username ?? null;
  const reporterDisplayName = sanitizeDisplayName(getInvokerDisplayName(interaction));
  const targetDisplayName = sanitizeDisplayName(getTargetDisplayName(interaction, targetId));

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)",
    ).bind(targetId, targetUsername, invoker.id, invoker.username),
    env.DB.prepare(
      "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP",
    ).bind(targetId, targetUsername),
  ]);

  const total = await env.DB.prepare("SELECT rag_count FROM rag_totals WHERE ragged_user_id = ?")
    .bind(targetId)
    .first<RagRow>();

  const ragCount = total?.rag_count ?? 1;
  const reporterStats = await env.DB.prepare(
    "SELECT COUNT(*) AS report_count FROM rag_events WHERE reported_by_user_id = ?",
  )
    .bind(invoker.id)
    .first<ReporterRow>();
  const reporterCount = reporterStats?.report_count ?? 1;
  const recentRoastRows = await getRecentRoasts(env);
  const recentRoastSet = new Set(recentRoastRows.map((line) => normalizeRoastText(line)));

  let roastLine = pickFallbackRoast(reporterDisplayName, targetDisplayName, recentRoastSet);
  try {
    roastLine = await generateRoast(
      env,
      reporterDisplayName,
      targetDisplayName,
      reporterCount,
      ragCount,
      recentRoastSet,
      recentRoastRows.slice(0, 12),
    );
  } catch { }
  await storeRoast(env, roastLine);

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `<@${targetId}> has just ragged. Total: ${ragCount}\n${roastLine}`,
      allowed_mentions: {
        parse: [],
        users: [targetId],
      },
    },
  });
};

const handleRagboardCommand = async (env: Env) => {
  const result = await env.DB.prepare(
    "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10",
  ).run<RagboardRow>();

  const rows = result.results ?? [];
  if (rows.length === 0) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "No rags have been recorded yet." },
    });
  }

  const lines = rows.map((row, index) => {
    const name = row.ragged_username ? `${row.ragged_username} (<@${row.ragged_user_id}>)` : `<@${row.ragged_user_id}>`;
    return `${index + 1}. ${name} - ${row.rag_count}`;
  });

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `Ragboard\n${lines.join("\n")}` },
  });
};

const handleAiCommand = async (interaction: DiscordInteraction, env: Env) => {
  const promptValue = interaction.data?.options?.find((opt) => opt.name === "prompt")?.value;
  const prompt = typeof promptValue === "string" ? promptValue.trim() : "";

  if (!prompt) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A prompt is required." },
    });
  }

  try {
    const aiResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content:
            "Answer clearly and concisely in plain text. Do not include user mentions, Discord IDs, tags, or handles.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const text = sanitizeAiText((aiResult as AiTextResponse).response ?? "");
    const content = text.length > 0 ? text.slice(0, 1900) : "I could not generate a response.";

    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content,
        allowed_mentions: {
          parse: [],
        },
      },
    });
  } catch {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "AI request failed. Try again." },
    });
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET") {
      return new Response("ok");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) {
      return new Response("Bad request signature", { status: 401 });
    }

    if (interaction.type === PING) {
      return jsonResponse({ type: PING });
    }

    if (interaction.type !== APPLICATION_COMMAND) {
      return jsonResponse({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Unsupported interaction." },
      });
    }

    try {
      const commandName = interaction.data?.name;
      if (commandName === "rag") {
        return handleRagCommand(interaction, env);
      }

      if (commandName === "ragboard") {
        return handleRagboardCommand(env);
      }

      if (commandName === "ai") {
        return handleAiCommand(interaction, env);
      }

      return jsonResponse({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Unknown command." },
      });
    } catch {
      return jsonResponse({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Command failed. Try again." },
      });
    }
  },
};
