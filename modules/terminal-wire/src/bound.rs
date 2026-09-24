/// Connection-bound framing; authentication/session/epoch remain transport policy.
pub struct BoundFrameFormat {
    pub magic: [u8; 4],
    pub max_payload: usize,
    pub kinds: &'static [u8],
}
impl BoundFrameFormat {
    pub fn encode(&self, kind: u8, sequence: u32, payload: &[u8]) -> Option<Vec<u8>> {
        if !self.kinds.contains(&kind) || sequence == 0 || payload.len() > self.max_payload {
            return None;
        }
        let mut bytes = Vec::with_capacity(13 + payload.len());
        bytes.extend_from_slice(&self.magic);
        bytes.push(kind);
        bytes.extend_from_slice(&sequence.to_be_bytes());
        bytes.extend_from_slice(&u32::try_from(payload.len()).ok()?.to_be_bytes());
        bytes.extend_from_slice(payload);
        Some(bytes)
    }
    pub fn decode<'a>(&self, bytes: &'a [u8]) -> Option<(u8, u32, &'a [u8])> {
        if bytes.len() < 13 || bytes[..4] != self.magic {
            return None;
        }
        let kind = bytes[4];
        let sequence = u32::from_be_bytes(bytes[5..9].try_into().ok()?);
        let length = u32::from_be_bytes(bytes[9..13].try_into().ok()?) as usize;
        if !self.kinds.contains(&kind)
            || sequence == 0
            || length > self.max_payload
            || bytes.len() != 13 + length
        {
            return None;
        }
        Some((kind, sequence, &bytes[13..]))
    }
}

pub fn replay_ack_payload(event_count: usize, output_bytes: usize) -> Vec<u8> {
    let mut payload = Vec::with_capacity(12);
    payload.extend_from_slice(b"TLRA");
    payload.extend_from_slice(&u32::try_from(event_count).unwrap_or(u32::MAX).to_be_bytes());
    payload.extend_from_slice(
        &u32::try_from(output_bytes)
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bound_frames_reject_truncation_trailing_data_unknown_kinds_and_zero_sequence() {
        let format = BoundFrameFormat {
            magic: *b"TEST",
            max_payload: 16,
            kinds: &[1, 3],
        };
        let bytes = format.encode(3, 1, b"abc").unwrap();
        assert_eq!(format.decode(&bytes), Some((3, 1, b"abc".as_slice())));
        for length in 0..bytes.len() {
            assert!(format.decode(&bytes[..length]).is_none());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(format.decode(&trailing).is_none());
        assert!(format.encode(2, 1, b"").is_none());
        assert!(format.encode(1, 0, b"").is_none());
        assert!(format.encode(1, 1, &[0; 17]).is_none());
    }
}
