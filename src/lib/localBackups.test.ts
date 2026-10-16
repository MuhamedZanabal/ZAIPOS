import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, Uint8Array>();
let uploading: number[] = [];
vi.mock("@/backend/local-client", () => ({
  localDispatch: vi.fn(async (path: string, payload: any) => {
    const action = path.split("/").pop();
    if (action === "read") {
      const all = store.get(payload.name)!;
      const slice = all.subarray(payload.offset, payload.offset + 4);
      const next = payload.offset + slice.length;
      return { data: { data: btoa(String.fromCharCode(...slice)), next, total: all.length, done: next >= all.length }, error: null };
    }
    if (action === "import-begin") { uploading = []; return { data: { upload_id: "u1" }, error: null }; }
    if (action === "import-chunk") {
      if (payload.offset !== uploading.length) return { data: null, error: { message: "out of order" } };
      for (const c of atob(payload.data)) uploading.push(c.charCodeAt(0));
      return { data: { next: uploading.length }, error: null };
    }
    if (action === "import-finish") return { data: { name: "zaipos-2.dump", bytes: uploading.length, sha256: "x", created_at_ms: 2, kind: "imported" }, error: null };
    return { data: null, error: { message: "unexpected" } };
  }),
}));

import { downloadBackup, sha256Hex, uploadBackup } from "./localBackups";

describe("local backups client", () => {
  beforeEach(() => store.clear());

  it("downloads in chunks and checks the SHA-256", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    store.set("zaipos-1.dump", bytes);
    const sha256 = await sha256Hex(bytes);
    const blob = await downloadBackup({ name: "zaipos-1.dump", bytes: 10, sha256, created_at_ms: 1, kind: "manual" });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    await expect(downloadBackup({ name: "zaipos-1.dump", bytes: 10, sha256: "0".repeat(64), created_at_ms: 1, kind: "manual" }))
      .rejects.toThrow(/checksum/);
  });

  it("uploads a file in ordered chunks", async () => {
    const bytes = new Uint8Array(1_000_000).map((_, i) => i % 251);
    const info = await uploadBackup(new Blob([bytes]));
    expect(info.bytes).toBe(1_000_000);
    expect(uploading.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });
});
