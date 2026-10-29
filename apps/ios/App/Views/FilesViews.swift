import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit

/// A chat's files (IO-33 FA-1), as a sheet from the chat's More menu.
struct FilesView: View {
    let root: FileRoot
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            FilesScreen(root: root, title: title)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// The computer's saved folders, each opening its files (from the computer menu).
struct FoldersView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    @State private var adding = false
    @State private var folderPath = ""
    @State private var removing: WorkspaceFolder?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            ConnectionBanner()
            if store.workspaces.isEmpty {
                Text("No saved folders on \(store.active?.name ?? "this computer").")
                    .foregroundStyle(palette.inkSoft)
            }
            ForEach(store.workspaces) { w in
                NavigationLink { FilesScreen(root: .folder(w.id), title: w.name) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(w.name, systemImage: "folder")
                        if let path = w.path { Text(path).font(.caption).foregroundStyle(palette.inkSoft) }
                    }
                }
                .accessibilityIdentifier("files.folder")
                .swipeActions(allowsFullSwipe: false) {
                    Button(role: .destructive) { removing = w } label: { Label("Remove saved folder", systemImage: "minus.circle") }
                        .disabled(unavailable)
                }
                .contextMenu {
                    Button(role: .destructive) { removing = w } label: { Label("Remove saved folder", systemImage: "minus.circle") }
                        .disabled(unavailable)
                }
            }
            Section {
                Button { folderPath = ""; adding = true } label: { Label("Add computer folder", systemImage: "plus") }
                    .disabled(unavailable)
                    .accessibilityIdentifier("files.addFolder")
                if busy { ProgressView() }
            } footer: {
                Text("Use an absolute path on the computer, not on this iPhone. Removing a saved folder never deletes files on disk.")
            }
        }
        .appBackground()
        .navigationTitle("Files")
        .accessibilityIdentifier("files.folders")
        .alert("Add computer folder", isPresented: $adding) {
            TextField("Absolute computer path", text: $folderPath)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Add") { act { try await store.addWorkspace(path: folderPath) } }
                .disabled(unavailable || !WorkspacePath.isAbsolute(folderPath.trimmingCharacters(in: .whitespacesAndNewlines)))
        } message: {
            Text("Enter the full folder path on \(store.active?.name ?? "the computer").")
        }
        .confirmationDialog("Remove saved folder?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove saved folder", role: .destructive) {
                if let folder = removing { act { try await store.removeWorkspace(folder.id) } }
            }.disabled(unavailable)
        } message: {
            Text("Only the saved entry is removed. The folder and its files stay on the computer.")
        }
        .alert("Couldn’t update folders", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    private var unavailable: Bool { busy || store.conn != .online }

    private func act(_ action: @escaping () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do { try await action() } catch { self.error = error.localizedDescription }
        }
    }
}

/// One folder's files: the root listing, with search across the folder.
struct FilesScreen: View {
    let root: FileRoot
    let title: String
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: FilesModel?

    var body: some View {
        Group {
            if let model {
                FolderList(model: model, path: "", title: title)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(palette.paper)
        .task { if model == nil { model = FilesModel(store: store, root: root) } }
    }
}

/// A folder's entries (folders first), or the files whose name matched the search.
private struct FolderList: View {
    let model: FilesModel
    let path: String
    let title: String
    @Environment(\.palette) private var palette
    @Environment(\.inPanes) private var inPanes
    @State private var listing: FileListing?
    @State private var error: String?
    @State private var query = ""
    @State private var hits: FileSearch?
    @State private var searching = false

    var body: some View {
        List {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                searchResults
            } else if let listing {
                entries(listing)
            } else if let error {
                failure(error)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .appBackground()
        .navigationTitle(path.isEmpty ? title : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Find a file by name")
        .accessibilityIdentifier("files.list")
        .refreshable { await load() }
        .task { if listing == nil { await load() } }
        .task(id: query) { await search() }
    }

    @ViewBuilder private func entries(_ l: FileListing) -> some View {
        Section {
            if l.entries.isEmpty { Text("Empty folder.").foregroundStyle(palette.inkSoft) }
            ForEach(l.entries) { e in row(e) }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if l.truncated { Text("Showing the first \(l.entries.count) of \(l.total).") }
                if l.hiddenSecrets > 0 {
                    Text(l.hiddenSecrets == 1 ? "1 file that may hold secrets isn’t shown on phones."
                         : "\(l.hiddenSecrets) files that may hold secrets aren’t shown on phones.")
                }
            }
        }
    }

    @ViewBuilder private var searchResults: some View {
        if let hits {
            Section {
                if hits.hits.isEmpty && !searching { Text("No file names match.").foregroundStyle(palette.inkSoft) }
                ForEach(hits.hits) { e in row(e, showPath: true) }
            } footer: {
                if hits.truncated || !hits.complete { Text("Showing the best matches. Narrow the search to see others.") }
            }
        } else if let error {
            failure(error)
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private func row(_ e: FileEntry, showPath: Bool = false) -> some View {
        NavigationLink {
            if e.dir {
                FolderList(model: model, path: e.path, title: title)
            } else {
                FileDetailView(model: model, path: e.path)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: e.dir ? "folder" : icon(e.name)).foregroundStyle(e.dir ? palette.accent : palette.inkSoft)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(e.name).foregroundStyle(palette.ink).lineLimit(1)
                    if showPath, e.path != e.name {
                        Text(e.path).font(.caption).foregroundStyle(palette.inkSoft).lineLimit(1).truncationMode(.head)
                    }
                }
                Spacer()
                if let size = e.size, !e.dir {
                    Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file)).font(.caption).foregroundStyle(palette.inkFaint)
                }
            }
        }
        .accessibilityIdentifier(e.dir ? "files.folderRow" : "files.fileRow")
        // On a folding phone or iPad, a file dragged to a chat pane adds its path to the message (FD-4).
        .modifier(PaneDraggable(text: e.dir || !inPanes ? nil : e.path))
    }

    private func failure(_ message: String) -> some View {
        Section {
            Label(message, systemImage: model.readOff ? "lock" : "exclamationmark.triangle").foregroundStyle(palette.danger)
                .accessibilityIdentifier("files.error")
            Button("Try again") { Task { await load() } }
        }
    }

    private func load() async {
        do {
            listing = try await model.list(path)
            error = nil
        } catch {
            self.error = FilesModel.message(error)
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { hits = nil; return }
        // Wait for typing to pause before asking the computer.
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        do {
            hits = try await model.search(q)
            error = nil
        } catch {
            hits = nil
            self.error = FilesModel.message(error)
        }
    }

    private func icon(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].contains(ext) { return "photo" }
        if ["md", "txt", "rst"].contains(ext) { return "doc.text" }
        return "doc.plaintext"
    }
}

/// One file: text in monospace with line numbers, an image, or a note; Edit for small text files.
struct FileDetailView: View {
    let model: FilesModel
    let path: String
    @Environment(\.palette) private var palette
    @State private var file: FileContent?
    @State private var error: String?
    @State private var editing: FileEditModel?
    @State private var rendered = false

    /// Lines drawn at most; the rest is on the computer.
    static let maxLines = 5000

    var body: some View {
        Group {
            if let file {
                content(file)
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn’t open it", systemImage: model.readOff ? "lock" : "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
                .accessibilityIdentifier("file.error")
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.paper)
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let file, file.markdown, file.text != nil {
                ToolbarItem(placement: .secondaryAction) {
                    Toggle(isOn: $rendered) { Label("Formatted", systemImage: "text.badge.checkmark") }
                }
            }
            if let file, file.canEdit, !model.changeOff {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { editing = FileEditModel(files: model, file: file) }
                        .accessibilityIdentifier("file.edit")
                }
            }
        }
        .sheet(item: Binding(get: { editing.map(EditBox.init) }, set: { if $0 == nil { editing = nil } })) { box in
            FileEditorView(edit: box.edit) { Task { await load() } }
        }
        .task { if file == nil { await load() } }
    }

    @ViewBuilder private func content(_ f: FileContent) -> some View {
        switch f.kind {
        case .image:
            if let data = f.image, let img = UIImage(data: data) {
                ScrollView([.vertical, .horizontal]) {
                    Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: 600).padding()
                        .accessibilityLabel(f.name)
                }
            } else {
                note("Too large to preview on a phone (\(size(f))).")
            }
        case .binary:
            note("Not a text file (\(size(f))). Open it on the computer.")
        case .text:
            ScrollView([.vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    banners(f)
                    if MermaidRules.isMermaidFile(f.name), !rendered, !f.truncated, let text = f.text {
                        // A .mmd or .mermaid file draws as its diagram, as a fence in a chat does (MM-2).
                        MermaidBlock(source: text, closed: true, style: .standard(palette)).padding(12)
                    } else if rendered, f.markdown, let text = f.text {
                        MarkdownText(text: text).padding(12)
                    } else {
                        CodeLines(lines: Array(f.lines.prefix(Self.maxLines)))
                        if f.lines.count > Self.maxLines {
                            note("Showing the first \(Self.maxLines) lines.")
                        }
                    }
                }
            }
            .refreshable { await load() }
            .accessibilityIdentifier("file.view")
        }
    }

    @ViewBuilder private func banners(_ f: FileContent) -> some View {
        if f.truncated {
            Label("Only the first \(ByteCountFormatter.string(fromByteCount: Int64(f.text?.utf8.count ?? 0), countStyle: .file)) of \(size(f)) is shown. Open it on the computer for the rest.",
                  systemImage: "scissors")
                .font(.footnote).foregroundStyle(palette.warning).padding(12)
                .accessibilityIdentifier("file.truncated")
        } else if f.editable == false {
            Text("Read only on a phone.").font(.footnote).foregroundStyle(palette.inkSoft).padding(.horizontal, 12).padding(.top, 8)
        } else if model.changeOff {
            Text("Changes from this phone are turned off on the computer.").font(.footnote).foregroundStyle(palette.inkSoft)
                .padding(.horizontal, 12).padding(.top, 8)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(palette.inkSoft).padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func size(_ f: FileContent) -> String { ByteCountFormatter.string(fromByteCount: f.size, countStyle: .file) }

    private func load() async {
        do {
            file = try await model.open(path)
            error = nil
        } catch {
            self.error = FilesModel.message(error)
        }
    }
}

private struct EditBox: Identifiable {
    let edit: FileEditModel
    var id: ObjectIdentifier { ObjectIdentifier(edit) }
}

/// Numbered monospace lines that scroll sideways as one block.
struct CodeLines: View {
    let lines: [String]
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView(.horizontal) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(i + 1)").font(.caption2.monospacedDigit()).foregroundStyle(palette.inkFaint)
                            .frame(minWidth: 34, alignment: .trailing)
                        Text(line.isEmpty ? " " : line).font(.footnote.monospaced()).foregroundStyle(palette.ink)
                            .fixedSize(horizontal: true, vertical: false)
                            .textSelection(.enabled)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 1)
                }
            }
            .padding(.vertical, 8)
        }
        .background(palette.code)
    }
}

/// Editing one small text file. Save asks for Face ID or the passcode (a
/// signed Change); if the file changed on the computer meanwhile, the owner
/// chooses to reload it or save over it.
struct FileEditorView: View {
    @Bindable var edit: FileEditModel
    var saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let error = edit.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        .accessibilityIdentifier("file.saveError")
                }
                TextEditor(text: $edit.draft)
                    .font(.footnote.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .scrollContentBackground(.hidden)
                    .background(palette.code)
                    .accessibilityIdentifier("file.editor")
                Text("Saving asks for Face ID or your passcode and shows in this phone’s activity on the computer.")
                    .font(.caption).foregroundStyle(palette.inkSoft).padding(10)
            }
            .background(palette.paper)
            .navigationTitle((edit.path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if edit.dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if edit.saving {
                        ProgressView()
                    } else {
                        Button("Save") {
                            Task {
                                if await edit.save() {
                                    saved()
                                    dismiss()
                                }
                            }
                        }
                        .disabled(!edit.canSave)
                        .accessibilityIdentifier("file.save")
                    }
                }
            }
            .interactiveDismissDisabled(edit.dirty)
            .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
            }
            .alert("Changed on the computer", isPresented: Binding(get: { edit.conflict != nil }, set: { if !$0 { edit.dismissConflict() } })) {
                Button("Reload, losing my edits", role: .destructive) { Task { await edit.reload() } }
                    .accessibilityIdentifier("file.conflict.reload")
                if edit.canOverwrite {
                    Button("Save over it") {
                        Task {
                            if await edit.overwrite() {
                                saved()
                                dismiss()
                            }
                        }
                    }
                    .accessibilityIdentifier("file.conflict.overwrite")
                }
                Button("Keep editing", role: .cancel) { edit.dismissConflict() }
            } message: {
                Text(edit.canOverwrite
                     ? "This file was changed on the computer after you opened it. Reload its new version, or save yours over it."
                     : "This file was removed or moved on the computer after you opened it.")
            }
        }
    }
}

/// Logs, from the computer menu, grouped by where they are kept: this
/// phone's connection log first, then each paired computer. The connected
/// computer's logs are read only (IO-33 FA-5); another computer offers to connect.
struct LogsView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: LogsModel?

    var body: some View {
        List {
            Section {
                NavigationLink(value: Route.connection) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Connection log", systemImage: "iphone").foregroundStyle(palette.ink).lineLimit(1)
                        Text(phoneDetail).font(.caption).foregroundStyle(palette.inkSoft)
                    }
                }
                .accessibilityIdentifier("logs.phone")
            } header: {
                GroupHeading(String(localized: "On this phone"))
            }
            .listRowBackground(Color.clear)
            ForEach(store.computers) { c in
                Section {
                    if c.id == store.activeId { computerLogs } else {
                        Button { store.connect(c.id) } label: {
                            Label("Connect to read its logs", systemImage: "bolt.horizontal").foregroundStyle(palette.accent)
                        }
                        .accessibilityIdentifier("logs.connect")
                    }
                } header: {
                    GroupHeading(c.name)
                }
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .appBackground()
        .navigationTitle("Logs")
        .accessibilityIdentifier("logs.list")
        .refreshable { await model?.load() }
        // Another computer connected from here: read its logs instead.
        .task(id: store.activeId) {
            model = LogsModel(store: store)
            await model?.load()
        }
    }

    @ViewBuilder private var computerLogs: some View {
        if let model {
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
                    .accessibilityIdentifier("logs.error")
            } else if model.loaded && model.logs.isEmpty {
                Text("No logs yet.").foregroundStyle(palette.inkSoft)
            }
            ForEach(model.logs) { log in
                NavigationLink { LogDetailView(model: model, log: log) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(log.title, systemImage: icon(log.kind)).foregroundStyle(palette.ink).lineLimit(1)
                        Text(detail(log)).font(.caption).foregroundStyle(palette.inkSoft)
                    }
                }
                .accessibilityIdentifier("logs.row")
            }
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    /// "12 events since the app started".
    private var phoneDetail: String {
        let n = store.connectionLog.entries.count
        return n == 0 ? String(localized: "Nothing yet since the app started")
                      : String(localized: "\(n) events since the app started")
    }

    private func icon(_ k: LogInfo.Kind) -> String {
        switch k { case .app: "macwindow"; case .daemon: "gearshape.2"; case .agent: "text.bubble" }
    }

    private func detail(_ l: LogInfo) -> String {
        let size = ByteCountFormatter.string(fromByteCount: l.size, countStyle: .file)
        guard let at = l.updatedAt else { return "Empty" }
        return "\(size) · \(at.formatted(.relative(presentation: .named)))"
    }
}

/// A log's tail (newest at the bottom) with refresh, or its lines matching a search.
struct LogDetailView: View {
    let model: LogsModel
    let log: LogInfo
    @Environment(\.palette) private var palette
    @State private var tail: LogText?
    @State private var found: LogText?
    @State private var error: String?
    @State private var query = ""
    @State private var loading = false

    var body: some View {
        Group {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                matches
            } else if let tail {
                tailView(tail)
            } else if let error {
                ContentUnavailableView("Couldn’t read the log", systemImage: "exclamationmark.triangle", description: Text(error))
                    .accessibilityIdentifier("log.error")
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.paper)
        .navigationTitle(log.title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Find in this log")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(loading)
                    .accessibilityIdentifier("log.refresh")
            }
            ToolbarItem(placement: .primaryAction) {
                if let shown {
                    ShareLink(item: LogShare.text(title: log.title, log: shown)) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("log.share")
                    .accessibilityHint("What this screen shows, as text, with secrets removed.")
                }
            }
        }
        .task { if tail == nil { await load() } }
        .task(id: query) { await search() }
    }

    /// What *Share* sends: the search results while searching, else the tail.
    private var shown: LogText? {
        query.trimmingCharacters(in: .whitespaces).isEmpty ? tail : found
    }

    private func tailView(_ t: LogText) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if t.truncated {
                        Text("Older lines are on the computer.").font(.footnote).foregroundStyle(palette.inkSoft).padding(12)
                    }
                    let lines = (t.text ?? "").components(separatedBy: "\n")
                    CodeLines(lines: lines.last == "" ? Array(lines.dropLast()) : lines)
                    Color.clear.frame(height: 1).id("end")
                }
            }
            .accessibilityIdentifier("log.view")
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: t) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }

    @ViewBuilder private var matches: some View {
        List {
            if let found {
                if found.matches.isEmpty && !loading { Text("No lines match.").foregroundStyle(palette.inkSoft) }
                ForEach(found.matches) { m in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(m.line)").font(.caption2.monospacedDigit()).foregroundStyle(palette.inkFaint).frame(minWidth: 40, alignment: .trailing)
                        Text(m.text).font(.footnote.monospaced()).foregroundStyle(palette.ink).textSelection(.enabled)
                    }
                    .accessibilityIdentifier("log.match")
                }
                if found.moreMatches { Text("More lines match. Narrow the search.").font(.footnote).foregroundStyle(palette.inkSoft) }
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            tail = try await model.tail(log.id)
            error = nil
        } catch {
            self.error = FilesModel.message(error)
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { found = nil; return }
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
        loading = true
        defer { loading = false }
        do {
            found = try await model.search(log.id, q)
            error = nil
        } catch {
            found = nil
            self.error = FilesModel.message(error)
        }
    }
}
