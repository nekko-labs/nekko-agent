import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import NekkoProtocol

/// *Send feedback* (#1004): the copied prompt, the note's body and request, and
/// the app info fields held to Nekko Cloud's limits.
final class FeedbackTests: XCTestCase {
    private let info = Feedback.AppInfo(app: "ios", version: "1.4.0", os: "iOS", osVersion: "18.1", arch: "arm64")

    func testPromptIsTheSharedTextWithTheAppLine() {
        XCTAssertEqual(Feedback.agentPrompt(info), """
            I want to send feedback about Nekko Agent to the team that makes it (Nekko Labs). Please help me file it as a GitHub issue on https://github.com/nekko-labs/nekko-agent.

            1. Ask me what happened and what I expected (for a bug, the steps to reproduce it), or what I'd like it to do (for an idea).
            2. Search the existing issues first, and if one already covers it, show me so I can add to it instead.
            3. Draft a short title and description and show them to me. File the issue only after I approve, for example with `gh issue create --repo nekko-labs/nekko-agent`, or give me the text to paste into https://github.com/nekko-labs/nekko-agent/issues/new/choose.
            4. Leave out anything personal: names, email addresses, file paths, keys and tokens, and chat contents.

            App: Nekko Agent 1.4.0 (ios, iOS 18.1, arm64)
            """)
    }

    func testAppLineLeavesOutWhatIsUnknown() {
        XCTAssertEqual(Feedback.AppInfo(app: "ios", version: "1.4.0", os: "iPadOS", osVersion: nil, arch: nil).line,
                       "App: Nekko Agent 1.4.0 (ios, iPadOS)")
        XCTAssertEqual(Feedback.AppInfo(app: "ios", version: "1.4.0", os: "iOS", osVersion: "18.1", arch: "").line,
                       "App: Nekko Agent 1.4.0 (ios, iOS 18.1)")
        XCTAssertEqual(Feedback.AppInfo(app: "ios", version: "1.4.0", os: "iOS", osVersion: " ", arch: "arm64").line,
                       "App: Nekko Agent 1.4.0 (ios, iOS, arm64)")
    }

    func testFieldsKeepOnlyAllowedCharactersWithinTheirLimits() {
        let i = Feedback.AppInfo(app: "ios", version: "1.4.0 (build \"7\")\n<b>", os: "iOS",
                                 osVersion: String(repeating: "9", count: 40), arch: "arm64e-but-much-too-long")
        XCTAssertEqual(i.version, "1.4.0 build 7b")
        XCTAssertEqual(i.osVersion?.count, 32)
        XCTAssertEqual(i.arch, "arm64e-but-much-")
        XCTAssertEqual(Feedback.AppInfo(app: "ios", version: "✨", os: "", osVersion: "é", arch: nil),
                       Feedback.AppInfo(app: "ios", version: "unknown", os: "iOS", osVersion: nil, arch: nil))
        XCTAssertEqual(Feedback.field("1.0+beta_2-rc", max: 32), "1.0+beta_2-rc")
    }

    func testMessageIsTrimmedAndCapped() {
        XCTAssertNil(Feedback.message("  \n\t "))
        XCTAssertEqual(Feedback.message("  The list jumps.\n"), "The list jumps.")
        XCTAssertNotNil(Feedback.message(String(repeating: "a", count: Feedback.maxMessage)))
        XCTAssertNil(Feedback.message(String(repeating: "a", count: Feedback.maxMessage + 1)))
        // An emoji is two UTF-16 units, as the server counts it.
        XCTAssertEqual(Feedback.length(" 😀 "), 2)
        XCTAssertNil(Feedback.message(String(repeating: "😀", count: Feedback.maxMessage / 2 + 1)))
    }

    func testBodyHasAppOnlyWhenSwitchedOn() throws {
        let without = try XCTUnwrap(JSONSerialization.jsonObject(with: Feedback.body(message: "Hi", info: nil)) as? [String: Any])
        XCTAssertEqual(without.keys.sorted(), ["message"])
        XCTAssertEqual(without["message"] as? String, "Hi")

        let with = try XCTUnwrap(JSONSerialization.jsonObject(with: Feedback.body(message: "Hi", info: info)) as? [String: Any])
        XCTAssertEqual(with.keys.sorted(), ["app", "message"])
        let app = try XCTUnwrap(with["app"] as? [String: String])
        XCTAssertEqual(app, ["app": "ios", "version": "1.4.0", "os": "iOS", "osVersion": "18.1", "arch": "arm64"])

        let partial = Feedback.AppInfo(app: "ios", version: "1.4.0", os: "iPadOS", osVersion: nil, arch: nil)
        let p = try XCTUnwrap(JSONSerialization.jsonObject(with: Feedback.body(message: "Hi", info: partial)) as? [String: Any])
        XCTAssertEqual((p["app"] as? [String: String])?.keys.sorted(), ["app", "os", "version"])
    }

    func testRequestGoesToNekkoCloudWithoutCredentials() throws {
        let req = Feedback.request(api: URL(string: "https://nekko-agent-api.fly.dev")!, message: "Hi", info: nil)
        XCTAssertEqual(req.url?.absoluteString, "https://nekko-agent-api.fly.dev/v1/feedback")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(req.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(req.httpShouldHandleCookies)
        XCTAssertEqual(req.httpBody, Feedback.body(message: "Hi", info: nil))
    }

    func testOutcomes() {
        XCTAssertEqual(Feedback.outcome(status: 202), .sent)
        XCTAssertEqual(Feedback.outcome(status: 429), .rateLimited)
        XCTAssertEqual(Feedback.outcome(status: 400), .rejected)
        XCTAssertEqual(Feedback.outcome(status: 302), .failed)
        XCTAssertEqual(Feedback.outcome(status: 500), .failed)
        XCTAssertEqual(Feedback.outcome(status: nil), .failed)
    }

    func testSendPostsThroughTheGivenHTTP() async throws {
        let http = RecordingHTTP(status: 202)
        let outcome = await Feedback.send(message: "Hi", info: info, api: URL(string: "https://example.test")!, http: http)
        XCTAssertEqual(outcome, .sent)
        let req = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(req.url?.absoluteString, "https://example.test/v1/feedback")
        XCTAssertEqual(req.httpBody, Feedback.body(message: "Hi", info: info))
        let limited = await Feedback.send(message: "Hi", info: nil, api: URL(string: "https://example.test")!, http: RecordingHTTP(status: 429))
        XCTAssertEqual(limited, .rateLimited)
    }
}

private final class RecordingHTTP: FeedbackHTTP, @unchecked Sendable {
    let answer: Int?
    private let lock = NSLock()
    private var sent: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { sent } }

    init(status: Int?) { answer = status }

    func status(for request: URLRequest) async -> Int? {
        lock.withLock { sent.append(request) }
        return answer
    }
}
