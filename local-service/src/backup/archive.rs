use std::collections::BTreeMap;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

use super::BackupManifest;

pub fn seal(key: &[u8; 32], files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, &'static str> {
    let manifest = BackupManifest::from_files(files.clone());
    manifest.verify(files)?;
    let payload = serde_json::to_vec(files).map_err(|_| "backup rejected")?;
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(|_| "backup rejected")?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), payload.as_ref())
        .map_err(|_| "backup rejected")?;
    let mut sealed = nonce_bytes.to_vec();
    sealed.extend(ciphertext);
    Ok(sealed)
}

pub fn open(key: &[u8; 32], sealed: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, &'static str> {
    if sealed.len() < 13 {
        return Err("corrupt backup");
    }
    let (nonce_bytes, ciphertext) = sealed.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let payload = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "corrupt backup")?;
    let files: BTreeMap<String, Vec<u8>> =
        serde_json::from_slice(&payload).map_err(|_| "corrupt backup")?;
    BackupManifest::from_files(files.clone()).verify(&files)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modified_ciphertext_is_rejected_before_promotion() {
        let key = [7u8; 32];
        let files = BTreeMap::from([("sales.json".to_string(), b"{\"total\":\"1.500\"}".to_vec())]);
        let mut sealed = seal(&key, &files).unwrap();
        let opened = open(&key, &sealed).unwrap();
        assert_eq!(opened, files);
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert_eq!(open(&key, &sealed), Err("corrupt backup"));
    }
}
