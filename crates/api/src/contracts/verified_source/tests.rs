//! Handler checks for `/verification` and `/verified-source` (task 0639).
//!
//! The paths that end before the database run everywhere. The full lookup
//! runs against a throwaway database (the real `init.sql`) and a stub Query
//! API, gated on `CH_URL` like the other DB-backed tests:
//!
//!   CH_URL=http://localhost:8123 CH_USER=default CH_PASSWORD=… \
//!     cargo test -p api verified_source

use axum::body;
use axum::http::StatusCode;
use serde_json::{Value, json};
use wiremock::matchers::{method, path as url_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::runtime_enrichment::{self, RuntimeEnrichment};

/// A real testnet contract id — the handlers validate the StrKey.
const CONTRACT: &str = "CD37GB5NIHBI5EGUNIJXEHDNVDDG23HJAVSJTAKSMDQQVKJMBSK6E5EW";
const DB: &str = "api_test_0639_verified_source";

fn state(
    ch: clickhouse::Client,
    source_verification: Option<SourceVerificationFetcher>,
) -> AppState {
    let unused = || vec!["http://unused".to_owned()];
    let runtime_enrichment = RuntimeEnrichment {
        stellar_archive: runtime_enrichment::stellar_archive::StellarArchiveFetcher::new(
            runtime_enrichment::stellar_archive::test_client(),
        ),
        sep1: runtime_enrichment::sep1::Sep1Fetcher::new().expect("build sep1 fetcher"),
        nft_token_uri: runtime_enrichment::nft_token_uri::NftTokenUriFetcher::with_rpc_url(
            "http://unused".to_owned(),
        )
        .expect("build nft_token_uri fetcher"),
        wasm_code: runtime_enrichment::wasm_code::WasmCodeFetcher::with_rpc_urls(unused())
            .expect("build wasm_code fetcher"),
        account_sponsors:
            runtime_enrichment::account_sponsors::AccountSponsorsFetcher::with_rpc_urls(unused())
                .expect("build account_sponsors fetcher"),
        source_verification,
    };
    AppState::for_tests(ch, runtime_enrichment)
}

async fn json_of(resp: Response) -> (StatusCode, Option<String>, Value) {
    let status = resp.status();
    let cache = resp
        .headers()
        .get("cache-control")
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, cache, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn no_verifier_service_is_a_404_before_any_query() {
    // Unconnected client: reaching the database would fail the test.
    let st = state(clickhouse::Client::default(), None);
    for resp in [
        get_verification(State(st.clone()), Path(CONTRACT.to_owned())).await,
        get_verified_source(State(st.clone()), Path(CONTRACT.to_owned())).await,
    ] {
        let (status, _, body) = json_of(resp).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("not available on this network"),
            "{body}"
        );
    }
}

#[tokio::test]
async fn invalid_contract_id_is_a_400() {
    let st = state(clickhouse::Client::default(), None);
    let (status, _, _) = json_of(get_verification(State(st), Path("GABC".to_owned())).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

fn hash() -> String {
    "aa".repeat(32)
}

/// One verifier record in the Query API's shape.
fn record(status: &str, archive: Option<&str>) -> Value {
    let mut r = json!({
        "verifier": { "url": "https://results.staging.example", "name": "SCVS Staging Verifier" },
        "status": status,
        "bldimg": "registry.example/env@sha256:2e21e7a2605cadca33f938affba710d97de0fd3d8775b0c1efdfd0b0d841997e",
        "bldopt": ["--locked", "--manifest-path=workers/dvn/Cargo.toml", "--package=dvn"],
        "source_sha256": "3ee9dbfefc5fe690b8a2bb19f495905bc1e25f98c349be816ffaab4e6073db03",
        "processed_at": "2026-10-08T02:51:00.000Z",
        "results_urls": [{ "type": "report", "url": "https://results.staging.example/reports/r.json" }]
    });
    if let Some(url) = archive {
        r["verified_source_code_uris"] =
            json!([{ "location": "verifier_self_storage", "url": url }]);
    }
    r
}

async fn query_api(agreement: &str, records: Vec<Value>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(url_path(format!("/api/query/v1/wasms/{}", hash())))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "wasm_hash": hash(),
            "updated_at": "2026-10-14T13:30:48.961Z",
            "agreement": agreement,
            "source_code_verifications": records
        })))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn verification_reads_the_contract_hash_and_the_aggregator() {
    let Some(base) = crate::common::ch::test_client_from_env() else {
        eprintln!("CH_URL unset — skipping verified-source handler check");
        return;
    };
    base.query(&format!("DROP DATABASE IF EXISTS {DB}"))
        .execute()
        .await
        .expect("drop");
    base.query(&format!("CREATE DATABASE {DB}"))
        .execute()
        .await
        .expect("create");
    let ch = base.clone().with_database(DB);
    db_clickhouse::apply_init_sql(&ch)
        .await
        .expect("apply init.sql");
    ch.query(&format!(
        "INSERT INTO soroban_contracts (id, contract_id, wasm_hash, wasm_uploaded_at_ledger, \
         deployer_id, deployed_at_ledger, contract_type, is_sac) VALUES \
         (1, '{CONTRACT}', unhex('{}'), 100, NULL, 100, 1, false)",
        hash()
    ))
    .execute()
    .await
    .expect("seed contract");

    let fetcher_for = |server: &MockServer| {
        Some(SourceVerificationFetcher::new(&format!("{}/api/query/v1", server.uri())).unwrap())
    };

    // ---- verified, source published ----
    let archive = "https://results.staging.example/sources/3ee9dbfe.zip";
    let server = query_api(
        "unanimous_verified",
        vec![record("verified", Some(archive))],
    )
    .await;
    let st = state(ch.clone(), fetcher_for(&server));
    let (status, cache, body) =
        json_of(get_verification(State(st), Path(CONTRACT.to_owned())).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(cache.as_deref(), Some("public, max-age=60"));
    assert_eq!(body["wasm_hash"], hash());
    assert_eq!(body["status"], "verified");
    assert_eq!(body["checked_at"], "2026-10-14T13:30:48.961Z");
    assert_eq!(body["verifiers"][0]["name"], "SCVS Staging Verifier");
    assert_eq!(body["source"]["url"], archive);
    assert_eq!(body["source"]["format"], "zip");
    assert_eq!(body["build"]["package"], "dvn");
    assert_eq!(body["build"]["manifest_path"], "workers/dvn/Cargo.toml");
    assert_eq!(
        body["build"]["report_url"],
        "https://results.staging.example/reports/r.json"
    );

    // ---- verified, nothing published: no source, and no files endpoint ----
    let server = query_api("unanimous_verified", vec![record("verified", None)]).await;
    let st = state(ch.clone(), fetcher_for(&server));
    let (_, _, body) =
        json_of(get_verification(State(st.clone()), Path(CONTRACT.to_owned())).await).await;
    assert_eq!(body["status"], "verified_private");
    assert_eq!(body["source"], Value::Null);
    let (status, _, _) =
        json_of(get_verified_source(State(st), Path(CONTRACT.to_owned())).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // ---- submitted source that did not verify is not served ----
    for agreement in ["single", "disputed"] {
        let records = if agreement == "single" {
            vec![record("mismatched", Some(archive))]
        } else {
            vec![
                record("mismatched", Some(archive)),
                record("verified", Some(archive)),
            ]
        };
        let server = query_api(agreement, records).await;
        let st = state(ch.clone(), fetcher_for(&server));
        let (_, _, body) =
            json_of(get_verification(State(st.clone()), Path(CONTRACT.to_owned())).await).await;
        assert_ne!(body["status"], "verified", "{agreement}: {body}");
        let (status, _, _) =
            json_of(get_verified_source(State(st), Path(CONTRACT.to_owned())).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{agreement}");
    }

    // ---- an archive off the verifier's host is refused, not fetched ----
    let server = query_api(
        "single",
        vec![record(
            "verified",
            Some("https://elsewhere.example/sources/3ee9dbfe.zip"),
        )],
    )
    .await;
    let st = state(ch.clone(), fetcher_for(&server));
    let (status, _, body) =
        json_of(get_verified_source(State(st), Path(CONTRACT.to_owned())).await).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "source_archive_invalid");

    // ---- the aggregator down: a loud 500, never "not verified" ----
    let down = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&down)
        .await;
    let st = state(ch.clone(), fetcher_for(&down));
    let (status, _, body) =
        json_of(get_verification(State(st), Path(CONTRACT.to_owned())).await).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "source_verification_failed");

    // ---- an unknown contract never reaches the aggregator ----
    let st = state(ch.clone(), fetcher_for(&down));
    let (status, _, _) = json_of(
        get_verification(
            State(st),
            Path("CA22CTI77LDCCJZJSTGFPJVH7Q5BEAUPLPQW3XFXQOSKI7O3I2VRU6QN".to_owned()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    base.query(&format!("DROP DATABASE IF EXISTS {DB}"))
        .execute()
        .await
        .expect("drop");
}
