/**
 * Structured JSON logger.
 *
 * Respects LOG_LEVEL env var: "debug" | "info" | "warn" | "error" (default "info").
 * Writes info/debug to stdout, warn/error to stderr.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentLevel(): number {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[env] ?? LEVELS.info;
}

function emit(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVELS[level] < currentLevel()) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };

  const line = JSON.stringify(entry);
  if (level === "warn" || level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) =>
    emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) =>
    emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) =>
    emit("error", msg, data),
};
