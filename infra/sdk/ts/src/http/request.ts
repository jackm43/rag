export const REQUEST_ID_HEADER = "x-request-id";

export interface RequestIdOptions {
  headerName?: string;
  existingRequestId?: string | null;
  generate?: () => string;
}

export function createRequestId(options: RequestIdOptions = {}): string {
  const existing = options.existingRequestId?.trim();
  if (existing) {
    return existing;
  }
  if (options.generate) {
    return options.generate();
  }
  return crypto.randomUUID();
}

export function requestIdHeader(requestId: string, headerName = REQUEST_ID_HEADER): Headers {
  return new Headers([[headerName, requestId]]);
}

