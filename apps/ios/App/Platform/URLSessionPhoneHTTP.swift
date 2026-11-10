import Foundation
import NekkoKit

/// One ephemeral session per operation. No cookies, cache, redirects or shared
/// credentials: a provider key must never follow a Location to another endpoint.
struct URLSessionPhoneHTTP: PhoneHTTP {
    final class Boundary: NSObject, URLSessionTaskDelegate, Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
            // Reject even same-origin redirects: changing path can cross a tenant
            // or API boundary. The user must configure the final HTTPS address.
            completionHandler(nil)
        }
    }

    private static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCredentialStorage = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 600
        c.waitsForConnectivity = false
        return URLSession(configuration: c, delegate: Boundary(), delegateQueue: nil)
    }

    func send(_ request: PhoneRequest) async throws -> (status: Int, body: Data) {
        let req = try Self.urlRequest(request)
        let session = Self.session()
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: req)
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 2_000_000 else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    func lines(_ request: PhoneRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        let req = try Self.urlRequest(request)
        let session = Self.session()
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do { (bytes, response) = try await session.bytes(for: req) }
        catch { session.invalidateAndCancel(); throw error }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) && response.mimeType?.lowercased() != "text/event-stream" {
            session.invalidateAndCancel()
            throw URLError(.cannotParseResponse)
        }
        let (stream, continuation) = AsyncThrowingStream<String, Error>.makeStream(bufferingPolicy: .bufferingOldest(32))
        let task = Task {
            defer { session.invalidateAndCancel() }
            do {
                var line = Data()
                var total = 0
                var afterCR = false
                for try await byte in bytes {
                    try Task.checkCancellation()
                    total += 1
                    guard total <= PhoneStreamParser.maxStreamBytes else { throw URLError(.dataLengthExceedsMaximum) }
                    if byte == 10 && afterCR { afterCR = false; continue }
                    afterCR = byte == 13
                    if byte == 10 || byte == 13 {
                        guard let text = String(data: line, encoding: .utf8) else { throw URLError(.cannotDecodeContentData) }
                        switch continuation.yield(text) {
                        case .enqueued: break
                        case .dropped: throw URLError(.dataLengthExceedsMaximum)
                        case .terminated: return
                        @unknown default: throw URLError(.cannotParseResponse)
                        }
                        line.removeAll(keepingCapacity: true)
                    } else {
                        guard line.count < PhoneStreamParser.maxFrameBytes else { throw URLError(.dataLengthExceedsMaximum) }
                        line.append(byte)
                    }
                }
                // EOF is not an SSE frame delimiter. Do not invent a final blank line.
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel(); session.invalidateAndCancel() }
        return (status, stream)
    }

    static func urlRequest(_ r: PhoneRequest) throws -> URLRequest {
        // Model discovery adds its own known query; configured base URLs never can.
        guard let url = URL(string: r.url), var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        let query = c.query
        c.query = nil
        guard let base = c.string, PhoneProviders.safeURL(base), query == nil || (r.method == "GET" && query == "limit=1000"),
              r.headers.allSatisfy({ PhoneProviders.headerValue($0.key) && PhoneProviders.headerValue($0.value) }) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = r.method
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = r.bodyData
        return req
    }
}
