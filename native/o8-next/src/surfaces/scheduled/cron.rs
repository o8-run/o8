//! Standard five-field cron, ported from src/lib/automations/cron.ts so the
//! editor can check an expression and name its next run as the desktop does.
//! `*`, numbers, lists, ranges and steps; 7 is Sunday in the weekday field; when
//! both day fields are restricted, either one matching is enough.

/// One local minute, as the expression reads it.
#[derive(Clone, Copy)]
pub(super) struct Moment {
    pub month: u32,
    pub day: u32,
    pub weekday: u32,
    pub hour: u32,
    pub minute: u32,
}

pub(super) struct Cron {
    minute: u64,
    hour: u64,
    day: u64,
    month: u64,
    weekday: u64,
    day_restricted: bool,
    weekday_restricted: bool,
}

fn expand(field: &str, min: u32, max: u32, weekday: bool) -> Option<u64> {
    let mut out = 0;
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().ok().filter(|s| *s >= 1)?),
            None => (part, 1),
        };
        let (mut start, mut end) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (a.parse().ok()?, b.parse().ok()?)
        } else {
            let value = range.parse().ok()?;
            (value, value)
        };
        if weekday {
            start = if start == 7 { 0 } else { start };
            end = if end == 7 { 0 } else { end };
        }
        if start < min || end > max || start > end {
            return None;
        }
        out |= (start..=end)
            .step_by(step as usize)
            .fold(0, |bits, value| bits | 1u64 << value);
    }
    Some(out)
}

impl Cron {
    pub(super) fn parse(expr: &str) -> Option<Self> {
        let [minute, hour, day, month, weekday] = expr
            .split_whitespace()
            .collect::<Vec<_>>()
            .try_into()
            .ok()?;
        Some(Self {
            minute: expand(minute, 0, 59, false)?,
            hour: expand(hour, 0, 23, false)?,
            day: expand(day, 1, 31, false)?,
            month: expand(month, 1, 12, false)?,
            weekday: expand(weekday, 0, 6, true)?,
            day_restricted: day != "*",
            weekday_restricted: weekday != "*",
        })
    }

    fn date_matches(&self, at: Moment) -> bool {
        let day = self.day >> at.day & 1 == 1;
        let weekday = self.weekday >> at.weekday & 1 == 1;
        self.month >> at.month & 1 == 1
            && match (self.day_restricted, self.weekday_restricted) {
                (true, true) => day || weekday,
                (true, false) => day,
                (false, true) => weekday,
                (false, false) => true,
            }
    }

    /// The first matching minute after `from` (epoch seconds), within a year.
    pub(super) fn next(
        &self,
        from: u64,
        local: impl Fn(u64) -> Option<Moment>,
    ) -> Option<(u64, Moment)> {
        let ceiling = from + 366 * 86_400;
        let mut at = (from / 60 + 1) * 60;
        while at <= ceiling {
            let moment = local(at)?;
            if !self.date_matches(moment) || self.hour >> moment.hour & 1 == 0 {
                // Whole hours at a time: a cron that rarely fires stays cheap.
                at += 60 * u64::from(60 - moment.minute);
            } else if self.minute >> moment.minute & 1 == 1 {
                return Some((at, moment));
            } else {
                at += 60;
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plain calendar: every month has 31 days and 1970-01-01 is a Thursday.
    fn plain(at: u64) -> Option<Moment> {
        let days = at / 86_400;
        Some(Moment {
            month: (days / 31 % 12) as u32 + 1,
            day: (days % 31) as u32 + 1,
            weekday: ((days + 4) % 7) as u32,
            hour: (at / 3600 % 24) as u32,
            minute: (at / 60 % 60) as u32,
        })
    }

    #[test]
    fn cron_accepts_what_the_desktop_accepts() {
        for good in [
            "0 9 * * *",
            "*/15 9-17 * * 1-5",
            "0,30 * 1 1 7",
            "1-10/2 * * * *",
        ] {
            assert!(Cron::parse(good).is_some(), "{good}");
        }
        for bad in [
            "",
            "0 9 * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "5-1 * * * *",
            "*/0 * * * *",
            "a * * * *",
            "* * * * 5-7",
        ] {
            assert!(Cron::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn cron_finds_the_next_minute_after_now() {
        let cron = Cron::parse("30 9 * * *").unwrap();
        let (at, moment) = cron.next(9 * 3600, plain).unwrap();
        assert_eq!(at, 9 * 3600 + 30 * 60);
        assert_eq!((moment.hour, moment.minute), (9, 30));
        // Exactly on the minute moves on to tomorrow, as the desktop's does.
        assert_eq!(cron.next(at, plain).unwrap().0, at + 86_400);
    }

    #[test]
    fn cron_reads_both_day_fields_as_either() {
        // Day 5 is a Monday in the plain calendar; Friday is day 2.
        let cron = Cron::parse("0 0 5 * 5").unwrap();
        assert_eq!(cron.next(0, plain).unwrap().1.day, 2);
    }

    #[test]
    fn cron_that_never_fires_within_a_year_has_no_next_run() {
        assert!(
            Cron::parse("0 0 31 2 *")
                .unwrap()
                .next(0, |at| {
                    plain(at).map(|moment| Moment {
                        day: moment.day.min(28),
                        ..moment
                    })
                })
                .is_none()
        );
    }
}
