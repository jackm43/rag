import { CHANNEL_MESSAGE_WITH_SOURCE, type DiscordInteraction, type Env } from "../types";
import { jsonResponse } from "../http";

type RagRow = {
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

const RECENT_ROAST_LOOKBACK = 30;
const ROAST_ATTEMPTS = 1;
const ROAST_TIMEOUT_MS = 1200;

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

export const handleRagCommand = async (interaction: DiscordInteraction, env: Env) => {
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
