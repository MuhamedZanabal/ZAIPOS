use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use rand_core::OsRng;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeviceAuthError {
    #[error("device proof of possession failed")]
    ProofOfPossession,
}

pub struct DeviceKeyPair {
    signing: SigningKey,
}

impl DeviceKeyPair {
    pub fn generate() -> Self {
        Self {
            signing: SigningKey::random(&mut OsRng),
        }
    }

    pub fn public_key(&self) -> VerifyingKey {
        *self.signing.verifying_key()
    }

    pub fn sign(&self, challenge: &[u8]) -> Vec<u8> {
        let signature: Signature = self.signing.sign(challenge);
        signature.to_bytes().to_vec()
    }
}

pub struct StoreCa {
    issued: Vec<DeviceCertificate>,
}

impl StoreCa {
    pub fn generate() -> Self {
        Self { issued: Vec::new() }
    }

    pub fn issue(&mut self, public_key: &VerifyingKey) -> DeviceCertificate {
        let certificate = DeviceCertificate {
            public_key: *public_key,
            serial: self.issued.len() as u64 + 1,
        };
        self.issued.push(certificate.clone());
        certificate
    }
}

#[derive(Clone)]
pub struct DeviceCertificate {
    public_key: VerifyingKey,
    serial: u64,
}

impl DeviceCertificate {
    pub fn serial(&self) -> u64 {
        self.serial
    }

    pub fn public_key_sec1(&self) -> Vec<u8> {
        self.public_key.to_encoded_point(true).as_bytes().to_vec()
    }
}

pub fn verify_possession(
    certificate: &DeviceCertificate,
    challenge: &[u8],
    proof: &[u8],
) -> Result<(), DeviceAuthError> {
    let signature = Signature::from_slice(proof).map_err(|_| DeviceAuthError::ProofOfPossession)?;
    certificate
        .public_key
        .verify(challenge, &signature)
        .map_err(|_| DeviceAuthError::ProofOfPossession)
}
