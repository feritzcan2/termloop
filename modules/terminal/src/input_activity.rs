use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::Duration,
};

const ESC: u8 = 0x1b;
const FOCUS_IN: &[u8] = b"\x1b[I";
const FOCUS_OUT: &[u8] = b"\x1b[O";
const MAX_NEGOTIATED_MODE_REQUESTS: usize = 16;
const MAX_INPUT_PROTOCOL_FRAGMENT_BYTES: usize = 512;
const MAX_XTVERSION_BODY_BYTES: usize = 256;
const MAX_KITTY_KEYBOARD_STACK: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ModeRequest {
    private: bool,
    mode: u16,
}

#[derive(Default)]
struct NegotiatedReplies {
    device_attributes: [bool; 3],
    cursor_positions: [bool; 2],
    color_scheme_query: bool,
    dynamic_colors: [bool; 3],
    keyboard_enhancement: bool,
    mode_requests: VecDeque<ModeRequest>,
    xtversion: bool,
}

#[derive(Default)]
struct ProtocolState {
    output_parser: OutputParser,
    modes: ClientInputModes,
    negotiated: NegotiatedReplies,
    input_fragment: Vec<u8>,
}

#[derive(Clone, Copy, Default)]
struct ClientInputModes {
    focus_reporting: bool,
    mouse_button_reporting: bool,
    mouse_drag_reporting: bool,
    mouse_any_motion: bool,
    mouse_sgr_encoding: bool,
    color_scheme_reporting: bool,
    kitty_keyboard_event_types: bool,
    kitty_keyboard_stack: [bool; MAX_KITTY_KEYBOARD_STACK],
    kitty_keyboard_stack_len: u8,
}

impl ClientInputModes {
    fn mouse_reporting(self) -> bool {
        self.mouse_button_reporting || self.mouse_drag_reporting || self.mouse_any_motion
    }

    fn record_kitty_keyboard_mode(&mut self, request: CsiRequest) {
        match request.prefix {
            Some(b'>') if request.has_digits => {
                let index = usize::from(self.kitty_keyboard_stack_len);
                if index >= MAX_KITTY_KEYBOARD_STACK {
                    // An unbalanced client protocol stack is not trustworthy
                    // enough to suppress any subsequent input as a key-up.
                    self.kitty_keyboard_event_types = false;
                    return;
                }
                self.kitty_keyboard_stack[index] = self.kitty_keyboard_event_types;
                self.kitty_keyboard_stack_len += 1;
                self.kitty_keyboard_event_types = request.value & 0b10 != 0;
            }
            Some(b'=') if request.has_digits => {
                self.kitty_keyboard_event_types = request.value & 0b10 != 0;
            }
            Some(b'<') => {
                let pops = if request.has_digits {
                    usize::from(request.value)
                } else {
                    1
                };
                for _ in 0..pops {
                    if self.kitty_keyboard_stack_len == 0 {
                        self.kitty_keyboard_event_types = false;
                        break;
                    }
                    self.kitty_keyboard_stack_len -= 1;
                    self.kitty_keyboard_event_types =
                        self.kitty_keyboard_stack[usize::from(self.kitty_keyboard_stack_len)];
                }
            }
            _ => {}
        }
    }
}

#[derive(Default)]
enum OutputParser {
    #[default]
    Ground,
    Escape,
    Csi(CsiRequest),
    Osc(OscRequest),
    OscEscape(OscRequest),
}

enum OutputEvent {
    Csi(CsiRequest, u8),
    DynamicColorQuery(usize),
}

#[derive(Clone, Copy, Default)]
struct CsiRequest {
    prefix: Option<u8>,
    value: u16,
    has_digits: bool,
    dollar: bool,
    invalid: bool,
}

#[derive(Clone, Copy, Default)]
struct OscRequest {
    code: u16,
    phase: OscPhase,
    invalid: bool,
}

#[derive(Clone, Copy, Default)]
enum OscPhase {
    #[default]
    Code,
    Query,
    Complete,
}

impl OscRequest {
    fn push(&mut self, byte: u8) {
        if self.invalid {
            return;
        }
        match (self.phase, byte) {
            (OscPhase::Code, b'0'..=b'9') => {
                self.code = match self
                    .code
                    .checked_mul(10)
                    .and_then(|code| code.checked_add(u16::from(byte - b'0')))
                {
                    Some(code) => code,
                    None => {
                        self.invalid = true;
                        return;
                    }
                };
            }
            (OscPhase::Code, b';') => self.phase = OscPhase::Query,
            (OscPhase::Query, b'?') => self.phase = OscPhase::Complete,
            _ => self.invalid = true,
        }
    }

    fn dynamic_color_index(self) -> Option<usize> {
        (!self.invalid && matches!(self.phase, OscPhase::Complete))
            .then_some(self.code)
            .filter(|code| (10..=12).contains(code))
            .map(|code| usize::from(code - 10))
    }
}

impl CsiRequest {
    fn push(&mut self, byte: u8) {
        if self.invalid {
            return;
        }
        match byte {
            b'?' | b'>' | b'=' | b'<'
                if self.prefix.is_none() && !self.has_digits && !self.dollar =>
            {
                self.prefix = Some(byte);
            }
            b'0'..=b'9' if !self.dollar => {
                self.has_digits = true;
                self.value = match self
                    .value
                    .checked_mul(10)
                    .and_then(|value| value.checked_add(u16::from(byte - b'0')))
                {
                    Some(value) => value,
                    None => {
                        self.invalid = true;
                        return;
                    }
                };
            }
            b'$' if self.has_digits && !self.dollar => self.dollar = true,
            _ => self.invalid = true,
        }
    }
}

impl OutputParser {
    fn advance(&mut self, byte: u8) -> Option<OutputEvent> {
        match self {
            Self::Ground => {
                if byte == ESC {
                    *self = Self::Escape;
                }
                None
            }
            Self::Escape => {
                *self = match byte {
                    b'[' => Self::Csi(CsiRequest::default()),
                    b']' => Self::Osc(OscRequest::default()),
                    ESC => Self::Escape,
                    _ => Self::Ground,
                };
                None
            }
            Self::Csi(request) => {
                if byte == ESC {
                    *self = Self::Escape;
                    return None;
                }
                if (0x40..=0x7e).contains(&byte) {
                    let completed = *request;
                    *self = Self::Ground;
                    return Some(OutputEvent::Csi(completed, byte));
                }
                request.push(byte);
                None
            }
            Self::Osc(request) => {
                if matches!(byte, 0x07 | 0x9c) {
                    let completed = request.dynamic_color_index();
                    *self = Self::Ground;
                    return completed.map(OutputEvent::DynamicColorQuery);
                }
                if byte == ESC {
                    *self = Self::OscEscape(*request);
                    return None;
                }
                request.push(byte);
                None
            }
            Self::OscEscape(request) => {
                if byte == b'\\' {
                    let completed = request.dynamic_color_index();
                    *self = Self::Ground;
                    return completed.map(OutputEvent::DynamicColorQuery);
                }
                *self = if byte == ESC {
                    Self::OscEscape(*request)
                } else {
                    Self::Ground
                };
                None
            }
        }
    }
}

/// Distinguishes input that can mutate or submit TUI state from negotiated
/// terminal replies, notifications, and no-button pointer motion that share
/// the client-to-PTY byte stream. Exact replies remain recognized after their
/// first query because a late attachment replays that query through its terminal
/// emulator and legitimately produces the same reply again. The classifier
/// retains only bounded protocol parser state and an incomplete negotiated
/// control-reply prefix, never terminal output.
#[derive(Default)]
pub(crate) struct ClientInputActivity {
    protocol: Mutex<ProtocolState>,
    protocol_settled: Condvar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClientInputActivityKind {
    None,
    SubmitOnly,
    Mutating,
}

impl ClientInputActivity {
    pub(crate) fn record_output(&self, bytes: &[u8]) {
        let Ok(mut protocol) = self.protocol.lock() else {
            return;
        };
        for &byte in bytes {
            let Some(event) = protocol.output_parser.advance(byte) else {
                continue;
            };
            match event {
                OutputEvent::Csi(request, final_byte) => {
                    record_request(&mut protocol, request, final_byte);
                }
                OutputEvent::DynamicColorQuery(index) => {
                    protocol.negotiated.dynamic_colors[index] = true;
                }
            }
        }
    }

    pub(crate) fn classify(&self, bytes: &[u8]) -> ClientInputActivityKind {
        let Ok(mut protocol) = self.protocol.lock() else {
            return ClientInputActivityKind::Mutating;
        };
        if protocol.input_fragment.len().saturating_add(bytes.len())
            > MAX_INPUT_PROTOCOL_FRAGMENT_BYTES
        {
            protocol.input_fragment.clear();
            return ClientInputActivityKind::Mutating;
        }
        let mut input = Vec::with_capacity(protocol.input_fragment.len() + bytes.len());
        input.extend_from_slice(&protocol.input_fragment);
        input.extend_from_slice(bytes);
        let activity = match classify_protocol_replies(&input, protocol.modes, &protocol.negotiated)
        {
            ProtocolReplyClassification::Complete => {
                protocol.input_fragment.clear();
                ClientInputActivityKind::None
            }
            ProtocolReplyClassification::Incomplete(offset) => {
                protocol.input_fragment.clear();
                protocol.input_fragment.extend_from_slice(&input[offset..]);
                ClientInputActivityKind::None
            }
            ProtocolReplyClassification::User => {
                protocol.input_fragment.clear();
                if is_submit_only_input(&input, protocol.modes, &protocol.negotiated) {
                    ClientInputActivityKind::SubmitOnly
                } else {
                    ClientInputActivityKind::Mutating
                }
            }
        };
        self.protocol_settled.notify_all();
        activity
    }

    #[cfg(test)]
    pub(crate) fn is_user_activity(&self, bytes: &[u8]) -> bool {
        self.classify(bytes) != ClientInputActivityKind::None
    }

    pub(crate) fn has_incomplete_protocol_reply(&self) -> bool {
        self.protocol
            .lock()
            .map(|protocol| !protocol.input_fragment.is_empty())
            .unwrap_or(true)
    }

    pub(crate) fn wait_for_protocol_reply_settlement(&self, timeout: Duration) -> bool {
        let Ok(protocol) = self.protocol.lock() else {
            return false;
        };
        if protocol.input_fragment.is_empty() {
            return true;
        }
        self.protocol_settled
            .wait_timeout_while(protocol, timeout, |protocol| {
                !protocol.input_fragment.is_empty()
            })
            .map(|(protocol, _)| protocol.input_fragment.is_empty())
            .unwrap_or(false)
    }
}

fn is_submit_only_input(
    mut bytes: &[u8],
    modes: ClientInputModes,
    negotiated: &NegotiatedReplies,
) -> bool {
    let mut saw_submit = false;
    while !bytes.is_empty() {
        if matches!(bytes[0], b'\r' | b'\n') {
            saw_submit = true;
            bytes = &bytes[1..];
            continue;
        }
        if modes.focus_reporting && (bytes.starts_with(FOCUS_IN) || bytes.starts_with(FOCUS_OUT)) {
            bytes = &bytes[FOCUS_IN.len()..];
            continue;
        }
        if let Some((response, consumed)) = parse_csi(bytes) {
            if consume_csi_response(response, modes, negotiated) {
                bytes = &bytes[consumed..];
                continue;
            }
            if kitty_enter_input(response, modes) {
                saw_submit = true;
                bytes = &bytes[consumed..];
                continue;
            }
            return false;
        }
        if negotiated.xtversion
            && let Some(consumed) = parse_xtversion(bytes)
        {
            bytes = &bytes[consumed..];
            continue;
        }
        if let Some((index, consumed)) = parse_dynamic_color(bytes)
            && negotiated.dynamic_colors[index]
        {
            bytes = &bytes[consumed..];
            continue;
        }
        return false;
    }
    saw_submit
}

fn kitty_enter_input(response: ParsedCsi<'_>, modes: ClientInputModes) -> bool {
    if !modes.kitty_keyboard_event_types
        || response.prefix.is_some()
        || !response.intermediates.is_empty()
        || response.final_byte != b'u'
    {
        return false;
    }
    let mut parameters = response.parameters.split(|byte| *byte == b';');
    let Some(key) = parameters.next() else {
        return false;
    };
    let mut key_fields = key.split(|byte| *byte == b':');
    if key_fields.next().and_then(parse_number) != Some(13)
        || key_fields.any(|field| parse_number(field).is_none())
    {
        return false;
    }
    let event_type = match parameters.next() {
        None => 1,
        Some(modifiers_and_event) => {
            let mut fields = modifiers_and_event.split(|byte| *byte == b':');
            if fields.next().and_then(parse_number).is_none() {
                return false;
            }
            match fields.next() {
                Some(event) => match parse_number(event) {
                    Some(event) => event,
                    None => return false,
                },
                None => 1,
            }
        }
    };
    parameters.all(|parameter| {
        !parameter.is_empty()
            && parameter
                .split(|byte| *byte == b':')
                .all(|field| parse_number(field).is_some())
    }) && matches!(event_type, 1 | 2)
}

fn record_request(protocol: &mut ProtocolState, request: CsiRequest, final_byte: u8) {
    if request.invalid {
        return;
    }
    match final_byte {
        b'h' | b'l' if request.prefix == Some(b'?') && request.has_digits && !request.dollar => {
            let enabled = final_byte == b'h';
            match request.value {
                1000 => protocol.modes.mouse_button_reporting = enabled,
                1002 => protocol.modes.mouse_drag_reporting = enabled,
                1003 => protocol.modes.mouse_any_motion = enabled,
                1004 => protocol.modes.focus_reporting = enabled,
                1006 => protocol.modes.mouse_sgr_encoding = enabled,
                2031 => protocol.modes.color_scheme_reporting = enabled,
                _ => {}
            }
        }
        b'c' if !request.dollar && (!request.has_digits || request.value == 0) => {
            let index = match request.prefix {
                None => Some(0),
                Some(b'>') => Some(1),
                Some(b'=') => Some(2),
                _ => None,
            };
            if let Some(index) = index {
                protocol.negotiated.device_attributes[index] = true;
            }
        }
        b'p' if request.dollar
            && request.has_digits
            && matches!(request.prefix, None | Some(b'?')) =>
        {
            let request = ModeRequest {
                private: request.prefix == Some(b'?'),
                mode: request.value,
            };
            if protocol.negotiated.mode_requests.len() < MAX_NEGOTIATED_MODE_REQUESTS
                && !protocol.negotiated.mode_requests.contains(&request)
            {
                protocol.negotiated.mode_requests.push_back(request);
            }
        }
        b'q' if request.prefix == Some(b'>')
            && request.has_digits
            && request.value == 0
            && !request.dollar =>
        {
            protocol.negotiated.xtversion = true;
        }
        b'n' if !request.dollar
            && request.has_digits
            && request.value == 6
            && matches!(request.prefix, None | Some(b'?')) =>
        {
            let index = usize::from(request.prefix == Some(b'?'));
            protocol.negotiated.cursor_positions[index] = true;
        }
        b'n' if !request.dollar
            && request.has_digits
            && request.value == 996
            && request.prefix == Some(b'?') =>
        {
            protocol.negotiated.color_scheme_query = true;
        }
        b'u' if request.prefix == Some(b'?') && !request.has_digits && !request.dollar => {
            protocol.negotiated.keyboard_enhancement = true;
        }
        b'u' if !request.dollar => protocol.modes.record_kitty_keyboard_mode(request),
        _ => {}
    }
}

enum ProtocolReplyClassification {
    Complete,
    Incomplete(usize),
    User,
}

fn classify_protocol_replies(
    mut bytes: &[u8],
    modes: ClientInputModes,
    negotiated: &NegotiatedReplies,
) -> ProtocolReplyClassification {
    if bytes.is_empty() {
        return ProtocolReplyClassification::User;
    }
    let total_len = bytes.len();
    while !bytes.is_empty() {
        if modes.focus_reporting && (bytes.starts_with(FOCUS_IN) || bytes.starts_with(FOCUS_OUT)) {
            bytes = &bytes[FOCUS_IN.len()..];
            continue;
        }
        let offset = total_len - bytes.len();
        if modes.focus_reporting && (FOCUS_IN.starts_with(bytes) || FOCUS_OUT.starts_with(bytes)) {
            return ProtocolReplyClassification::Incomplete(offset);
        }
        if let Some((response, consumed)) = parse_csi(bytes) {
            if !consume_csi_response(response, modes, negotiated) {
                return ProtocolReplyClassification::User;
            }
            bytes = &bytes[consumed..];
            continue;
        }
        if has_possible_csi_input(modes, negotiated) && possible_csi_prefix(bytes) {
            return ProtocolReplyClassification::Incomplete(offset);
        }
        if negotiated.xtversion
            && let Some(consumed) = parse_xtversion(bytes)
        {
            bytes = &bytes[consumed..];
            continue;
        }
        if negotiated.xtversion && possible_xtversion_prefix(bytes) {
            return ProtocolReplyClassification::Incomplete(offset);
        }
        if let Some((index, consumed)) = parse_dynamic_color(bytes)
            && negotiated.dynamic_colors[index]
        {
            bytes = &bytes[consumed..];
            continue;
        }
        if possible_dynamic_color_prefix(bytes, negotiated) {
            return ProtocolReplyClassification::Incomplete(offset);
        }
        return ProtocolReplyClassification::User;
    }
    ProtocolReplyClassification::Complete
}

fn has_possible_csi_input(modes: ClientInputModes, negotiated: &NegotiatedReplies) -> bool {
    modes.focus_reporting
        || (modes.mouse_reporting() && modes.mouse_sgr_encoding)
        || modes.color_scheme_reporting
        || modes.kitty_keyboard_event_types
        || negotiated.device_attributes.iter().any(|seen| *seen)
        || negotiated.cursor_positions.iter().any(|seen| *seen)
        || negotiated.color_scheme_query
        || negotiated.keyboard_enhancement
        || !negotiated.mode_requests.is_empty()
}

fn possible_csi_prefix(bytes: &[u8]) -> bool {
    if bytes.len() > 64
        || !b"\x1b[".starts_with(bytes.get(..bytes.len().min(2)).unwrap_or_default())
    {
        return false;
    }
    if bytes.len() < 2 {
        return true;
    }
    bytes[2..].iter().all(|byte| (0x20..=0x3f).contains(byte))
}

#[derive(Clone, Copy)]
struct ParsedCsi<'a> {
    prefix: Option<u8>,
    parameters: &'a [u8],
    intermediates: &'a [u8],
    final_byte: u8,
}

fn parse_csi(bytes: &[u8]) -> Option<(ParsedCsi<'_>, usize)> {
    if !bytes.starts_with(b"\x1b[") {
        return None;
    }
    let mut index = 2;
    let prefix = bytes
        .get(index)
        .copied()
        .filter(|byte| matches!(*byte, b'?' | b'>' | b'=' | b'<'));
    if prefix.is_some() {
        index += 1;
    }
    let parameters_start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_digit() || matches!(*byte, b';' | b':'))
    {
        index += 1;
    }
    let parameters = bytes.get(parameters_start..index)?;
    let intermediates_start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| (0x20..=0x2f).contains(byte))
    {
        index += 1;
    }
    let intermediates = bytes.get(intermediates_start..index)?;
    let final_byte = *bytes.get(index)?;
    if !(0x40..=0x7e).contains(&final_byte) {
        return None;
    }
    Some((
        ParsedCsi {
            prefix,
            parameters,
            intermediates,
            final_byte,
        },
        index + 1,
    ))
}

fn consume_csi_response(
    response: ParsedCsi<'_>,
    modes: ClientInputModes,
    negotiated: &NegotiatedReplies,
) -> bool {
    match response.final_byte {
        b'c' if response.intermediates.is_empty() && valid_parameter_list(response.parameters) => {
            let index = match response.prefix {
                Some(b'?') => Some(0),
                Some(b'>') => Some(1),
                Some(b'=') => Some(2),
                _ => None,
            };
            if index.is_some_and(|index| negotiated.device_attributes[index]) {
                return true;
            }
            false
        }
        b'y' if response.intermediates == b"$" => {
            let Some((mode, status)) = parse_two_parameters(response.parameters) else {
                return false;
            };
            if status > 4 {
                return false;
            }
            let requested = ModeRequest {
                private: response.prefix == Some(b'?'),
                mode,
            };
            negotiated
                .mode_requests
                .iter()
                .any(|candidate| *candidate == requested)
        }
        b'R' if response.intermediates.is_empty() => {
            let Some((row, column)) = parse_two_parameters(response.parameters) else {
                return false;
            };
            if row == 0 || column == 0 {
                return false;
            }
            let index = match response.prefix {
                None => 0,
                Some(b'?') => 1,
                _ => return false,
            };
            if !negotiated.cursor_positions[index] {
                return false;
            }
            true
        }
        b'u' if response.prefix == Some(b'?')
            && response.intermediates.is_empty()
            && parse_number(response.parameters).is_some() =>
        {
            if !negotiated.keyboard_enhancement {
                return false;
            }
            true
        }
        b'u' if response.prefix.is_none()
            && response.intermediates.is_empty()
            && modes.kitty_keyboard_event_types =>
        {
            kitty_keyboard_event_type(response.parameters) == Some(3)
        }
        b'n' if response.prefix == Some(b'?') && response.intermediates.is_empty() => {
            if !matches!(
                parse_two_parameters(response.parameters),
                Some((997, 1 | 2))
            ) {
                return false;
            }
            if negotiated.color_scheme_query {
                return true;
            }
            modes.color_scheme_reporting
        }
        b'M' | b'm' if response.prefix == Some(b'<') && response.intermediates.is_empty() => {
            let Some((button, column, row)) = parse_three_parameters(response.parameters) else {
                return false;
            };
            if !modes.mouse_reporting() || !modes.mouse_sgr_encoding || column == 0 || row == 0 {
                return false;
            }
            response.final_byte == b'm'
                || button & 0b100_0000 != 0
                || (modes.mouse_any_motion && button & 0b10_0000 != 0 && button & 0b11 == 0b11)
        }
        _ => false,
    }
}

fn valid_parameter_list(bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes
            .split(|byte| *byte == b';')
            .all(|part| !part.is_empty() && part.iter().all(u8::is_ascii_digit))
}

fn parse_two_parameters(bytes: &[u8]) -> Option<(u16, u16)> {
    let separator = bytes.iter().position(|byte| *byte == b';')?;
    if bytes[separator + 1..].contains(&b';') {
        return None;
    }
    Some((
        parse_number(&bytes[..separator])?,
        parse_number(&bytes[separator + 1..])?,
    ))
}

fn parse_three_parameters(bytes: &[u8]) -> Option<(u16, u16, u16)> {
    let first_separator = bytes.iter().position(|byte| *byte == b';')?;
    let second_separator = bytes[first_separator + 1..]
        .iter()
        .position(|byte| *byte == b';')?
        + first_separator
        + 1;
    if bytes[second_separator + 1..].contains(&b';') {
        return None;
    }
    Some((
        parse_number(&bytes[..first_separator])?,
        parse_number(&bytes[first_separator + 1..second_separator])?,
        parse_number(&bytes[second_separator + 1..])?,
    ))
}

fn kitty_keyboard_event_type(bytes: &[u8]) -> Option<u16> {
    let mut parameters = bytes.split(|byte| *byte == b';');
    parse_number(parameters.next()?)?;
    let modifiers_and_event = parameters.next()?;
    let mut fields = modifiers_and_event.split(|byte| *byte == b':');
    parse_number(fields.next()?)?;
    let event_type = parse_number(fields.next()?)?;
    if fields.next().is_some()
        || parameters.any(|parameter| {
            parameter.is_empty()
                || parameter
                    .split(|byte| *byte == b':')
                    .any(|field| parse_number(field).is_none())
        })
    {
        return None;
    }
    Some(event_type)
}

fn parse_number(bytes: &[u8]) -> Option<u16> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0_u16, |value, byte| {
        value.checked_mul(10)?.checked_add(u16::from(*byte - b'0'))
    })
}

fn parse_xtversion(bytes: &[u8]) -> Option<usize> {
    let body = bytes.strip_prefix(b"\x1bP>|")?;
    for (index, byte) in body.iter().copied().enumerate() {
        if byte == ESC {
            return (body.get(index + 1) == Some(&b'\\') && index > 0).then_some(index + 6);
        }
        if index >= MAX_XTVERSION_BODY_BYTES || !(0x20..=0x7e).contains(&byte) {
            return None;
        }
    }
    None
}

fn possible_xtversion_prefix(bytes: &[u8]) -> bool {
    const PREFIX: &[u8] = b"\x1bP>|";
    if bytes.len() <= PREFIX.len() {
        return PREFIX.starts_with(bytes);
    }
    if !bytes.starts_with(PREFIX) {
        return false;
    }
    let body = &bytes[PREFIX.len()..];
    if body.len() > MAX_XTVERSION_BODY_BYTES + 1 {
        return false;
    }
    for (index, byte) in body.iter().copied().enumerate() {
        if byte == ESC {
            return index + 1 == body.len();
        }
        if !(0x20..=0x7e).contains(&byte) {
            return false;
        }
    }
    true
}

fn parse_dynamic_color(bytes: &[u8]) -> Option<(usize, usize)> {
    let body = bytes.strip_prefix(b"\x1b]")?;
    let separator = body.iter().position(|byte| *byte == b';')?;
    let code = parse_number(&body[..separator])?;
    let index = usize::from(code.checked_sub(10)?);
    if index >= 3 {
        return None;
    }
    let mut cursor = separator + 1;
    if body.get(cursor..cursor + 4)? != b"rgb:" {
        return None;
    }
    cursor += 4;
    for component in 0..3 {
        let start = cursor;
        while body.get(cursor).is_some_and(u8::is_ascii_hexdigit) && cursor - start < 4 {
            cursor += 1;
        }
        if cursor == start || body.get(cursor).is_some_and(u8::is_ascii_hexdigit) {
            return None;
        }
        if component < 2 {
            if body.get(cursor) != Some(&b'/') {
                return None;
            }
            cursor += 1;
        }
    }
    let terminator = match body.get(cursor..) {
        Some([0x07, ..]) | Some([0x9c, ..]) => 1,
        Some([ESC, b'\\', ..]) => 2,
        _ => return None,
    };
    Some((index, cursor + terminator + 2))
}

fn possible_dynamic_color_prefix(bytes: &[u8], negotiated: &NegotiatedReplies) -> bool {
    const PREFIXES: [&[u8]; 3] = [b"\x1b]10;rgb:", b"\x1b]11;rgb:", b"\x1b]12;rgb:"];
    PREFIXES.iter().enumerate().any(|(index, prefix)| {
        if !negotiated.dynamic_colors[index] {
            return false;
        }
        if bytes.len() <= prefix.len() {
            return prefix.starts_with(bytes);
        }
        bytes.starts_with(prefix) && possible_rgb_prefix(&bytes[prefix.len()..])
    })
}

fn possible_rgb_prefix(mut bytes: &[u8]) -> bool {
    for component in 0..3 {
        let digits = bytes
            .iter()
            .take_while(|byte| byte.is_ascii_hexdigit())
            .take(5)
            .count();
        if digits > 4 {
            return false;
        }
        bytes = &bytes[digits..];
        if bytes.is_empty() {
            return true;
        }
        if digits == 0 {
            return false;
        }
        if component < 2 {
            if bytes[0] != b'/' {
                return false;
            }
            bytes = &bytes[1..];
            if bytes.is_empty() {
                return true;
            }
        }
    }
    matches!(bytes, [] | [ESC])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiated_focus_reports_are_not_user_activity() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"before\x1b[?10");
        activity.record_output(b"04hafter");

        assert!(!activity.is_user_activity(FOCUS_IN));
        assert!(!activity.is_user_activity(b"\x1b[I\x1b[O"));
        assert!(activity.is_user_activity(b"\x1b[Ix"));
    }

    #[test]
    fn focus_sequences_are_conservative_without_an_enabled_mode() {
        let activity = ClientInputActivity::default();
        assert!(activity.is_user_activity(FOCUS_IN));

        activity.record_output(b"\x1b[?1004h");
        assert!(!activity.is_user_activity(FOCUS_OUT));

        activity.record_output(b"\x1b[?1004l");
        assert!(activity.is_user_activity(FOCUS_IN));
    }

    #[test]
    fn query_bound_terminal_replies_are_not_user_activity() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"\x1b[c\x1b[c\x1b[c\x1b[?20");
        activity.record_output(b"26$p\x1b[>0q\x1b[6n\x1b[?u\x1b]1");
        activity.record_output(b"1;?\x1b\\");

        assert!(!activity.is_user_activity(b"\x1b[?62;22;52c"));
        assert!(!activity.is_user_activity(b"\x1b[?62;22;52c"));
        assert!(!activity.is_user_activity(b"\x1b[?62;22;52c"));
        assert!(!activity.is_user_activity(b"\x1b[?2026;1$y"));
        assert!(!activity.is_user_activity(b"\x1bP>|ghostty 1.2.3\x1b\\"));
        assert!(!activity.is_user_activity(b"\x1b[1;1R"));
        assert!(!activity.is_user_activity(b"\x1b[?5u"));
        assert!(!activity.is_user_activity(b"\x1b]11;rgb:2828/2c2c/3434\x1b\\"));
    }

    #[test]
    fn protocol_replies_require_an_exact_negotiated_query() {
        let activity = ClientInputActivity::default();
        assert!(activity.is_user_activity(b"\x1b[?62;22;52c"));

        activity.record_output(b"\x1b[c\x1b[?2026$p\x1b[>0q\x1b[?u");
        assert!(activity.is_user_activity(b"\x1b[?62;22;52cx"));
        assert!(activity.is_user_activity(b"\x1b[?2025;1$y"));
        assert!(activity.is_user_activity(b"\x1b[1;1R"));
        assert!(activity.is_user_activity(b"\x1b[13;2u"));
        assert!(activity.is_user_activity(b"\x1b[?5ux"));
        assert!(activity.is_user_activity(b"\x1bP>|ghostty\x07"));
        assert!(activity.is_user_activity(b"\x1b]11;rgb:2828/2c2c/3434\x1b\\"));

        assert!(
            !activity
                .is_user_activity(b"\x1b[?62;22c\x1b[?2026;2$y\x1bP>|ghostty 1.2.3\x1b\\\x1b[?5u")
        );
        assert!(
            !activity
                .is_user_activity(b"\x1b[?62;22c\x1b[?2026;2$y\x1bP>|ghostty 1.2.3\x1b\\\x1b[?5u")
        );
    }

    #[test]
    fn fragmented_protocol_reply_remains_pending_until_complete() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"\x1b[6n\x1b]11;?\x07");

        assert!(!activity.is_user_activity(b"\x1b[1;"));
        assert!(activity.has_incomplete_protocol_reply());
        assert!(!activity.is_user_activity(b"1R"));
        assert!(!activity.has_incomplete_protocol_reply());

        assert!(!activity.is_user_activity(b"\x1b]11;rgb:2828/"));
        assert!(activity.has_incomplete_protocol_reply());
        assert!(!activity.is_user_activity(b"2c2c/3434\x1b"));
        assert!(activity.has_incomplete_protocol_reply());
        assert!(!activity.is_user_activity(b"\\"));
        assert!(!activity.has_incomplete_protocol_reply());
    }

    #[test]
    fn protocol_reply_settlement_waits_for_the_remaining_fragment() {
        let activity = std::sync::Arc::new(ClientInputActivity::default());
        activity.record_output(b"\x1b[6n");
        assert!(!activity.is_user_activity(b"\x1b[1;"));

        let completing_activity = std::sync::Arc::clone(&activity);
        let completion = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            assert!(!completing_activity.is_user_activity(b"1R"));
        });

        assert!(activity.wait_for_protocol_reply_settlement(Duration::from_millis(100)));
        completion.join().unwrap();
        assert!(!activity.has_incomplete_protocol_reply());
    }

    #[test]
    fn color_scheme_reports_require_a_query_or_enabled_notifications() {
        let activity = ClientInputActivity::default();
        assert!(activity.is_user_activity(b"\x1b[?997;1n"));

        activity.record_output(b"\x1b[?996n");
        assert!(!activity.is_user_activity(b"\x1b[?997;2n"));
        assert!(!activity.is_user_activity(b"\x1b[?997;2n"));

        activity.record_output(b"\x1b[?2031h");
        assert!(!activity.is_user_activity(b"\x1b[?997;1n"));
        assert!(!activity.is_user_activity(b"\x1b[?997;2n"));
        assert!(activity.is_user_activity(b"\x1b[?997;3n"));

        activity.record_output(b"\x1b[?2031l");
        assert!(!activity.is_user_activity(b"\x1b[?997;1n"));
    }

    #[test]
    fn negotiated_non_mutating_mouse_frames_do_not_mask_mouse_actions() {
        let activity = ClientInputActivity::default();
        assert!(activity.is_user_activity(b"\x1b[<35;12;8M"));
        assert!(activity.is_user_activity(b"\x1b[<0;12;8m"));
        assert!(activity.is_user_activity(b"\x1b[<64;12;8M"));

        activity.record_output(b"\x1b[?1000h\x1b[?1003h\x1b[?1006h");
        assert!(!activity.is_user_activity(b"\x1b[<35;12;8M"));
        assert!(!activity.is_user_activity(b"\x1b[<39;13;8M"));
        assert!(activity.is_user_activity(b"\x1b[<0;12;8M"));
        assert!(!activity.is_user_activity(b"\x1b[<0;12;8m"));
        assert!(activity.is_user_activity(b"\x1b[<32;12;8M"));
        assert!(!activity.is_user_activity(b"\x1b[<64;12;8M"));
        assert!(!activity.is_user_activity(b"\x1b[<68;12;8M"));
        assert!(!activity.is_user_activity(b"\x1b[<81;12;8M"));

        activity.record_output(b"\x1b[?1003l");
        assert!(activity.is_user_activity(b"\x1b[<35;12;8M"));
        assert!(!activity.is_user_activity(b"\x1b[<0;12;8m"));
        assert!(!activity.is_user_activity(b"\x1b[<64;12;8M"));

        activity.record_output(b"\x1b[?1000l");
        assert!(activity.is_user_activity(b"\x1b[<0;12;8m"));
        assert!(activity.is_user_activity(b"\x1b[<64;12;8M"));
    }

    #[test]
    fn negotiated_kitty_key_release_does_not_mask_press_or_repeat() {
        let activity = ClientInputActivity::default();
        assert!(activity.is_user_activity(b"\x1b[13;1:3u"));

        activity.record_output(b"\x1b[>7u");
        assert!(!activity.is_user_activity(b"\x1b[13;1:3u"));
        assert!(activity.is_user_activity(b"\x1b[13;1:1u"));
        assert!(activity.is_user_activity(b"\x1b[13;1:2u"));
        assert!(activity.is_user_activity(b"\x1b[13;1:3:4u"));
        assert!(!activity.is_user_activity(b"\x1b[97;1:3;97u"));

        activity.record_output(b"\x1b[<u");
        assert!(activity.is_user_activity(b"\x1b[13;1:3u"));
    }

    #[test]
    fn enter_is_submit_only_but_other_keyboard_input_is_mutating() {
        let activity = ClientInputActivity::default();

        assert_eq!(
            activity.classify(b"\r"),
            ClientInputActivityKind::SubmitOnly
        );
        assert_eq!(
            activity.classify(b"\r\n"),
            ClientInputActivityKind::SubmitOnly
        );
        assert_eq!(activity.classify(b"x"), ClientInputActivityKind::Mutating);
    }

    #[test]
    fn negotiated_kitty_enter_press_is_submit_only_and_release_is_protocol() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"\x1b[>7u");

        assert_eq!(
            activity.classify(b"\x1b[13u"),
            ClientInputActivityKind::SubmitOnly
        );
        assert_eq!(
            activity.classify(b"\x1b[13;1:1u"),
            ClientInputActivityKind::SubmitOnly
        );
        assert_eq!(
            activity.classify(b"\x1b[13;1:2u"),
            ClientInputActivityKind::SubmitOnly
        );
        assert_eq!(
            activity.classify(b"\x1b[13;1:3u"),
            ClientInputActivityKind::None
        );
        assert_eq!(
            activity.classify(b"\x1b[97u"),
            ClientInputActivityKind::Mutating
        );
    }

    #[test]
    fn protocol_reply_plus_enter_remains_submit_only() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"\x1b[6n");

        assert_eq!(
            activity.classify(b"\x1b[1;1R\r"),
            ClientInputActivityKind::SubmitOnly
        );
    }

    #[test]
    fn fragmented_kitty_key_release_settles_without_user_activity() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"\x1b[>7u");

        assert!(!activity.is_user_activity(b"\x1b[13;"));
        assert!(activity.has_incomplete_protocol_reply());
        assert!(!activity.is_user_activity(b"1:3u"));
        assert!(!activity.has_incomplete_protocol_reply());
    }

    #[test]
    fn kitty_keyboard_mode_stack_restores_event_reporting() {
        let activity = ClientInputActivity::default();
        activity.record_output(b"\x1b[>7u\x1b[>5u");
        assert!(activity.is_user_activity(b"\x1b[13;1:3u"));

        activity.record_output(b"\x1b[<u");
        assert!(!activity.is_user_activity(b"\x1b[13;1:3u"));

        activity.record_output(b"\x1b[=5u");
        assert!(activity.is_user_activity(b"\x1b[13;1:3u"));
    }
}
