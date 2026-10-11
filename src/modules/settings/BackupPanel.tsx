import { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseBackup, Download, Loader2, RotateCcw, Upload, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  backupJobStatus, downloadBackup, formatBytes, isLocalBackupAvailable, listBackups, startBackup, startRestore, uploadBackup,
  type BackupJob, type LocalBackup,
} from "@/lib/localBackups";
import { translate as tx } from "@/i18n";

const KIND_LABEL: Record<string, string> = { automatic: "Automatic (daily)", manual: "Manual", imported: "Imported file", "before-restore": "Safety copy (before restore)" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full local-database backup and restore (owner/admin, local ZAIPOS server). */
export function BackupPanel() {
  const [backups, setBackups] = useState<LocalBackup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<LocalBackup | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try { setBackups(await listBackups()); } catch (e: any) { toast.error(e?.message ?? "Could not list backups"); }
  }, []);
  useEffect(() => { if (isLocalBackupAvailable()) void refresh(); }, [refresh]);

  if (!isLocalBackupAvailable()) return null;

  const waitForJob = async (): Promise<BackupJob> => {
    for (let i = 0; i < 600; i += 1) {
      await wait(1000);
      try {
        const job = await backupJobStatus();
        if (job.state === "done" || job.state === "failed") return job;
      } catch (e: any) {
        if (/UNAUTHORIZED|401/i.test(String(e?.message))) return { state: "done", kind: "restore-signed-out" };
        // The server may be busy restoring; keep polling.
      }
    }
    throw new Error("Timed out waiting for the server");
  };

  const create = async () => {
    setBusy("create"); setProgress("Creating and verifying backup…");
    try {
      await startBackup();
      const job = await waitForJob();
      if (job.state === "failed") throw new Error(job.error ?? "Backup failed");
      const info = job.result as LocalBackup;
      toast.success(`Backup created and verified · ${formatBytes(info.bytes)}`);
      await refresh();
    } catch (e: any) { toast.error(e?.message ?? "Backup failed"); }
    finally { setBusy(null); setProgress(null); }
  };

  const saveCopy = async (backup: LocalBackup) => {
    setBusy(backup.name);
    try {
      const blob = await downloadBackup(backup, (d, t) => setProgress(`Downloading ${formatBytes(d)} of ${formatBytes(t)}…`));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const at = new Date(backup.created_at_ms);
      const pad = (n: number) => String(n).padStart(2, "0");
      a.download = `ZAIPOS-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.dump`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.success(tx("Backup copy saved (checksum verified)"));
    } catch (e: any) { toast.error(e?.message ?? "Download failed"); }
    finally { setBusy(null); setProgress(null); }
  };

  const importFile = async (file: File) => {
    setBusy("import");
    try {
      const info = await uploadBackup(file, (d, t) => setProgress(`Uploading ${formatBytes(d)} of ${formatBytes(t)}…`));
      toast.success(`Backup file verified and added · ${formatBytes(info.bytes)}`);
      await refresh();
    } catch (e: any) { toast.error(e?.message ?? "That file is not a valid ZAIPOS backup"); }
    finally { setBusy(null); setProgress(null); if (fileInput.current) fileInput.current.value = ""; }
  };

  const restore = async () => {
    if (!restoreTarget || confirmText !== "RESTORE") return;
    const target = restoreTarget;
    setRestoreTarget(null); setConfirmText("");
    setBusy("restore"); setProgress("Restoring… a safety copy of the current data is taken first. Do not close ZAIPOS.");
    try {
      await startRestore(target.name);
      const job = await waitForJob();
      if (job.state === "failed") throw new Error(job.error ?? "Restore failed; your data was not changed");
      toast.success("Restore complete. ZAIPOS will reload; sign in again if asked.", { duration: 15_000 });
      setTimeout(() => window.location.reload(), 2500);
    } catch (e: any) { toast.error(e?.message ?? "Restore failed"); }
    finally { setBusy(null); setProgress(null); }
  };

  return (
    <div className="glass rounded-2xl p-5 flex flex-col gap-4" data-testid="backup-panel">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="orb g-orb-32"><DatabaseBackup size={16} /></div>
          <div>
            <div className="text-sm font-semibold text-ink-900">Full backup &amp; restore</div>
            <div className="h-meta">Complete copy of this ZAIPOS server's database: sales, stock, customers, settings. Each backup is read back and checksummed before it is listed. An automatic backup runs every day (the newest 14 are kept); set ZAIPOS_BACKUP_MIRROR_DIR to also copy each one to a USB disk or network folder.</div>
          </div>
        </div>
        <div className="flex gap-2">
          <input ref={fileInput} type="file" accept=".dump" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
          <Button variant="outline" disabled={!!busy} onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4 mr-2" />{tx("Import backup file")}</Button>
          <Button disabled={!!busy} onClick={() => void create()}>
            {busy === "create" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DatabaseBackup className="h-4 w-4 mr-2" />}Create backup now
          </Button>
        </div>
      </div>
      {progress && <div className="h-meta flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{progress}</div>}
      <div className="flex flex-col divide-y divide-[var(--hairline)]">
        {backups.length === 0 && <div className="h-meta py-3 text-center">{tx("No backups yet")}</div>}
        {backups.map((b) => (
          <div key={b.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="h-4 w-4 text-success" />
              <div>
                <div className="font-medium text-ink-900">{new Date(b.created_at_ms).toLocaleString("en-BH")}</div>
                <div className="h-meta">{KIND_LABEL[b.kind] ?? b.kind} · {formatBytes(b.bytes)} · SHA-256 {b.sha256.slice(0, 12)}…</div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void saveCopy(b)}><Download className="h-4 w-4 mr-1" />{tx("Save copy")}</Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { setConfirmText(""); setRestoreTarget(b); }}><RotateCcw className="h-4 w-4 mr-1" />{tx("Restore…")}</Button>
            </div>
          </div>
        ))}
      </div>
      <Dialog open={!!restoreTarget} onOpenChange={(o) => { if (!o) setRestoreTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tx("Restore this backup?")}</DialogTitle>
            <DialogDescription>
              All current data on this ZAIPOS server will be replaced with the backup from{" "}
              {restoreTarget ? new Date(restoreTarget.created_at_ms).toLocaleString("en-BH") : ""}. Sales made after that time will be removed.
              A safety copy of the current data is taken first, so this can be undone. Other users may need to sign in again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label className="h-meta" htmlFor="restore-confirm">Type RESTORE to confirm</label>
            <Input id="restore-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={confirmText !== "RESTORE"} onClick={() => void restore()}>Restore backup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
