// Discord message bodies, interaction webhook writes and mention text.
import { API, discordFetch } from "./rest.ts";

export type Attachment = { name: string; type: string; data: Uint8Array };

/** User, nickname and role mentions: `<@id>`, `<@!id>` and `<@&id>`. */
export const MENTION = /<@([!&]?)([^>\s]+)>/g;

/** A JSON body, or multipart with `payload_json` when files are attached. */
export function messageBody(payload: object, files: Attachment[] = []): RequestInit {
  if (!files.length) return { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  const form = new FormData();
  const attachments = files.map((file, id) => ({ id: String(id), filename: file.name }));
  form.append("payload_json", JSON.stringify({ ...payload, attachments }));
  files.forEach((file, i) => form.append(`files[${i}]`, new Blob([file.data], { type: file.type }), file.name));
  return { body: form };
}

/**
 * Edit an interaction's original response, or post a follow-up. The interaction token in the URL
 * authenticates these routes, so no bot credential is sent.
 */
export function interactionMessage(
  interaction: { application_id: string; token: string },
  payload: object,
  { files = [], followup = false }: { files?: Attachment[]; followup?: boolean } = {},
) {
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}`;
  return discordFetch(followup ? url : `${url}/messages/@original`, {
    ...messageBody(payload, files),
    method: followup ? "POST" : "PATCH",
  });
}

/** The name Discord shows: server nickname, then global name, then username. */
export const displayName = (user: any, nick?: string | null): string =>
  [nick, user.global_name, user.username].find((name) => name?.trim())?.trim() ?? "user";
