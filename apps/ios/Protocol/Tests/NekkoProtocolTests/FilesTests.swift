import Foundation
import XCTest
@testable import NekkoProtocol

/// IO-33 FA-1 and FA-5: files and logs requests, and the computer's phone
/// views decoded from the shared cases its TS and Rust are held to.
final class FilesTests: XCTestCase {
    func golden() throws -> JSONValue {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/tests/golden/phone-files.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available at \(file.path)") }
        return try JSONValue.parse(data)
    }

    func view(_ g: JSONValue, _ channel: String, _ n: Int = 0) throws -> JSONValue {
        let all = (g["views"]?.array ?? []).filter { $0.str("channel") == channel }
        return try XCTUnwrap(all.dropFirst(n).first?["view"])
    }

    func testRequestsNameAFolderByIdAndOnlyFieldsTheComputerAccepts() throws {
        XCTAssertEqual(FilesRequest.list(.chat("s1")).args, [["sessionId": "s1"], ""])
        XCTAssertEqual(FilesRequest.list(.folder("w1"), "src").args, [["workspaceId": "w1"], "src"])
        XCTAssertEqual(FilesRequest.search(.chat("s1"), "read").args, [["sessionId": "s1"], "read", 50])
        XCTAssertEqual(FilesRequest.read(.chat("s1"), "a.md").args, [["sessionId": "s1"], "a.md"])
        let hash = String(repeating: "a", count: 64)
        let w = FilesRequest.write(.chat("s1"), "a.md", content: "x", expectHash: hash)
        XCTAssertEqual(w.args, [["sessionId": "s1"], "a.md", "x", ["expectHash": .string(hash)]])
        XCTAssertTrue(w.isChange)
        XCTAssertFalse(FilesRequest.read(.chat("s1"), "a.md").isChange)
        XCTAssertEqual(FilesRequest.log("daemon", query: "").args, ["daemon", [:]])
        XCTAssertEqual(FilesRequest.log("app", query: "err", tailBytes: 10).args, ["app", ["query": "err", "tailBytes": 10]])
        // A save can be signed (canonical JSON: no floats).
        XCTAssertNoThrow(try ChangeProof.canonicalJSON(.array(w.args)))
    }

    func testTheRequestsAreTheOnesTheComputerAccepts() throws {
        // Each request this phone sends is a case the computer screens without a refusal.
        let g = try golden()
        let ok = (g["screens"]?.array ?? []).filter { $0["error"] == nil }
        let accepted = ok.map { [$0["channel"] ?? .null, $0["args"] ?? .null] } + ok.map { [$0["channel"] ?? .null, $0["callArgs"] ?? .null] }
        let hash = String(repeating: "a", count: 64)
        for r in [FilesRequest.list(.chat("s1")), .list(.folder("w1")), .read(.chat("s1"), "src/main.rs"),
                  .write(.chat("s1"), "notes.md", content: "# Notes\n", expectHash: hash), .logs(), .search(.chat("s1"), "readme", limit: 20)] {
            XCTAssertTrue(accepted.contains([.string(r.channel), .array(r.args)]), "\(r.channel) \(r.args)")
        }
    }

    func testDecodesWhatTheComputerSends() throws {
        let g = try golden()
        let l = try XCTUnwrap(FileListing.from(try view(g, "files:list")))
        XCTAssertEqual(l.entries.map(\.path), ["src", "README.md"])
        XCTAssertEqual(l.hiddenSecrets, 5, "two counted by the computer, three more left out on the way")
        XCTAssertTrue(l.entries[0].dir)
        XCTAssertTrue(l.entries[1].link)
        let many = try XCTUnwrap(FileListing.from(try view(g, "files:list", 1)))
        XCTAssertEqual(many.entries.count, 500)
        XCTAssertTrue(many.truncated)
        let s = FileSearch.from(try view(g, "files:search"))
        XCTAssertEqual(s.hits.map(\.path), ["README.md", "docs/readme.txt"])
        let f = try XCTUnwrap(FileContent.from(try view(g, "files:read")))
        XCTAssertEqual(f.kind, .text)
        XCTAssertEqual(f.language, "rust")
        XCTAssertEqual(f.lines, ["fn main() {}"])
        XCTAssertTrue(f.canEdit)
        let img = try XCTUnwrap(FileContent.from(try view(g, "files:read", 1)))
        XCTAssertEqual(img.kind, .image)
        XCTAssertNotNil(img.image)
        XCTAssertFalse(img.canEdit)
        let evil = try XCTUnwrap(FileContent.from(try view(g, "files:read", 2)))
        XCTAssertNil(evil.image, "only data:image URLs reach the phone")
        XCTAssertEqual(FileSaveResult.from(try view(g, "files:write")), .saved(hash: String(repeating: "a", count: 64)))
        XCTAssertEqual(FileSaveResult.from(try view(g, "files:write", 1)), .conflict(current: String(repeating: "b", count: 64)))
        let logs = LogInfo.list(try view(g, "logs:list"))
        XCTAssertEqual(logs.map(\.id), ["app", "daemon", "agent:s1"])
        XCTAssertEqual(logs[2].sessionId, "s1")
        XCTAssertNil(logs[1].updatedAt)
        let tail = try XCTUnwrap(LogText.from(try view(g, "logs:read")))
        XCTAssertEqual(tail.text, "line one\nline two\n")
        let found = try XCTUnwrap(LogText.from(try view(g, "logs:read", 1)))
        XCTAssertEqual(found.matches.map(\.line), [4, 9])
        XCTAssertEqual(found.matches[1].text.count, 2000)
    }

    func testFilesErrorsAreSaidPlainly() {
        XCTAssertEqual(FilesError.plain("not-found: no such chat"), "No such chat.")
        XCTAssertEqual(FilesError.plain("secret-file: this file may hold secrets and is never shown"),
                       "This file may hold secrets, so it never leaves the computer.")
        XCTAssertEqual(FilesError.plain("Something else: kept"), "Something else: kept")
        XCTAssertEqual(PhoneRefusal("Not allowed from a paired phone (value-invalid): secret file")?.message(computer: "Studio"),
                       "This file may hold secrets, so it never leaves Studio.")
    }
}
