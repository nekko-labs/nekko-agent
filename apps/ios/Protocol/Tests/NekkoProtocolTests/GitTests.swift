import Foundation
import XCTest
@testable import NekkoProtocol

/// IO-33 FA-2: git requests, the computer's phone views decoded, and git
/// patches drawn as the Changes view's hunks.
final class GitTests: XCTestCase {
    /// The shared cases the computer's TS and Rust are held to (phone-git.json).
    func golden() throws -> JSONValue {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/tests/golden/phone-git.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available at \(file.path)") }
        return try JSONValue.parse(data)
    }

    func view(_ g: JSONValue, _ channel: String, _ n: Int = 0) throws -> JSONValue {
        let all = (g["views"]?.array ?? []).filter { $0.str("channel") == channel }
        return try XCTUnwrap(all.dropFirst(n).first?["view"])
    }

    func testRequestsNameTheChatAndOnlyFieldsTheComputerAccepts() {
        XCTAssertEqual(GitRequest.status("s1"), GitRequest("workspace:gitStatus", ["session:s1", false]))
        XCTAssertEqual(GitRequest.diff("s1", staged: true).args, ["session:s1", ["staged": true]])
        XCTAssertEqual(GitRequest.log("s1", limit: 20, skip: 40).args, ["session:s1", ["limit": 20, "skip": 40]])
        XCTAssertEqual(GitRequest.stage("s1", ["a", "b/c"]).args, ["session:s1", ["a", "b/c"]])
        XCTAssertEqual(GitRequest.commit("s1", message: "Fix").args, ["session:s1", ["message": "Fix"]])
        XCTAssertEqual(GitRequest.push("s1").args, ["session:s1", ["setUpstream": true]])
        XCTAssertEqual(GitRequest.switchBranch("s1", "feat", create: true).args, ["session:s1", "feat", ["create": true]])
        XCTAssertEqual(GitRequest.createPr("s1", title: "T", body: "", base: nil, draft: true).args, ["session:s1", ["title": "T", "draft": true]])
        XCTAssertEqual(GitRequest.createPr("s1", title: "T", body: "B", base: "main").args,
                       ["session:s1", ["title": "T", "draft": false, "body": "B", "base": "main"]])
        XCTAssertEqual(GitRequest.prAction("https://github.com/o/r/pull/1", .merge).args, ["https://github.com/o/r/pull/1", "merge"])
        // The Change actions are the ones the computer asks a signature for.
        XCTAssertTrue(GitRequest.commitMessage("s1").isChange, "it spends the computer's model tokens")
        XCTAssertTrue(GitRequest.prAction("u", .approve).isChange)
        XCTAssertFalse(GitRequest.diff("s1", staged: false).isChange)
        XCTAssertFalse(GitRequest.prChecks("u").isChange)
        // Every git request can be signed (canonical JSON: no floats).
        for r in [GitRequest.stage("s1", ["a"]), .commit("s1", message: "m"), .push("s1"), .switchBranch("s1", "b"), .mergeAbort("s1"),
                  .createPr("s1", title: "t"), .prAction("u", .close), .commitMessage("s1"), .unstage("s1", ["a"])] {
            XCTAssertNoThrow(try ChangeProof.canonicalJSON(.array(r.args)), r.channel)
        }
    }

    func testTheClassesMatchTheComputer() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/src/phone-access.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available") }
        let policy = try JSONValue.parse(data)
        let change = Set(policy["changeChannels"]?.array?.compactMap(\.string) ?? [])
        XCTAssertEqual(change.filter { Channels.all.contains($0) }, Channels.gitChange)
    }

    func testDecodesTheComputersViews() throws {
        let g = try golden()
        let status = try XCTUnwrap(GitStatus.from(try view(g, "workspace:gitStatus")))
        XCTAssertEqual(status.position, "feat")
        XCTAssertEqual(status.drift, "1 to push · 2 to pull")
        XCTAssertEqual(status.worktree, "feat-wt")
        XCTAssertEqual(status.pr?.number, 7)
        XCTAssertFalse(try XCTUnwrap(GitStatus.from(try view(g, "workspace:gitStatus", 1))).repo)

        let diff = GitDiff.from(try view(g, "git:diff"))
        let env = try XCTUnwrap(diff.files.first { $0.path == ".env" })
        XCTAssertTrue(env.hidden)
        XCTAssertTrue(env.hunks.isEmpty, "a secret file’s patch never arrives")
        XCTAssertEqual(diff.hiddenFiles, 2)
        let app = try XCTUnwrap(diff.files.first { $0.path == "src/app.ts" })
        XCTAssertEqual(app.hunks.first?.lines.map(\.kind), [.removed, .added, .same])
        XCTAssertEqual(diff.files.first { $0.path == "new.txt" }?.mark, "?")
        let big = try XCTUnwrap(diff.files.first { $0.path == "big.txt" })
        XCTAssertTrue(big.truncated)
        XCTAssertEqual(big.hunks.first?.lines.count, 299, "300 patch lines kept: the header and 299 lines")
        let many = GitDiff.from(try view(g, "git:diff", 1))
        XCTAssertEqual(many.files.count, 100)
        XCTAssertEqual(many.omittedFiles, 5)
        XCTAssertTrue(many.truncated)

        let detail = try XCTUnwrap(GitCommitDetail.from(try view(g, "git:show")))
        XCTAssertEqual(detail.commit.author, "Ada Lovelace")
        XCTAssertEqual(detail.commit.body?.count, 4000)
        XCTAssertEqual(GitCommit.list(try view(g, "git:log")).map(\.subject), ["First", "Second"])
        XCTAssertEqual(GitCommit.list(try view(g, "git:log", 1)).count, 100)

        let cmp = try XCTUnwrap(GitCompare.from(try view(g, "git:compare")))
        XCTAssertEqual([cmp.ahead, cmp.behind], [2, 1])
        XCTAssertEqual(cmp.diff.files.map(\.hidden), [false, true])

        let branches = GitBranches.from(try view(g, "git:branches"))
        XCTAssertEqual(branches.current, "feat")
        XCTAssertEqual(branches.local.first?.upstream, "origin/feat")
        XCTAssertEqual(branches.remote.count, 200)
        XCTAssertEqual(branches.omitted, 3)

        let checks = try XCTUnwrap(PrCheckList.from(try view(g, "pr:checks")))
        XCTAssertEqual(checks.rollup, .failing)
        XCTAssertEqual(checks.items.map(\.state), [.fail, .pass])

        let commit = GitResult.from(try view(g, "git:commit"))
        XCTAssertTrue(commit.ok)
        XCTAssertEqual(commit.commit?.subject, "Fix it")
        let refused = GitResult.from(try view(g, "git:commit", 1))
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.message.count, 4000)
        XCTAssertEqual(GitResult.from(try view(g, "pr:create")).url, "https://github.com/o/r/pull/7")
        XCTAssertEqual(GitResult.from(try view(g, "pr:action")).pr?.state, .merged)
        XCTAssertEqual(GitCommitMessage.from(try view(g, "git:commitMessage"))?.message, "Fix it\n\nBecause.")
    }

    func testDrawsGitPatchesAsHunks() {
        let hunks = GitFile.hunks("@@ -3,4 +3,5 @@ fn main\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file\n@@ -20 +21 @@\n-x\n+y")
        XCTAssertEqual(hunks.count, 2)
        XCTAssertEqual(hunks[0].lines.map(\.number), [3, 4, 4, 5, 6])
        XCTAssertEqual(hunks[0].lines.map(\.kind), [.same, .removed, .added, .added, .same])
        XCTAssertEqual(hunks[1].oldStart, 20)
        XCTAssertEqual(hunks[1].newStart, 21)
        // A new file starts at 0 on the old side.
        let new = GitFile.hunks("@@ -0,0 +1,2 @@\n+one\n+two\n")
        XCTAssertEqual(new.first?.lines.map(\.number), [1, 2])
        XCTAssertTrue(GitFile.hunks("").isEmpty)
        XCTAssertTrue(GitFile.hunks("not a patch").isEmpty)
    }

    func testBranchHelpers() {
        let b = GitBranches(current: "main", defaultBranch: nil, local: [GitBranch(name: "main", current: true)],
                            remote: [GitBranch(name: "origin/main", remote: "origin"), GitBranch(name: "origin/feat", remote: "origin"),
                                     GitBranch(name: "origin/HEAD", remote: "origin")])
        XCTAssertEqual(b.remoteOnly.map(\.localName), ["feat"])
        XCTAssertEqual(b.compareBase, "main")
    }
}
