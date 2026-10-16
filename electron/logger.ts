export type LogLevel = "info" | "warn" | "error";

type Sink = (entry: { ts: string; level: LogLevel; message: string; source?: string; context?: Record<string, unknown> }) => void;
let sink: Sink | null = null;
/** Routes warn/error lines to the rotating on-disk log as well as the console. */
export function setLogSink(next: Sink | null) { sink = next; }

export function log(level: LogLevel, message: string, context?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ? { context } : {}),
  });
  if (sink && level !== "info") sink({ ts: new Date().toISOString(), level, message, source: "main", ...(context ? { context } : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
