type LogData = Record<string, unknown>;

const emit = (level: "debug" | "info" | "warn" | "error", message: string, data?: LogData) => {
  const line = JSON.stringify({ level, message, ...data });
  if (level === "debug") {
    console.debug(line);
    return;
  }
  if (level === "info") {
    console.info(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.error(line);
};

export const logger = {
  debug: (message: string, data?: LogData) => emit("debug", message, data),
  info: (message: string, data?: LogData) => emit("info", message, data),
  warn: (message: string, data?: LogData) => emit("warn", message, data),
  error: (message: string, data?: LogData) => emit("error", message, data),
};

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Deliberately narrow: stacks and enumerable error properties can embed
// upstream response bodies (which may carry prompts or secrets), so only
// the error's name/message and its cause's name/message are logged. Call
// sites log their own structured context (model, profile, lengths).
export const errorDetails = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    ...(error.cause !== undefined
      ? {
        cause:
          error.cause instanceof Error
            ? { name: error.cause.name, message: error.cause.message }
            : { message: String(error.cause) },
      }
      : {}),
  };
};
