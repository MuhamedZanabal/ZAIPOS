use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

/// Location of an installed local-service root supplied by the Windows launcher.
#[derive(Debug, Clone)]
pub struct ServicePaths {
    raw: String,
    #[cfg(feature = "test-utils")]
    allow_unapproved: bool,
}

impl ServicePaths {
    pub fn new(root: impl Into<String>) -> Self {
        Self {
            raw: root.into(),
            #[cfg(feature = "test-utils")]
            allow_unapproved: false,
        }
    }

    /// Test-only root that still rejects user profiles, relative paths, and `..`.
    /// Production builds do not compile this constructor.
    #[cfg(feature = "test-utils")]
    pub fn test_root(root: impl Into<String>) -> Self {
        Self {
            raw: root.into(),
            allow_unapproved: true,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("unsafe service root")]
    UnsafeRoot,
    #[error("service configuration is missing")]
    MissingConfig,
    #[error("service configuration contains an unknown key")]
    UnknownKey,
    #[error("service configuration is invalid")]
    InvalidConfig,
    #[error("wildcard listen addresses are forbidden")]
    WildcardListen,
    #[error("plaintext LAN mode is forbidden")]
    PlaintextLan,
    #[error("public listen addresses are forbidden")]
    PublicListen,
    #[error("database secret file is missing or not ACL-protected")]
    MissingSecret,
    #[error("database secret file permissions are too broad")]
    UnsafeSecretPermissions,
}

/// Validated service configuration. Secret bytes are never exposed through `Debug`.
pub struct ServiceConfig {
    listen: SocketAddr,
    database_secret: Vec<u8>,
}

impl std::fmt::Debug for ServiceConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServiceConfig")
            .field("listen", &self.listen)
            .field("database_secret", &"<redacted>")
            .finish()
    }
}

impl ServiceConfig {
    pub fn listen(&self) -> SocketAddr {
        self.listen
    }

    pub fn has_database_secret(&self) -> bool {
        !self.database_secret.is_empty()
    }

    pub fn load(paths: ServicePaths) -> Result<Self, ConfigError> {
        let root = approved_root(&paths)?;
        let config_path = root.join("config.json");
        let bytes = fs::read(&config_path).map_err(|_| ConfigError::MissingConfig)?;
        parse_config(&root, &bytes)
    }
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    listen: String,
    tls: String,
    database_secret_file: String,
}

const ALLOWED_KEYS: &[&str] = &["database_secret_file", "listen", "tls"];

fn parse_config(root: &Path, bytes: &[u8]) -> Result<ServiceConfig, ConfigError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ConfigError::InvalidConfig)?;
    let object = value.as_object().ok_or(ConfigError::InvalidConfig)?;
    if object
        .keys()
        .any(|key| !ALLOWED_KEYS.contains(&key.as_str()))
    {
        return Err(ConfigError::UnknownKey);
    }
    let raw: RawConfig = serde_json::from_value(value).map_err(|_| ConfigError::InvalidConfig)?;
    if raw.tls != "required" {
        return Err(ConfigError::PlaintextLan);
    }
    let listen = parse_listen(&raw.listen)?;
    let secret_path = secret_path(root, &raw.database_secret_file)?;
    let database_secret = read_private_secret(&secret_path)?;
    Ok(ServiceConfig {
        listen,
        database_secret,
    })
}

fn parse_listen(value: &str) -> Result<SocketAddr, ConfigError> {
    if value.contains("://") || value.contains('@') || value.contains('*') {
        return Err(ConfigError::InvalidConfig);
    }
    let address: SocketAddr = value.parse().map_err(|_| ConfigError::InvalidConfig)?;
    match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => Err(ConfigError::WildcardListen),
        IpAddr::V6(ip) if ip.is_unspecified() => Err(ConfigError::WildcardListen),
        IpAddr::V4(ip) if is_allowed_v4(ip) => Ok(address),
        IpAddr::V6(ip) if is_allowed_v6(ip) => Ok(address),
        _ => Err(ConfigError::PublicListen),
    }
}

fn is_allowed_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private() || ip.is_link_local()
}

fn is_allowed_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback() || is_unique_local(ip) || is_link_local_v6(ip)
}

fn is_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_link_local_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn secret_path(root: &Path, relative: &str) -> Result<PathBuf, ConfigError> {
    if relative.is_empty()
        || relative.contains('\0')
        || relative.starts_with('/')
        || relative.starts_with('\\')
        || relative.contains(':')
    {
        return Err(ConfigError::InvalidConfig);
    }
    let relative_path = Path::new(relative);
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ConfigError::InvalidConfig);
    }
    let candidate = root.join(relative_path);
    let root_text = root.to_string_lossy();
    let candidate_text = candidate.to_string_lossy();
    if !candidate_text.starts_with(root_text.as_ref()) {
        return Err(ConfigError::InvalidConfig);
    }
    Ok(candidate)
}

fn read_private_secret(path: &Path) -> Result<Vec<u8>, ConfigError> {
    let metadata = fs::metadata(path).map_err(|_| ConfigError::MissingSecret)?;
    if !metadata.is_file() {
        return Err(ConfigError::MissingSecret);
    }
    ensure_private_permissions(path)?;
    let bytes = fs::read(path).map_err(|_| ConfigError::MissingSecret)?;
    if bytes.is_empty() {
        return Err(ConfigError::MissingSecret);
    }
    Ok(bytes)
}

fn ensure_private_permissions(path: &Path) -> Result<(), ConfigError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|_| ConfigError::MissingSecret)?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(ConfigError::UnsafeSecretPermissions);
        }
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}

fn approved_root(paths: &ServicePaths) -> Result<PathBuf, ConfigError> {
    let raw = paths.raw.trim().trim_end_matches(['/', '\\']);
    if raw.is_empty() || raw.contains('\0') || raw.contains("..") {
        return Err(ConfigError::UnsafeRoot);
    }
    let windows = raw.replace('/', "\\");
    let windows_lower = windows.to_ascii_lowercase();
    if is_user_profile(&windows_lower, raw) {
        return Err(ConfigError::UnsafeRoot);
    }
    if is_program_data(&windows_lower) {
        return Ok(PathBuf::from(windows));
    }
    if is_var_lib(raw) {
        return Ok(PathBuf::from(raw));
    }
    #[cfg(feature = "test-utils")]
    if paths.allow_unapproved && is_absolute_non_profile(raw) {
        return Ok(PathBuf::from(raw));
    }
    Err(ConfigError::UnsafeRoot)
}

fn is_user_profile(windows_lower: &str, raw: &str) -> bool {
    windows_lower.contains("\\users\\")
        || windows_lower.contains("\\documents and settings\\")
        || raw.starts_with("/home/")
        || raw.starts_with("/Users/")
        || raw == "/root"
        || raw.starts_with("/root/")
}

fn is_program_data(windows_lower: &str) -> bool {
    let prefix = "c:\\programdata\\zaipos";
    windows_lower == prefix || windows_lower.starts_with(&(prefix.to_string() + "\\"))
}

fn is_var_lib(raw: &str) -> bool {
    raw == "/var/lib/zaipos" || raw.starts_with("/var/lib/zaipos/")
}

#[cfg(feature = "test-utils")]
fn is_absolute_non_profile(raw: &str) -> bool {
    if raw.starts_with('/') {
        return !raw.contains('\\');
    }
    let bytes = raw.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_user_profile_is_unsafe() {
        let err = ServiceConfig::load(ServicePaths::new(r"C:\Users\Public\zaipos")).unwrap_err();
        assert!(matches!(err, ConfigError::UnsafeRoot));
    }
}
