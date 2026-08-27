use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use sha2::{Digest, Sha256};

const PAIRING_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn generate_access_nonce() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_pairing_code() -> String {
    let mut random = [0_u8; 8];
    rand::rng().fill_bytes(&mut random);
    let mut code = String::with_capacity(9);
    for (index, byte) in random.into_iter().enumerate() {
        if index == 4 {
            code.push('-');
        }
        code.push(PAIRING_ALPHABET[usize::from(byte & 31)] as char);
    }
    code
}

pub fn pairing_code_digest(code: &str) -> [u8; 32] {
    Sha256::digest(code.as_bytes()).into()
}

pub fn access_server_fingerprint(server_id: &str) -> String {
    let digest = Sha256::digest(server_id.as_bytes());
    format!("sha256:{}", hex(&digest))
}

pub fn access_public_key_valid(public_key: &str) -> bool {
    let Ok(public_key) = URL_SAFE_NO_PAD.decode(public_key) else {
        return false;
    };
    let Ok(public_key): Result<[u8; 32], _> = public_key.try_into() else {
        return false;
    };
    VerifyingKey::from_bytes(&public_key).is_ok()
}

pub fn verify_access_signature(
    public_key: &str,
    server_fingerprint: &str,
    channel: &str,
    nonce: &str,
    signature: &str,
) -> bool {
    if !matches!(channel, "control" | "terminal" | "forward") {
        return false;
    }
    let Ok(public_key) = URL_SAFE_NO_PAD.decode(public_key) else {
        return false;
    };
    let Ok(public_key): Result<[u8; 32], _> = public_key.try_into() else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&public_key) else {
        return false;
    };
    let Ok(nonce_bytes) = URL_SAFE_NO_PAD.decode(nonce) else {
        return false;
    };
    if nonce_bytes.len() != 32 {
        return false;
    }
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let Ok(signature): Result<[u8; 64], _> = signature.try_into() else {
        return false;
    };
    let signature = Signature::from_bytes(&signature);
    let message = format!("tl-access-v1|{server_fingerprint}|{channel}|{nonce}");
    verifying_key.verify(message.as_bytes(), &signature).is_ok()
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing into a String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn pairing_codes_are_bounded_and_digest_without_retaining_plaintext() {
        let code = generate_pairing_code();
        assert_eq!(code.len(), 9);
        assert_eq!(code.as_bytes()[4], b'-');
        assert!(!String::from_utf8_lossy(&pairing_code_digest(&code)).contains(&code));
    }

    #[test]
    fn access_proofs_are_server_nonce_and_channel_bound() {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes());
        let nonce = URL_SAFE_NO_PAD.encode([9; 32]);
        let server_fingerprint = format!("sha256:{}", "a".repeat(64));
        let message = format!("tl-access-v1|{server_fingerprint}|control|{nonce}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(message.as_bytes()).to_bytes());
        assert!(verify_access_signature(
            &public_key,
            &server_fingerprint,
            "control",
            &nonce,
            &signature
        ));
        assert!(!verify_access_signature(
            &public_key,
            &server_fingerprint,
            "terminal",
            &nonce,
            &signature
        ));
        assert!(!verify_access_signature(
            &public_key,
            &server_fingerprint,
            "control",
            &URL_SAFE_NO_PAD.encode([8; 32]),
            &signature
        ));
        assert!(!verify_access_signature(
            &public_key,
            &format!("sha256:{}", "b".repeat(64)),
            "control",
            &nonce,
            &signature
        ));
    }
}
