use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use secrecy::{ExposeSecret, SecretString};
use thiserror::Error;

const POSTGRESQL_CONF_TEMPLATE: &str =
    include_str!("../../../installer/postgres/postgresql.conf.template");
const PG_HBA_CONF_TEMPLATE: &str = include_str!("../../../installer/postgres/pg_hba.conf.template");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresPolicy {
    pub postgresql_conf: String,
    pub pg_hba_conf: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProvisionError {
    #[error("postgres port is not allowed")]
    InvalidPort,
    #[error("postgres policy template is unsafe")]
    UnsafePolicy,
    #[error("postgres binaries are not installed")]
    BinariesMissing,
    #[error("postgres provisioning failed")]
    CommandFailed,
    #[error("postgres credential file is unsafe")]
    UnsafeCredential,
}

pub struct ProvisionedDatabase {
    pub port: u16,
    pub database_name: String,
    credential: SecretString,
    socket_host: String,
}

impl std::fmt::Debug for ProvisionedDatabase {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProvisionedDatabase")
            .field("port", &self.port)
            .field("database_name", &self.database_name)
            .field("credential", &"<redacted>")
            .field("socket_host", &self.socket_host)
            .finish()
    }
}

impl ProvisionedDatabase {
    pub fn socket_host(&self) -> &str {
        &self.socket_host
    }

    pub fn credential(&self) -> &SecretString {
        &self.credential
    }
}

pub struct PostgresProvisioner {
    database_root: PathBuf,
    port: u16,
    bin_dir: Option<PathBuf>,
}

impl PostgresProvisioner {
    pub fn new(database_root: impl Into<PathBuf>, port: u16) -> Self {
        Self {
            database_root: database_root.into(),
            port,
            bin_dir: None,
        }
    }

    pub fn with_bin_dir(mut self, bin_dir: impl Into<PathBuf>) -> Self {
        self.bin_dir = Some(bin_dir.into());
        self
    }

    pub async fn ensure_cluster(&self) -> Result<ProvisionedDatabase, ProvisionError> {
        let policy = render_postgres_policy(self.port)?;
        fs::create_dir_all(&self.database_root).map_err(|_| ProvisionError::CommandFailed)?;
        let credential = generate_password()?;
        write_private(
            &self.database_root.join("zaipos_service.secret"),
            credential.expose_secret().as_bytes(),
        )?;
        fs::write(
            self.database_root.join("postgresql.conf"),
            &policy.postgresql_conf,
        )
        .map_err(|_| ProvisionError::CommandFailed)?;
        fs::write(self.database_root.join("pg_hba.conf"), &policy.pg_hba_conf)
            .map_err(|_| ProvisionError::CommandFailed)?;
        if policy.postgresql_conf.contains(credential.expose_secret())
            || policy.pg_hba_conf.contains(credential.expose_secret())
        {
            return Err(ProvisionError::UnsafeCredential);
        }
        let Some(initdb) = find_binary(self.bin_dir.as_deref(), "initdb") else {
            return Err(ProvisionError::BinariesMissing);
        };
        let data_dir = self.database_root.join("data");
        if !data_dir.join("PG_VERSION").exists() {
            let status = Command::new(&initdb)
                .arg("-D")
                .arg(&data_dir)
                .arg("-U")
                .arg("zaipos_owner_bootstrap")
                .arg("--auth-local=reject")
                .arg("--auth-host=scram-sha-256")
                .arg("--pwfile")
                .arg(self.database_root.join("zaipos_service.secret"))
                .status()
                .map_err(|_| ProvisionError::CommandFailed)?;
            if !status.success() {
                return Err(ProvisionError::CommandFailed);
            }
        }
        install_policy(&data_dir, &policy)?;
        Ok(ProvisionedDatabase {
            port: self.port,
            database_name: "zaipos".to_string(),
            credential,
            socket_host: "127.0.0.1".to_string(),
        })
    }
}

pub fn render_postgres_policy(port: u16) -> Result<PostgresPolicy, ProvisionError> {
    if port < 1024 {
        return Err(ProvisionError::InvalidPort);
    }
    let postgresql_conf = POSTGRESQL_CONF_TEMPLATE.replace("__ZAIPOS_PORT__", &port.to_string());
    let pg_hba_conf = PG_HBA_CONF_TEMPLATE.to_string();
    let rendered = PostgresPolicy {
        postgresql_conf,
        pg_hba_conf,
    };
    if !rendered
        .postgresql_conf
        .contains("listen_addresses = '127.0.0.1'")
        || rendered.postgresql_conf.contains("0.0.0.0")
        || rendered.postgresql_conf.contains('*')
        || rendered.pg_hba_conf.contains("0.0.0.0/0")
        || rendered.pg_hba_conf.contains(" trust")
        || rendered.pg_hba_conf.contains("\ttrust")
        || !rendered
            .pg_hba_conf
            .contains("hostssl zaipos zaipos_service 127.0.0.1/32 scram-sha-256")
    {
        return Err(ProvisionError::UnsafePolicy);
    }
    Ok(rendered)
}

fn generate_password() -> Result<SecretString, ProvisionError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ProvisionError::CommandFailed)?;
    let encoded = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(SecretString::from(encoded))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ProvisionError> {
    if path.exists() {
        return Err(ProvisionError::UnsafeCredential);
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| ProvisionError::UnsafeCredential)?;
    file.write_all(bytes)
        .map_err(|_| ProvisionError::UnsafeCredential)?;
    Ok(())
}

fn install_policy(data_dir: &Path, policy: &PostgresPolicy) -> Result<(), ProvisionError> {
    fs::write(data_dir.join("postgresql.conf"), &policy.postgresql_conf)
        .map_err(|_| ProvisionError::CommandFailed)?;
    fs::write(data_dir.join("pg_hba.conf"), &policy.pg_hba_conf)
        .map_err(|_| ProvisionError::CommandFailed)?;
    Ok(())
}

fn find_binary(bin_dir: Option<&Path>, name: &str) -> Option<PathBuf> {
    if let Some(dir) = bin_dir {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_postgres_policy_is_loopback_and_scram_only() {
        let rendered = render_postgres_policy(55432).unwrap();
        assert!(
            rendered
                .postgresql_conf
                .contains("listen_addresses = '127.0.0.1'")
        );
        assert!(
            rendered
                .pg_hba_conf
                .contains("hostssl zaipos zaipos_service 127.0.0.1/32 scram-sha-256")
        );
        assert!(!rendered.pg_hba_conf.contains("0.0.0.0/0"));
        assert!(!rendered.pg_hba_conf.contains(" trust"));
    }

    #[test]
    fn privileged_ports_are_rejected() {
        assert!(matches!(
            render_postgres_policy(80),
            Err(ProvisionError::InvalidPort)
        ));
        assert!(matches!(
            render_postgres_policy(0),
            Err(ProvisionError::InvalidPort)
        ));
    }
}
