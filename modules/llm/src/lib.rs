#![forbid(unsafe_code)]

/// LLM transport is intentionally absent in S0. This marker prevents the
/// Companion process from taking a provider SDK dependency directly.
pub fn gateway_capability() -> &'static str {
    "companion.llm.request"
}
