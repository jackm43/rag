export type RequestLogEvent =
  | "request_started"
  | "request_completed"
  | "request_failed"
  | "request_denied"
  | "identity_boundary"
  | "provider_credential_injected";

export interface StructuredRequestLog {
  event: RequestLogEvent;
  requestId: string;
  method: string;
  path: string;
  status?: number;
  elapsedMs?: number;
  traceId?: string;
  subject?: string;
  actor?: string;
  audience?: string;
  route?: string;
  reason?: string;
  credentialMode?: string;
  provider?: string;
}

export type StructuredLogSink = (log: StructuredRequestLog) => void;

export function consoleStructuredLogSink(log: StructuredRequestLog): void {
  console.log(JSON.stringify(log));
}

export function requestCompletedLog(input: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  startedAt: number;
  traceId?: string;
  subject?: string;
  actor?: string;
  audience?: string;
  route?: string;
}): StructuredRequestLog {
  return {
    event: input.status >= 500 ? "request_failed" : "request_completed",
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    status: input.status,
    elapsedMs: Date.now() - input.startedAt,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    ...(input.route ? { route: input.route } : {}),
  };
}

