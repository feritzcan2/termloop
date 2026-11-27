//! Wall-clock reading in a named IANA time zone, from the bundled time zone
//! database so a daemon on a UTC server reads the user's own hours.

/// Where an instant falls on the wall clock of one time zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZonedClock {
    /// Minutes since local midnight, `0..1440`.
    pub minute_of_day: u16,
    /// Milliseconds already elapsed within that minute, `0..60_000`.
    pub ms_into_minute: u64,
}

/// The wall clock of `time_zone` at `epoch_ms`. `None` when the zone is not
/// a known IANA name or the instant is out of range.
pub fn zoned_clock(epoch_ms: u64, time_zone: &str) -> Option<ZonedClock> {
    let zone = jiff::tz::TimeZone::get(time_zone).ok()?;
    let instant = jiff::Timestamp::from_millisecond(i64::try_from(epoch_ms).ok()?).ok()?;
    let local = instant.to_zoned_datetime(zone);
    Some(ZonedClock {
        minute_of_day: u16::try_from(local.hour()).ok()? * 60
            + u16::try_from(local.minute()).ok()?,
        ms_into_minute: u64::try_from(local.second()).ok()? * 1000
            + u64::try_from(local.millisecond()).ok()?,
    })
}

/// Whether `time_zone` names a zone the bundled database knows.
pub fn time_zone_is_known(time_zone: &str) -> bool {
    jiff::tz::TimeZone::get(time_zone).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_wall_clock_of_the_named_zone() {
        // 2026-01-15T08:30:12.500Z
        let winter = 1_768_465_812_500;
        assert_eq!(
            zoned_clock(winter, "UTC"),
            Some(ZonedClock {
                minute_of_day: 8 * 60 + 30,
                ms_into_minute: 12_500
            })
        );
        assert_eq!(
            zoned_clock(winter, "Europe/Berlin").unwrap().minute_of_day,
            9 * 60 + 30
        );
        // 2026-07-15T08:30:00Z: Berlin is on summer time.
        assert_eq!(
            zoned_clock(1_784_104_200_000, "Europe/Berlin")
                .unwrap()
                .minute_of_day,
            10 * 60 + 30
        );
        assert_eq!(zoned_clock(winter, "Mars/Olympus"), None);
        assert!(time_zone_is_known("Europe/Istanbul"));
        assert!(!time_zone_is_known("Mars/Olympus"));
    }
}
