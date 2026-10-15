use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;

const HASH: &str = "2419cbfd2f1af27b3668b1fac2c468dedfb9927c12cb3c8a65b32213f8665b70";

/// One verifier record, trimmed from a real Query API answer (2026-10-14).
fn record(name: &str, status: &str, with_source: bool) -> Value {
    let mut r = json!({
        "verifier": { "url": format!("https://results.{name}.example"), "name": name },
        "status": status,
        "bldimg": "registry.example/env@sha256:2e21e7a2605cadca33f938affba710d97de0fd3d8775b0c1efdfd0b0d841997e",
        "bldopt": ["--locked", "--manifest-path=contracts/verified-demo/Cargo.toml", "--package=verified-demo"],
        "source_sha256": "ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533",
        "processed_at": "2026-09-30T10:27:04.170Z",
        "results_urls": [{ "type": "report", "url": format!("https://results.{name}.example/reports/a.json") }]
    });
    if with_source {
        r["verified_source_code_uris"] = json!([{
            "location": "verifier_self_storage",
            "url": format!("https://results.{name}.example/sources/ecf4bc7d.tar.gz")
        }]);
    }
    r
}

fn aggregate(agreement: &str, records: Vec<Value>) -> Aggregate {
    serde_json::from_value(json!({
        "schema": "stellar-verification-aggregate",
        "schema_version": "1.0",
        "wasm_hash": HASH,
        "updated_at": "2026-10-14T13:30:48.961Z",
        "source_code_verifications": records,
        "unavailable_verifiers": [],
        "agreement": agreement
    }))
    .unwrap()
}

fn status_of(agreement: &str, records: Vec<Value>) -> (VerificationStatus, Option<String>) {
    let agg = aggregate(agreement, records);
    let r = reduce(&agg).unwrap();
    (r.status, r.shown.map(|s| s.verifier.name.clone().unwrap()))
}

#[test]
fn reduces_every_agreement_class() {
    use VerificationStatus as S;
    // Verified with published source; the record with source is shown.
    assert_eq!(
        status_of(
            "unanimous_verified",
            vec![
                record("dev", "verified", false),
                record("staging", "verified", true)
            ]
        ),
        (S::Verified, Some("staging".into()))
    );
    // Verified, nothing published (17 of 33 hashes on 2026-10-14).
    assert_eq!(
        status_of("unanimous_verified", vec![record("dev", "verified", false)]),
        (S::VerifiedPrivate, Some("dev".into()))
    );
    // One verifier, mismatched, with the submitted source.
    assert_eq!(
        status_of("single", vec![record("staging", "mismatched", true)]),
        (S::Mismatched, Some("staging".into()))
    );
    // Mismatched without a published archive: status stands, nothing to show.
    assert_eq!(
        status_of("single", vec![record("staging", "mismatched", false)]),
        (S::Mismatched, None)
    );
    assert_eq!(
        status_of(
            "unanimous_mismatched",
            vec![
                record("a", "mismatched", true),
                record("b", "mismatched", true)
            ]
        ),
        (S::Mismatched, Some("a".into()))
    );
    // Disagreement shows the verified side's source.
    assert_eq!(
        status_of(
            "disputed",
            vec![
                record("a", "mismatched", true),
                record("b", "verified", true)
            ]
        ),
        (S::Disputed, Some("b".into()))
    );
    assert_eq!(status_of("no_data", vec![]), (S::None, None));
    assert_eq!(
        status_of("unverified_only", vec![record("a", "pending", false)]),
        (S::Unverified, None)
    );
    // `single` with a status that is neither verified nor mismatched.
    assert_eq!(
        status_of("single", vec![record("a", "pending", false)]),
        (S::Unverified, None)
    );
}

#[test]
fn unknown_agreement_is_an_error() {
    let agg = aggregate("mostly_verified", vec![record("a", "verified", true)]);
    assert!(
        matches!(reduce(&agg), Err(VerificationError::Shape(m)) if m.contains("mostly_verified"))
    );
}

#[test]
fn bare_uri_entries_are_read() {
    let mut r = record("a", "verified", false);
    r["verified_source_code_uris"] = json!(["https://results.a.example/sources/x.zip"]);
    let agg = aggregate("single", vec![r]);
    let shown = reduce(&agg).unwrap().shown.unwrap();
    assert_eq!(
        shown.verified_source_code_uris[0].url(),
        "https://results.a.example/sources/x.zip"
    );
}

#[test]
fn status_names_on_the_wire() {
    use VerificationStatus as S;
    let names: Vec<_> = [
        S::Verified,
        S::VerifiedPrivate,
        S::Mismatched,
        S::Disputed,
        S::Unverified,
        S::None,
    ]
    .iter()
    .map(|s| s.as_str())
    .collect();
    assert_eq!(
        names,
        [
            "verified",
            "verified_private",
            "mismatched",
            "disputed",
            "unverified",
            "none"
        ]
    );
}

async fn server_answering(template: ResponseTemplate) -> (MockServer, SourceVerificationFetcher) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/api/query/v1/wasms/{HASH}")))
        .respond_with(template)
        .mount(&server)
        .await;
    let fetcher =
        SourceVerificationFetcher::new(&format!("{}/api/query/v1/", server.uri())).unwrap();
    (server, fetcher)
}

#[tokio::test]
async fn fetches_the_aggregate_by_hash() {
    let body = json!({
        "wasm_hash": HASH, "updated_at": "2026-10-14T13:30:48.961Z",
        "agreement": "single", "source_code_verifications": [record("a", "verified", true)]
    });
    let (_s, f) = server_answering(ResponseTemplate::new(200).set_body_json(body)).await;
    let agg = f.fetch_aggregate(HASH).await.unwrap();
    assert_eq!(agg.agreement, "single");
    assert_eq!(agg.source_code_verifications.len(), 1);
}

#[tokio::test]
async fn http_error_is_an_error() {
    let (_s, f) = server_answering(ResponseTemplate::new(503)).await;
    assert!(matches!(
        f.fetch_aggregate(HASH).await,
        Err(VerificationError::Status(503))
    ));
}

#[tokio::test]
async fn answer_for_another_hash_is_an_error() {
    let body = json!({
        "wasm_hash": "00".repeat(32), "updated_at": "x",
        "agreement": "no_data", "source_code_verifications": []
    });
    let (_s, f) = server_answering(ResponseTemplate::new(200).set_body_json(body)).await;
    assert!(matches!(
        f.fetch_aggregate(HASH).await,
        Err(VerificationError::Shape(_))
    ));
}

#[tokio::test]
async fn unexpected_document_is_an_error() {
    let (_s, f) = server_answering(ResponseTemplate::new(200).set_body_string("<html>")).await;
    assert!(matches!(
        f.fetch_aggregate(HASH).await,
        Err(VerificationError::Shape(_))
    ));
}

#[test]
fn unset_or_blank_setting_means_no_verifier_service() {
    assert!(
        SourceVerificationFetcher::from_setting(None)
            .unwrap()
            .is_none()
    );
    assert!(
        SourceVerificationFetcher::from_setting(Some("  "))
            .unwrap()
            .is_none()
    );
    let f = SourceVerificationFetcher::from_setting(Some(" https://x.example/api/query/v1/ "))
        .unwrap()
        .expect("a set value builds the client");
    assert_eq!(f.base_url, "https://x.example/api/query/v1");
}

#[test]
fn report_url_is_the_entry_typed_report() {
    let mut r = record("a", "verified", true);
    r["results_urls"] = json!([
        "https://results.a.example/bare.json",
        { "type": "log", "url": "https://results.a.example/log.txt" },
        { "type": "report", "url": "https://results.a.example/reports/r.json" }
    ]);
    let rec: VerifierResult = serde_json::from_value(r).unwrap();
    assert_eq!(
        rec.report_url(),
        Some("https://results.a.example/reports/r.json")
    );
    let mut none = record("a", "verified", true);
    none["results_urls"] = json!([{ "type": "log", "url": "https://results.a.example/log.txt" }]);
    let rec: VerifierResult = serde_json::from_value(none).unwrap();
    assert_eq!(rec.report_url(), None);
}

#[tokio::test]
async fn the_client_does_not_follow_redirects() {
    // The archive host is checked before the download; a redirect would
    // take the request past that check.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/sources/a.zip"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "https://evil.example/x"),
        )
        .mount(&server)
        .await;
    let f = SourceVerificationFetcher::new(&server.uri()).unwrap();
    let err = archive::download(f.http(), &format!("{}/sources/a.zip", server.uri()))
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            archive::ArchiveError::Download(VerificationError::Status(302))
        ),
        "{err}"
    );
}
