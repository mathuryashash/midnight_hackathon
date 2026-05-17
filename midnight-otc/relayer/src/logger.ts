import pino, { type Logger } from "pino";
import { Writable } from "stream";

const isDev = process.env.NODE_ENV !== "production";

function createBaseLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";

  if (isDev) {
    try {
      return pino({
        name: "midnight-otc",
        level,
        redact: ["req.headers.authorization", "req.headers.cookie"],
        transport: {
          target: "pino-pretty",
          options: { destination: 2 },
        },
      });
    } catch {
    }
  }

  return pino({
    name: "midnight-otc",
    level,
    redact: ["req.headers.authorization", "req.headers.cookie"],
    transport: {
      target: "pino/file",
      options: { destination: 2 },
    },
  });
}

export const logger: Logger = createBaseLogger();

export function createLogger(name: string): Logger {
  return logger.child({ module: name });
}
