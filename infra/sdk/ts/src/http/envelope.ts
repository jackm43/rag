import type { ApiError, ApiErrorResponse, ApiLink, ApiResponse } from "./types";

export function apiResponse<T>(
  data: T,
  options: { meta?: Record<string, unknown>; links?: ApiLink[] } = {},
): ApiResponse<T> {
  return {
    data,
    ...(options.meta ? { meta: options.meta } : {}),
    ...(options.links ? { _links: options.links } : {}),
  };
}

export function apiError(error: ApiError, meta?: Record<string, unknown>): ApiErrorResponse {
  return {
    errors: [error],
    ...(meta ? { meta } : {}),
  };
}

export function apiErrors(errors: ApiError[], meta?: Record<string, unknown>): ApiErrorResponse {
  return {
    errors,
    ...(meta ? { meta } : {}),
  };
}

