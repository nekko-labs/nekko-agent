import Foundation
import NekkoProtocol
import Observation

/// Git on one chat's folder from the phone (IO-33 FA-2): its status and
/// changed files, history, branches, compare and a PR's checks, and the
/// Change actions. Reads are plain calls; every change goes through
/// `ComputersStore.call(change:)`, so the phone asks for Face ID or the
/// passcode (once per 5 minutes) and the computer checks the signature.
@MainActor
@Observable
public final class GitModel {
    public let chatId: String
    public private(set) var status: GitStatus?
    /// Unstaged changes, new files included.
    public private(set) var unstaged = GitDiff()
    public private(set) var staged = GitDiff()
    public private(set) var loaded = false
    public private(set) var loading = false
    /// Why the last read failed.
    public private(set) var error: String?
    /// A change in flight: its channel.
    public private(set) var busy: String?
    /// What the last change said (git's own words), and whether it worked.
    public private(set) var notice: GitNotice?
    /// The commit message being written.
    public var message = ""
    /// The model's message was written from a cut diff.
    public private(set) var messageFromCutDiff = false

    public typealias Call = @MainActor @Sendable (GitRequest) async throws -> JSONValue
    private let read: Call
    private let change: Call

    /// `read` and `change` call the computer; tests pass their own.
    public init(chatId: String, read: @escaping Call, change: @escaping Call) {
        self.chatId = chatId
        self.read = read
        self.change = change
    }

    public convenience init(store: ComputersStore, chatId: String) {
        self.init(chatId: chatId,
                  read: { [weak store] r in
                      guard let store else { throw RelayError("Not connected to a computer.") }
                      return try await store.call(read: r.channel, r.args)
                  },
                  change: { [weak store] r in
                      guard let store else { throw RelayError("Not connected to a computer.") }
                      // A model-written message can take a while.
                      return try await store.call(change: r.channel, r.args, timeout: r.channel == Channels.gitCommitMessage ? 90 : 150)
                  })
    }

    public var canCommit: Bool { !staged.files.isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && busy == nil }
    public var hasChanges: Bool { !staged.files.isEmpty || !unstaged.files.isEmpty }
    /// A file is unmerged: a merge stopped on a conflict, so it can be aborted.
    public var merging: Bool { (staged.files + unstaged.files).contains { $0.status == .conflicted } }

    // MARK: Reads

    /// Status, then the unstaged and staged changes, read together.
    public func load(refresh: Bool = false) async {
        loading = true
        defer { loading = false }
        do {
            async let s = read(.status(chatId, refresh: refresh))
            async let u = read(.diff(chatId, staged: false))
            async let st = read(.diff(chatId, staged: true))
            let (sv, uv, stv) = try await (s, u, st)
            status = GitStatus.from(sv)
            unstaged = GitDiff.from(uv)
            staged = GitDiff.from(stv)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    public func history(limit: Int = 50, skip: Int = 0, ref: String? = nil) async throws -> [GitCommit] {
        GitCommit.list(try await read(.log(chatId, limit: limit, skip: skip, ref: ref)))
    }

    public func commit(_ sha: String) async throws -> GitCommitDetail {
        guard let d = GitCommitDetail.from(try await read(.show(chatId, sha))) else { throw RelayError("Commit not found.") }
        return d
    }

    public func branches() async throws -> GitBranches { GitBranches.from(try await read(.branches(chatId))) }

    public func compare(base: String, head: String) async throws -> GitCompare {
        guard let c = GitCompare.from(try await read(.compare(chatId, base: base, head: head))) else { throw RelayError("Nothing to compare.") }
        return c
    }

    public func checks(_ url: String) async throws -> PrCheckList {
        guard let c = PrCheckList.from(try await read(.prChecks(url))) else { throw RelayError("No checks for this pull request.") }
        return c
    }

    public func prDiff(_ url: String) async throws -> GitDiff { GitDiff.from(try await read(.prDiff(url))) }

    // MARK: Changes

    public func stage(_ paths: [String]) async { await act(.stage(chatId, paths)) }
    public func unstage(_ paths: [String]) async { await act(.unstage(chatId, paths)) }
    public func stageAll() async { await stage(unstaged.files.map(\.path)) }
    public func unstageAll() async { await unstage(staged.files.map(\.path)) }

    /// Commit what is staged with `message`; the field empties when it worked.
    public func commit() async {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if await act(.commit(chatId, message: text))?.ok == true {
            message = ""
            messageFromCutDiff = false
        }
    }

    /// Ask the computer's model for a message for what is staged, into the field.
    public func writeMessage() async {
        guard busy == nil else { return }
        busy = Channels.gitCommitMessage
        defer { busy = nil }
        do {
            guard let m = GitCommitMessage.from(try await change(.commitMessage(chatId))) else {
                notice = GitNotice(ok: false, text: "The model wrote no message. Try again, or write one.")
                return
            }
            message = m.message
            messageFromCutDiff = m.inputTruncated
            notice = nil
        } catch {
            notice = GitNotice(ok: false, text: error.localizedDescription)
        }
    }

    public func push() async { await act(.push(chatId)) }

    @discardableResult
    public func switchTo(_ branch: String, create: Bool = false) async -> Bool {
        await act(.switchBranch(chatId, branch, create: create))?.ok == true
    }

    public func abortMerge() async { await act(.mergeAbort(chatId)) }

    /// Open a PR from the current branch (pushed first if it has no upstream). Its address, when it worked.
    public func createPr(title: String, body: String, base: String?, draft: Bool) async -> String? {
        let r = await act(.createPr(chatId, title: title.trimmingCharacters(in: .whitespacesAndNewlines), body: body, base: base, draft: draft))
        return r?.ok == true ? (r?.url ?? r?.pr?.url) : nil
    }

    @discardableResult
    public func prAction(_ url: String, _ action: PrAction) async -> GitResult? {
        await act(.prAction(url, action), reload: false)
    }

    public func clearNotice() { notice = nil }

    /// Run one change, say what happened, and read the status again.
    @discardableResult
    private func act(_ request: GitRequest, reload: Bool = true) async -> GitResult? {
        guard busy == nil else { return nil }
        busy = request.channel
        defer { busy = nil }
        do {
            let r = GitResult.from(try await change(request))
            notice = GitNotice(ok: r.ok, text: r.message.isEmpty ? (r.ok ? "Done." : "Git refused it.") : r.message)
            if reload { await load() }
            return r
        } catch {
            notice = GitNotice(ok: false, text: error.localizedDescription)
            return nil
        }
    }
}

/// What the last git change said: git's own words, and whether it worked.
public struct GitNotice: Equatable, Sendable {
    public let ok: Bool
    public let text: String

    public init(ok: Bool, text: String) {
        self.ok = ok
        self.text = text
    }
}
