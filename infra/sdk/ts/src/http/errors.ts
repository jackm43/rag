import type { ApiError } from "./types";

export class HttpApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly requestId?: string;

  constructor(error: ApiError) {
    super(error.detail ?? error.title);
    this.name = "HttpApiError";
    this.status = error.status;
    this.code = error.code;
    this.title = error.title;
    this.requestId = error.requestId;
  }

  toApiError(): ApiError {
    return {
      status: this.status,
      code: this.code,
      title: this.title,
      detail: this.message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export function badRequest(detail: string, requestId?: string): HttpApiError {
  return new HttpApiError({
    status: 400,
    code: "bad_request",
    title: "Bad request",
    detail,
    requestId,
  });
}

export function unauthorized(detail = "Authentication is required", requestId?: string): HttpApiError {
  return new HttpApiError({
    status: 401,
    code: "unauthorized",
    title: "Unauthorized",
    detail,
    requestId,
  });
}

export function forbidden(detail = "The caller is not allowed to perform this action", requestId?: string): HttpApiError {
  return new HttpApiError({
    status: 403,
    code: "forbidden",
    title: "Forbidden",
    detail,
    requestId,
  });
}

export function notFound(detail = "The requested resource was not found", requestId?: string): HttpApiError {
  return new HttpApiError({
    status: 404,
    code: "not_found",
    title: "Not found",
    detail,
    requestId,
  });
}

export function methodNotAllowed(detail = "The requested method is not allowed", requestId?: string): HttpApiError {
  return new HttpApiError({
    status: 405,
    code: "method_not_allowed",
    title: "Method not allowed",
    detail,
    requestId,
  });
}

export function internalError(detail = "An internal error occurred", requestId?: string): HttpApiError {
  return new HttpApiError({
    status: 500,
    code: "internal_error",
    title: "Internal error",
    detail,
    requestId,
  });
}

