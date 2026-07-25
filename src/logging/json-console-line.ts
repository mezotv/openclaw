// Shared JSON console envelope formatting for captured and pre-capture diagnostics.
import type { LogLevel } from "./levels.js";
import { redactSensitiveText } from "./redact.js";
import { formatTimestamp } from "./timestamps.js";

export function formatJsonConsoleLine(params: {
  level: LogLevel;
  message: string;
  subsystem?: string;
  meta?: Record<string, unknown>;
}): string {
  return redactSensitiveText(
    JSON.stringify({
      time: formatTimestamp(new Date(), { style: "long" }),
      level: params.level,
      ...(params.subsystem ? { subsystem: params.subsystem } : {}),
      message: params.message,
      ...params.meta,
    }),
  );
}
