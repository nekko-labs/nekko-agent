import Foundation
import NekkoProtocol
import Observation

/// A chat's or saved folder's files from the phone (IO-33 FA-1): browse,
/// search, read, and save small text files. Reads are plain calls; a save goes
/// through `ComputersStore.call(change:)`, so the phone asks for Face ID or
/// the passcode (once per 5 minutes) and the computer checks the signature
/// and the hash the phone read.
@MainActor
@Observable
public final class FilesModel {
    public let root: FileRoot
    /// Reading from this phone is turned off on the computer (it said so).
    public private(set) var readOff = false
    /// Changes from this phone are turned off on the computer (it said so): Save is hidden.
    public private(set) var changeOff = false

    public typealias Call = @MainActor @Sendable (FilesRequest) async throws -> JSONValue
    private let read: Call
    private let change: Call

    /// `read` and `change` call the computer; tests pass their own.
    public init(root: FileRoot, read: @escaping Call, change: @escaping Call) {
        self.root = root
        self.read = read
        self.change = change
    }

    public convenience init(store: ComputersStore, root: FileRoot) {
        self.init(root: root,
                  read: { [weak store] r in
                      guard let store else { throw RelayError("Not connected to a computer.") }
                      return try await store.call(read: r.channel, r.args)
                  },
                  change: { [weak store] r in
                      guard let store else { throw RelayError("Not connected to a computer.") }
                      return try await store.call(change: r.channel, r.args)
                  })
    }

    public func list(_ path: String = "") async throws -> FileListing {
        guard let l = FileListing.from(try await reading(.list(root, path))) else { throw RelayError("The computer sent no listing.") }
        return l
    }

    public func search(_ query: String) async throws -> FileSearch {
        FileSearch.from(try await reading(.search(root, query)))
    }

    public func open(_ path: String) async throws -> FileContent {
        guard let f = FileContent.from(try await reading(.read(root, path))) else {
            throw RelayError("This file can’t be shown on a phone.")
        }
        return f
    }

    /// Save `content` over the version with `expectHash`.
    public func save(_ path: String, content: String, expectHash: String) async throws -> FileSaveResult {
        do {
            let v = try await change(.write(root, path, content: content, expectHash: expectHash))
            guard let r = FileSaveResult.from(v) else { throw RelayError("The computer didn’t say whether it saved.") }
            changeOff = false
            return r
        } catch {
            throw noted(error)
        }
    }

    /// What to show for a failed call: the computer's refusal said plainly.
    public static func message(_ error: Error) -> String {
        if let r = error as? ChangeRefused { return r.message }
        return FilesError.plain(error.localizedDescription)
    }

    private func reading(_ r: FilesRequest) async throws -> JSONValue {
        do {
            let v = try await read(r)
            readOff = false
            return v
        } catch {
            throw noted(error)
        }
    }

    private func noted(_ error: Error) -> Error {
        if let r = error as? ChangeRefused {
            if r.code == "read-off" { readOff = true }
            if r.code == "change-off" { changeOff = true }
            return r
        }
        if let e = error as? RelayError { return RelayError(FilesError.plain(e.message)) }
        return error
    }
}

/// Editing one text file: the version read (its hash), the draft, and what
/// happens on Save when the computer's copy changed meanwhile ("Changed on
/// the computer": reload it, or save over that newer version).
@MainActor
@Observable
public final class FileEditModel {
    public let path: String
    private let files: FilesModel
    /// The text as read, and its hash on the computer.
    public private(set) var base: String
    public private(set) var hash: String
    public var draft: String
    public private(set) var saving = false
    public private(set) var error: String?
    /// The computer's copy changed since it was read: its hash now (nil: it is gone).
    public private(set) var conflict: String??
    public private(set) var savedAt: Date?

    public init(files: FilesModel, file: FileContent) {
        path = file.path
        self.files = files
        base = file.text ?? ""
        hash = file.hash ?? ""
        draft = file.text ?? ""
    }

    public var dirty: Bool { draft != base }
    /// Whether Save is offered: there is something to save and the computer allows changes.
    public var canSave: Bool { dirty && !saving && !files.changeOff && conflict == nil }
    /// A newer version on the computer can be saved over (not when the file is gone: a phone never creates one).
    public var canOverwrite: Bool { if case .some(.some) = conflict { return true } else { return false } }
    /// The draft is larger than a phone may save (`PHONE_FILES_VIEW.writeBytes`).
    public var tooLarge: Bool { draft.utf8.count > Self.writeBytes }
    nonisolated public static let writeBytes = 256 * 1024

    /// Save the draft over the version read. True when it saved.
    @discardableResult
    public func save() async -> Bool { await save(over: hash) }

    /// Save over the computer's newer version, after "Changed on the computer".
    @discardableResult
    public func overwrite() async -> Bool {
        guard case .some(.some(let current)) = conflict else { return false }
        return await save(over: current)
    }

    /// Throw the draft away and read the computer's version again.
    public func reload() async {
        do {
            let f = try await files.open(path)
            base = f.text ?? ""
            hash = f.hash ?? ""
            draft = base
            conflict = nil
            error = f.canEdit ? nil : "This file can no longer be edited from a phone."
        } catch {
            self.error = FilesModel.message(error)
        }
    }

    /// Keep editing without resolving the conflict yet.
    public func dismissConflict() { conflict = nil }

    private func save(over expect: String) async -> Bool {
        guard !saving else { return false }
        if tooLarge {
            error = "Too large to save from a phone (256 KB at most)."
            return false
        }
        saving = true
        defer { saving = false }
        do {
            switch try await files.save(path, content: draft, expectHash: expect) {
            case .saved(let h):
                base = draft
                hash = h
                conflict = nil
                error = nil
                savedAt = Date()
                return true
            case .conflict(let current):
                conflict = .some(current)
                error = nil
                return false
            }
        } catch {
            self.error = FilesModel.message(error)
            return false
        }
    }
}

/// The computer's logs, read only (IO-33 FA-5): the desktop app's, the
/// engine's and each chat's agent run log, redacted on the computer.
@MainActor
@Observable
public final class LogsModel {
    public private(set) var logs: [LogInfo] = []
    public private(set) var loaded = false
    public private(set) var error: String?
    /// How much of a tail to ask for.
    nonisolated public static let tailBytes = 64 * 1024

    public typealias Call = FilesModel.Call
    private let read: Call

    public init(read: @escaping Call) {
        self.read = read
    }

    public convenience init(store: ComputersStore) {
        self.init(read: { [weak store] r in
            guard let store else { throw RelayError("Not connected to a computer.") }
            return try await store.call(read: r.channel, r.args)
        })
    }

    public func load() async {
        do {
            logs = LogInfo.list(try await read(.logs()))
            error = nil
        } catch {
            self.error = FilesModel.message(error)
        }
        loaded = true
    }

    /// The end of a log.
    public func tail(_ id: String, bytes: Int = LogsModel.tailBytes) async throws -> LogText {
        guard let t = LogText.from(try await read(.log(id, tailBytes: bytes))) else { throw RelayError("The computer sent no log.") }
        return t
    }

    /// The log's lines that hold `query` (case-insensitive), numbered.
    public func search(_ id: String, _ query: String) async throws -> LogText {
        guard let t = LogText.from(try await read(.log(id, query: query))) else { throw RelayError("The computer sent no log.") }
        return t
    }
}
