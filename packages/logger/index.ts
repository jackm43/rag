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

export const errorDetails = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message } : error.cause,
    properties: Object.fromEntries(
      Object.entries(error).filter(([, value]) => typeof value !== "function"),
    ),
  };
};
