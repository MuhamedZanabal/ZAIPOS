use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use rand_core::OsRng;

pub fn hash_password(password: &str) -> Result<String, &'static str> {
    if password.is_empty() || password.len() > 1024 {
        return Err("password rejected");
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "password rejected")
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(encoded) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_verifies_only_the_same_password() {
        let encoded = hash_password("correct-horse").unwrap();
        assert!(verify_password("correct-horse", &encoded));
        assert!(!verify_password("wrong-horse", &encoded));
        assert!(!encoded.contains("correct-horse"));
        assert!(hash_password("").is_err());
    }
}
