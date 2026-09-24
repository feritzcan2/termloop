#![forbid(unsafe_code)]
use uuid::Uuid;
pub const TERMINAL_WIRE_VERSION: u32 = 1;
pub const TERMINAL_FRAME_MAGIC: &[u8; 4] = b"TL01";
pub const TERMINAL_HEADER_LEN: usize = 41;
pub const MAX_TERMINAL_PAYLOAD: usize = 16 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Input = 1,
    Output = 2,
    Resize = 3,
    Gap = 4,
    Eof = 5,
    ReplayOutput = 6,
    Attach = 10,
    Ack = 11,
    Error = 12,
    Focus = 13,
    ResizeOwnership = 14,
    Detach = 15,
    InputAck = 16,
    EnableInputAck = 17,
}

#[derive(Clone)]
pub struct TerminalFrame {
    pub session_id: Uuid,
    pub epoch: u64,
    pub sequence: u64,
    pub kind: u8,
    pub payload: Vec<u8>,
}

pub fn encode_terminal_frame(frame: &TerminalFrame) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(TERMINAL_HEADER_LEN + frame.payload.len());
    bytes.extend_from_slice(b"TL01");
    bytes.extend_from_slice(frame.session_id.as_bytes());
    bytes.extend_from_slice(&frame.epoch.to_be_bytes());
    bytes.extend_from_slice(&frame.sequence.to_be_bytes());
    bytes.push(frame.kind);
    bytes.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&frame.payload);
    bytes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTerminalFrame;
impl std::fmt::Display for InvalidTerminalFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid terminal frame")
    }
}
impl std::error::Error for InvalidTerminalFrame {}

pub fn decode_terminal_frame(bytes: &[u8]) -> Result<TerminalFrame, InvalidTerminalFrame> {
    if bytes.len() < TERMINAL_HEADER_LEN || &bytes[..4] != b"TL01" {
        return Err(InvalidTerminalFrame);
    }
    let session_id = Uuid::from_slice(&bytes[4..20]).map_err(|_| InvalidTerminalFrame)?;
    let epoch = u64::from_be_bytes(bytes[20..28].try_into().map_err(|_| InvalidTerminalFrame)?);
    let sequence = u64::from_be_bytes(bytes[28..36].try_into().map_err(|_| InvalidTerminalFrame)?);
    let kind = bytes[36];
    let length =
        u32::from_be_bytes(bytes[37..41].try_into().map_err(|_| InvalidTerminalFrame)?) as usize;
    if length > MAX_TERMINAL_PAYLOAD || bytes.len() != TERMINAL_HEADER_LEN + length {
        return Err(InvalidTerminalFrame);
    }
    Ok(TerminalFrame {
        session_id,
        epoch,
        sequence,
        kind,
        payload: bytes[41..].to_vec(),
    })
}

mod bound;
pub use bound::{BoundFrameFormat, replay_ack_payload};
