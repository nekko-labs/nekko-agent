import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class PullRequestsTests: XCTestCase {
    var secrets = MemoryStore()
    var files = MemoryOfflineFiles()
    var http = FakePhoneHTTP()

    func connectors() -> ConnectorsModel { ConnectorsModel(secrets: secrets, files: files, http: http, now: { 1 }) }

    static let ghNode = #"{"number":7,"title":"Fix login","url":"https://github.com/o/app/pull/7","isDraft":false,"updatedAt":"2026-11-04T10:00:00Z","headRefName":"fix/login","baseRefName":"main","reviewDecision":"CHANGES_REQUESTED","author":{"login":"ada"},"repository":{"nameWithOwner":"o/app"},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]}}"#
    static let ghOther = #"{"number":3,"title":"Docs","url":"https://github.com/o/site/pull/3","isDraft":true,"updatedAt":"2026-11-05T10:00:00Z","headRefName":"docs","baseRefName":"main","reviewDecision":null,"author":{"login":"bob"},"repository":{"nameWithOwner":"o/site"},"commits":{"nodes":[]}}"#

    func testGitHubMineIsOneGraphQLCallWithThreeSearchesMergedByURL() async throws {
        let c = connectors()
        http.answers = [(200, [#"{"login":"ada"}"#])]
        _ = try await c.connect(kind: "github", token: "ghp", settings: [:])
        let m = PullRequestsModel(connectors: c, files: files)
        http.answers = [(200, [#"{"data":{"authored":{"nodes":[\#(Self.ghNode)]},"reviewRequested":{"nodes":[\#(Self.ghOther)]},"assigned":{"nodes":[\#(Self.ghNode)]}}}"#])]
        await m.load(.mine, folders: [])
        XCTAssertNil(m.error)
        let req = try XCTUnwrap(http.requests.last)
        XCTAssertEqual(req.url, "https://api.github.com/graphql")
        let q = try XCTUnwrap(req.body?["query"]?.string)
        XCTAssertTrue(q.contains("author:@me is:pr is:open"))
        XCTAssertTrue(q.contains("review-requested:@me"))
        XCTAssertEqual(m.mine.map(\.number), [3, 7], "each once, newest first")
        let fix = try XCTUnwrap(m.mine.last)
        XCTAssertEqual(fix.roles, [.authored, .assigned])
        XCTAssertEqual(fix.checks, .failing)
        XCTAssertEqual(fix.review, .changesRequested)
        XCTAssertEqual(fix.head, "fix/login")
        XCTAssertEqual(fix.repoName, "app")
        XCTAssertTrue(m.mine.first!.isDraft)
    }

    func testAGraphQLRefusalIsShown() async throws {
        let c = connectors()
        http.answers = [(200, [#"{"login":"ada"}"#])]
        _ = try await c.connect(kind: "github", token: "ghp", settings: [:])
        let m = PullRequestsModel(connectors: c, files: files)
        http.answers = [(200, [#"{"data":null,"errors":[{"message":"Resource not accessible by personal access token"}]}"#])]
        await m.load(.mine, folders: [])
        XCTAssertEqual(m.error, "GitHub: Resource not accessible by personal access token")
    }

    func testProjectsAreTheFoldersReposAndThePinnedOnes() async throws {
        let c = connectors()
        http.answers = [(200, [#"{"login":"ada"}"#])]
        _ = try await c.connect(kind: "github", token: "ghp", settings: [:])
        let m = PullRequestsModel(connectors: c, files: files)
        m.pin(PhoneRepo("o/site"))
        http.answers = [
            (200, [#"[{"full_name":"o/app"},{"full_name":"o/site"},{"full_name":"o/other"}]"#]),
            (200, [#"{"data":{"p0":{"nodes":[\#(Self.ghNode),\#(Self.ghOther)]}}}"#]),
        ]
        await m.load(.projects, folders: [WorkspaceFolder(id: "w1", name: "App", path: "/Users/me/code/app")])
        XCTAssertNil(m.error)
        XCTAssertEqual(m.projectRepos.map(\.fullName), ["o/app", "o/site"])
        XCTAssertEqual(http.requests[1].url, "https://api.github.com/user/repos?per_page=100&sort=pushed")
        let q = try XCTUnwrap(http.requests[2].body?["query"]?.string)
        XCTAssertTrue(q.contains("repo:o/app repo:o/site"))
        XCTAssertEqual(m.projects.count, 2)
        // Pins are kept per provider.
        XCTAssertEqual(PullRequestsModel(connectors: c, files: files).pinned, [PhoneRepo("o/site")])
        m.unpin(PhoneRepo("o/site"))
        XCTAssertEqual(m.projects.map(\.repo), ["o/app"])
    }

    func testLongRepoListsAreSplitAcrossSearches() {
        let repos = (1...30).map { "some-org/repository-number-\($0)" }
        let qs = PullRequestsAPI.repoQueries(repos)
        XCTAssertGreaterThan(qs.count, 1)
        XCTAssertTrue(qs.allSatisfy { $0.count <= 200 })
        XCTAssertEqual(qs.joined(separator: " ").split(separator: " ").count, 30)
    }

    func testEnterpriseGraphQLAddress() {
        XCTAssertEqual(PullRequestsAPI.githubGraphQL("https://api.github.com"), "https://api.github.com/graphql")
        XCTAssertEqual(PullRequestsAPI.githubGraphQL("https://git.corp.example/api/v3"), "https://git.corp.example/api/graphql")
    }

    func testGitLabListsMineAssignedAndToReview() async throws {
        let c = connectors()
        http.answers = [(200, [#"{"username":"ada"}"#])]
        _ = try await c.connect(kind: "gitlab", token: "glpat", settings: ["site": "https://gitlab.example.com/"])
        let m = PullRequestsModel(connectors: c, files: files)
        let mr = #"[{"web_url":"https://gitlab.example.com/g/app/-/merge_requests/4","iid":4,"title":"MR","draft":true,"updated_at":"2026-11-04T10:00:00.123Z","author":{"username":"ada"},"references":{"full":"g/app!4"},"source_branch":"feat","target_branch":"main","detailed_merge_status":"ci_still_running"}]"#
        http.answers = [(200, [mr]), (200, ["[]"]), (200, [mr])]
        await m.load(.mine, folders: [])
        XCTAssertNil(m.error)
        XCTAssertEqual(http.requests.count, 4)
        XCTAssertTrue(http.requests[1].url.hasPrefix("https://gitlab.example.com/api/v4/merge_requests?state=opened"))
        XCTAssertTrue(http.requests[3].url.hasSuffix("reviewer_username=ada"))
        XCTAssertEqual(http.requests[1].headers["PRIVATE-TOKEN"], "glpat")
        let p = try XCTUnwrap(m.mine.first)
        XCTAssertEqual(m.mine.count, 1)
        XCTAssertEqual(p.repo, "g/app")
        XCTAssertEqual(p.roles, [.authored, .reviewRequested])
        XCTAssertEqual(p.checks, .pending)
        XCTAssertTrue(p.isDraft)
        XCTAssertNotNil(p.updatedAt)
        XCTAssertEqual(PullRequestsAPI.projects(c.connector("gitlab")!, token: "t", repos: ["g/sub/app"]).first?.url,
                       "https://gitlab.example.com/api/v4/projects/g%2Fsub%2Fapp/merge_requests?state=opened&per_page=30")
    }

    func testBitbucketListsByTheUsersUUID() async throws {
        let c = connectors()
        http.answers = [(200, [#"{"username":"ada","uuid":"{1234}"}"#])]
        _ = try await c.connect(kind: "bitbucket", token: "t", settings: ["email": "a@b.c"])
        let m = PullRequestsModel(connectors: c, files: files)
        http.answers = [(200, [#"{"values":[{"id":9,"title":"BB","links":{"html":{"href":"https://bitbucket.org/ws/app/pull-requests/9"}},"author":{"display_name":"Ada"},"updated_on":"2026-11-04T10:00:00.123456+00:00","source":{"branch":{"name":"f"}},"destination":{"branch":{"name":"main"},"repository":{"full_name":"ws/app"}}}]}"#])]
        await m.load(.mine, folders: [])
        XCTAssertEqual(http.requests.last?.url, "https://api.bitbucket.org/2.0/pullrequests/%7B1234%7D?state=OPEN&pagelen=50")
        XCTAssertEqual(m.mine.first?.repo, "ws/app")
        XCTAssertEqual(m.mine.first?.author, "Ada")
        XCTAssertNotNil(m.mine.first?.updatedAt, "microseconds and an offset still read")
    }

    func testNoGitProviderMeansNothingIsAsked() async {
        let m = PullRequestsModel(connectors: connectors(), files: files)
        await m.load(.mine, folders: [])
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertTrue(m.mine.isEmpty)
    }

    // MARK: Prompts and where they run

    func testPromptsNameThePullRequestAndItsBranches() throws {
        var pr = PhonePullRequest(url: "https://github.com/o/app/pull/7", repo: "o/app", number: 7, title: "Fix login")
        pr.head = "fix/login"
        pr.base = "main"
        let review = PullRequestPrompt.review.text(for: pr)
        XCTAssertTrue(review.contains("https://github.com/o/app/pull/7"))
        XCTAssertTrue(review.contains("`fix/login`"))
        XCTAssertTrue(review.contains("`main`"))
        XCTAssertFalse(PullRequestPrompt.fixChecks.fits(pr))
        pr.checks = .failing
        XCTAssertTrue(PullRequestPrompt.fixChecks.fits(pr))
        XCTAssertTrue(PullRequestPrompt.ask.text(for: pr).hasPrefix("About pull request"))
    }

    func testTheChatRunsWhereTheRepositoryIs() {
        let studio = (id: "studio", folders: [WorkspaceFolder(id: "s1", name: "site")])
        let laptop = (id: "laptop", folders: [WorkspaceFolder(id: "l1", name: "Work", path: "C:\\code\\app")])
        XCTAssertEqual(PullRequestPlace.find(repo: "o/app", computers: [studio, laptop], active: "studio"),
                       .init(computer: "laptop", folder: "l1"))
        XCTAssertEqual(PullRequestPlace.find(repo: "o/unknown", computers: [studio, laptop], active: "laptop"),
                       .init(computer: "laptop", folder: nil), "else the active computer, no folder")
        let both = (id: "laptop", folders: [WorkspaceFolder(id: "l2", name: "site")])
        XCTAssertEqual(PullRequestPlace.find(repo: "o/site", computers: [studio, both], active: "laptop")?.computer, "laptop",
                       "the active computer first when both hold it")
        XCTAssertNil(PullRequestPlace.find(repo: "o/app", computers: [], active: nil))
    }
}
