use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupManifest {
    pub files: BTreeMap<String, String>,
}

impl BackupManifest {
    pub fn from_files(files: BTreeMap<String, Vec<u8>>) -> Self {
        let files = files
            .into_iter()
            .map(|(name, bytes)| (name, hex(Sha256::digest(bytes))))
            .collect();
        Self { files }
    }

    pub fn verify(&self, files: &BTreeMap<String, Vec<u8>>) -> Result<(), &'static str> {
        if files.len() != self.files.len() {
            return Err("incomplete backup");
        }
        for (name, expected) in &self.files {
            let Some(bytes) = files.get(name) else {
                return Err("incomplete backup");
            };
            if &hex(Sha256::digest(bytes)) != expected {
                return Err("corrupt backup");
            }
        }
        Ok(())
    }
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_modified_byte_is_rejected() {
        let mut files = BTreeMap::from([("sales.json".into(), b"{\"total\":\"1.500\"}".to_vec())]);
        let manifest = BackupManifest::from_files(files.clone());
        manifest.verify(&files).unwrap();
        files.get_mut("sales.json").unwrap()[0] ^= 0xff;
        assert_eq!(manifest.verify(&files), Err("corrupt backup"));
    }
}
