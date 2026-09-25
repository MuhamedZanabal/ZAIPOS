use std::process::ExitCode;

use zaipos_local_service::http::AppState;
use zaipos_local_service::{ServiceConfig, ServicePaths, build_router};

fn main() -> ExitCode {
    let root = std::env::var("ZAIPOS_SERVICE_ROOT")
        .unwrap_or_else(|_| r"C:\ProgramData\ZAIPOS".to_string());
    match ServiceConfig::load(ServicePaths::new(root)) {
        Ok(config) => serve(config),
        Err(error) => {
            eprintln!("zaipos-local-service: configuration rejected: {error}");
            ExitCode::from(1)
        }
    }
}

fn serve(config: ServiceConfig) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("zaipos-local-service: runtime unavailable: {error}");
            return ExitCode::from(1);
        }
    };
    let result = runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(config.listen()).await?;
        axum::serve(listener, build_router(AppState::starting())).await?;
        Ok::<(), std::io::Error>(())
    });
    if let Err(error) = result {
        eprintln!("zaipos-local-service: listener stopped: {error}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
