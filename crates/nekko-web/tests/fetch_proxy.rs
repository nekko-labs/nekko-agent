//! With a proxy configured, `fetch_url` still decides local versus public
//! itself, then sends the request through the proxy. Its own binary: the
//! proxy settings are read once per process.

use nekko_tools::Cancel;
use nekko_web::fetch::uses_proxy;
use nekko_web::{FetchError, fetch_url};
use std::collections::HashSet;

#[tokio::test]
async fn proxied_fetches_go_through_the_proxy_and_are_still_checked() {
    use axum::http::{StatusCode, header};
    use axum::routing::get;
    // A stand-in proxy: a plain HTTP proxy gets the absolute URL and answers it.
    let app = axum::Router::new()
        .route("/page", get(|| async { ([(header::CONTENT_TYPE, "text/plain")], "via the proxy") }))
        .route(
            "/to-metadata",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "http://169.254.169.254/latest/meta-data/")]) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    // SAFETY: set before any thread reads the environment; this binary has one test.
    unsafe {
        std::env::set_var("HTTP_PROXY", format!("http://127.0.0.1:{port}"));
        std::env::set_var("http_proxy", format!("http://127.0.0.1:{port}"));
        std::env::set_var("NO_PROXY", "skip.example");
        std::env::set_var("no_proxy", "skip.example");
    }
    let url = |s: &str| url::Url::parse(s).unwrap();
    assert!(uses_proxy(&url("http://example.com/page")));
    assert!(!uses_proxy(&url("http://skip.example/page")));

    let none = HashSet::new();
    // The proxy is used (nothing listens at example.com:80 here; the stand-in answers).
    let page = fetch_url("http://example.com/page", None, &Cancel::new(), &none).await.unwrap();
    assert_eq!(page.text, "via the proxy");
    // A redirect through the proxy into the local network is caught at the hop.
    let err = fetch_url("http://example.com/to-metadata", None, &Cancel::new(), &none).await.unwrap_err();
    assert!(matches!(&err, FetchError::Local { host, .. } if host == "169.254.169.254"), "{err:?}");
    // A local address literal never reaches the proxy without approval.
    let err = fetch_url("http://127.0.0.1:9/x", None, &Cancel::new(), &none).await.unwrap_err();
    assert!(matches!(err, FetchError::Local { .. }), "{err:?}");
}
