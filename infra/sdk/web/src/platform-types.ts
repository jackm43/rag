export type TraceSummary = {
  traceId: string;
  root?: string;
  service?: string;
  actor?: string;
  spans?: number | string;
  durationMs?: number | string;
  status?: string;
  error?: string;
};

export type TraceSpan = {
  spanId: string;
  parentSpanId: string;
  service: string;
  name: string;
  kind: string;
  start: string;
  durationMs: number | string | bigint;
  status: string;
  error: string;
  attributesJson: string;
};

export type ModelInfo = {
  id: string;
  provider: string;
  costIn: number;
  costOut: number;
};

export type ConfigEntry = {
  key: string;
  value?: string;
  defaultValue?: string;
  overridden?: boolean;
};

export type RagInteraction = {
  id: number;
  kind: string;
  channelId: string;
  requesterUsername: string;
  prompt: string;
  responseText: string;
  model: string;
  aiDurationMs: number;
  totalDurationMs: number;
  status: string;
  errorMessage: string;
  createdAt: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ChatStreamChunk =
  | { done: false; delta?: string }
  | {
    done: true;
    content?: string;
    model?: string;
    durationMs?: number | string;
    usage?: Record<string, unknown>;
  };

export type RagbotChatStreamChunk =
  | { done: false; delta: string }
  | {
    done: true;
    delta: string;
    responseText: string;
    model: string;
    aiDurationMs: number;
    totalDurationMs: number;
  };

export type TraceStreamMessage = {
  traceId: string;
  span?: TraceSpan;
};
