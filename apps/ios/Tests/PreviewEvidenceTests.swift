import XCTest
import NekkoKit
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class PreviewEvidenceTests: XCTestCase {
    func testOnlyExplicitSyntheticArtifactsCanBeRead() async throws {
        let html = try await PreviewEvidenceFixture.read(.artifact("preview-evidence", "/synthetic/release.html"))
        XCTAssertEqual(html.str("mime"), "text/html")
        XCTAssertTrue(html.str("content")?.contains("Try prototype") == true)
        let notes = try await PreviewEvidenceFixture.read(.artifact("preview-evidence", "/synthetic/notes.md"))
        XCTAssertEqual(notes.str("mime"), "text/markdown")
        for path in ["/Users/real/private.md", "/synthetic/missing.md"] {
            do {
                _ = try await PreviewEvidenceFixture.read(.artifact("preview-evidence", path))
                XCTFail("No real file access or unknown fixture fallback")
            } catch {}
        }
    }

    func testOnlyExactSyntheticLoopbackAddressIsAccepted() async throws {
        let request = PreviewRequest.fetch("preview-evidence", try XCTUnwrap(URL(string: "http://localhost:5173/demo")))
        let body = try await PreviewEvidenceFixture.read(request)
        XCTAssertEqual(body["status"]?.int64, 200)
        XCTAssertNotNil(body.str("base64").flatMap { Data(base64Encoded: $0) })
        for url in ["https://example.com/", "http://localhost:5173/private"] {
            do {
                _ = try await PreviewEvidenceFixture.read(.fetch("preview-evidence", try XCTUnwrap(URL(string: url))))
                XCTFail("No network or unknown fixture URL fallback")
            } catch {}
        }
    }

    func testARealChatCannotUseTheFixtureReader() async {
        do {
            _ = try await PreviewEvidenceFixture.read(.artifact("real-chat", "/synthetic/release.html"))
            XCTFail("The fixture reader must be scoped to its isolated chat")
        } catch {}
    }
}
