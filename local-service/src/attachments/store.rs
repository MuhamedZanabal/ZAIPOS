use std::collections::BTreeMap;

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

fn unsafe_path(path: &str) -> bool {
    path.is_empty() || path.contains("..") || path.starts_with('/') || path.contains('\\')
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
}
