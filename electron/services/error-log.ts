/**
 * Local structured error log (JSON lines) with size-based rotation. Nothing
 * leaves the machine; the owner can export a diagnostics bundle from Settings.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LogEntry { ts: string; level: 'info' | 'warn' | 'error'; message: string; source?: string; context?: Record<string, unknown> }

const SECRET_KEY = /token|password|passcode|secret|authori[sz]ation|cookie|pin|cpr|card/i;
const MAX_STRING = 2000;

/** Drops credentials and bounds sizes so the log is safe to share. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export class RotatingLog {
  private readonly file: string;
  constructor(private readonly dir: string, private readonly maxBytes = 1024 * 1024, private readonly keep = 5, private readonly name = 'zaipos-errors') {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.log`);
  }

  files(): string[] {
    const list = [this.file];
    for (let i = 1; i <= this.keep; i++) list.push(path.join(this.dir, `${this.name}.${i}.log`));
    return list.filter((f) => fs.existsSync(f));
  }

  private rotate(): void {
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : path.join(this.dir, `${this.name}.${i - 1}.log`);
      const to = path.join(this.dir, `${this.name}.${i}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  }

  append(entry: LogEntry): void {
    const line = `${JSON.stringify(redact(entry))}\n`;
    try {
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size + line.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      // Logging must never crash the till.
    }
  }

  /** Most recent entries first, across rotated files. */
  recent(limit = 500): LogEntry[] {
    const out: LogEntry[] = [];
    for (const f of this.files()) {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').reverse();
      for (const l of lines) {
        if (!l) continue;
        try { out.push(JSON.parse(l)); } catch { /* skip torn line */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

/** Validates a renderer-reported error before it is written. */
export function rendererErrorEntry(value: unknown): LogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.message !== 'string' || !v.message.trim()) return null;
  return {
    ts: new Date().toISOString(), level: 'error', source: 'renderer',
    message: v.message.slice(0, 500),
    context: { stack: typeof v.stack === 'string' ? v.stack.slice(0, 4000) : undefined, route: typeof v.route === 'string' ? v.route.slice(0, 200) : undefined },
  };
}

export function diagnosticsBundle(log: RotatingLog, info: Record<string, unknown>): string {
  return JSON.stringify({ generatedAt: new Date().toISOString(), info: redact(info), entries: log.recent(1000) }, null, 2);
}
