use zaipos_local_service::device::{DeviceAuthError, DeviceKeyPair, StoreCa, verify_possession};

#[test]
fn copied_certificate_without_private_key_has_zero_effects() {
    let mut ca = StoreCa::generate();
    let device = DeviceKeyPair::generate();
    let certificate = ca.issue(&device.public_key());
    let attacker = DeviceKeyPair::generate();
    let challenge = b"terminal-enrollment-challenge";
    let copied = verify_possession(&certificate, challenge, &attacker.sign(challenge));
    assert!(matches!(copied, Err(DeviceAuthError::ProofOfPossession)));
    assert!(verify_possession(&certificate, challenge, &device.sign(challenge)).is_ok());
    assert_eq!(certificate.serial(), 1);
    assert!(!certificate.public_key_sec1().is_empty());
}
