//! Retention windows for the two moderation tables that only ever grew.
//!
//! `reports` and `audit_log` had length caps and a rate limit but no pruning,
//! so a busy server carried every resolved report and every audit row for the
//! life of the database. A periodic sweep (main.rs) now deletes resolved
//! reports and audit rows older than a window. Deleting moderation history is
//! irreversible, so the defaults are generous and an operator with a
//! compliance need can opt out: `REPORTS_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS`
//! set to `0` means keep forever. Pending reports are never pruned.

pub const REPORTS_RETENTION_DAYS_DEFAULT: i64 = 180;
pub const AUDIT_RETENTION_DAYS_DEFAULT: i64 = 365;

/// How long `task_create_keys` (migration 070) remembers that a create
/// happened. A retry chain lasts minutes; a day is generous. `0` keeps them
/// forever, which is an operator's choice and not a default, because the
/// window is what bounds how long a create id exists at all.
pub const OP_KEY_RETENTION_HOURS_DEFAULT: i64 = 24;

/// The retention window in HOURS for `var`, with the same contract as
/// `retention_days`: 0 = keep forever, and anything unparseable or out of
/// range falls back to the default rather than to "prune everything".
pub fn retention_hours(var: &str, default: i64) -> Option<i64> {
    let hours = std::env::var(var)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        // Bounded for the same reason as retention_days: the sweep binds the
        // window as i32 hours. A century of hours is plenty.
        .filter(|h| (0..=876_000).contains(h))
        .unwrap_or(default);
    if hours == 0 { None } else { Some(hours) }
}

/// The retention window in days for `var`, or None when the operator opted out
/// (0) — an unparseable value falls back to the default rather than to "prune
/// everything" or "keep forever", either of which would be a surprise.
pub fn retention_days(var: &str, default: i64) -> Option<i64> {
    let days = std::env::var(var)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        // Bounded: the sweep binds the window as i32 days, and a value past
        // 2^31 would wrap negative and delete everything. A century is plenty.
        .filter(|d| (0..=36_500).contains(d))
        .unwrap_or(default);
    if days == 0 { None } else { Some(days) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_means_keep_forever_and_garbage_means_the_default() {
        let var = "PUCA_TEST_RETENTION_DAYS";
        std::env::set_var(var, "0");
        assert_eq!(retention_days(var, 180), None, "0 = opt out");
        std::env::set_var(var, "30");
        assert_eq!(retention_days(var, 180), Some(30));
        std::env::set_var(var, "-5");
        assert_eq!(retention_days(var, 180), Some(180), "negative: default, not prune-all");
        std::env::set_var(var, "2147483648");
        assert_eq!(retention_days(var, 180), Some(180), "past i32: default, not a wrapped window");
        std::env::set_var(var, "soon");
        assert_eq!(retention_days(var, 180), Some(180));
        std::env::remove_var(var);
        assert_eq!(retention_days(var, 180), Some(180), "unset: default");
    }

    #[test]
    fn the_op_key_window_is_hours_with_the_same_opt_out() {
        let var = "PUCA_TEST_RETENTION_HOURS";
        std::env::remove_var(var);
        assert_eq!(retention_hours(var, 24), Some(24), "unset: default");
        // The positive control: a real window is honoured, so the negative
        // cases below cannot pass just because everything returns the default.
        std::env::set_var(var, "6");
        assert_eq!(retention_hours(var, 24), Some(6));
        std::env::set_var(var, "0");
        assert_eq!(retention_hours(var, 24), None, "0 = keep forever");
        std::env::set_var(var, "-1");
        assert_eq!(retention_hours(var, 24), Some(24), "negative: default, not prune-all");
        std::env::set_var(var, "2147483648");
        assert_eq!(retention_hours(var, 24), Some(24), "past i32: default, not a wrapped window");
        std::env::set_var(var, "later");
        assert_eq!(retention_hours(var, 24), Some(24));
        std::env::remove_var(var);
    }
}
