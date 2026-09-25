use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

#[derive(Default)]
pub struct AttachmentStore {
    objects: BTreeMap<(String, String, String), Vec<u8>>,
}

impl AttachmentStore {
    pub fn put(
        &mut self,
        tenant: &str,
        bucket: &str,
        path: &str,
        bytes: Vec<u8>,
    ) -> Result<String, &'static str> {
        if tenant.is_empty()
            || !matches!(bucket, "product-images" | "return-evidence")
            || unsafe_path(path)
            || bytes.len() > 5 * 1024 * 1024
        {
            return Err("attachment rejected");
        }
        let digest = bytes.iter().fold(Sha256::new(), |mut hasher, byte| {
            hasher.update([*byte]);
            hasher
        });
        let hash = format!("{:x}", digest.finalize());
        self.objects.insert(
            (tenant.to_string(), bucket.to_string(), hash.clone()),
            bytes,
        );
        Ok(hash)
    }

    pub fn read(&self, tenant: &str, bucket: &str, hash: &str) -> Option<&[u8]> {
        self.objects
            .get(&(tenant.to_string(), bucket.to_string(), hash.to_string()))
            .map(Vec::as_slice)
    }
}

pub struct DurableAttachmentStore {
    root: PathBuf,
}

impl DurableAttachmentStore {
    pub fn open(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn put(
        &self,
        tenant: &str,
        bucket: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<String, &'static str> {
        if !safe_segment(tenant)
            || !matches!(bucket, "product-images" | "return-evidence")
            || unsafe_path(path)
            || bytes.len() > 5 * 1024 * 1024
        {
            return Err("attachment rejected");
        }
        let hash = format!("{:x}", Sha256::digest(bytes));
        let directory = self.root.join(tenant).join(bucket);
        fs::create_dir_all(&directory).map_err(|_| "attachment rejected")?;
        let target = directory.join(&hash);
        if !target.starts_with(&self.root) {
            return Err("attachment rejected");
        }
        fs::write(target, bytes).map_err(|_| "attachment rejected")?;
        Ok(hash)
    }

    pub fn read(
        &self,
        tenant: &str,
        bucket: &str,
        hash: &str,
    ) -> Result<Option<Vec<u8>>, &'static str> {
        if !safe_segment(tenant)
            || !matches!(bucket, "product-images" | "return-evidence")
            || !safe_segment(hash)
        {
            return Ok(None);
        }
        let target = self.root.join(tenant).join(bucket).join(hash);
        if !target.starts_with(self.root.as_path()) {
            return Err("attachment rejected");
        }
        match fs::read(target) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("attachment rejected"),
        }
    }
}

fn unsafe_path(path: &str) -> bool {
    path.is_empty() || path.contains("..") || path.starts_with('/') || path.contains('\\')
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_and_cross_tenant_reads_fail() {
        let mut store = AttachmentStore::default();
        let hash = store
            .put("tenant-a", "product-images", "photo.jpg", b"image".to_vec())
            .unwrap();
        assert!(
            store
                .put("tenant-a", "product-images", "../secret", b"no".to_vec())
                .is_err()
        );
        assert!(store.read("tenant-b", "product-images", &hash).is_none());
        assert_eq!(
            store.read("tenant-a", "product-images", &hash),
            Some(b"image".as_slice())
        );
    }

    #[test]
    fn durable_store_keeps_tenants_apart() {
        let root = std::env::temp_dir().join(format!("zaipos-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = DurableAttachmentStore::open(&root);
        let hash = store
            .put("tenanta", "product-images", "photo.jpg", b"image")
            .unwrap();
        assert!(
            store
                .put("tenanta", "product-images", "../secret", b"no")
                .is_err()
        );
        assert_eq!(
            store.read("tenantb", "product-images", &hash).unwrap(),
            None
        );
        assert_eq!(
            store
                .read("tenanta", "product-images", &hash)
                .unwrap()
                .unwrap(),
            b"image"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
