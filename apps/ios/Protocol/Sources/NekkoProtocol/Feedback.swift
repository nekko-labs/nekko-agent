import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// *Send feedback* (#1004), the same three ways on every app: a prompt to
/// copy for the person's own coding agent, a short note sent to Nekko Labs
/// through Nekko Cloud (`POST /v1/feedback`), or the GitHub issue chooser.
/// The note carries app info only when the person switches it on, and then
/// only the app, its version, the OS and its version, and the CPU type:
/// nothing that identifies the person or the device.
public enum Feedback {
    public static let repository = "https://github.com/nekko-labs/nekko-agent"
    public static let newIssueURL = URL(string: "https://github.com/nekko-labs/nekko-agent/issues/new/choose")!
    /// The longest note Nekko Cloud takes, in UTF-16 units (what the server's `length` counts).
    public static let maxMessage = 4000
    /// The note's counter shows from here.
    public static let counterFrom = 3500

    /// App info for the note and the copied prompt. Each field keeps only
    /// `[A-Za-z0-9 ._+-]` and is capped as Nekko Cloud requires (32, the CPU type 16);
    /// an OS version or CPU type left empty is unknown and left out.
    public struct AppInfo: Equatable, Sendable, Encodable {
        public let app: String
        public let version: String
        public let os: String
        public let osVersion: String?
        public let arch: String?

        public init(app: String, version: String?, os: String, osVersion: String?, arch: String?) {
            self.app = Feedback.field(app, max: 16) ?? "ios"
            self.version = Feedback.field(version, max: 32) ?? "unknown"
            self.os = Feedback.field(os, max: 32) ?? "iOS"
            self.osVersion = Feedback.field(osVersion, max: 32)
            self.arch = Feedback.field(arch, max: 16)
        }

        /// `App: Nekko Agent 1.4.0 (ios, iOS 18.1, arm64)`, the copied prompt's last line.
        public var line: String {
            let os = [self.os, osVersion].compactMap { $0 }.joined(separator: " ")
            let inside = [app, os, arch].compactMap { $0 }.joined(separator: ", ")
            return "App: Nekko Agent \(version) (\(inside))"
        }
    }

    private static let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._+-")

    /// One app info field: allowed characters only, trimmed, capped; nil when nothing is left.
    static func field(_ raw: String?, max: Int) -> String? {
        guard let raw else { return nil }
        let kept = String(raw.filter { allowed.contains($0) }.prefix(max)).trimmingCharacters(in: .whitespaces)
        return kept.isEmpty ? nil : kept
    }

    /// The prompt *Copy for an agent* puts on the pasteboard.
    public static func agentPrompt(_ info: AppInfo) -> String {
        """
        I want to send feedback about Nekko Agent to the team that makes it (Nekko Labs). Please help me file it as a GitHub issue on \(repository).

        1. Ask me what happened and what I expected (for a bug, the steps to reproduce it), or what I'd like it to do (for an idea).
        2. Search the existing issues first, and if one already covers it, show me so I can add to it instead.
        3. Draft a short title and description and show them to me. File the issue only after I approve, for example with `gh issue create --repo nekko-labs/nekko-agent`, or give me the text to paste into \(newIssueURL.absoluteString).
        4. Leave out anything personal: names, email addresses, file paths, keys and tokens, and chat contents.

        \(info.line)
        """
    }

    /// The note's length as Nekko Cloud counts it, after trimming.
    public static func length(_ text: String) -> Int {
        text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    }

    /// The note as sent: trimmed, or nil when it is empty or too long (Send stays off).
    public static func message(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.utf16.count > maxMessage ? nil : trimmed
    }

    private struct Body: Encodable {
        let message: String
        let app: AppInfo?
    }

    /// `{"message": …, "app": {…}}`; `app` is there only when the person switched it on.
    public static func body(message: String, info: AppInfo?) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(Body(message: message, app: info))) ?? Data()
    }

    /// The POST to Nekko Cloud: JSON only, no cookies, no Authorization header.
    public static func request(api: URL, message: String, info: AppInfo?) -> URLRequest {
        var req = URLRequest(url: api.appendingPathComponent("v1/feedback"), timeoutInterval: 20)
        req.httpMethod = "POST"
        req.httpShouldHandleCookies = false
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = body(message: message, info: info)
        return req
    }

    public enum Outcome: Equatable, Sendable {
        case sent
        /// 429 `rate-limited`.
        case rateLimited
        /// 400 `bad-feedback`.
        case rejected
        /// Any other answer, a redirect, or no answer at all.
        case failed
    }

    /// What an HTTP status means for the note; nil is no answer.
    public static func outcome(status: Int?) -> Outcome {
        switch status {
        case (200..<300)?: return .sent
        case 429?: return .rateLimited
        case 400?: return .rejected
        default: return .failed
        }
    }

    /// Send a note (already through `message(_:)`).
    public static func send(message: String, info: AppInfo?, api: URL, http: FeedbackHTTP = URLSessionFeedbackHTTP()) async -> Outcome {
        outcome(status: await http.status(for: request(api: api, message: message, info: info)))
    }
}

/// The note's HTTP, so tests can answer without a network.
public protocol FeedbackHTTP: Sendable {
    /// The response's status, or nil when there was none.
    func status(for request: URLRequest) async -> Int?
}

/// A fresh ephemeral session per note: no cookies, no cache, and a redirect
/// is refused (its 3xx comes back as the answer), so the note goes only to Nekko Cloud.
public struct URLSessionFeedbackHTTP: FeedbackHTTP {
    public init() {}

    public func status(for request: URLRequest) async -> Int? {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        #if canImport(Darwin)
        config.waitsForConnectivity = false
        #endif
        let session = URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return await withCheckedContinuation { (cont: CheckedContinuation<Int?, Never>) in
            session.dataTask(with: request) { _, response, error in
                cont.resume(returning: error == nil ? (response as? HTTPURLResponse)?.statusCode : nil)
            }.resume()
        }
    }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
