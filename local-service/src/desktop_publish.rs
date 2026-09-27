//! Publish only the files a logged-in desktop user is allowed to read.
//!
//! Database secrets, TLS private keys, and raw service errors stay private.
//! Windows ACEs use well-known SIDs so a localized account name cannot miss.

use std::fs;
use std::path::Path;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceNotice {
    DatabaseStarting,
    Ready,
    PostgresProvisioningFailed,
    DatabaseConnectionFailed,
    MigrationFailed,
    TlsFailed,
    ProfileFailed,
    RuntimeFailed,
}

impl ServiceNotice {
    pub fn code(self) -> &'static str {
        match self {
            Self::DatabaseStarting => "DATABASE_STARTING",
            Self::Ready => "READY",
            Self::PostgresProvisioningFailed => "POSTGRES_PROVISIONING_FAILED",
            Self::DatabaseConnectionFailed => "DATABASE_CONNECTION_FAILED",
            Self::MigrationFailed => "MIGRATION_FAILED",
            Self::TlsFailed => "TLS_FAILED",
            Self::ProfileFailed => "PROFILE_FAILED",
            Self::RuntimeFailed => "RUNTIME_FAILED",
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PublishError {
    #[error("desktop publish failed")]
    Io,
    #[error("desktop acl failed")]
    Acl,
}

#[derive(Serialize)]
struct NoticeFile {
    code: &'static str,
}

/// Map a runtime error onto a fixed code. The original text is never written.
pub fn notice_from_runtime_error(message: &str) -> ServiceNotice {
    if message.starts_with("PostgreSQL provisioning failed") {
        ServiceNotice::PostgresProvisioningFailed
    } else if message.starts_with("owner database connection failed")
        || message.starts_with("service database connection failed")
        || message.starts_with("database readiness failed")
        || message.starts_with("local database compatibility failed")
        || message.starts_with("local identity initialization failed")
    {
        ServiceNotice::DatabaseConnectionFailed
    } else if message.starts_with("migration chain failed")
        || message.starts_with("migration manifest rejected")
    {
        ServiceNotice::MigrationFailed
    } else if message.starts_with("TLS ") {
        ServiceNotice::TlsFailed
    } else if message.starts_with("server profile") {
        ServiceNotice::ProfileFailed
    } else {
        ServiceNotice::RuntimeFailed
    }
}

pub fn publish_notice(root: &Path, notice: ServiceNotice) -> Result<(), PublishError> {
    let directory = root.join("desktop");
    fs::create_dir_all(&directory).map_err(|_| PublishError::Io)?;
    let path = directory.join("server-status.json");
    let bytes = serde_json::to_vec(&NoticeFile {
        code: notice.code(),
    })
    .map_err(|_| PublishError::Io)?;
    fs::write(&path, bytes).map_err(|_| PublishError::Io)?;
    // The installer grants Users read on this directory and its future files.
    // A failed icacls call must not hide a status file that inheritance already published.
    match publish_desktop_readable(&path) {
        Ok(()) => Ok(()),
        Err(PublishError::Acl) if cfg!(windows) => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn publish_desktop_readable(path: &Path) -> Result<(), PublishError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|_| PublishError::Io)?
            .permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(path, permissions).map_err(|_| PublishError::Io)?;
        Ok(())
    }
    #[cfg(windows)]
    {
        grant_users(path, "*S-1-5-32-545:R")
    }
}

/// Let interactive users open a known file under the service root.
/// The ACE is not inherited, so secrets created in this directory stay private.
pub fn grant_desktop_traverse(root: &Path) -> Result<(), PublishError> {
    #[cfg(unix)]
    {
        let _ = root;
        Ok(())
    }
    #[cfg(windows)]
    {
        grant_users(root, "*S-1-5-32-545:(X)")
    }
}

#[cfg(windows)]
fn grant_users(path: &Path, ace: &str) -> Result<(), PublishError> {
    let status = std::process::Command::new("icacls.exe")
        .arg(path)
        .arg("/grant:r")
        .arg(ace)
        .arg("/Q")
        .arg("/C")
        .status()
        .map_err(|_| PublishError::Acl)?;
    if status.success() {
        Ok(())
    } else {
        Err(PublishError::Acl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_and_migration_failures_stay_bounded() {
        assert_eq!(
            notice_from_runtime_error("migration chain failed: password=hidden"),
            ServiceNotice::MigrationFailed
        );
        assert_eq!(
            notice_from_runtime_error("TLS configuration failed"),
            ServiceNotice::TlsFailed
        );
        assert_eq!(
            notice_from_runtime_error("server profile write failed: denied"),
            ServiceNotice::ProfileFailed
        );
        assert_eq!(
            notice_from_runtime_error("configuration rejected: unsafe service root"),
            ServiceNotice::RuntimeFailed
        );
        assert_eq!(
            notice_from_runtime_error(
                "PostgreSQL provisioning failed: postgres://zaipos_service:supersecret@127.0.0.1/zaipos"
            ),
            ServiceNotice::PostgresProvisioningFailed
        );
    }

    #[cfg(unix)]
    #[test]
    fn published_notice_is_readable_and_does_not_expose_a_sibling_secret() {
        use std::os::unix::fs::PermissionsExt;
        let notice = ServiceNotice::PostgresProvisioningFailed;
        let root = std::env::temp_dir().join(format!("zaipos-notice-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        publish_notice(&root, notice).unwrap();
        let text = fs::read_to_string(root.join("desktop").join("server-status.json")).unwrap();
        assert_eq!(text, "{\"code\":\"POSTGRES_PROVISIONING_FAILED\"}");
        assert!(!text.to_ascii_lowercase().contains("secret"));
        let mode = fs::metadata(root.join("desktop").join("server-status.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o644);

        let secret = root.join("zaipos_service.secret");
        fs::write(&secret, b"ab").unwrap();
        let mut permissions = fs::metadata(&secret).unwrap().permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&secret, permissions).unwrap();
        publish_notice(&root, ServiceNotice::DatabaseStarting).unwrap();
        let secret_mode = fs::metadata(&secret).unwrap().permissions().mode() & 0o777;
        assert_eq!(secret_mode, 0o600);
        let _ = fs::remove_dir_all(&root);
    }
}
