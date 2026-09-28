use std::process::ExitCode;
use std::time::Duration;

use axum_server::tls_rustls::RustlsConfig;
use zaipos_local_service::auth::ensure_identity;
use zaipos_local_service::db::{Database, MigrationRunner};
use zaipos_local_service::desktop_publish::{self, ServiceNotice, notice_from_runtime_error};
use zaipos_local_service::provisioning::PostgresProvisioner;
use zaipos_local_service::{AppState, ServiceConfig, ServicePaths, build_router};

fn main() -> ExitCode {
    #[cfg(windows)]
    {
        if !std::env::args().any(|arg| arg == "--console") {
            return run_windows_service();
        }
    }
    run_console()
}

fn service_root() -> String {
    std::env::var("ZAIPOS_SERVICE_ROOT").unwrap_or_else(|_| {
        if cfg!(windows) {
            r"C:\ProgramData\ZAIPOS".to_string()
        } else {
            "/var/lib/zaipos".to_string()
        }
    })
}

fn run_console() -> ExitCode {
    match run_runtime(None) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("zaipos-local-service: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_runtime(stop: Option<tokio::sync::watch::Receiver<bool>>) -> Result<(), String> {
    let config = ServiceConfig::load_or_initialize(ServicePaths::new(service_root()))
        .map_err(|error| format!("configuration rejected: {error}"))?;
    let root = config.root().to_path_buf();
    let _ = desktop_publish::grant_desktop_traverse(&root);
    let _ = desktop_publish::publish_notice(&root, ServiceNotice::DatabaseStarting);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("runtime unavailable: {error}"))?;
    runtime
        .block_on(serve_ready(config, stop))
        .inspect_err(|error| {
            let _ = desktop_publish::publish_notice(&root, notice_from_runtime_error(error));
        })
}

async fn serve_ready(
    config: ServiceConfig,
    stop: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<(), String> {
    let provisioned = PostgresProvisioner::new(config.database_root(), 55432)
        .ensure_cluster()
        .await
        .map_err(|error| format!("PostgreSQL provisioning failed: {error}"))?;

    let owner = Database::connect_owner(&provisioned)
        .await
        .map_err(|error| format!("owner database connection failed: {error}"))?;
    owner
        .prepare_local_compatibility()
        .await
        .map_err(|error| format!("local database compatibility failed: {error}"))?;
    MigrationRunner::embedded()
        .map_err(|error| format!("migration manifest rejected: {error}"))?
        .apply(&owner)
        .await
        .map_err(|error| format!("migration chain failed: {error}"))?;
    ensure_identity(&owner)
        .await
        .map_err(|error| format!("local identity initialization failed: {error}"))?;

    let database = Database::connect(&provisioned)
        .await
        .map_err(|error| format!("service database connection failed: {error}"))?;
    database
        .is_ready()
        .await
        .map_err(|error| format!("database readiness failed: {error}"))?;

    let profile = serde_json::json!({
        "origin": format!("https://{}", config.listen()),
        "caFingerprint": provisioned.certificate_fingerprint,
        "deviceCertificateRef": "local-server-terminal"
    });
    let bytes = serde_json::to_vec_pretty(&profile)
        .map_err(|_| "server profile write failed".to_string())?;
    if let Some(parent) = config.server_profile_path().parent() {
        std::fs::create_dir_all(parent).map_err(|_| "server profile write failed".to_string())?;
    }
    std::fs::write(config.server_profile_path(), bytes)
        .map_err(|_| "server profile write failed".to_string())?;
    if !cfg!(windows) {
        desktop_publish::publish_desktop_readable(&config.server_profile_path())
            .map_err(|_| "server profile write failed".to_string())?;
    } else {
        let _ = desktop_publish::publish_desktop_readable(&config.server_profile_path());
    }
    let _ = desktop_publish::publish_notice(config.root(), ServiceNotice::Ready);

    let tls = RustlsConfig::from_pem_file(&provisioned.cert_path, &provisioned.key_path)
        .await
        .map_err(|error| format!("TLS configuration failed: {error}"))?;
    let handle = axum_server::Handle::new();

    if let Some(mut receiver) = stop {
        let shutdown = handle.clone();
        tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                if *receiver.borrow() {
                    shutdown.graceful_shutdown(Some(Duration::from_secs(10)));
                    break;
                }
            }
        });
    }

    axum_server::bind_rustls(config.listen(), tls)
        .handle(handle)
        .serve(build_router(AppState::ready(database)).into_make_service())
        .await
        .map_err(|error| format!("TLS listener stopped: {error}"))
}

#[cfg(windows)]
fn run_windows_service() -> ExitCode {
    use windows_services::{Command, Service};

    let mut stop_tx: Option<tokio::sync::watch::Sender<bool>> = None;
    let mut runtime_thread: Option<std::thread::JoinHandle<()>> = None;

    let mut service = Service::new();
    service.can_stop();
    let control_result = service.run(|_service, command| match command {
        Command::Start if runtime_thread.is_none() => {
            let (tx, rx) = tokio::sync::watch::channel(false);
            stop_tx = Some(tx);
            runtime_thread = Some(std::thread::spawn(move || {
                if let Err(error) = run_runtime(Some(rx)) {
                    write_startup_error(&error);
                }
            }));
        }
        Command::Stop => {
            if let Some(tx) = stop_tx.take() {
                let _ = tx.send(true);
            }
            if let Some(thread) = runtime_thread.take() {
                let _ = thread.join();
            }
        }
        _ => {}
    });
    // Service owns the callback, which borrows the worker handles. Drop the
    // dispatcher before touching those handles again so the callback lifetime ends.
    drop(service);

    if let Some(tx) = stop_tx.take() {
        let _ = tx.send(true);
    }
    if let Some(thread) = runtime_thread.take() {
        let _ = thread.join();
    }

    if let Err(error) = control_result {
        write_startup_error(&format!("service dispatcher failed: {error}"));
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(windows)]
fn write_startup_error(error: &str) {
    use std::io::Write;

    let root = std::path::PathBuf::from(service_root());
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    let path = root.join("startup-error.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
    {
        let _ = writeln!(file, "{error}");
    }
}
