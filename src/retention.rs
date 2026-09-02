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
}
