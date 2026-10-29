//! Local calendar boundary, matching the desktop's start-of-day grouping.
//! Keep this platform seam here so the rail needs no shared manifest change.
use std::ffi::{c_char, c_int, c_long};

#[repr(C)]
#[derive(Default)]
struct Calendar {
    second: c_int,
    minute: c_int,
    hour: c_int,
    day: c_int,
    month: c_int,
    year: c_int,
    weekday: c_int,
    year_day: c_int,
    daylight: c_int,
    #[cfg(unix)]
    offset: c_long,
    #[cfg(unix)]
    zone: *const c_char,
}

// The pinned syntax reader treats macro token trees opaquely; the compiler
// still checks these edition-2024 declarations and the platform signatures.
macro_rules! calendar_abi {
    ($($declaration:tt)*) => { unsafe extern "C" { $($declaration)* } };
}
#[cfg(unix)]
calendar_abi! {
    fn localtime_r(time: *const c_long, result: *mut Calendar) -> *mut Calendar;
    fn mktime(calendar: *mut Calendar) -> c_long;
}
#[cfg(windows)]
calendar_abi! {
    fn _localtime64_s(result: *mut Calendar, time: *const i64) -> c_int;
    fn _mktime64(calendar: *mut Calendar) -> i64;
}

/// The platform's local calendar fields for an epoch second.
fn local(now: u64) -> Option<Calendar> {
    let mut calendar = Calendar::default();
    #[cfg(unix)]
    {
        let time = c_long::try_from(now).ok()?;
        // SAFETY: Calendar has the platform C tm layout on the supported 64-bit
        // Unix targets. Both pointers refer to live, correctly aligned storage;
        // the reentrant conversion writes only the supplied result.
        if unsafe { localtime_r(&time, &mut calendar) }.is_null() {
            return None;
        }
    }
    #[cfg(windows)]
    {
        let time = i64::try_from(now).ok()?;
        // SAFETY: the Windows tm consists of the nine integer fields above.
        if unsafe { _localtime64_s(&mut calendar, &time) } != 0 {
            return None;
        }
    }
    Some(calendar)
}

/// Local weekday (0 is Sunday), hour and minute for an epoch second.
pub(crate) fn clock(now: u64) -> Option<(i32, i32, i32)> {
    local(now).map(|calendar| (calendar.weekday, calendar.hour, calendar.minute))
}

pub(super) fn midnight(now: u64) -> u64 {
    let fallback = now / 86400 * 86400;
    let Some(mut calendar) = local(now) else {
        return fallback;
    };
    calendar.hour = 0;
    calendar.minute = 0;
    calendar.second = 0;
    // Ask the platform to resolve midnight's DST, rather than reusing the
    // current hour's offset across a clock-change day.
    calendar.daylight = -1;
    #[cfg(unix)]
    // SAFETY: mktime receives the same initialized, platform-layout tm.
    let time = unsafe { mktime(&mut calendar) };
    #[cfg(windows)]
    // SAFETY: _mktime64 receives the initialized Windows tm.
    let time = unsafe { _mktime64(&mut calendar) };
    u64::try_from(time).unwrap_or(fallback)
}
