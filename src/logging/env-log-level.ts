// Env log level helpers normalize log level values from environment variables.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readLoggingConfig } from "./config.js";
import { formatJsonConsoleLine } from "./json-console-line.js";
import { ALLOWED_LOG_LEVELS, type LogLevel, tryParseLogLevel } from "./levels.js";
import { loggingState } from "./state.js";

function formatInvalidLogLevelWarning(message: string): string {
  const override = loggingState.overrideSettings as { consoleStyle?: unknown } | null;
  const style = override?.consoleStyle ?? readLoggingConfig()?.consoleStyle;
  return style === "json" ? formatJsonConsoleLine({ level: "warn", message }) : message;
}

/** Resolves OPENCLAW_LOG_LEVEL once per value, warning only when the invalid value changes. */
export function resolveEnvLogLevelOverride(): LogLevel | undefined {
  const trimmed = normalizeOptionalString(process.env.OPENCLAW_LOG_LEVEL) ?? "";
  if (!trimmed) {
    loggingState.invalidEnvLogLevelValue = null;
    return undefined;
  }
  const parsed = tryParseLogLevel(trimmed);
  if (parsed) {
    loggingState.invalidEnvLogLevelValue = null;
    return parsed;
  }
  if (loggingState.invalidEnvLogLevelValue !== trimmed) {
    loggingState.invalidEnvLogLevelValue = trimmed;
    const message = `[openclaw] Ignoring invalid OPENCLAW_LOG_LEVEL="${trimmed}" (allowed: ${ALLOWED_LOG_LEVELS.join("|")}).`;
    process.stderr.write(`${formatInvalidLogLevelWarning(message)}\n`);
  }
  return undefined;
}
