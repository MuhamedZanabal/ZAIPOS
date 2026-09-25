use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use rcgen::{CertifiedKey, generate_simple_self_signed};
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use sqlx::{Connection, PgConnection, Row};
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
    #[error("postgres TLS material is invalid")]
    Tls,
}

pub struct ProvisionedDatabase {
    pub port: u16,
    pub database_name: String,
    credential: SecretString,
    socket_host: String,
    pub data_dir: PathBuf,
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    pub certificate_fingerprint: String,
}

impl std::fmt::Debug for ProvisionedDatabase {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProvisionedDatabase")
            .field("port", &self.port)
            .field("database_name", &self.database_name)
            .field("credential", &"<redacted>")
            .field("socket_host", &self.socket_host)
            .field("data_dir", &self.data_dir)
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

    pub fn service_url(&self) -> String {
        format!(
            "postgres://zaipos_service:{}@{}:{}/{}?sslmode=require",
            self.credential.expose_secret(),
            self.socket_host,
            self.port,
            self.database_name
        )
    }

    pub fn owner_url(&self, database: &str) -> String {
        format!(
            "postgres://zaipos_owner_bootstrap:{}@{}:{}/{}?sslmode=require",
            self.credential.expose_secret(),
            self.socket_host,
            self.port,
            database
        )
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
        let credential_path = self.database_root.join("zaipos_service.secret");
        let credential = if credential_path.exists() {
            let value = fs::read_to_string(&credential_path)
                .map_err(|_| ProvisionError::UnsafeCredential)?;
            if !is_hex_secret(value.trim()) {
                return Err(ProvisionError::UnsafeCredential);
            }
            SecretString::from(value.trim().to_string())
        } else {
            let generated = generate_password()?;
            write_private(&credential_path, generated.expose_secret().as_bytes())?;
            generated
        };
        fs::write(
            self.database_root.join("postgresql.conf"),
            &policy.postgresql_conf,
        )
        .map_err(|_| ProvisionError::CommandFailed)?;
        fs::write(self.database_root.join("pg_hba.conf"), &policy.pg_hba_conf)
            .map_err(|_| ProvisionError::CommandFailed)?;

        let bin_dir = resolve_bin_dir(self.bin_dir.as_deref())?;
        let initdb = find_binary(&bin_dir, "initdb").ok_or(ProvisionError::BinariesMissing)?;
        let pg_ctl = find_binary(&bin_dir, "pg_ctl").ok_or(ProvisionError::BinariesMissing)?;
        let data_dir = self.database_root.join("data");
        let (cert_path, key_path, certificate_fingerprint) =
            ensure_tls_material(&self.database_root)?;

        if !data_dir.join("PG_VERSION").exists() {
            let status = Command::new(&initdb)
                .arg("-D")
                .arg(&data_dir)
                .arg("-U")
                .arg("zaipos_owner_bootstrap")
                .arg("--auth-local=reject")
                .arg("--auth-host=scram-sha-256")
                .arg("--pwfile")
                .arg(&credential_path)
                .status()
                .map_err(|_| ProvisionError::CommandFailed)?;
            if !status.success() {
                return Err(ProvisionError::CommandFailed);
            }
        }

        install_policy(&data_dir, &policy)?;
        fs::copy(&cert_path, data_dir.join("server.crt")).map_err(|_| ProvisionError::Tls)?;
        fs::copy(&key_path, data_dir.join("server.key")).map_err(|_| ProvisionError::Tls)?;
        restrict_key(&data_dir.join("server.key"))?;
        start_cluster(&pg_ctl, &data_dir, &self.database_root.join("postgres.log"))?;

        let provisioned = ProvisionedDatabase {
            port: self.port,
            database_name: "zaipos".to_string(),
            credential,
            socket_host: "127.0.0.1".to_string(),
            data_dir,
            cert_path,
            key_path,
            certificate_fingerprint,
        };
        bootstrap_roles_and_database(&provisioned).await?;
        Ok(provisioned)
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

fn resolve_bin_dir(explicit: Option<&Path>) -> Result<PathBuf, ProvisionError> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        let bundled = parent.join("postgres").join("bin");
        if find_binary(&bundled, "initdb").is_some() {
            return Ok(bundled);
        }
    }
    let path = std::env::var_os("PATH").ok_or(ProvisionError::BinariesMissing)?;
    for directory in std::env::split_paths(&path) {
        if find_binary(&directory, "initdb").is_some() {
            return Ok(directory);
        }
    }
    Err(ProvisionError::BinariesMissing)
}

fn find_binary(bin_dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = bin_dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    let executable = bin_dir.join(format!("{name}.exe"));
    executable.is_file().then_some(executable)
}

fn generate_password() -> Result<SecretString, ProvisionError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ProvisionError::CommandFailed)?;
    Ok(SecretString::from(
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    ))
}

fn is_hex_secret(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn ensure_tls_material(root: &Path) -> Result<(PathBuf, PathBuf, String), ProvisionError> {
    let cert_path = root.join("server.crt");
    let key_path = root.join("server.key");
    if !cert_path.exists() || !key_path.exists() {
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()])
                .map_err(|_| ProvisionError::Tls)?;
        fs::write(&cert_path, cert.pem()).map_err(|_| ProvisionError::Tls)?;
        write_private(&key_path, signing_key.serialize_pem().as_bytes())?;
    }
    restrict_key(&key_path)?;
    let pem = fs::read_to_string(&cert_path).map_err(|_| ProvisionError::Tls)?;
    let compact = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    let der = decode_base64(&compact).ok_or(ProvisionError::Tls)?;
    let fingerprint = Sha256::digest(&der)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((cert_path, key_path, fingerprint))
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for byte in value.bytes() {
        if byte == b'=' {
            break;
        }
        let index = TABLE.iter().position(|candidate| *candidate == byte)? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(output)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ProvisionError> {
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
        .map_err(|_| ProvisionError::UnsafeCredential)
}

fn restrict_key(path: &Path) -> Result<(), ProvisionError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| ProvisionError::Tls)?;
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}

fn install_policy(data_dir: &Path, policy: &PostgresPolicy) -> Result<(), ProvisionError> {
    fs::write(data_dir.join("postgresql.conf"), &policy.postgresql_conf)
        .map_err(|_| ProvisionError::CommandFailed)?;
    fs::write(data_dir.join("pg_hba.conf"), &policy.pg_hba_conf)
        .map_err(|_| ProvisionError::CommandFailed)?;
    Ok(())
}

fn start_cluster(pg_ctl: &Path, data_dir: &Path, log_path: &Path) -> Result<(), ProvisionError> {
    let status = Command::new(pg_ctl)
        .arg("status")
        .arg("-D")
        .arg(data_dir)
        .status()
        .map_err(|_| ProvisionError::CommandFailed)?;
    if status.success() {
        return Ok(());
    }
    let status = Command::new(pg_ctl)
        .arg("-D")
        .arg(data_dir)
        .arg("-l")
        .arg(log_path)
        .arg("-w")
        .arg("start")
        .status()
        .map_err(|_| ProvisionError::CommandFailed)?;
    status
        .success()
        .then_some(())
        .ok_or(ProvisionError::CommandFailed)
}

async fn bootstrap_roles_and_database(
    provisioned: &ProvisionedDatabase,
) -> Result<(), ProvisionError> {
    let mut owner = PgConnection::connect(&provisioned.owner_url("postgres"))
        .await
        .map_err(|_| ProvisionError::CommandFailed)?;
    let secret = provisioned.credential.expose_secret();
    let sql = format!(
        "DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zaipos_service') THEN CREATE ROLE zaipos_service LOGIN NOINHERIT PASSWORD '{secret}'; END IF;
         END $$;
         ALTER ROLE zaipos_service LOGIN NOINHERIT PASSWORD '{secret}';
         GRANT authenticated TO zaipos_service;
         GRANT service_role TO zaipos_service;"
    );
    sqlx::raw_sql(&sql)
        .execute(&mut owner)
        .await
        .map_err(|_| ProvisionError::CommandFailed)?;
    let exists: bool =
        sqlx::query("select exists(select 1 from pg_database where datname='zaipos') as present")
            .fetch_one(&mut owner)
            .await
            .map_err(|_| ProvisionError::CommandFailed)?
            .get("present");
    if !exists {
        sqlx::query("create database zaipos owner zaipos_owner_bootstrap")
            .execute(&mut owner)
            .await
            .map_err(|_| ProvisionError::CommandFailed)?;
    }
    Ok(())
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
