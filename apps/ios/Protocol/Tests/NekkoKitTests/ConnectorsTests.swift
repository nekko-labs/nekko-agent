import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class ConnectorsTests: XCTestCase {
    var secrets = MemoryStore()
    var files = MemoryOfflineFiles()
    var http = FakePhoneHTTP()

    func make() -> ConnectorsModel {
        var t: Int64 = 1_000
        return ConnectorsModel(secrets: secrets, files: files, http: http, now: { t += 1; return t })
    }

    func testConnectChecksTheTokenAndKeepsItOnlyInTheKeychain() async throws {
        let m = make()
        http.answers = [(200, [#"{"login":"octocat","id":1}"#])]
        let c = try await m.connect(kind: "github", token: " ghp_secret ", settings: [:])
        XCTAssertEqual(c.account, "octocat")
        XCTAssertEqual(c.settings["api"], "https://api.github.com")
        let req = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.url, "https://api.github.com/user")
        XCTAssertEqual(req.headers["Authorization"], "Bearer ghp_secret")
        XCTAssertEqual(secrets.get(PhoneConnectors.tokenName("github")), "ghp_secret")
        let saved = try XCTUnwrap(files.files["this-iphone-connectors/phone-connectors"]).serialized()
        XCTAssertFalse(saved.contains("ghp_secret"))
        // A second launch reads it back, and it is the git provider.
        let again = make()
        XCTAssertEqual(again.connectors, [c])
        XCTAssertEqual(again.gitProvider?.kind, "github")
    }

    func testATokenTheServiceTurnsDownIsNotKept() async {
        let m = make()
        http.answers = [(401, [#"{"message":"Bad credentials"}"#])]
        do {
            _ = try await m.connect(kind: "github", token: "nope", settings: [:])
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "GitHub turned the token down (401): Bad credentials")
        }
        XCTAssertTrue(m.connectors.isEmpty)
        XCTAssertNil(secrets.get(PhoneConnectors.tokenName("github")))
    }

    func testLinearErrorsInA200AreARefusal() async {
        let m = make()
        http.answers = [(200, [#"{"errors":[{"message":"Authentication required"}]}"#])]
        do {
            _ = try await m.connect(kind: "linear", token: "lin_bad", settings: [:])
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Linear turned the token down: Authentication required")
        }
        XCTAssertNil(m.connector("linear"))
        XCTAssertEqual(http.requests.first?.headers["Authorization"], "lin_bad", "Linear takes the bare key")
        XCTAssertEqual(http.requests.first?.body?["query"]?.string, "{ viewer { name email } }")
    }

    func testFieldsAreCheckedBeforeAnythingIsSent() async {
        let m = make()
        do {
            _ = try await m.connect(kind: "jira", token: "t", settings: ["site": "https://team.atlassian.net"])
            XCTFail()
        } catch { XCTAssertEqual(error as? PhoneConnectors.Problem, .missing("Email")) }
        do {
            _ = try await m.connect(kind: "jira", token: "t", settings: ["site": "http://team.atlassian.net", "email": "a@b.c"])
            XCTFail()
        } catch { XCTAssertEqual(error as? PhoneConnectors.Problem, .url("Site"), "tokens go over https only") }
        do {
            _ = try await m.connect(kind: "floop", token: " ", settings: ["url": "https://f.example"])
            XCTFail()
        } catch { XCTAssertEqual(error as? PhoneConnectors.Problem, .token) }
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testJiraAndBitbucketUseBasicAuthWithTheEmail() throws {
        let jira = try PhoneConnectors.make(kind: "jira", token: "tok", settings: ["site": "https://t.atlassian.net/", "email": "a@b.c"], at: 1)
        XCTAssertEqual(jira.settings["site"], "https://t.atlassian.net")
        let r = PhoneConnectors.whoAmI(jira, token: "tok")
        XCTAssertEqual(r.url, "https://t.atlassian.net/rest/api/3/myself")
        XCTAssertEqual(r.headers["Authorization"], "Basic " + Data("a@b.c:tok".utf8).base64EncodedString())
        let bb = try PhoneConnectors.make(kind: "bitbucket", token: "tok", settings: ["email": "a@b.c"], at: 1)
        XCTAssertEqual(PhoneConnectors.whoAmI(bb, token: "tok").headers["Authorization"], r.headers["Authorization"])
    }

    func testTrelloSendsItsKeyAndTokenInTheQuery() throws {
        let c = try PhoneConnectors.make(kind: "trello", token: "t&k", settings: ["key": "abc"], at: 1)
        let r = PhoneConnectors.whoAmI(c, token: "t&k")
        XCTAssertTrue(r.url.hasSuffix("&key=abc&token=t%26k"), r.url)
        XCTAssertNil(r.headers["Authorization"])
    }

    func testAccountNames() {
        XCTAssertEqual(PhoneConnectors.account(kind: "gitlab", body: Data(#"{"username":"gl"}"#.utf8)), "gl")
        XCTAssertEqual(PhoneConnectors.account(kind: "jira", body: Data(#"{"displayName":"Ada"}"#.utf8)), "Ada")
        XCTAssertEqual(PhoneConnectors.account(kind: "asana", body: Data(#"{"data":{"name":"Ada"}}"#.utf8)), "Ada")
        XCTAssertEqual(PhoneConnectors.account(kind: "clickup", body: Data(#"{"user":{"username":"ada"}}"#.utf8)), "ada")
        XCTAssertNil(PhoneConnectors.account(kind: "floop", body: Data("[]".utf8)))
    }

    func testSelectingTheGitProviderAndDisconnecting() async throws {
        let m = make()
        http.answers = [(200, [#"{"login":"a"}"#]), (200, [#"{"username":"b"}"#]), (200, [#"{"data":{"viewer":{"name":"c"}}}"#])]
        _ = try await m.connect(kind: "github", token: "1", settings: [:])
        _ = try await m.connect(kind: "gitlab", token: "2", settings: [:])
        _ = try await m.connect(kind: "linear", token: "3", settings: [:])
        XCTAssertEqual(m.git.map(\.kind), ["github", "gitlab"])
        XCTAssertEqual(m.tasks.map(\.kind), ["linear"])
        XCTAssertEqual(m.gitProvider?.kind, "github")
        m.selectGit("linear")
        XCTAssertEqual(m.gitProvider?.kind, "github", "only a git provider can be the git provider")
        m.selectGit("gitlab")
        XCTAssertEqual(make().gitProvider?.kind, "gitlab")
        m.disconnect("gitlab")
        XCTAssertNil(secrets.get(PhoneConnectors.tokenName("gitlab")))
        XCTAssertEqual(m.gitProvider?.kind, "github")
        m.forgetAll()
        XCTAssertTrue(make().connectors.isEmpty)
        XCTAssertNil(secrets.get(PhoneConnectors.tokenName("github")))
        XCTAssertNil(secrets.get(PhoneConnectors.tokenName("linear")))
    }
}
