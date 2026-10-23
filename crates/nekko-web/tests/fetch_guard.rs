//! `fetch_url` reaches this computer or the local network only for hosts the
//! user approved, on the first request and on every redirect hop.

use nekko_tools::Cancel;
use nekko_web::{FetchError, fetch_url};
use std::collections::HashSet;

async fn serve() -> u16 {
    use axum::http::{StatusCode, header};
    use axum::routing::get;
    let app = axum::Router::new()
        .route("/page", get(|| async { ([(header::CONTENT_TYPE, "text/plain")], "hello from the dev server") }))
        .route(
            "/to-metadata",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://169.254.169.254/latest/meta-data/")]) }),
        )
        .route("/to-localhost", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://localhost:1/")]) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

fn hosts(h: &[&str]) -> HashSet<String> {
    h.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn a_local_address_needs_the_users_approval() {
    let port = serve().await;
    let url = format!("http://127.0.0.1:{port}/page");
    let err = fetch_url(&url, None, &Cancel::new(), &HashSet::new()).await.unwrap_err();
    assert_eq!(err, FetchError::Local { url: url.clone(), host: "127.0.0.1".into() });
    for raw in [
        "http://localhost:1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:1/",
        "http://10.0.0.1/",
        "http://printer.local/",
        "http://0x7f.1/",
    ] {
        let err = fetch_url(raw, None, &Cancel::new(), &HashSet::new()).await.unwrap_err();
        assert!(matches!(err, FetchError::Local { .. }), "{raw}: {err:?}");
    }
    let page = fetch_url(&url, None, &Cancel::new(), &hosts(&["127.0.0.1"])).await.unwrap();
    assert_eq!(page.text, "hello from the dev server");
}

#[tokio::test]
async fn every_redirect_hop_is_checked_again() {
    let port = serve().await;
    let approved = hosts(&["127.0.0.1"]);
    let url = format!("http://127.0.0.1:{port}/to-metadata");
    let err = fetch_url(&url, None, &Cancel::new(), &approved).await.unwrap_err();
    assert_eq!(
        err,
        FetchError::Local { url: "http://169.254.169.254/latest/meta-data/".into(), host: "169.254.169.254".into() }
    );
    let url = format!("http://127.0.0.1:{port}/to-localhost");
    let err = fetch_url(&url, None, &Cancel::new(), &approved).await.unwrap_err();
    assert!(matches!(&err, FetchError::Local { host, .. } if host == "localhost"), "{err:?}");
}
