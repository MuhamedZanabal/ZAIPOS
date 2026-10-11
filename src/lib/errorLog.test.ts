import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticsBundle, redact, rendererErrorEntry, RotatingLog } from "../../electron/services/error-log";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "zaipos-log-"));

describe("rotating error log", () => {
  it("rotates by size and keeps a bounded number of files", () => {
    const dir = tmp();
    const log = new RotatingLog(dir, 300, 2);
    for (let i = 0; i < 40; i++) log.append({ ts: "t", level: "error", message: `boom ${i}` });
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(["zaipos-errors.1.log", "zaipos-errors.2.log", "zaipos-errors.log"]);
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(300);
    expect(log.recent(1)[0].message).toBe("boom 39");
  });

  it("removes credentials before writing", () => {
    const dir = tmp();
    const log = new RotatingLog(dir);
    log.append({ ts: "t", level: "error", message: "auth failed Bearer abc.def.ghi", context: { accessToken: "secret", nested: { password: "p", pin: "1234", ok: 1 } } });
    const text = fs.readFileSync(path.join(dir, "zaipos-errors.log"), "utf8");
    expect(text).not.toMatch(/abc\.def|secret|"p"|1234/);
    expect(text).toContain("[redacted]");
    expect(redact({ cardNumber: "4111" })).toEqual({ cardNumber: "[redacted]" });
  });

  it("validates renderer reports and builds a shareable bundle", () => {
    expect(rendererErrorEntry(null)).toBeNull();
    expect(rendererErrorEntry({ message: "" })).toBeNull();
    const entry = rendererErrorEntry({ message: "x".repeat(900), stack: "at a", route: "#/pos" })!;
    expect(entry.message).toHaveLength(500);
    expect(entry.source).toBe("renderer");
    const dir = tmp();
    const log = new RotatingLog(dir);
    log.append(entry);
    const bundle = JSON.parse(diagnosticsBundle(log, { appVersion: "1.0.0", authorization: "x" }));
    expect(bundle.info).toEqual({ appVersion: "1.0.0", authorization: "[redacted]" });
    expect(bundle.entries).toHaveLength(1);
  });
});
