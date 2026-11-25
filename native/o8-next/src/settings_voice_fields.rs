//! Classic Voice > Proactive attention: Broadcast commentary and the automation and Calendar
//! posts, using their shared persisted settings.
use super::*;
pub(super) const FIELDS: &[Field] = &[
    field(
        "broadcastCommentary",
        "Automatic AI commentary",
        "voice",
        "Generate periodic activity summaries using your model allowance. Turning this off keeps messages and approvals available.",
        Kind::WordToggle("interval"),
    ),
    field(
        "broadcastVoice",
        "Automation and Calendar posts",
        "voice",
        "Let scheduled automation check-ins and upcoming Calendar events post to the Broadcast feed.",
        Kind::WordToggle("on"),
    ),
    field(
        "broadcastCommentaryMaxPerHour",
        "Hourly budget",
        "voice",
        "Maximum automatic commentary in any rolling hour (1–60).",
        NUMBER,
    ),
    field(
        "broadcastVoiceCalendar",
        "Calendar events",
        "voice",
        "Post an upcoming timed event once, before it starts.",
        BOOL,
    ),
    field(
        "broadcastVoiceCalendarLeadMinutes",
        "Calendar lead time",
        "voice",
        "Minutes before an event becomes eligible for one deduplicated post (1–1440).",
        NUMBER,
    ),
    field(
        "broadcastVoiceTimeCheckins",
        "Time check-ins",
        "voice",
        "Let a scheduled automation post one focus-aware check-in.",
        BOOL,
    ),
];
