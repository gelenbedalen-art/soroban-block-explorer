//! `GET /v1/contracts/{id}/verification` and `…/verified-source` (task 0639).
//!
//! Same shape as `/decompiled`: the contract's current Wasm hash comes from
//! our database (CAP-85 references resolved), the answer from an outside
//! service on request, nothing is stored, and the response carries a cache
//! header. The status is small and fetched with the page; the files are
//! fetched only when the Source code tab opens.

// Helpers return the error `Response` itself, as in `common::path`.
#![allow(clippy::result_large_err)]

use axum::Json;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};

use crate::common::{cache_control, errors, path};
use crate::openapi::schemas::ErrorEnvelope;
use crate::runtime_enrichment::source_verification::archive::{self, ArchiveError};
use crate::runtime_enrichment::source_verification::{
    self, Aggregate, SourceVerificationFetcher, VerificationStatus, VerifierResult,
};
use crate::state::AppState;

use super::dto::{
    BuildRecipe, SourceVerificationResponse, SourceVerifier, VerifiedSourceArchive,
    VerifiedSourceFile, VerifiedSourceResponse,
};
use super::queries;

/// The contract, its current Wasm hash and the aggregator's answer for it —
/// the shared first half of both endpoints. `Err` is the response to send.
struct Lookup {
    contract_id: String,
    wasm_hash: String,
    aggregate: Aggregate,
    /// Kept for `/verified-source`, which downloads the archive with it.
    fetcher: SourceVerificationFetcher,
}

async fn lookup(state: &AppState, contract_id: &str) -> Result<Lookup, Response> {
    path::strkey(contract_id, 'C', "contract_id")?;
    // Unset on networks without a verifier service: an honest 404, and the
    // frontend shows no tab.
    let Some(fetcher) = state.runtime_enrichment.source_verification.clone() else {
        return Err(errors::not_found(
            "source verification is not available on this network",
        ));
    };
    let row = match queries::fetch_wasm_interface(&state.ch(), contract_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return Err(errors::not_found("contract not found")),
        Err(e) => {
            tracing::error!("DB error resolving wasm_hash for {contract_id}: {e}");
            return Err(errors::internal_error(errors::DB_ERROR, "database error"));
        }
    };
    let Some(wasm_hash) = row.wasm_hash else {
        return Err(errors::not_found(
            "contract has no wasm (SAC or pre-upload)",
        ));
    };
    let aggregate = fetcher.fetch_aggregate(&wasm_hash).await.map_err(|e| {
        tracing::error!("source verification lookup failed for {contract_id} ({wasm_hash}): {e}");
        errors::internal_error(
            errors::SOURCE_VERIFICATION_FAILED,
            "the source verification service could not be read",
        )
    })?;
    Ok(Lookup {
        contract_id: row.contract_id,
        wasm_hash,
        aggregate,
        fetcher,
    })
}

fn reduce(l: &Lookup) -> Result<source_verification::Reduced<'_>, Response> {
    source_verification::reduce(&l.aggregate).map_err(|e| {
        tracing::error!(
            "source verification answer unreadable for {} ({}): {e}",
            l.contract_id,
            l.wasm_hash
        );
        errors::internal_error(
            errors::SOURCE_VERIFICATION_FAILED,
            "the source verification service answered an unexpected document",
        )
    })
}

/// The published archive of a record: URL, sha256 and format, or `None`
/// when the record publishes no source. A record that publishes one we
/// cannot use (no sha256, unknown format) is an error, not an absence.
fn archive_of(r: &VerifierResult) -> Result<Option<VerifiedSourceArchive>, ArchiveError> {
    let Some(entry) = r.verified_source_code_uris.first() else {
        return Ok(None);
    };
    let url = entry.url().to_owned();
    let format = archive::format_of(&url)?;
    let sha256 = r
        .source_sha256
        .clone()
        .ok_or_else(|| ArchiveError::Corrupt("published archive without source_sha256".into()))?;
    Ok(Some(VerifiedSourceArchive {
        url,
        sha256,
        format: format.as_str().to_owned(),
    }))
}

fn archive_error(contract_id: &str, e: ArchiveError) -> Response {
    tracing::error!("verified source archive rejected for {contract_id}: {e}");
    errors::internal_error(
        errors::SOURCE_ARCHIVE_INVALID,
        "the verified source archive failed its checks",
    )
}

// ---------------------------------------------------------------------------
// GET /v1/contracts/{contract_id}/verification
// ---------------------------------------------------------------------------

/// What independent verifiers say about the contract's current Wasm.
///
/// Read from the verifier aggregator on request. 404 on a network without
/// a verifier service, for an unknown contract and for one without Wasm.
#[utoipa::path(
    get,
    path = "/contracts/{contract_id}/verification",
    tag = "contracts",
    params(("contract_id" = String, Path, description = "Contract StrKey (C…, 56 chars)")),
    responses(
        (status = 200, description = "Verification status", body = SourceVerificationResponse),
        (status = 400, description = "Invalid contract_id", body = ErrorEnvelope),
        (status = 404, description = "No verifier service on this network, contract not found, or no WASM", body = ErrorEnvelope),
        (status = 500, description = "Verification service unreadable or archive unusable", body = ErrorEnvelope),
    ),
)]
pub async fn get_verification(
    State(state): State<AppState>,
    Path(contract_id): Path<String>,
) -> Response {
    let l = match lookup(&state, &contract_id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    let reduced = match reduce(&l) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let (source, build) = match reduced.shown {
        None => (None, None),
        Some(r) => {
            let source = match archive_of(r) {
                Ok(s) => s,
                Err(e) => return archive_error(&contract_id, e),
            };
            let build = BuildRecipe {
                package: r.build_option("package").map(str::to_owned),
                manifest_path: r.build_option("manifest-path").map(str::to_owned),
                image: r.bldimg.clone(),
                options: r.bldopt.clone(),
                verified_at: r.processed_at.clone(),
                report_url: r.report_url().map(str::to_owned),
            };
            (source, Some(build))
        }
    };
    let mut resp = Json(SourceVerificationResponse {
        contract_id: l.contract_id.clone(),
        wasm_hash: l.wasm_hash.clone(),
        status: reduced.status.as_str().to_owned(),
        checked_at: l.aggregate.updated_at.clone(),
        verifiers: l
            .aggregate
            .source_code_verifications
            .iter()
            .map(|r| SourceVerifier {
                name: r.verifier.name.clone(),
                url: r.verifier.url.clone(),
                status: r.status.clone(),
            })
            .collect(),
        source,
        build,
    })
    .into_response();
    // A new verification can land at any time: the contract-detail tier.
    cache_control::attach(&mut resp, cache_control::MEDIUM);
    resp
}

// ---------------------------------------------------------------------------
// GET /v1/contracts/{contract_id}/verified-source
// ---------------------------------------------------------------------------

/// The shown record's source archive, downloaded from the verifier's own
/// host, checked against its published sha256 and unpacked.
///
/// Only for `verified`: source that did not reproduce the on-chain code
/// (`mismatched`, `disputed`) is not served, and the page shows none of it.
/// 404 for every other status and when no source is published.
#[utoipa::path(
    get,
    path = "/contracts/{contract_id}/verified-source",
    tag = "contracts",
    params(("contract_id" = String, Path, description = "Contract StrKey (C…, 56 chars)")),
    responses(
        (status = 200, description = "Unpacked source archive", body = VerifiedSourceResponse),
        (status = 400, description = "Invalid contract_id", body = ErrorEnvelope),
        (status = 404, description = "No verifier service, contract or WASM, or no published source", body = ErrorEnvelope),
        (status = 500, description = "Verification service unreadable or archive failed its checks", body = ErrorEnvelope),
    ),
)]
pub async fn get_verified_source(
    State(state): State<AppState>,
    Path(contract_id): Path<String>,
) -> Response {
    let l = match lookup(&state, &contract_id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    let reduced = match reduce(&l) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let shown = match (reduced.status, reduced.shown) {
        (VerificationStatus::Verified, Some(r)) => r,
        _ => return errors::not_found("no verified published source for this contract"),
    };
    let published = match archive_of(shown) {
        Ok(Some(a)) => a,
        Ok(None) => return errors::not_found("no published source for this contract"),
        Err(e) => return archive_error(&contract_id, e),
    };
    let checked = async {
        archive::check_host(&published.url, &shown.verifier.url)?;
        let bytes = archive::download(l.fetcher.http(), &published.url).await?;
        archive::check_sha256(&bytes, &published.sha256)?;
        archive::unpack(&bytes, archive::format_of(&published.url)?)
    };
    let files = match checked.await {
        Ok(files) => files,
        Err(e) => return archive_error(&contract_id, e),
    };
    let mut resp = Json(VerifiedSourceResponse {
        contract_id: l.contract_id.clone(),
        wasm_hash: l.wasm_hash.clone(),
        archive_sha256: published.sha256.to_ascii_lowercase(),
        files: files
            .into_iter()
            .map(|f| VerifiedSourceFile {
                path: f.path,
                size: f.size,
                content: f.text,
            })
            .collect(),
    })
    .into_response();
    // The archive is content-addressed, but the contract can move to other
    // code: the `/decompiled` tier.
    cache_control::attach(&mut resp, cache_control::LONG);
    resp
}

#[cfg(test)]
mod tests;
