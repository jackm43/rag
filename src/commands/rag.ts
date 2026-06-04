import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  DISCORD_API_BASE_URL,
  type DiscordInteraction,
  type Env,
} from "../types";
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

type InteractionMessageData = {
  content: string;
  allowed_mentions?: {
    parse?: string[];
    users?: string[];
  };
};

const RECENT_ROAST_LOOKBACK = 30;
// The /rag response is deferred and edited in via webhook (valid ~15 min), so we
// can afford several generous attempts rather than racing Discord's 3s deadline.
const ROAST_ATTEMPTS = 3;
const ROAST_TIMEOUT_MS = 6000;

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

const getTargetUsername = async (interaction: DiscordInteraction, env: Env, targetId: string) => {
  const targetUser = interaction.data?.resolved?.users?.[targetId] ?? interaction.resolved?.users?.[targetId];
  if (targetUser?.username) {
    return targetUser.username;
  }

  try {
    const response = await fetch(`${DISCORD_API_BASE_URL}/users/${targetId}`, {
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    const user = (await response.json()) as { username?: string };
    return user.username ?? null;
  } catch {
    return null;
  }
};

const sanitizeDisplayName = (value: string) =>
  value
    .replace(/<@!?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim() || "someone";

// Returns a cleaned roast line, or null when the model output can't be made
// safe/usable. Callers decide what to do with null (retry or fall back).
const sanitizeRoastLine = (line: string, targetDisplayName: string): string | null => {
  const noMentions = line
    .replace(/<@!?\d+>/g, "")
    .replace(/@/g, "")
    .replace(/\d[\d_ -]{5,}\d/g, targetDisplayName)
    .replace(/\b\d{17,20}\b/g, targetDisplayName)
    .replace(/\s+/g, " ")
    .trim();

  if (!noMentions || /\d{6,}/.test(noMentions)) {
    return null;
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
  `${reporterDisplayName} hit the rag button so fast that ${targetDisplayName} barely had time to mess up.`,
  `${targetDisplayName} earned another tally, and ${reporterDisplayName} is clearly the unofficial scorekeeper.`,
  `${reporterDisplayName} reports, ${targetDisplayName} delivers, and the leaderboard just keeps eating.`,
  `Somewhere a siren went off, and sure enough ${targetDisplayName} did the thing while ${reporterDisplayName} watched.`,
  `${targetDisplayName} is collecting rags like trading cards, with ${reporterDisplayName} sponsoring the whole set.`,
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

  // Hold onto the most recent usable model line so that even if every attempt
  // collides with a recent roast we still return the LLM's words rather than a
  // canned fallback. The fallback pool is a last resort for total model failure.
  let lastModelLine: string | null = null;

  for (let attempt = 0; attempt < ROAST_ATTEMPTS; attempt += 1) {
    let sanitized: string | null = null;
    try {
      const aiResult = await withTimeout(
        env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [
            {
              role: "system",
              content:
                "You are a sharp, inventive roast writer for a Discord 'rag' bot. Write ONE original roast sentence under 140 characters teasing both people by display name. Be creative and specific: vary your imagery, reach for unexpected comparisons, and never settle for generic or formulaic phrasing. Plain text only, exactly one sentence. Never include @ mentions, Discord IDs, tags, or handles. Be playful and a little mean, never genuinely cruel.",
            },
            {
              role: "user",
              content: `Reporter display name: ${reporterDisplayName}. Reporter has filed ${reporterCount} rag reports total. Reported user display name: ${targetDisplayName}. Reported user has been ragged ${targetCount} times total. Write one punchy, original line teasing both by display name only. Do not reuse or closely paraphrase any of these previous roast lines: ${blockedList}.`,
            },
          ],
          max_tokens: 64,
          temperature: 0.95,
        }),
        ROAST_TIMEOUT_MS,
      );

      const text = (aiResult as AiTextResponse).response?.trim();
      sanitized = text ? sanitizeRoastLine(text.slice(0, 180), targetDisplayName) : null;
    } catch {
      // Timeout or model error on this attempt; keep trying the next one.
    }

    if (!sanitized) {
      continue;
    }

    lastModelLine = sanitized;
    if (!recentRoasts.has(normalizeRoastText(sanitized))) {
      return sanitized;
    }
  }

  return lastModelLine ?? pickFallbackRoast(reporterDisplayName, targetDisplayName, recentRoasts);
};

const editOriginalInteractionResponse = async (
  interaction: DiscordInteraction,
  data: InteractionMessageData,
) => {
  if (!interaction.application_id || !interaction.token) {
    throw new Error("missing_interaction_webhook");
  }

  await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    },
  );
};

const buildRagCommandResponseData = async (
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionMessageData> => {
  const invoker = getInvoker(interaction);
  const targetIdValue = interaction.data?.options?.find((opt) => opt.name === "user")?.value;
  const targetId = targetIdValue ? String(targetIdValue) : "";

  if (!targetId) {
    return { content: "A user mention is required." };
  }

  const targetUsername = await getTargetUsername(interaction, env, targetId);
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

  const [total, reporterStats, recentRoastRows] = await Promise.all([
    env.DB.prepare("SELECT rag_count FROM rag_totals WHERE ragged_user_id = ?")
      .bind(targetId)
      .first<RagRow>(),
    env.DB.prepare("SELECT COUNT(*) AS report_count FROM rag_events WHERE reported_by_user_id = ?")
      .bind(invoker.id)
      .first<ReporterRow>(),
    getRecentRoasts(env),
  ]);

  const ragCount = total?.rag_count ?? 1;
  const reporterCount = reporterStats?.report_count ?? 1;
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

  return {
    content: `<@${targetId}> has just ragged. Total: ${ragCount}\n${roastLine}`,
    allowed_mentions: {
      parse: [],
      users: [targetId],
    },
  };
};

export const handleRagCommand = async (interaction: DiscordInteraction, env: Env) =>
  jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: await buildRagCommandResponseData(interaction, env),
  });

export const handleDeferredRagCommand = (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  if (!interaction.application_id || !interaction.token) {
    return handleRagCommand(interaction, env);
  }

  ctx.waitUntil(
    (async () => {
      try {
        await editOriginalInteractionResponse(interaction, await buildRagCommandResponseData(interaction, env));
      } catch {
        await editOriginalInteractionResponse(interaction, {
          content: "Command failed. Try again.",
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
