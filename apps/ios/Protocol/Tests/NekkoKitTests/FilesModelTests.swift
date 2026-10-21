import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// IO-33 FA-1 and FA-5: the Files and Logs screens' state. Reads are plain
/// calls; a save is a signed Change, checked against the hash the phone read.
@MainActor
final class FilesModelTests: XCTestCase {
    nonisolated static let h1 = String(repeating: "1", count: 64)
    nonisolated static let h2 = String(repeating: "2", count: 64)
    nonisolated static let h3 = String(repeating: "3", count: 64)

    /// A computer's folder with one file, whose hash changes with each save.
    final class Disk {
        var text = "hello\n"
        var hash = FilesModelTests.h1
        var reads: [FilesRequest] = []
        var changes: [FilesRequest] = []
        var refuseRead: Error?
        var refuseChange: Error?

        func read(_ r: FilesRequest) throws -> JSONValue {
            reads.append(r)
            if let refuseRead { throw refuseRead }
            switch r.channel {
            case Channels.filesList:
                return ["path": "", "entries": [["name": "src", "path": "src", "dir": true], ["name": "a.md", "path": "a.md", "dir": false, "size": 6]],
                        "total": 2, "truncated": false, "hiddenSecrets": 1, "hiddenLinks": 0]
            case Channels.filesSearch: return ["hits": [["path": "a.md", "name": "a.md"]], "truncated": false, "complete": true]
            case Channels.filesRead:
                return ["path": "a.md", "name": "a.md", "size": 6, "hash": .string(hash), "kind": "text", "content": .string(text),
                        "truncated": false, "editable": true, "markdown": true]
            case Channels.logsList: return [["id": "daemon", "title": "Engine", "kind": "daemon", "size": 10, "updatedAt": 1]]
            case Channels.logsRead:
                if r.args[1]["query"] != nil { return ["id": "daemon", "size": 10, "truncated": false, "query": "err", "matches": [["line": 3, "text": "error"]]] }
                return ["id": "daemon", "size": 10, "truncated": true, "text": "a\nb\n"]
            default: return .null
            }
        }

        func change(_ r: FilesRequest) throws -> JSONValue {
            changes.append(r)
            if let refuseChange { throw refuseChange }
            guard r.args[3]["expectHash"]?.string == hash else { return ["ok": false, "error": "conflict", "hash": .string(hash)] }
            text = r.args[2].string ?? ""
            hash = FilesModelTests.h3
            return ["ok": true, "hash": .string(hash), "size": 1, "mtime": 2]
        }
    }

    func model(_ disk: Disk, _ root: FileRoot = .chat("s1")) -> FilesModel {
        FilesModel(root: root, read: { try disk.read($0) }, change: { try disk.change($0) })
    }

    func testListsSearchesAndOpensByFolderIdOnly() async throws {
        let disk = Disk()
        let m = model(disk, .folder("w1"))
        let l = try await m.list()
        XCTAssertEqual(l.entries.map(\.path), ["src", "a.md"])
        XCTAssertEqual(l.hiddenSecrets, 1)
        let hits = try await m.search("a").hits
        XCTAssertEqual(hits.map(\.path), ["a.md"])
        let f = try await m.open("a.md")
        XCTAssertTrue(f.canEdit)
        XCTAssertEqual(f.lines, ["hello"])
        XCTAssertEqual(disk.reads.map { $0.args.first }, Array(repeating: FileRoot.folder("w1").json as JSONValue?, count: 3))
        XCTAssertTrue(disk.reads.allSatisfy { !$0.isChange })
        XCTAssertTrue(disk.changes.isEmpty)
    }

    func testSavesOverTheVersionReadThenTracksTheNewHash() async throws {
        let disk = Disk()
        let m = model(disk)
        let edit = FileEditModel(files: m, file: try await m.open("a.md"))
        XCTAssertFalse(edit.canSave, "nothing changed yet")
        edit.draft = "hello, phone\n"
        XCTAssertTrue(edit.canSave)
        let saved = await edit.save()
        XCTAssertTrue(saved)
        XCTAssertEqual(disk.text, "hello, phone\n")
        XCTAssertEqual(disk.changes.first, .write(.chat("s1"), "a.md", content: "hello, phone\n", expectHash: Self.h1))
        XCTAssertTrue(disk.changes.allSatisfy(\.isChange))
        XCTAssertEqual(edit.hash, Self.h3)
        XCTAssertFalse(edit.dirty)
    }

    func testAChangeOnTheComputerAsksToReloadOrOverwrite() async throws {
        let disk = Disk()
        let m = model(disk)
        let edit = FileEditModel(files: m, file: try await m.open("a.md"))
        // The desktop saved meanwhile.
        disk.text = "desktop\n"
        disk.hash = Self.h2
        edit.draft = "phone\n"
        let first = await edit.save()
        XCTAssertFalse(first)
        XCTAssertEqual(edit.conflict, .some(Self.h2))
        XCTAssertTrue(edit.canOverwrite)
        XCTAssertFalse(edit.canSave, "Save waits for a choice")
        XCTAssertEqual(disk.text, "desktop\n", "nothing was overwritten unseen")
        // Overwrite saves over the version the computer has now.
        let over = await edit.overwrite()
        XCTAssertTrue(over)
        XCTAssertEqual(disk.text, "phone\n")
        XCTAssertTrue(edit.conflict == nil)
        // Or reload: the draft becomes the computer's copy.
        disk.text = "desktop again\n"
        disk.hash = Self.h2
        edit.draft = "lost\n"
        _ = await edit.save()
        await edit.reload()
        XCTAssertEqual(edit.draft, "desktop again\n")
        XCTAssertEqual(edit.hash, Self.h2)
        XCTAssertTrue(edit.conflict == nil)
    }

    func testRefusalsAreSaidPlainlyAndHideSave() async throws {
        let disk = Disk()
        let m = model(disk)
        let edit = FileEditModel(files: m, file: try await m.open("a.md"))
        disk.refuseChange = ChangeRefused(code: "change-off", message: "Changes from this phone are turned off on Studio.")
        edit.draft = "x"
        let saved = await edit.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(edit.error, "Changes from this phone are turned off on Studio.")
        XCTAssertTrue(m.changeOff)
        XCTAssertFalse(edit.canSave)
        disk.refuseRead = ChangeRefused(code: "read-off", message: "Reading from this phone is turned off on Studio.")
        do {
            _ = try await m.list()
            XCTFail("refused")
        } catch {
            XCTAssertEqual(FilesModel.message(error), "Reading from this phone is turned off on Studio.")
        }
        XCTAssertTrue(m.readOff)
        disk.refuseRead = RelayError("secret-file: this file may hold secrets and is never shown", fromComputer: true)
        do {
            _ = try await m.open(".env")
            XCTFail("refused")
        } catch {
            XCTAssertEqual(FilesModel.message(error), "This file may hold secrets, so it never leaves the computer.")
        }
    }

    func testAPhoneNeverSavesMoreThanItCouldRead() async throws {
        let disk = Disk()
        let m = model(disk)
        let edit = FileEditModel(files: m, file: try await m.open("a.md"))
        edit.draft = String(repeating: "x", count: FileEditModel.writeBytes + 1)
        XCTAssertTrue(edit.tooLarge)
        let saved = await edit.save()
        XCTAssertFalse(saved)
        XCTAssertTrue(disk.changes.isEmpty)
    }

    func testLogsListTailAndSearch() async throws {
        let disk = Disk()
        let logs = LogsModel(read: { try disk.read($0) })
        await logs.load()
        XCTAssertEqual(logs.logs.map(\.id), ["daemon"])
        let t = try await logs.tail("daemon")
        XCTAssertEqual(t.text, "a\nb\n")
        XCTAssertTrue(t.truncated)
        let s = try await logs.search("daemon", "err")
        XCTAssertEqual(s.matches, [LogText.Match(line: 3, text: "error")])
        XCTAssertEqual(disk.reads.last, .log("daemon", query: "err"))
        XCTAssertEqual(disk.reads[1].args[1], ["tailBytes": .int(Int64(LogsModel.tailBytes))])
    }
}
