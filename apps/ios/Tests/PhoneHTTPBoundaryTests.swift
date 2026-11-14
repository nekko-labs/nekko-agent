import Foundation
import XCTest
import NekkoKit
@testable import NekkoNative

final class PhoneHTTPBoundaryTests: XCTestCase {
    func testOnlyValidatedHTTPSRequestsCanCarryHeaders() throws {
        for url in ["http://example.com/v1", "https://secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#fragment", "https://example.com/%2e%2e/v1"] {
            XCTAssertThrowsError(try URLSessionPhoneHTTP.urlRequest(PhoneRequest(method: "POST", url: url, headers: ["x-api-key": "secret"])))
        }
        XCTAssertThrowsError(try URLSessionPhoneHTTP.urlRequest(PhoneRequest(method: "POST", url: "https://example.com/v1", headers: ["Authorization": "Bearer k\r\nInjected: yes"])))
        let request = try URLSessionPhoneHTTP.urlRequest(PhoneRequest(method: "GET", url: "https://api.anthropic.com/v1/models?limit=1000", headers: ["x-api-key": "secret"]))
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), "secret")
        XCTAssertEqual(request.httpMethod, "GET")
    }

    func testRedirectsNeverCarryCredentialsAcrossAnyBoundary() async throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: "https://example.com/v1/messages")!)
        for target in ["https://other.example/v1/messages", "http://example.com/v1/messages", "https://example.com/other-tenant", "https://example.com/v1/messages"] {
            let response = try XCTUnwrap(HTTPURLResponse(url: URL(string: "https://example.com/v1/messages")!, statusCode: 307, httpVersion: nil, headerFields: ["Location": target]))
            var proposed = URLRequest(url: URL(string: target)!)
            proposed.setValue("secret", forHTTPHeaderField: "x-api-key")
            let redirected: URLRequest? = await withCheckedContinuation { continuation in
                URLSessionPhoneHTTP.Boundary().urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: proposed) { continuation.resume(returning: $0) }
            }
            XCTAssertNil(redirected, target)
        }
    }
}
