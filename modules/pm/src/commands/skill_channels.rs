//! Slack read positions of skills. The agent reads Slack with its own
//! tools; the PM only keeps, per skill and channel, the newest message
//! timestamp a reported run read up to, so the next run starts after it.
//! Positions and skill suggestions expire after 30 days.

use rusqlite::{Connection, params};

use super::check_id;
use crate::delivery::risks::DAY_MS;
use crate::skill::{SKILL_CHANNELS_MAX, SKILL_RUN_SUMMARY_MAX_CHARS, SkillRun, SkillRunOutcome};
use crate::store::{run_by_id, skill_manifest, skill_record};
use crate::validation::valid_label;
use crate::{PmError, PmStore};

/// Read positions and skill suggestions older than this are dropped.
pub const SKILL_SLACK_RETENTION_MS: u64 = 30 * DAY_MS;
pub(crate) const TS_SECONDS_MAX_DIGITS: usize = 12;
pub(crate) const TS_FRACTION_MAX_DIGITS: usize = 8;

/// How far a run read one channel: the `ts` of the newest message it read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChannelWatermark {
    pub channel_id: String,
    pub ts: String,
}

/// A Slack message timestamp, `<seconds>.<fraction>`, as comparable
/// numbers; `None` when it is not one.
pub fn slack_ts_key(ts: &str) -> Option<(u64, u64)> {
    let (seconds, fraction) = ts.split_once('.')?;
    let digits = |part: &str, max: usize| {
        !part.is_empty() && part.len() <= max && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !digits(seconds, TS_SECONDS_MAX_DIGITS) || !digits(fraction, TS_FRACTION_MAX_DIGITS) {
        return None;
    }
    let padded = format!("{fraction:0<TS_FRACTION_MAX_DIGITS$}");
    Some((seconds.parse().ok()?, padded.parse().ok()?))
}

/// The Slack timestamp of a moment, so a read can start after it.
pub fn slack_ts_at(epoch_ms: u64) -> String {
    format!("{}.000000", epoch_ms / 1000)
}

fn channel_watermarks(
    connection: &Connection,
    skill_id: &str,
) -> Result<Vec<ChannelWatermark>, PmError> {
    let mut statement = connection.prepare(
        "SELECT channel_id, ts FROM skill_channel_watermarks WHERE skill_id = ?1 \
         ORDER BY channel_id",
    )?;
    let rows = statement.query_map([skill_id], |row| {
        Ok(ChannelWatermark {
            channel_id: row.get(0)?,
            ts: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

impl PmStore {
    /// Where each channel of the skill was last read up to.
    pub fn skill_channel_watermarks(
        &self,
        skill_id: &str,
    ) -> Result<Vec<ChannelWatermark>, PmError> {
        check_id(skill_id, "skillId")?;
        channel_watermarks(self.connection(), skill_id)
    }

    /// Closes a running run as reported. An installed skill's run also
    /// moves its channels' read positions forward, never back; positions
    /// of channels the skill no longer reads are dropped. A dry run keeps
    /// none.
    pub fn report_skill_run(
        &mut self,
        run_id: &str,
        summary: &str,
        watermarks: &[ChannelWatermark],
    ) -> Result<SkillRun, PmError> {
        if !valid_label(summary, SKILL_RUN_SUMMARY_MAX_CHARS) {
            return Err(PmError::Invalid("summary"));
        }
        if watermarks.len() > SKILL_CHANNELS_MAX
            || !watermarks
                .iter()
                .all(|watermark| slack_ts_key(&watermark.ts).is_some())
        {
            return Err(PmError::Invalid("channelWatermarks"));
        }
        let now = self.now();
        self.write(|transaction| {
            let run = run_by_id(transaction, run_id)?.ok_or(PmError::NotFound)?;
            if !run.is_running() {
                return Err(PmError::Constraint("the run is already closed"));
            }
            if let (Some(skill_id), Some(version)) = (&run.skill_id, run.version) {
                let record = skill_record(transaction, skill_id)?.ok_or(PmError::NotFound)?;
                let manifest =
                    skill_manifest(transaction, skill_id, version, record.builtin.is_some())?;
                if !watermarks
                    .iter()
                    .all(|watermark| manifest.reads_channel(&watermark.channel_id))
                {
                    return Err(PmError::Invalid("channelWatermarks"));
                }
                let known = channel_watermarks(transaction, skill_id)?;
                for watermark in &known {
                    if !manifest.reads_channel(&watermark.channel_id) {
                        transaction.execute(
                            "DELETE FROM skill_channel_watermarks \
                             WHERE skill_id = ?1 AND channel_id = ?2",
                            params![skill_id, watermark.channel_id],
                        )?;
                    }
                }
                for watermark in watermarks {
                    let behind = known.iter().any(|old| {
                        old.channel_id == watermark.channel_id
                            && slack_ts_key(&old.ts) >= slack_ts_key(&watermark.ts)
                    });
                    if behind {
                        continue;
                    }
                    transaction.execute(
                        "INSERT INTO skill_channel_watermarks \
                             (skill_id, channel_id, ts, updated_at_epoch_ms) \
                         VALUES (?1, ?2, ?3, ?4) \
                         ON CONFLICT (skill_id, channel_id) \
                         DO UPDATE SET ts = excluded.ts, \
                             updated_at_epoch_ms = excluded.updated_at_epoch_ms",
                        params![skill_id, watermark.channel_id, watermark.ts, now],
                    )?;
                }
            }
            super::skill::close_run(
                transaction,
                &run,
                SkillRunOutcome::Reported,
                Some(summary),
                now,
            )?;
            run_by_id(transaction, run_id)?.ok_or(PmError::NotFound)
        })
    }

    /// Drops read positions not moved for 30 days and skill suggestions
    /// still waiting after 30 days, with the evidence they carry. Returns
    /// how many suggestions were dropped.
    pub fn expire_skill_data(&mut self, now: u64) -> Result<usize, PmError> {
        let cutoff = now.saturating_sub(SKILL_SLACK_RETENTION_MS);
        self.write(|transaction| {
            transaction.execute(
                "DELETE FROM skill_channel_watermarks WHERE updated_at_epoch_ms < ?1",
                [cutoff],
            )?;
            Ok(transaction.execute(
                "DELETE FROM ticket_proposals \
                 WHERE skill_id IS NOT NULL AND created_at_epoch_ms < ?1",
                [cutoff],
            )?)
        })
    }
}
