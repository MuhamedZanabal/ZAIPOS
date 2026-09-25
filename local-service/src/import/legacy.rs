use crate::backup::BackupManifest;

pub fn prepare_import(
    manifest: &BackupManifest,
    files: &std::collections::BTreeMap<String, Vec<u8>>,
) -> Result<usize, &'static str> {
    manifest.verify(files)?;
    if files
        .keys()
        .any(|name| name.contains("..") || !name.ends_with(".json"))
    {
        return Err("import rejected");
    }
    Ok(files.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn checksum_failure_imports_nothing() {
        let files = BTreeMap::from([("customers.json".into(), b"[]".to_vec())]);
        let manifest = BackupManifest::from_files(files.clone());
        assert_eq!(prepare_import(&manifest, &files).unwrap(), 1);
        let mut tampered = files.clone();
        tampered.get_mut("customers.json").unwrap().push(b'x');
        assert!(prepare_import(&manifest, &tampered).is_err());
    }
}
