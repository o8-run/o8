// Keep in sync with src/lib/models.ts.

pub const CLAUDE_OPUS_4_8: &str = "claude-opus-4-8";
pub const CLAUDE_OPUS_5_5: &str = "claude-opus-5-5";
pub const CLAUDE_FABLE_5_2: &str = "claude-fable-5-2";
pub const CLAUDE_FABLE_5_1: &str = "claude-fable-5-1";
pub const CLAUDE_OPUS_5: &str = "claude-opus-5";
pub const CLAUDE_SONNET_5: &str = "claude-sonnet-5";
pub const CLAUDE_HAIKU_4_5_DATED: &str = "claude-haiku-4-5-20251001";
pub const CLAUDE_FABLE_5: &str = "claude-fable-5";
pub const CODEX_GPT_5_6_SOL: &str = "gpt-5.6-sol";
pub const CODEX_GPT_6_1_SOL: &str = "gpt-6.1-sol";
pub const CODEX_GPT_6_SOL: &str = "gpt-6-sol";
pub const CODEX_GPT_6_LUNA: &str = "gpt-6-luna";
pub const CODEX_GPT_5_6_TERRA: &str = "gpt-5.6-terra";
pub const GEMINI_3_FLASH_PREVIEW: &str = "gemini-3-flash-preview";
// Dictation polish default — A/B 2026-07-07: 426-467ms vs 5.8-6.6s (and cleaner
// corrections) than 3-flash-preview/2.5-flash on the polish task.
pub const GEMINI_2_5_FLASH_LITE: &str = "gemini-2.5-flash-lite";

// Opus at full power for the native-action brain (Q ruling 2026-07-15). The
// Sonnet 5 stint was a speed experiment; the CLI path hides most of the gap,
// so run the strongest model and adjust after shipping if it feels slow.
pub const AGENT_MAC_NATIVE_ACTION_DEFAULT: &str = CLAUDE_OPUS_4_8;
pub const AGENT_INTENT_CLASSIFICATION_DEFAULT: &str = GEMINI_3_FLASH_PREVIEW;
pub const AGENT_RESULT_SUMMARIZATION_DEFAULT: &str = GEMINI_3_FLASH_PREVIEW;
// The background `escalate` brain no longer pins a model of its own: it resolves
// through `agent::planner_route`, which seats the worker/builder tier (#2155).
