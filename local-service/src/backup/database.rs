//! Full local-database backups (pg_dump custom format) and verified restore.
//!
//! Backups live in `<database_root>/../backups`. Each `zaipos-<unix_ms>.dump`
//! has a `.json` sidecar with its SHA-256 and size. A backup is only listed
//! after `pg_restore --list` has read it back and it contains the sales table.
//! Restore re-verifies the checksum, takes a safety backup of the current
//! database first, and applies the dump in a single transaction.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::provisioning::{ProvisionedDatabase, find_binary};

pub const CHUNK_BYTES: usize = 512 * 1024;
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const OWNER_ROLE: &str = "zaipos_owner_bootstrap";
pub const AUTOMATIC_KIND: &str = "automatic";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BackupError {
    #[error("backup tools are not installed")]
    ToolsMissing,
    #[error("backup name is invalid")]
    InvalidName,
    #[error("backup not found")]
    NotFound,
    #[error("backup failed verification")]
    Corrupt,
    #[error("backup command failed: {0}")]
    Command(String),
    #[error("backup storage failed")]
    Io,
    #[error("upload not found")]
    UnknownUpload,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BackupInfo {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    pub created_at_ms: u64,
    pub kind: String,
}

/// Where and as whom backups connect (the schema owner, so restore can replace objects).
pub struct Connection {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: SecretString,
    pub require_tls: bool,
}

#[derive(Clone)]
pub struct BackupStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for BackupStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupStore")
            .field("dir", &self.inner.dir)
            .finish()
    }
}

struct Inner {
    dir: PathBuf,
    pg_dump: PathBuf,
    pg_restore: PathBuf,
    host: String,
    port: u16,
    database: String,
    user: String,
    sslmode: &'static str,
    password: SecretString,
    lock: Mutex<()>,
    uploads: Mutex<HashMap<String, PathBuf>>,
    job: std::sync::Mutex<serde_json::Value>,
    last_scheduled: std::sync::Mutex<serde_json::Value>,
}

impl BackupStore {
    pub fn new(
        provisioned: &ProvisionedDatabase,
        bin_dir: &Path,
        dir: PathBuf,
    ) -> Result<Self, BackupError> {
        Self::from_parts(
            Connection {
                host: provisioned.socket_host().to_string(),
                port: provisioned.port,
                database: provisioned.database_name.clone(),
                user: OWNER_ROLE.to_string(),
                password: provisioned.credential().clone(),
                require_tls: true,
            },
            bin_dir,
            dir,
        )
    }

    pub fn from_parts(
        connection: Connection,
        bin_dir: &Path,
        dir: PathBuf,
    ) -> Result<Self, BackupError> {
        let pg_dump = find_binary(bin_dir, "pg_dump").ok_or(BackupError::ToolsMissing)?;
        let pg_restore = find_binary(bin_dir, "pg_restore").ok_or(BackupError::ToolsMissing)?;
        fs::create_dir_all(&dir).map_err(|_| BackupError::Io)?;
        Ok(Self {
            inner: Arc::new(Inner {
                dir,
                pg_dump,
                pg_restore,
                host: connection.host,
                port: connection.port,
                database: connection.database,
                user: connection.user,
                sslmode: if connection.require_tls {
                    "require"
                } else {
                    "disable"
                },
                password: connection.password,
                lock: Mutex::new(()),
                uploads: Mutex::new(HashMap::new()),
                job: std::sync::Mutex::new(serde_json::json!({"state": "idle"})),
                last_scheduled: std::sync::Mutex::new(serde_json::Value::Null),
            }),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    pub async fn create(&self) -> Result<BackupInfo, BackupError> {
        let _guard = self.inner.lock.lock().await;
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.create_blocking("manual"))
            .await
            .map_err(|_| BackupError::Io)?
    }

    /// Long operations run in the background (the desktop transport has a
    /// short idle timeout); callers poll `job_status`.
    pub fn start(
        &self,
        kind: &'static str,
        name: Option<String>,
    ) -> Result<serde_json::Value, BackupError> {
        {
            let mut job = self.inner.job.lock().map_err(|_| BackupError::Io)?;
            if job.get("state").and_then(|v| v.as_str()) == Some("running") {
                return Err(BackupError::Command(
                    "another backup or restore is running".into(),
                ));
            }
            *job = serde_json::json!({"state": "running", "kind": kind, "started_at_ms": now_ms()});
        }
        let store = self.clone();
        tokio::spawn(async move {
            let outcome = match (kind, name) {
                ("restore", Some(name)) => store
                    .restore(&name)
                    .await
                    .map(|safety| serde_json::json!({"restored": name, "safety_backup": safety})),
                _ => store.create().await.map(|info| serde_json::json!(info)),
            };
            let status = match outcome {
                Ok(result) => {
                    serde_json::json!({"state": "done", "kind": kind, "result": result, "finished_at_ms": now_ms()})
                }
                Err(error) => {
                    serde_json::json!({"state": "failed", "kind": kind, "error": error.to_string(), "finished_at_ms": now_ms()})
                }
            };
            if let Ok(mut job) = store.inner.job.lock() {
                *job = status;
            }
        });
        self.job_status()
    }

    pub fn job_status(&self) -> Result<serde_json::Value, BackupError> {
        self.inner
            .job
            .lock()
            .map(|job| job.clone())
            .map_err(|_| BackupError::Io)
    }

    pub async fn list(&self) -> Result<Vec<BackupInfo>, BackupError> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.list_blocking())
            .await
            .map_err(|_| BackupError::Io)?
    }

    /// Reads `CHUNK_BYTES` from `offset`; returns (bytes, total size).
    pub async fn read_chunk(&self, name: &str, offset: u64) -> Result<(Vec<u8>, u64), BackupError> {
        let path = self.inner.backup_path(name)?;
        tokio::task::spawn_blocking(move || {
            let mut file = fs::File::open(&path).map_err(|_| BackupError::NotFound)?;
            let total = file.metadata().map_err(|_| BackupError::Io)?.len();
            file.seek(SeekFrom::Start(offset.min(total)))
                .map_err(|_| BackupError::Io)?;
            let mut buffer = vec![0u8; CHUNK_BYTES];
            let mut read = 0;
            while read < CHUNK_BYTES {
                let n = file
                    .read(&mut buffer[read..])
                    .map_err(|_| BackupError::Io)?;
                if n == 0 {
                    break;
                }
                read += n;
            }
            buffer.truncate(read);
            Ok((buffer, total))
        })
        .await
        .map_err(|_| BackupError::Io)?
    }

    pub async fn import_begin(&self) -> Result<String, BackupError> {
        let id = random_hex(16)?;
        let path = self.inner.dir.join(format!(".upload-{id}.part"));
        fs::File::create(&path).map_err(|_| BackupError::Io)?;
        self.inner.uploads.lock().await.insert(id.clone(), path);
        Ok(id)
    }

    pub async fn import_chunk(
        &self,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, BackupError> {
        let path = self
            .inner
            .uploads
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or(BackupError::UnknownUpload)?;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|_| BackupError::Io)?;
        let length = file.metadata().map_err(|_| BackupError::Io)?.len();
        if length != offset {
            return Err(BackupError::Command("upload chunks out of order".into()));
        }
        if length + bytes.len() as u64 > MAX_IMPORT_BYTES {
            return Err(BackupError::Command("backup file is too large".into()));
        }
        file.write_all(bytes).map_err(|_| BackupError::Io)?;
        Ok(length + bytes.len() as u64)
    }

    pub async fn import_finish(&self, id: &str) -> Result<BackupInfo, BackupError> {
        let path = self
            .inner
            .uploads
            .lock()
            .await
            .remove(id)
            .ok_or(BackupError::UnknownUpload)?;
        let _guard = self.inner.lock.lock().await;
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let result = inner.adopt_file(&path, "imported");
            let _ = fs::remove_file(&path);
            result
        })
        .await
        .map_err(|_| BackupError::Io)?
    }

    /// Takes a backup tagged `automatic`, copies it to the optional mirror
    /// directory (USB disk, network share or synced cloud folder) and prunes
    /// old automatic backups beyond `keep`. Manual/imported/safety backups are
    /// never pruned.
    pub async fn create_automatic(
        &self,
        keep: usize,
        mirror: Option<PathBuf>,
    ) -> Result<BackupInfo, BackupError> {
        let _guard = self.inner.lock.lock().await;
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let info = inner.create_blocking(AUTOMATIC_KIND)?;
            if let Some(mirror) = mirror {
                inner.mirror(&info, &mirror)?;
            }
            let all = inner.list_blocking()?;
            for name in prunable(&all, keep) {
                let _ = fs::remove_file(inner.dir.join(&name));
                let _ = fs::remove_file(inner.dir.join(format!("{name}.json")));
            }
            Ok(info)
        })
        .await
        .map_err(|_| BackupError::Io)?
    }

    /// Runs `create_automatic` whenever the newest automatic backup is older
    /// than `interval`. Checks every 15 minutes so a till that was switched
    /// off overnight still backs up soon after it is turned on.
    pub fn spawn_schedule(&self, interval: Duration, keep: usize, mirror: Option<PathBuf>) {
        let store = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(120)).await;
            loop {
                let due = match store.list().await {
                    Ok(items) => backup_due(&items, now_ms(), interval),
                    Err(_) => true,
                };
                if due {
                    let status = match store.create_automatic(keep, mirror.clone()).await {
                        Ok(info) => {
                            serde_json::json!({"state": "done", "name": info.name, "at_ms": now_ms()})
                        }
                        Err(error) => {
                            eprintln!("scheduled backup failed: {error}");
                            serde_json::json!({"state": "failed", "error": error.to_string(), "at_ms": now_ms()})
                        }
                    };
                    if let Ok(mut last) = store.inner.last_scheduled.lock() {
                        *last = status;
                    }
                }
                tokio::time::sleep(Duration::from_secs(15 * 60)).await;
            }
        });
    }

    /// Outcome of the most recent scheduled backup (for the backups screen).
    pub fn last_scheduled(&self) -> serde_json::Value {
        self.inner
            .last_scheduled
            .lock()
            .map(|v| v.clone())
            .unwrap_or(serde_json::Value::Null)
    }

    /// Restores `name` over the live database. Returns the safety backup taken first.
    pub async fn restore(&self, name: &str) -> Result<BackupInfo, BackupError> {
        let path = self.inner.backup_path(name)?;
        let _guard = self.inner.lock.lock().await;
        let inner = self.inner.clone();
        let name = name.to_string();
        tokio::task::spawn_blocking(move || {
            let expected = inner.read_info(&name)?;
            if sha256_file(&path)? != expected.sha256 {
                return Err(BackupError::Corrupt);
            }
            inner.verify_dump(&path)?;
            let safety = inner.create_blocking("before-restore")?;
            inner.run(
                &inner.pg_restore,
                &[
                    "--clean",
                    "--if-exists",
                    "--single-transaction",
                    "--exit-on-error",
                    "--no-comments",
                    "--dbname",
                    &inner.conninfo(),
                    path.to_str().ok_or(BackupError::Io)?,
                ],
            )?;
            Ok(safety)
        })
        .await
        .map_err(|_| BackupError::Io)?
    }
}

impl Inner {
    fn conninfo(&self) -> String {
        format!(
            "host={} port={} dbname={} user={} sslmode={}",
            self.host, self.port, self.database, self.user, self.sslmode
        )
    }

    fn run(&self, program: &Path, args: &[&str]) -> Result<Vec<u8>, BackupError> {
        let output = Command::new(program)
            .args(args)
            // The password goes through the environment, never argv (visible in process lists).
            .env("PGPASSWORD", self.password.expose_secret())
            .env("PGCONNECT_TIMEOUT", "10")
            .output()
            .map_err(|_| BackupError::ToolsMissing)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let line = stderr
                .lines()
                .find(|l| l.contains("error"))
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>();
            return Err(BackupError::Command(line));
        }
        Ok(output.stdout)
    }

    fn verify_dump(&self, path: &Path) -> Result<(), BackupError> {
        let listing = self
            .run(
                &self.pg_restore,
                &["--list", path.to_str().ok_or(BackupError::Io)?],
            )
            .map_err(|_| BackupError::Corrupt)?;
        let listing = String::from_utf8_lossy(&listing);
        if !listing.contains("TABLE DATA public sales ") {
            return Err(BackupError::Corrupt);
        }
        Ok(())
    }

    fn create_blocking(&self, kind: &str) -> Result<BackupInfo, BackupError> {
        let tmp = self.dir.join(format!(".dump-{}.part", random_hex(8)?));
        let result = self
            .run(
                &self.pg_dump,
                &[
                    "--format=custom",
                    "--compress=6",
                    "--file",
                    tmp.to_str().ok_or(BackupError::Io)?,
                    "--dbname",
                    &self.conninfo(),
                ],
            )
            .and_then(|_| self.adopt_file(&tmp, kind));
        let _ = fs::remove_file(&tmp);
        result
    }

    /// Verifies a dump file and moves it into the store with a checksum sidecar.
    fn adopt_file(&self, file: &Path, kind: &str) -> Result<BackupInfo, BackupError> {
        self.verify_dump(file)?;
        let mut created_at_ms = now_ms();
        let mut name = format!("zaipos-{created_at_ms}.dump");
        while self.dir.join(&name).exists() {
            created_at_ms += 1;
            name = format!("zaipos-{created_at_ms}.dump");
        }
        let info = BackupInfo {
            bytes: fs::metadata(file).map_err(|_| BackupError::Io)?.len(),
            sha256: sha256_file(file)?,
            name: name.clone(),
            created_at_ms,
            kind: kind.to_string(),
        };
        fs::copy(file, self.dir.join(&name)).map_err(|_| BackupError::Io)?;
        if sha256_file(&self.dir.join(&name))? != info.sha256 {
            let _ = fs::remove_file(self.dir.join(&name));
            return Err(BackupError::Corrupt);
        }
        fs::write(
            self.dir.join(format!("{name}.json")),
            serde_json::to_vec(&info).map_err(|_| BackupError::Io)?,
        )
        .map_err(|_| BackupError::Io)?;
        Ok(info)
    }

    /// Copies a verified backup and its sidecar to `mirror`, then re-checks the copy.
    fn mirror(&self, info: &BackupInfo, mirror: &Path) -> Result<(), BackupError> {
        fs::create_dir_all(mirror).map_err(|_| BackupError::Io)?;
        let target = mirror.join(&info.name);
        let part = mirror.join(format!(".{}.part", info.name));
        fs::copy(self.dir.join(&info.name), &part).map_err(|_| BackupError::Io)?;
        if sha256_file(&part)? != info.sha256 {
            let _ = fs::remove_file(&part);
            return Err(BackupError::Corrupt);
        }
        fs::rename(&part, &target).map_err(|_| BackupError::Io)?;
        fs::copy(
            self.dir.join(format!("{}.json", info.name)),
            mirror.join(format!("{}.json", info.name)),
        )
        .map_err(|_| BackupError::Io)?;
        Ok(())
    }

    fn read_info(&self, name: &str) -> Result<BackupInfo, BackupError> {
        let raw =
            fs::read(self.dir.join(format!("{name}.json"))).map_err(|_| BackupError::NotFound)?;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| BackupError::Corrupt)?;
        Ok(BackupInfo {
            name: name.to_string(),
            bytes: value
                .get("bytes")
                .and_then(|v| v.as_u64())
                .ok_or(BackupError::Corrupt)?,
            sha256: value
                .get("sha256")
                .and_then(|v| v.as_str())
                .ok_or(BackupError::Corrupt)?
                .to_string(),
            created_at_ms: value
                .get("created_at_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            kind: value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("manual")
                .to_string(),
        })
    }

    fn list_blocking(&self) -> Result<Vec<BackupInfo>, BackupError> {
        let mut items = Vec::new();
        for entry in fs::read_dir(&self.dir).map_err(|_| BackupError::Io)? {
            let name = entry
                .map_err(|_| BackupError::Io)?
                .file_name()
                .to_string_lossy()
                .to_string();
            if valid_name(&name)
                && let Ok(info) = self.read_info(&name)
            {
                items.push(info);
            }
        }
        items.sort_by_key(|item| std::cmp::Reverse(item.created_at_ms));
        Ok(items)
    }

    fn backup_path(&self, name: &str) -> Result<PathBuf, BackupError> {
        if !valid_name(name) {
            return Err(BackupError::InvalidName);
        }
        let path = self.dir.join(name);
        if !path.is_file() {
            return Err(BackupError::NotFound);
        }
        Ok(path)
    }
}

/// Automatic backups beyond the newest `keep` (oldest first). Other kinds are kept.
pub fn prunable(items: &[BackupInfo], keep: usize) -> Vec<String> {
    let mut automatic: Vec<&BackupInfo> =
        items.iter().filter(|i| i.kind == AUTOMATIC_KIND).collect();
    automatic.sort_by_key(|i| std::cmp::Reverse(i.created_at_ms));
    automatic
        .into_iter()
        .skip(keep.max(1))
        .map(|i| i.name.clone())
        .collect()
}

/// True when no backup of any kind was taken within `interval`.
pub fn backup_due(items: &[BackupInfo], now_ms: u64, interval: Duration) -> bool {
    let newest = items.iter().map(|i| i.created_at_ms).max();
    match newest {
        None => true,
        Some(at) => now_ms.saturating_sub(at) >= interval.as_millis() as u64,
    }
}

pub fn valid_name(name: &str) -> bool {
    name.strip_prefix("zaipos-")
        .and_then(|rest| rest.strip_suffix(".dump"))
        .is_some_and(|digits| {
            !digits.is_empty() && digits.len() <= 20 && digits.bytes().all(|b| b.is_ascii_digit())
        })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> Result<String, BackupError> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| BackupError::Io)?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}

fn sha256_file(path: &Path) -> Result<String, BackupError> {
    let mut file = fs::File::open(path).map_err(|_| BackupError::NotFound)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| BackupError::Io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{AUTOMATIC_KIND, BackupInfo, backup_due, prunable, valid_name};
    use std::time::Duration;

    fn info(name: &str, at: u64, kind: &str) -> BackupInfo {
        BackupInfo {
            name: name.into(),
            bytes: 1,
            sha256: "x".into(),
            created_at_ms: at,
            kind: kind.into(),
        }
    }

    #[test]
    fn prunes_only_old_automatic_backups() {
        let items = vec![
            info("zaipos-1.dump", 1, AUTOMATIC_KIND),
            info("zaipos-2.dump", 2, "manual"),
            info("zaipos-3.dump", 3, AUTOMATIC_KIND),
            info("zaipos-4.dump", 4, AUTOMATIC_KIND),
            info("zaipos-5.dump", 5, "before-restore"),
        ];
        assert_eq!(prunable(&items, 2), vec!["zaipos-1.dump".to_string()]);
        assert!(prunable(&items, 10).is_empty());
        // keep is never zero: the newest automatic backup always survives
        assert_eq!(prunable(&items, 0).len(), 2);
    }

    #[test]
    fn schedule_is_due_when_no_recent_backup() {
        let day = Duration::from_secs(86_400);
        assert!(backup_due(&[], 10, day));
        let items = vec![info("zaipos-1.dump", 1_000, "manual")];
        assert!(!backup_due(&items, 1_000 + 3_600_000, day));
        assert!(backup_due(&items, 1_000 + 86_400_000, day));
    }

    #[test]
    fn only_store_names_are_accepted() {
        assert!(valid_name("zaipos-1791650503123.dump"));
        assert!(!valid_name("../zaipos-1.dump"));
        assert!(!valid_name("zaipos-.dump"));
        assert!(!valid_name("zaipos-12a.dump"));
        assert!(!valid_name("zaipos-1.dump.json"));
        assert!(!valid_name("/etc/passwd"));
    }
}
