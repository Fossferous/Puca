//! `GET /source` — where the source of the running server can be obtained.
//!
//! AGPL-3.0 §13: anyone interacting with a modified version over a network is
//! entitled to its Corresponding Source. This route is the server's half of
//! honouring that for every operator, including one who forks and never
//! touches the client: it answers with the repository URL the operator set
//! (`SOURCE_URL`, .env.example) and the commit the binary was built from
//! (`PUCA_GIT_COMMIT`, embedded by build.rs from `git rev-parse` or a
//! `SOURCE_COMMIT` file placed beside Cargo.toml by the release tarball).
//! Public and unauthenticated on purpose: the people it is for have no account.
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct SourceOffer {
    pub repository: String,
    pub commit: &'static str,
    pub license: &'static str,
}

pub const BUILD_COMMIT: &str = env!("PUCA_GIT_COMMIT");

pub fn source_offer() -> SourceOffer {
    SourceOffer {
        repository: std::env::var("SOURCE_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://github.com/Fossferous/Puca".to_string()),
        commit: BUILD_COMMIT,
        license: "AGPL-3.0-or-later",
    }
}

pub async fn get_source() -> Json<SourceOffer> {
    Json(source_offer())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_offer_names_a_repository_a_commit_and_the_license() {
        let o = source_offer();
        assert!(o.repository.starts_with("https://"), "{}", o.repository);
        assert!(!o.commit.is_empty());
        assert_eq!(o.license, "AGPL-3.0-or-later");
    }
}
