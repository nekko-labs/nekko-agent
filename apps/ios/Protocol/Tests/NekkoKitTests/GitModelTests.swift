import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// IO-33 FA-2: the Git screen's state. Reads are plain calls; every change is
/// a signed Change action, checked here by the same rules the computer uses.
@MainActor
final class GitModelTests: XCTestCase {
    /// A computer's git, answering reads and recording changes.
    final class Repo {
        var reads: [GitRequest] = []
        var changes: [GitRequest] = []
        var staged: [JSONValue] = []
        var unstaged: [JSONValue] = [["path": "src/a.ts", "status": "modified", "additions": 1, "deletions": 0, "patch": "@@ -1 +1,2 @@\n a\n+b"],
                                     ["path": ".env", "status": "modified", "additions": 1, "deletions": 1, "patch": "", "hidden": true]]
        var refuse: Error?
        var commitOk = true

        func read(_ r: GitRequest) throws -> JSONValue {
            reads.append(r)
            if let refuse { throw refuse }
            switch r.channel {
            case Channels.workspaceGitStatus: return ["repo": true, "branch": "feat", "dirtyCount": 2, "ahead": 1, "behind": 0]
            case Channels.gitDiff: return ["files": .array(r.args[1]["staged"]?.bool == true ? staged : unstaged), "truncated": false]
            case Channels.gitLog: return [["sha": "abc", "author": "Ada", "subject": "First", "parents": []]]
            default: return .null
            }
        }

        func change(_ r: GitRequest) throws -> JSONValue {
            changes.append(r)
            if let refuse { throw refuse }
            switch r.channel {
            case Channels.gitStage:
                staged = unstaged.filter { f in r.args[1].array?.contains(f["path"] ?? .null) == true }
                unstaged.removeAll { f in r.args[1].array?.contains(f["path"] ?? .null) == true }
                return ["ok": true, "message": "Staged."]
            case Channels.gitCommitMessage: return ["message": "Add b\n\nBecause.", "inputTruncated": true]
            case Channels.gitCommit:
                return commitOk ? ["ok": true, "message": "Committed abc.", "commit": ["sha": "abc", "author": "Ada", "subject": "Add b"]]
                    : ["ok": false, "message": "nothing to commit"]
            case Channels.prCreate: return ["ok": true, "message": "Opened.", "url": "https://github.com/o/r/pull/9"]
            default: return ["ok": true, "message": "Done."]
            }
        }
    }

    func model(_ repo: Repo) -> GitModel {
        GitModel(chatId: "s1", read: { try repo.read($0) }, change: { try repo.change($0) })
    }

    func testLoadsStatusAndBothSidesOfTheIndex() async {
        let repo = Repo()
        let m = model(repo)
        await m.load()
        XCTAssertEqual(m.status?.branch, "feat")
        XCTAssertEqual(m.unstaged.files.map(\.path), ["src/a.ts", ".env"])
        XCTAssertTrue(m.staged.files.isEmpty)
        XCTAssertEqual(Set(repo.reads.map(\.channel)), [Channels.workspaceGitStatus, Channels.gitDiff])
        XCTAssertTrue(repo.reads.allSatisfy { $0.args.first == "session:s1" }, "a phone names the chat, never a folder")
        XCTAssertTrue(repo.changes.isEmpty, "reading changes nothing")
    }

    func testStageWriteACommitMessageAndCommit() async {
        let repo = Repo()
        let m = model(repo)
        await m.load()
        XCTAssertFalse(m.canCommit)
        await m.stage(["src/a.ts"])
        XCTAssertEqual(m.staged.files.map(\.path), ["src/a.ts"])
        XCTAssertEqual(m.notice, GitNotice(ok: true, text: "Staged."))
        await m.writeMessage()
        XCTAssertEqual(m.message, "Add b\n\nBecause.")
        XCTAssertTrue(m.messageFromCutDiff)
        XCTAssertTrue(m.canCommit)
        await m.commit()
        XCTAssertEqual(m.message, "", "the field empties once committed")
        XCTAssertEqual(repo.changes.map(\.channel), [Channels.gitStage, Channels.gitCommitMessage, Channels.gitCommit])
        XCTAssertEqual(repo.changes.last?.args, ["session:s1", ["message": "Add b\n\nBecause."]])
        XCTAssertTrue(repo.changes.allSatisfy(\.isChange))
    }

    func testGitsRefusalKeepsTheMessageAndSaysWhy() async {
        let repo = Repo()
        repo.commitOk = false
        let m = model(repo)
        m.message = "Try"
        await m.commit()
        XCTAssertEqual(m.message, "Try")
        XCTAssertEqual(m.notice, GitNotice(ok: false, text: "nothing to commit"))
    }

    func testTheComputersRefusalIsShownPlainly() async {
        let repo = Repo()
        repo.refuse = ChangeRefused(code: "change-off", message: "Changes from this phone are turned off on Studio.")
        let m = model(repo)
        await m.push()
        XCTAssertEqual(m.notice?.ok, false)
        XCTAssertEqual(m.notice?.text, "Changes from this phone are turned off on Studio.")
        XCTAssertNil(m.busy)
    }

    func testCreatesAPullRequestAndHistory() async throws {
        let repo = Repo()
        let m = model(repo)
        let url = await m.createPr(title: "  Add b ", body: "", base: "main", draft: true)
        XCTAssertEqual(url, "https://github.com/o/r/pull/9")
        XCTAssertEqual(repo.changes.first?.args, ["session:s1", ["title": "Add b", "draft": true, "base": "main"]])
        let log = try await m.history()
        XCTAssertEqual(log.first?.author, "Ada")
    }

    /// Git changes signed for real and checked by a computer that verifies proofs.
    func testGitChangesAreSignedAndAcceptedByTheComputersRules() async throws {
        let computer = ProofComputer()
        let now = computer.now
        let calls = ChangeCalls(caller: computer, signer: SoftwareChangeSigner(), deviceId: "phone-1", computerName: "Studio", now: { now })
        let m = GitModel(chatId: "s1", read: { _ in .null }, change: { r in try await calls.call(change: r.channel, r.args) })
        await m.stage(["a.txt"])
        await m.push()
        XCTAssertEqual(computer.channels(), [ChangeProof.keyChannel, Channels.gitStage, Channels.gitPush])
        XCTAssertEqual(m.notice?.ok, false, "the stand-in answers {ok: channel}, not a git result")
        computer.changeOn = false
        await m.abortMerge()
        XCTAssertEqual(m.notice?.text, "Changes from this phone are turned off on Studio. Turn them on in Remote access → What phones can do.")
    }
}
