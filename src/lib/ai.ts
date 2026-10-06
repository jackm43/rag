// Model request and response shapes for Chat Completions, Responses and Workers AI. No Ragbot logic.
import { isObject } from "./json.ts";

export type ApiFormat = "chat-completions" | "responses";
export type Tool = { name: string; description: string; parameters: object };
export type ToolCall = { name: string; args: Record<string, any> };

/** OpenAI reasoning models reject sampling controls such as temperature. */
export const rejectsSampling = (model: string) => /^openai\/(?:gpt-[5-9]|o[1-9])/.test(model);

export function chatRequest(
  apiFormat: ApiFormat,
  messages: object[],
  { tools = [], reasoningEffort, temperature }: { tools?: Tool[]; reasoningEffort?: string; temperature?: number },
) {
  const responses = apiFormat === "responses";
  const body: Record<string, unknown> = responses ? { input: messages } : { messages };
  if (tools.length) {
    body.tools = tools.map((tool) => (responses ? { type: "function", ...tool } : { type: "function", function: tool }));
  }
  if (reasoningEffort && responses) body.reasoning = { effort: reasoningEffort };
  if (reasoningEffort && !responses) body.reasoning_effort = reasoningEffort;
  if (temperature !== undefined) body.temperature = temperature;
  return body;
}

export function chatResponse(payload: any, requestedModel: string) {
  const usage = isObject(payload?.usage) ? payload.usage : {};
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  const prompt = count(usage.prompt_tokens ?? usage.input_tokens);
  const completion = count(usage.completion_tokens ?? usage.output_tokens);
  return {
    content: text(payload),
    toolCalls: toolCalls(payload),
    model: typeof payload?.model === "string" && payload.model ? payload.model : requestedModel,
    usage: {
      prompt,
      completion,
      total: count(usage.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null),
    },
  };
}

function text(payload: any): string {
  if (typeof payload === "string") return payload;
  if (typeof payload?.output_text === "string" && payload.output_text) return payload.output_text;
  if (Array.isArray(payload?.output) && payload.output.length) {
    return payload.output
      .filter((output: any) => output.type === "message")
      .flatMap((output: any) => output.content ?? [])
      .filter((part: any) => part.type === "output_text")
      .map((part: any) => part.text)
      .join("\n\n");
  }
  if (typeof payload?.response === "string") return payload.response;
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

// Arguments arrive as JSON text.
function toolCalls(payload: any): ToolCall[] {
  const calls: any[] = [
    ...(payload?.choices?.[0]?.message?.tool_calls ?? []).map((call: any) => call.function),
    ...(Array.isArray(payload?.output) ? payload.output.filter((output: any) => output.type === "function_call") : []),
    ...(Array.isArray(payload?.tool_calls) ? payload.tool_calls : []),
  ];
  return calls.flatMap((call) => {
    try {
      const args = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : call?.arguments;
      return typeof call?.name === "string" && isObject(args) ? [{ name: call.name, args }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The image in a text-to-image result: the bytes or stream themselves, or a base64, data URI or
 * URL string, possibly nested under `result`.
 */
export function imageOutput(result: any): ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string {
  if (result instanceof ReadableStream || result instanceof ArrayBuffer || ArrayBuffer.isView(result)) return result;
  for (let depth = 0; depth < 3; depth++) {
    const candidates = [result, result?.image, result?.data?.[0]?.b64_json, result?.data?.[0]?.url];
    const value = candidates.find((candidate) => typeof candidate === "string" && candidate);
    if (value) return value;
    result = result?.result;
  }
  throw new Error("missing image output");
}
