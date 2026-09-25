//! ZAIPOS Local Service library.
//!
//! The process that links this crate is the only runtime allowed to hold
//! PostgreSQL credentials. Health responses and `Debug` output must not
//! disclose them.

pub mod config;
pub mod http;

pub use config::{ConfigError, ServiceConfig, ServicePaths};
pub use http::{AppState, HealthResponse, build_router};

pub mod test_support {
    pub use crate::http::test_support::{body_text, request, test_app};
}
