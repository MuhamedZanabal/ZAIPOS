//! ZAIPOS Local Service library.
//!
//! The process that links this crate is the only runtime allowed to hold
//! PostgreSQL credentials. Health responses and `Debug` output must not
//! disclose them.

pub mod attachments;
pub mod auth;
pub mod backup;
pub mod commands;
pub mod config;
pub mod db;
pub mod device;
pub mod events;
pub mod http;
pub mod import;
pub mod provisioning;

pub use config::{ConfigError, ServiceConfig, ServicePaths};
pub use http::{AppState, HealthResponse, build_router};

pub mod test_support {
    pub use crate::http::test_support::{body_text, request, test_app};
}
