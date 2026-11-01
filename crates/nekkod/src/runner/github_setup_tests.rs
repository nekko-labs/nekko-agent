use super::*;
use serde_json::json;

const PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----\n";

fn org() -> Owner {
    Owner::Org("nekko-labs".into())
}

fn user() -> Owner {
    Owner::User("ermish".into())
}

fn perms(m: &Value) -> &serde_json::Map<String, Value> {
    m["default_permissions"].as_object().unwrap()
}

#[test]
fn name_is_capped_at_34_and_never_split_mid_character() {
    assert_eq!(app_name("nekko-labs", "3fa9"), "Nekko Runner nekko-labs 3fa9");
    let long = app_name("a-very-long-organization-name", "3fa9");
    assert_eq!(long, "Nekko Runner a-very-long-orga 3fa9");
    assert_eq!(long.chars().count(), 34);
    let wide = app_name(&"\u{732b}".repeat(40), "3fa9");
    assert_eq!(wide.chars().count(), 34);
    assert!(wide.ends_with("\u{732b} 3fa9"), "{wide}");
}

#[test]
fn manifest_has_the_designed_fields() {
    let m = manifest(&org(), 4242, "3fa9", false);
    assert_eq!(m["name"], "Nekko Runner nekko-labs 3fa9");
    assert_eq!(m["url"], "https://nekkoagent.com/docs/ci-runners");
    assert_eq!(m["hook_attributes"], json!({ "url": "https://nekkoagent.com/docs/ci-runners", "active": false }));
    assert_eq!(m["redirect_url"], "http://localhost:4242/created");
    assert_eq!(m["setup_url"], "http://localhost:4242/installed");
    assert_eq!(m["public"], false);
}

#[test]
fn org_manifest_has_the_runner_permission_and_no_administration() {
    let m = manifest(&org(), 1, "abcd", false);
    assert_eq!(
        perms(&m),
        json!({ "actions": "write", "metadata": "read", "organization_self_hosted_runners": "write" })
            .as_object()
            .unwrap()
    );
}

#[test]
fn user_manifest_has_administration() {
    let m = manifest(&user(), 1, "abcd", false);
    assert_eq!(
        perms(&m),
        json!({ "actions": "write", "metadata": "read", "administration": "write" }).as_object().unwrap()
    );
}

#[test]
fn an_org_gets_administration_only_on_the_single_repo_path() {
    let m = manifest(&org(), 1, "abcd", true);
    assert_eq!(
        perms(&m),
        json!({ "actions": "write", "metadata": "read", "administration": "write" }).as_object().unwrap()
    );
}

#[test]
fn urls_name_the_right_place() {
    assert_eq!(create_url(&user(), "s1"), "https://github.com/settings/apps/new?state=s1");
    assert_eq!(create_url(&org(), "s1"), "https://github.com/organizations/nekko-labs/settings/apps/new?state=s1");
    assert_eq!(install_url("nekko-runner-3fa9"), "https://github.com/apps/nekko-runner-3fa9/installations/new");
}

#[test]
fn form_page_escapes_the_manifest() {
    let page =
        form_page("https://github.com/settings/apps/new?state=a&b=1", &json!({ "name": "\"><script>x</script>" }));
    assert!(page.contains("method=\"post\"") && page.contains("name=\"manifest\""), "{page}");
    assert!(page.contains("action=\"https://github.com/settings/apps/new?state=a&amp;b=1\""), "{page}");
    assert!(page.contains("&quot;&gt;&lt;script&gt;x"), "{page}");
    assert!(!page.contains("\"><script>x"), "{page}");
    assert!(page.contains(".submit()"), "{page}");
}

#[test]
fn conversion_reads_the_new_app() {
    let c = parse_conversion(&json!({ "id": 7, "slug": "nekko-runner", "pem": PEM, "client_secret": "s" })).unwrap();
    assert_eq!((c.app_id, c.slug.as_str(), c.pem.as_str()), (7, "nekko-runner", PEM));
    assert!(!format!("{c:?}").contains("MIIBOgIBAAJB"));
}

#[test]
fn conversion_refuses_a_key_that_is_not_pkcs1_and_never_echoes_it() {
    let pem = "-----BEGIN PRIVATE KEY-----\nSECRETBODY\n-----END PRIVATE KEY-----\n";
    let e = parse_conversion(&json!({ "id": 7, "slug": "s", "pem": pem })).unwrap_err();
    assert!(e.contains("BEGIN RSA PRIVATE KEY") && !e.contains("SECRETBODY"), "{e}");
}

#[test]
fn conversion_refuses_a_slug_that_could_leave_the_install_path() {
    let e = parse_conversion(&json!({ "id": 7, "slug": "../evil", "pem": PEM })).unwrap_err();
    assert!(!e.is_empty() && !e.contains("MIIBOgIBAAJB"), "{e}");
    assert!(parse_conversion(&json!({ "slug": "s", "pem": PEM })).is_err());
    assert!(parse_conversion(&json!({ "id": 7, "slug": "s" })).is_err());
}
