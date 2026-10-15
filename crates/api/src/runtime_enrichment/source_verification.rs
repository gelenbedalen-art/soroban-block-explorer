//! Source verification results from a verifier aggregator (task 0639).
//!
//! A contract author submits source to a verifier, which rebuilds the Wasm
//! in a pinned container and compares its hash with the code on chain. The
//! aggregator's Query API (`GET {base}/wasms/{wasm_hash}`) collects the
//! results of several verifiers per Wasm hash. This module reads that answer
//! and reduces it to one [`VerificationStatus`]; [`archive`] downloads and
//! unpacks the published source.
//!
//! Configuration, not code: the client exists only when
//! `SOURCE_VERIFICATION_API_URL` is set (testnet today — the service runs on
//! a staging host). Nothing is stored; responses are cacheable by header.
//! Every failure is an error the handler reports — an unknown `agreement`
//! or `status` value included, so a change on their side is loud here.

pub mod archive;

use std::time::Duration;

use serde::Deserialize;

/// The Query API answers in ~1 s (measured from Europe, 2026-10-14); the
/// budget leaves room for a slow day without holding the Lambda.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

const USER_AGENT: &str = concat!("soroban-block-explorer/", env!("CARGO_PKG_VERSION"));

/// Env var naming the Query API base, e.g.
/// `https://staging.sv.blocksmith.co/api/query/v1`.
pub const API_URL_ENV: &str = "SOURCE_VERIFICATION_API_URL";

#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("source verification API unreachable: {0}")]
    Http(#[from] reqwest::Error),
    #[error("source verification API answered HTTP {0}")]
    Status(u16),
    #[error("source verification API answered an unexpected document: {0}")]
    Shape(String),
}

// ---------------------------------------------------------------------------
// Wire shapes — only the fields we read. Field names are the Query API's
// (OpenAPI `AggregatedWasmStatus`, `AggregatedRegistryVerification`).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct Aggregate {
    pub wasm_hash: String,
    pub updated_at: String,
    pub agreement: String,
    pub source_code_verifications: Vec<VerifierResult>,
}

#[derive(Debug, Deserialize)]
pub struct VerifierResult {
    pub verifier: Verifier,
    pub status: String,
    pub bldimg: Option<String>,
    #[serde(default)]
    pub bldopt: Vec<String>,
    pub source_sha256: Option<String>,
    pub processed_at: Option<String>,
    #[serde(default)]
    pub results_urls: Vec<UriEntry>,
    #[serde(default)]
    pub verified_source_code_uris: Vec<UriEntry>,
}

#[derive(Debug, Deserialize)]
pub struct Verifier {
    pub url: String,
    pub name: Option<String>,
}

/// A bare URI (pre-SEP draft shape) or a `{url, …}` object — the OpenAPI
/// allows both.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum UriEntry {
    Bare(String),
    Entry {
        url: String,
        /// `report` for a verification report (OpenAPI `results_urls`).
        #[serde(rename = "type")]
        kind: Option<String>,
    },
}

impl UriEntry {
    pub fn url(&self) -> &str {
        match self {
            UriEntry::Bare(u) => u,
            UriEntry::Entry { url, .. } => url,
        }
    }
}

impl VerifierResult {
    /// Value of a `--key=value` build option (SEP-58 `bldopt`), e.g. the
    /// `--package` the verifier built — one archive can hold several.
    pub fn build_option(&self, key: &str) -> Option<&str> {
        let prefix = format!("--{key}=");
        self.bldopt
            .iter()
            .find_map(|o| o.strip_prefix(prefix.as_str()))
    }

    /// The verification report, when the verifier typed one as `report`.
    pub fn report_url(&self) -> Option<&str> {
        self.results_urls.iter().find_map(|r| match r {
            UriEntry::Entry { url, kind: Some(k) } if k == "report" => Some(url.as_str()),
            _ => None,
        })
    }
}

// ---------------------------------------------------------------------------
// Reduction to one status
// ---------------------------------------------------------------------------

/// What the contract page shows. One branch point, read off the aggregate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationStatus {
    /// A verifier rebuilt the on-chain Wasm and the source is published.
    Verified,
    /// A verifier rebuilt the on-chain Wasm; the source is not published.
    VerifiedPrivate,
    /// Source was submitted but rebuilt to a different Wasm.
    Mismatched,
    /// Verifiers disagree: at least one verified, at least one did not.
    Disputed,
    /// Results exist, none of them verified or mismatched.
    Unverified,
    /// No verifier holds a result for this Wasm.
    None,
}

impl VerificationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            VerificationStatus::Verified => "verified",
            VerificationStatus::VerifiedPrivate => "verified_private",
            VerificationStatus::Mismatched => "mismatched",
            VerificationStatus::Disputed => "disputed",
            VerificationStatus::Unverified => "unverified",
            VerificationStatus::None => "none",
        }
    }
}

/// The aggregate reduced to the page's status plus the one verifier record
/// whose source and recipe the page shows (`None` when there is none).
pub struct Reduced<'a> {
    pub status: VerificationStatus,
    pub shown: Option<&'a VerifierResult>,
}

/// Reduce the aggregate. `agreement` is the aggregator's own verdict across
/// verifiers (an enum in their OpenAPI — an unknown value is an error);
/// per-verifier `status` picks the record to show. Their OpenAPI leaves
/// `status` an open string and only `verified` / `mismatched` have been
/// seen, so any other value counts as neither and is logged, not guessed.
pub fn reduce(agg: &Aggregate) -> Result<Reduced<'_>, VerificationError> {
    for r in &agg.source_code_verifications {
        if !matches!(r.status.as_str(), "verified" | "mismatched") {
            tracing::warn!(
                wasm_hash = %agg.wasm_hash,
                verifier = %r.verifier.url,
                status = %r.status,
                "source verification: verifier status outside verified/mismatched"
            );
        }
    }
    let has_source = |r: &&VerifierResult| !r.verified_source_code_uris.is_empty();
    let verified_with_source = agg
        .source_code_verifications
        .iter()
        .filter(|r| r.status == "verified")
        .find(has_source);
    let any_verified = agg
        .source_code_verifications
        .iter()
        .find(|r| r.status == "verified");
    let mismatched_with_source = agg
        .source_code_verifications
        .iter()
        .filter(|r| r.status == "mismatched")
        .find(has_source);

    let (status, shown) = match agg.agreement.as_str() {
        "no_data" => (VerificationStatus::None, None),
        "unverified_only" => (VerificationStatus::Unverified, None),
        "disputed" => (
            VerificationStatus::Disputed,
            verified_with_source.or(any_verified),
        ),
        "unanimous_mismatched" => (VerificationStatus::Mismatched, mismatched_with_source),
        // `single`: one verifier answered, its own status decides.
        "single" | "unanimous_verified" => match (verified_with_source, any_verified) {
            (Some(r), _) => (VerificationStatus::Verified, Some(r)),
            (None, Some(r)) => (VerificationStatus::VerifiedPrivate, Some(r)),
            (None, None) if mismatched_with_source.is_some() => {
                (VerificationStatus::Mismatched, mismatched_with_source)
            }
            (None, None)
                if agg
                    .source_code_verifications
                    .iter()
                    .any(|r| r.status == "mismatched") =>
            {
                (VerificationStatus::Mismatched, None)
            }
            (None, None) => (VerificationStatus::Unverified, None),
        },
        other => {
            return Err(VerificationError::Shape(format!(
                "unknown agreement `{other}`"
            )));
        }
    };
    Ok(Reduced { status, shown })
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// Query API client. Cheap to clone (`reqwest::Client` is `Arc`-backed).
#[derive(Clone)]
pub struct SourceVerificationFetcher {
    client: reqwest::Client,
    base_url: String,
}

impl SourceVerificationFetcher {
    /// `None` when `SOURCE_VERIFICATION_API_URL` is unset — the network has
    /// no verifier service and the endpoints answer 404.
    pub fn from_env() -> Result<Option<Self>, reqwest::Error> {
        Self::from_setting(std::env::var(API_URL_ENV).ok().as_deref())
    }

    /// The env value as read: unset or blank means no verifier service.
    fn from_setting(value: Option<&str>) -> Result<Option<Self>, reqwest::Error> {
        match value.map(str::trim) {
            Some(url) if !url.is_empty() => Self::new(url).map(Some),
            _ => Ok(None),
        }
    }

    pub fn new(base_url: &str) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            // The archive host is checked before each download; a redirect
            // would move the request past that check.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_owned(),
        })
    }

    /// The aggregate for one Wasm hash (lowercase hex, 64 chars — the
    /// caller passes the hash our own database holds).
    pub async fn fetch_aggregate(
        &self,
        wasm_hash_hex: &str,
    ) -> Result<Aggregate, VerificationError> {
        let url = format!("{}/wasms/{wasm_hash_hex}", self.base_url);
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(VerificationError::Status(resp.status().as_u16()));
        }
        let agg: Aggregate = resp
            .json()
            .await
            .map_err(|e| VerificationError::Shape(e.to_string()))?;
        // The aggregator keys by hash; an answer for another hash is a bug
        // on one side and must not be shown as this contract's result.
        if !agg.wasm_hash.eq_ignore_ascii_case(wasm_hash_hex) {
            return Err(VerificationError::Shape(format!(
                "asked for {wasm_hash_hex}, answered for {}",
                agg.wasm_hash
            )));
        }
        Ok(agg)
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.client
    }
}

#[cfg(test)]
mod tests;
