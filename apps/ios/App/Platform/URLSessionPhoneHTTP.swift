import Foundation
import NekkoKit

/// How chats on this iPhone reach their provider (decision 0048): an ephemeral
/// session (no cookies, no cache), so a key never lands in a URL cache. The
/// request goes straight to the provider; nothing passes through a computer,
/// the relay or Nekko Cloud.
struct URLSessionPhoneHTTP: PhoneHTTP {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 120
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    func send(_ request: PhoneRequest) async throws -> (status: Int, body: Data) {
        let (data, response) = try await Self.session.data(for: try Self.urlRequest(request))
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    func lines(_ request: PhoneRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        let (bytes, response) = try await Self.session.bytes(for: try Self.urlRequest(request))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // The task starts here, where `bytes` (not Sendable) is still this function's own.
        let (stream, continuation) = AsyncThrowingStream<String, Error>.makeStream()
        let task = Task {
            do {
                for try await line in bytes.lines {
                    try Task.checkCancellation()
                    continuation.yield(line)
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
        return (status, stream)
    }

    private static func urlRequest(_ r: PhoneRequest) throws -> URLRequest {
        guard let url = URL(string: r.url), url.scheme == "https" else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = r.method
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = r.bodyData
        return req
    }
}
