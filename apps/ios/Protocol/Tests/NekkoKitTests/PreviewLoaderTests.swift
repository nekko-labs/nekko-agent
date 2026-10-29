import XCTest
@testable import NekkoKit
import NekkoProtocol

@MainActor
final class PreviewLoaderTests: XCTestCase {
    final class Calls: @unchecked Sendable {
        var requests: [PreviewRequest] = []
    }

    func testReadsOnceAndReloadsOnRequest() async throws {
        let calls = Calls()
        let loader = PreviewLoader(read: { r in
            calls.requests.append(r)
            return try JSONValue.parse(#"{"path":"/p/index.html","mime":"text/html","size":4,"kind":"text","content":"<b>","truncated":false}"#)
        })
        let a = try await loader.artifact("s1", "/p/index.html")
        XCTAssertEqual(a.mime, "text/html")
        XCTAssertEqual(a.charset, "utf-8")
        XCTAssertEqual(String(data: a.data, encoding: .utf8), "<b>")
        _ = try await loader.artifact("s1", "/p/index.html")
        XCTAssertEqual(calls.requests.count, 1, "the card's thumbnail and the window share one read")
        XCTAssertNotNil(loader.cached(artifact: "s1", "/p/index.html"))
        _ = try await loader.artifact("s1", "/p/index.html", reload: true)
        XCTAssertEqual(calls.requests.count, 2)
        _ = try await loader.artifact("s2", "/p/index.html")
        XCTAssertEqual(calls.requests.count, 3, "cached per chat")
        loader.forget("s1")
        XCTAssertNil(loader.cached(artifact: "s1", "/p/index.html"))
        XCTAssertNotNil(loader.cached(artifact: "s2", "/p/index.html"))
    }

    func testFetchesLoopbackPagesAndRefusesRedirectsAway() async throws {
        let loader = PreviewLoader(read: { r in
            let url = r.args[1].string ?? ""
            if url.hasSuffix("/moved") { return try JSONValue.parse(#"{"status":302,"contentType":"","base64":""}"#) }
            return try JSONValue.parse(#"{"url":"x","status":200,"contentType":"text/css; charset=utf-8","base64":"Yg=="}"#)
        })
        let css = try await loader.fetch("s1", try XCTUnwrap(URL(string: "http://localhost:5173/a.css")))
        XCTAssertEqual(css.mime, "text/css")
        XCTAssertEqual(css.charset, "utf-8")
        XCTAssertEqual(css.status, 200)
        do {
            _ = try await loader.fetch("s1", try XCTUnwrap(URL(string: "http://localhost:5173/moved")))
            XCTFail("a redirect away is not followed")
        } catch {}
    }

    func testTruncatedFilesAndErrorsSayWhy() async throws {
        let loader = PreviewLoader(read: { r in
            if r.channel == PreviewRequest.fetchChannel { throw RelayError("unreachable: nothing is listening on 5173", fromComputer: true) }
            return try JSONValue.parse(#"{"path":"/a.pdf","mime":"application/pdf","size":12000000,"kind":"binary","truncated":true}"#)
        })
        do {
            _ = try await loader.artifact("s1", "/a.pdf")
            XCTFail()
        } catch {
            XCTAssertEqual(PreviewLoader.message(error, loopback: false), "Too large to open on a phone (12 MB).")
        }
        do {
            _ = try await loader.fetch("s1", try XCTUnwrap(URL(string: "http://localhost:5173/")))
            XCTFail()
        } catch {
            XCTAssertEqual(PreviewLoader.message(error, loopback: true), "The preview server on your computer isn’t running.")
        }
    }

    func testALargeTextFileComesCut() async throws {
        let loader = PreviewLoader(read: { _ in
            try JSONValue.parse(#"{"path":"/big.txt","mime":"text/plain","size":3000000,"kind":"text","content":"start","truncated":true}"#)
        })
        let body = try await loader.artifact("s", "/big.txt")
        XCTAssertTrue(body.truncated)
        XCTAssertEqual(body.size, 3_000_000)
        XCTAssertEqual(String(data: body.data, encoding: .utf8), "start")
    }

    func testTheCacheKeepsToItsLimit() async throws {
        let loader = PreviewLoader(read: { r in
            .object(["path": r.args[1], "mime": "text/plain", "kind": "text", "content": .string(String(repeating: "x", count: 600))])
        }, byteLimit: 1000)
        _ = try await loader.artifact("s", "/a.txt")
        _ = try await loader.artifact("s", "/b.txt")
        XCTAssertNil(loader.cached(artifact: "s", "/a.txt"), "the oldest is dropped")
        XCTAssertNotNil(loader.cached(artifact: "s", "/b.txt"))
    }

    func testThumbnailSlotsLimitConcurrentLoads() async {
        let loader = PreviewLoader(read: { _ in .null }, thumbnailSlots: 2)
        var running = 0
        var peak = 0
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<5 {
                group.addTask { @MainActor in
                    await loader.withThumbnailSlot {
                        running += 1
                        peak = max(peak, running)
                        await Task.yield()
                        try? await Task.sleep(nanoseconds: 5_000_000)
                        running -= 1
                    }
                }
            }
        }
        XCTAssertEqual(peak, 2)
        XCTAssertEqual(running, 0)
    }
}
