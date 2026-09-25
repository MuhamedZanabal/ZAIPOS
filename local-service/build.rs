use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

fn main() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let migrations = manifest_dir.join("../supabase/migrations");
    println!("cargo:rerun-if-changed={}", migrations.display());
    let mut files = fs::read_dir(&migrations)
        .unwrap_or_else(|error| panic!("migration directory is required: {error}"))
        .map(|entry| entry.expect("migration entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect::<Vec<_>>();
    files.sort();
    let mut rendered = String::from("&[\n");
    let mut seen = std::collections::BTreeSet::new();
    for path in files {
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("migration filename is utf-8")
            .to_string();
        println!("cargo:rerun-if-changed={}", path.display());
        if !seen.insert(filename.clone()) {
            panic!("duplicate migration {filename}");
        }
        if !valid_migration_name(&filename) {
            panic!("invalid migration name {filename}");
        }
        let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {filename}: {error}"));
        if bytes.is_empty() {
            panic!("empty migration {filename}");
        }
        let sql = String::from_utf8(bytes)
            .unwrap_or_else(|_| panic!("migration is not utf-8: {filename}"));
        if sql.trim().is_empty() {
            panic!("blank migration {filename}");
        }
        let digest = Sha256::digest(sql.as_bytes());
        let hash = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let include_path = path.to_string_lossy().replace('\\', "/");
        rendered.push_str(&format!(
            "    (\"{filename}\", \"{hash}\", include_str!(\"{include_path}\")),\n"
        ));
    }
    rendered.push_str("]\n");
    let out = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("embedded_migrations.rs");
    fs::write(out, rendered).expect("write embedded migrations");
}

fn valid_migration_name(name: &str) -> bool {
    let mut chars = name.chars();
    let prefix: String = chars.by_ref().take(14).collect();
    prefix.len() == 14
        && prefix.chars().all(|char| char.is_ascii_digit())
        && name[14..].starts_with('_')
        && name.ends_with(".sql")
        && !name.contains("..")
        && name
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '-' | '.'))
}
