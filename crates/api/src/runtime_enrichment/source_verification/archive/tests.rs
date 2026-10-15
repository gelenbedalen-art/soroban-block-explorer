use std::io::Write;

use super::*;

/// A `.tar.gz` holding `entries`, plus one directory entry that must be skipped.
fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(gz);
    let mut dir = tar::Header::new_gnu();
    dir.set_entry_type(tar::EntryType::Directory);
    dir.set_size(0);
    builder
        .append_data(&mut dir, "source/", std::io::empty())
        .unwrap();
    for (path, body) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        builder.append_data(&mut header, path, *body).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    w.add_directory("contracts/", opts).unwrap();
    for (path, body) in entries {
        w.start_file(*path, opts).unwrap();
        w.write_all(body).unwrap();
    }
    w.finish().unwrap().into_inner()
}

#[test]
fn unpacks_tar_gz_sorted_and_skips_directories() {
    let bytes = tar_gz(&[
        ("source/src/lib.rs", b"#![no_std]\n"),
        ("source/Cargo.toml", b"[package]\n"),
    ]);
    let files = unpack(&bytes, ArchiveFormat::TarGz).unwrap();
    assert_eq!(
        files,
        vec![
            SourceFile {
                path: "source/Cargo.toml".into(),
                size: 10,
                text: Some("[package]\n".into())
            },
            SourceFile {
                path: "source/src/lib.rs".into(),
                size: 11,
                text: Some("#![no_std]\n".into())
            },
        ]
    );
}

#[test]
fn unpacks_zip_and_skips_directories() {
    let bytes = zip(&[("contracts/workers/dvn/src/lib.rs", b"pub mod dvn;\n")]);
    let files = unpack(&bytes, ArchiveFormat::Zip).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "contracts/workers/dvn/src/lib.rs");
    assert_eq!(files[0].text.as_deref(), Some("pub mod dvn;\n"));
}

#[test]
fn non_utf8_file_stays_listed_without_text() {
    let bytes = tar_gz(&[("source/logo.png", &[0x89, 0x50, 0xff, 0xfe])]);
    let files = unpack(&bytes, ArchiveFormat::TarGz).unwrap();
    assert_eq!(files[0].path, "source/logo.png");
    assert_eq!(files[0].size, 4);
    assert_eq!(files[0].text, None);
}

#[test]
fn too_many_files_is_an_error() {
    let names: Vec<String> = (0..=MAX_FILES).map(|i| format!("f{i}")).collect();
    let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
    let err = unpack(&zip(&entries), ArchiveFormat::Zip).unwrap_err();
    assert!(matches!(err, ArchiveError::UnpackCapExceeded), "{err}");
}

#[test]
fn exactly_max_files_unpacks() {
    let names: Vec<String> = (0..MAX_FILES).map(|i| format!("f{i}")).collect();
    let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
    assert_eq!(
        unpack(&zip(&entries), ArchiveFormat::Zip).unwrap().len(),
        MAX_FILES
    );
}

#[test]
fn unpacked_bytes_over_the_cap_is_an_error() {
    // Zeros compress to almost nothing: a small archive that unpacks past the cap.
    let big = vec![0u8; MAX_UNPACKED_BYTES as usize + 1];
    let err = unpack(&tar_gz(&[("source/big", &big)]), ArchiveFormat::TarGz).unwrap_err();
    assert!(matches!(err, ArchiveError::UnpackCapExceeded), "{err}");
}

#[test]
fn unpacked_bytes_at_the_cap_unpack() {
    let exact = vec![0u8; MAX_UNPACKED_BYTES as usize];
    let files = unpack(&tar_gz(&[("source/big", &exact)]), ArchiveFormat::TarGz).unwrap();
    assert_eq!(files[0].size, MAX_UNPACKED_BYTES);
}

#[test]
fn garbage_is_corrupt_not_empty() {
    assert!(matches!(
        unpack(b"not an archive", ArchiveFormat::Zip),
        Err(ArchiveError::Corrupt(_))
    ));
    assert!(matches!(
        unpack(b"not an archive", ArchiveFormat::TarGz),
        Err(ArchiveError::Corrupt(_))
    ));
}

#[test]
fn sha256_must_match_case_insensitively() {
    // sha256("abc")
    let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    check_sha256(b"abc", abc).unwrap();
    check_sha256(b"abc", &abc.to_uppercase()).unwrap();
    let err = check_sha256(b"abd", abc).unwrap_err();
    assert!(matches!(err, ArchiveError::ShaMismatch { .. }), "{err}");
}

#[test]
fn format_comes_from_the_extension() {
    let base = "https://results.example/sources/ab";
    assert_eq!(
        format_of(&format!("{base}.tar.gz")).unwrap(),
        ArchiveFormat::TarGz
    );
    assert_eq!(
        format_of(&format!("{base}.tgz")).unwrap(),
        ArchiveFormat::TarGz
    );
    assert_eq!(
        format_of(&format!("{base}.zip")).unwrap(),
        ArchiveFormat::Zip
    );
    assert!(matches!(
        format_of(&format!("{base}.rar")),
        Err(ArchiveError::UnknownFormat(_))
    ));
}

#[test]
fn archive_must_be_https_on_the_verifier_host() {
    let verifier = "https://results.staging.example";
    check_host("https://results.staging.example/sources/a.zip", verifier).unwrap();
    for bad in [
        "http://results.staging.example/sources/a.zip",
        "https://evil.example/sources/a.zip",
        "https://results.staging.example.evil.example/a.zip",
        "file:///etc/passwd",
        "not a url",
    ] {
        assert!(
            matches!(check_host(bad, verifier), Err(ArchiveError::ForeignUrl(_))),
            "{bad} must be refused"
        );
    }
}

#[test]
fn a_realistic_project_size_unpacks() {
    // The largest archive published so far unpacks to 1.46 MB; 3 MB in one
    // file must fit comfortably under the caps.
    let body = vec![b'a'; 3 * 1024 * 1024];
    let files = unpack(&tar_gz(&[("source/big.rs", &body)]), ArchiveFormat::TarGz).unwrap();
    assert_eq!(files[0].size, 3 * 1024 * 1024);
}

#[test]
fn the_unpack_cap_counts_every_file_together() {
    // Two files of 60% of the cap each: each fits alone, both do not.
    let part = vec![0u8; (MAX_UNPACKED_BYTES as usize) * 6 / 10];
    let err = unpack(
        &tar_gz(&[("source/a", &part), ("source/b", &part)]),
        ArchiveFormat::TarGz,
    )
    .unwrap_err();
    assert!(matches!(err, ArchiveError::UnpackCapExceeded), "{err}");
}

mod download {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::*;

    async fn serving(status: u16, body: Vec<u8>) -> (MockServer, String) {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/sources/a.zip"))
            .respond_with(ResponseTemplate::new(status).set_body_bytes(body))
            .mount(&server)
            .await;
        let url = format!("{}/sources/a.zip", server.uri());
        (server, url)
    }

    #[tokio::test]
    async fn returns_the_body() {
        let (_s, url) = serving(200, b"PK archive bytes".to_vec()).await;
        let bytes = download(&reqwest::Client::new(), &url).await.unwrap();
        assert_eq!(bytes, b"PK archive bytes");
    }

    #[tokio::test]
    async fn a_body_up_to_the_cap_is_kept_whole() {
        let body = vec![7u8; MAX_ARCHIVE_BYTES];
        let (_s, url) = serving(200, body.clone()).await;
        assert_eq!(download(&reqwest::Client::new(), &url).await.unwrap(), body);
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_refused() {
        let (_s, url) = serving(200, vec![7u8; MAX_ARCHIVE_BYTES + 1]).await;
        let err = download(&reqwest::Client::new(), &url).await.unwrap_err();
        assert!(matches!(err, ArchiveError::TooLarge), "{err}");
    }

    #[tokio::test]
    async fn an_http_error_is_an_error() {
        let (_s, url) = serving(404, Vec::new()).await;
        let err = download(&reqwest::Client::new(), &url).await.unwrap_err();
        assert!(
            matches!(err, ArchiveError::Download(VerificationError::Status(404))),
            "{err}"
        );
    }

    #[test]
    fn the_caps_are_the_documented_ones() {
        // docs/architecture/backend/backend-overview.md states them.
        assert_eq!(MAX_ARCHIVE_BYTES, 10 * 1024 * 1024);
        assert_eq!(MAX_UNPACKED_BYTES, 25 * 1024 * 1024);
        assert_eq!(MAX_FILES, 2_000);
    }
}
