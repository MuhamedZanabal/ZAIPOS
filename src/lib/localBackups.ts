import { localDispatch } from "@/backend/local-client";

export interface LocalBackup { name: string; bytes: number; sha256: string; created_at_ms: number; kind: string }
export interface BackupJob { state: "idle" | "running" | "done" | "failed"; kind?: string; error?: string; result?: unknown }

const call = async <T,>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const { data, error } = await localDispatch(`/v1/admin/backups/${action}`, payload);
  if (error) throw new Error(error.message);
  return data as T;
};

export const isLocalBackupAvailable = () => typeof window !== "undefined" && typeof window.electron?.localRequest === "function";
export const listBackups = () => call<LocalBackup[]>("list");
export const backupJobStatus = () => call<BackupJob>("status");
export const startBackup = () => call<BackupJob>("create");
export const startRestore = (name: string) => call<BackupJob>("restore", { name, confirm: "RESTORE" });

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Downloads a backup in chunks; the result is byte-identical (checked against its SHA-256). */
export async function downloadBackup(backup: LocalBackup, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await call<{ data: string; next: number; total: number; done: boolean }>("read", { name: backup.name, offset });
    parts.push(fromBase64(chunk.data));
    offset = chunk.next;
    onProgress?.(offset, chunk.total);
    if (chunk.done) break;
  }
  const blob = new Blob(parts as BlobPart[], { type: "application/octet-stream" });
  const digest = await sha256Hex(await blob.arrayBuffer());
  if (digest !== backup.sha256) throw new Error("Downloaded backup failed its checksum; try again");
  return blob;
}

/** Uploads a backup file to the server; the server verifies it before listing it. */
export async function uploadBackup(file: Blob, onProgress?: (done: number, total: number) => void): Promise<LocalBackup> {
  const { upload_id } = await call<{ upload_id: string }>("import-begin");
  const size = file.size;
  const chunk = 384 * 1024; // base64 keeps each request well under the 1 MiB limit
  let offset = 0;
  while (offset < size) {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer());
    const { next } = await call<{ next: number }>("import-chunk", { upload_id, offset, data: toBase64(bytes) });
    offset = next;
    onProgress?.(offset, size);
  }
  return call<LocalBackup>("import-finish", { upload_id });
}

export async function sha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  // Copy into this realm's Uint8Array (Blob buffers can come from another realm).
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(new Uint8Array(buffer as ArrayBuffer)));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
