import NekkoKit
import NekkoProtocol
import SwiftUI

/// Git on a chat's folder (IO-33 FA-2), as a sheet from the chat's More menu.
struct GitView: View {
    let chatId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            GitScreen(chatId: chatId)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// The chat folder's branch, changed files (staged and not), the commit box,
/// and the way to history, branches, compare and a new PR. Every change asks
/// for Face ID or the passcode (once per 5 minutes) and lands in this phone's
/// activity on the computer.
struct GitScreen: View {
    let chatId: String
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: GitModel?

    var body: some View {
        Group {
            if let model {
                GitStatusList(model: model)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.paper)
        .navigationTitle("Git")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = GitModel(store: store, chatId: chatId) }
            await model?.load()
        }
    }
}

private struct GitStatusList: View {
    @Bindable var model: GitModel
    @Environment(\.palette) private var palette
    @State private var confirmAbort = false
    @State private var creatingPr = false
    @FocusState private var messageFocused: Bool

    var body: some View {
        if let error = model.error, model.status == nil {
            ContentUnavailableView {
                Label("Couldn’t read git", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") { Task { await model.load(refresh: true) } }
            }
        } else if let s = model.status, !s.repo {
            ContentUnavailableView("Not a git repository", systemImage: "folder",
                                   description: Text("This chat’s folder isn’t in a git repository."))
        } else if !model.loaded {
            ProgressView()
        } else {
            list
        }
    }

    private var list: some View {
        List {
            statusSection
            if let n = model.notice {
                Section {
                    Label(n.text, systemImage: n.ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(n.ok ? palette.success : palette.danger)
                        .accessibilityIdentifier("git.notice")
                }
            }
            filesSection(title: "Staged", diff: model.staged, staged: true)
            filesSection(title: "Changes", diff: model.unstaged, staged: false)
            if !model.hasChanges {
                Section { Text("No changes to commit.").foregroundStyle(palette.inkSoft) }
            }
            commitSection
            Section {
                NavigationLink { GitHistoryView(model: model) } label: { Label("History", systemImage: "clock.arrow.circlepath") }
                NavigationLink { GitBranchesView(model: model) } label: { Label("Branches", systemImage: "arrow.triangle.branch") }
                NavigationLink { GitCompareView(model: model) } label: { Label("Compare", systemImage: "arrow.left.arrow.right") }
                Button { creatingPr = true } label: { Label("Open a pull request", systemImage: "arrow.triangle.pull") }
                    .accessibilityIdentifier("git.openPr")
            } footer: {
                Text("Changes from this phone ask for Face ID or your passcode, and show in this phone’s activity on the computer.")
            }
        }
        .refreshable { await model.load(refresh: true) }
        .disabled(model.busy != nil)
        .overlay { if model.busy != nil { ProgressView().controlSize(.large).accessibilityLabel("Working") } }
        .sheet(isPresented: $creatingPr) { CreatePrView(model: model) }
        .confirmationDialog("Abort the merge?", isPresented: $confirmAbort, titleVisibility: .visible) {
            Button("Abort merge", role: .destructive) { Task { await model.abortMerge() } }
        } message: {
            Text("The folder goes back to how it was before the merge started.")
        }
    }

    private var statusSection: some View {
        Section {
            if let s = model.status {
                VStack(alignment: .leading, spacing: 4) {
                    Label(s.position, systemImage: "arrow.triangle.branch").font(.headline).foregroundStyle(palette.ink)
                    Text([s.drift ?? "Up to date with its upstream", s.worktree.map { "worktree \($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("git.branch")
                if let pr = s.pr {
                    NavigationLink { PrDetailView(model: model, pr: pr) } label: {
                        Label(pr.summary, systemImage: "arrow.triangle.pull")
                    }
                }
            }
            Button { Task { await model.push() } } label: { Label("Push", systemImage: "arrow.up.circle") }
                .accessibilityIdentifier("git.push")
            if model.merging {
                Button(role: .destructive) { confirmAbort = true } label: { Label("Abort merge", systemImage: "xmark.octagon") }
            }
        }
    }

    @ViewBuilder
    private func filesSection(title: String, diff: GitDiff, staged: Bool) -> some View {
        if !diff.files.isEmpty || diff.omittedFiles > 0 {
            Section {
                ForEach(diff.files) { f in
                    NavigationLink { GitFileView(file: f) } label: { GitFileRow(file: f) }
                        .swipeActions {
                            Button(staged ? "Unstage" : "Stage") {
                                toggle(f, staged: staged)
                            }
                            .tint(staged ? palette.warning : palette.success)
                        }
                        .contextMenu {
                            Button(staged ? "Unstage" : "Stage") {
                                toggle(f, staged: staged)
                            }
                        }
                        .accessibilityAction(named: staged ? "Unstage" : "Stage") {
                            toggle(f, staged: staged)
                        }
                }
                if diff.omittedFiles > 0 {
                    Text("\(diff.omittedFiles) more \(diff.omittedFiles == 1 ? "file" : "files"). See them on your computer.")
                        .font(.footnote).foregroundStyle(palette.inkFaint)
                }
            } header: {
                HStack {
                    Text("\(title) (\(diff.files.count + diff.omittedFiles))")
                    Spacer()
                    Button(staged ? "Unstage all" : "Stage all") {
                        Task { if staged { await model.unstageAll() } else { await model.stageAll() } }
                    }
                    .font(.caption.weight(.semibold))
                    .accessibilityIdentifier(staged ? "git.unstageAll" : "git.stageAll")
                }
            } footer: {
                if diff.hiddenFiles > 0 {
                    Text("Files that may hold secrets are listed but never shown on a phone.")
                }
            }
        }
    }

    private func toggle(_ f: GitFile, staged: Bool) {
        Task { if staged { await model.unstage([f.path]) } else { await model.stage([f.path]) } }
    }

    private var commitSection: some View {
        Section {
            TextField("Commit message", text: $model.message, axis: .vertical)
                .lineLimit(2...8)
                .focused($messageFocused)
                .accessibilityIdentifier("git.message")
            HStack {
                Button { Task { await model.writeMessage() } } label: { Label("Write message", systemImage: "sparkles") }
                    .disabled(model.staged.files.isEmpty)
                    .accessibilityIdentifier("git.writeMessage")
                Spacer()
                Button {
                    messageFocused = false
                    Task { await model.commit() }
                } label: { Label("Commit", systemImage: "checkmark.circle.fill") }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canCommit)
                    .accessibilityIdentifier("git.commit")
            }
            .buttonStyle(.borderless)
        } header: {
            Text("Commit")
        } footer: {
            if model.messageFromCutDiff {
                Text("The change was too big to show the model in full; check the message.")
            } else if model.staged.files.isEmpty {
                Text("Stage the files to commit first. Write message asks your computer’s model, which uses its tokens.")
            }
        }
    }
}

/// One changed file in a list: its status letter, path and line counts.
struct GitFileRow: View {
    let file: GitFile
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Text(file.mark).font(.caption.monospaced().weight(.bold)).foregroundStyle(color).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.path).font(.subheadline.monospaced()).foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let old = file.oldPath {
                    Text("from \(old)").font(.caption.monospaced()).foregroundStyle(palette.inkFaint)
                }
            }
            Spacer(minLength: 4)
            if file.hidden {
                Image(systemName: "eye.slash").foregroundStyle(palette.inkFaint).accessibilityLabel("Not shown on phones")
            } else if !file.binary {
                Text("+\(file.additions)").font(.caption.monospacedDigit()).foregroundStyle(palette.success)
                Text("−\(file.deletions)").font(.caption.monospacedDigit()).foregroundStyle(palette.danger)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch file.status {
        case .added: palette.success
        case .removed: palette.danger
        case .conflicted: palette.warning
        default: palette.accent
        }
    }
}

/// One file's diff, drawn like the Changes view.
struct GitFileView: View {
    let file: GitFile
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                GitFileRow(file: file)
                if file.hidden {
                    note("May hold secrets, so it isn’t shown on phones.")
                } else if file.binary {
                    note("Not a text file.")
                } else if file.hunks.isEmpty {
                    note(file.truncated ? "Too big to show here. See it on your computer." : "No line changes to show.")
                } else {
                    GitHunksView(hunks: file.hunks)
                    if file.truncated { note("Cut short for a phone. See the rest on your computer.") }
                }
            }
            .padding(16)
        }
        .background(palette.paper)
        .navigationTitle((file.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(palette.inkSoft)
    }
}

struct GitHunksView: View {
    let hunks: [PhoneChanges.Hunk]
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunks.enumerated()), id: \.offset) { i, hunk in
                    if i > 0 {
                        Text("⋯").font(.caption.monospaced()).foregroundStyle(palette.inkFaint)
                            .padding(.horizontal, 12).padding(.vertical, 2)
                            .accessibilityLabel("Unchanged lines skipped")
                    }
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in LineView(line: line) }
                }
            }
            .padding(.vertical, 6)
        }
        .background(palette.code, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.line))
    }
}

/// Newest commits first, fifty at a time.
struct GitHistoryView: View {
    let model: GitModel
    @Environment(\.palette) private var palette
    @State private var commits: [GitCommit] = []
    @State private var more = true
    @State private var error: String?

    var body: some View {
        List {
            ForEach(commits) { c in
                NavigationLink { GitCommitView(model: model, commit: c) } label: { GitCommitRow(commit: c) }
            }
            if more && !commits.isEmpty {
                Button("Load more") { Task { await load(skip: commits.count) } }
            }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
            if commits.isEmpty && error == nil && !more { Text("No commits yet.").foregroundStyle(palette.inkSoft) }
        }
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .task { if commits.isEmpty { await load(skip: 0) } }
        .refreshable { commits = []; await load(skip: 0) }
    }

    private func load(skip: Int) async {
        do {
            let page = try await model.history(limit: 50, skip: skip)
            commits += page
            more = page.count == 50
            error = nil
        } catch {
            self.error = error.localizedDescription
            more = false
        }
    }
}

struct GitCommitRow: View {
    let commit: GitCommit
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(commit.subject.isEmpty ? "(no message)" : commit.subject).font(.subheadline).foregroundStyle(palette.ink).lineLimit(2)
            Text([commit.short, commit.author, commit.when.map { $0.formatted(.relative(presentation: .named)) }, commit.isMerge ? "merge" : nil]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(palette.inkSoft)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One commit: its message and its files.
struct GitCommitView: View {
    let model: GitModel
    let commit: GitCommit
    @Environment(\.palette) private var palette
    @State private var detail: GitCommitDetail?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(commit.subject).font(.headline).foregroundStyle(palette.ink)
                    if let body = detail?.commit.body, !body.isEmpty {
                        Text(body).font(.footnote).foregroundStyle(palette.inkSoft)
                    }
                    Text([commit.author, commit.when?.formatted(date: .abbreviated, time: .shortened), commit.short].compactMap { $0 }
                        .joined(separator: " · "))
                        .font(.caption).foregroundStyle(palette.inkFaint)
                        .textSelection(.enabled)
                }
            }
            if let d = detail?.diff {
                Section {
                    ForEach(d.files) { f in NavigationLink { GitFileView(file: f) } label: { GitFileRow(file: f) } }
                    if d.omittedFiles > 0 {
                        Text("\(d.omittedFiles) more files. See them on your computer.").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                } header: {
                    Text("\(d.files.count + d.omittedFiles) files · +\(d.additions) −\(d.deletions)")
                }
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(commit.short)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { detail = try await model.commit(commit.sha) } catch { self.error = error.localizedDescription }
        }
    }
}

/// Local and remote branches; tap one to switch to it, or make a new one.
struct GitBranchesView: View {
    let model: GitModel
    @Environment(\.palette) private var palette
    @State private var branches: GitBranches?
    @State private var error: String?
    @State private var switching: GitBranch?
    @State private var naming = false
    @State private var newName = ""

    var body: some View {
        List {
            if let b = branches {
                Section("On this computer") {
                    ForEach(b.local) { br in row(br) }
                }
                if !b.remoteOnly.isEmpty {
                    Section("On the remote only") {
                        ForEach(b.remoteOnly) { br in row(br) }
                    }
                }
                if b.omitted > 0 {
                    Text("\(b.omitted) more branches. See them on your computer.").font(.footnote).foregroundStyle(palette.inkFaint)
                }
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
            } else {
                ProgressView()
            }
            if let n = model.notice {
                Label(n.text, systemImage: n.ok ? "checkmark.circle" : "exclamationmark.triangle")
                    .foregroundStyle(n.ok ? palette.success : palette.danger)
            }
        }
        .navigationTitle("Branches")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newName = ""; naming = true } label: { Label("New branch", systemImage: "plus") }
                    .accessibilityIdentifier("git.newBranch")
            }
        }
        .disabled(model.busy != nil)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Switch to \(switching?.localName ?? "")?", isPresented: Binding(get: { switching != nil }, set: { if !$0 { switching = nil } }),
                            titleVisibility: .visible) {
            Button("Switch") {
                if let b = switching { Task { await model.switchTo(b.localName); await load() } }
            }
        } message: {
            Text("Git refuses if uncommitted changes would be lost.")
        }
        .alert("New branch", isPresented: $naming) {
            TextField("Name", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Create and switch") {
                let name = newName.trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { return }
                Task { await model.switchTo(name, create: true); await load() }
            }
        } message: {
            Text("Starts from the commit you’re on.")
        }
    }

    private func row(_ br: GitBranch) -> some View {
        Button { if !br.current { switching = br } } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(br.name).font(.subheadline.monospaced()).foregroundStyle(palette.ink)
                    Text([br.subject, br.gone ? "upstream gone" : nil,
                          br.ahead > 0 ? "\(br.ahead) ahead" : nil, br.behind > 0 ? "\(br.behind) behind" : nil].compactMap { $0 }
                        .joined(separator: " · "))
                        .font(.caption).foregroundStyle(palette.inkSoft).lineLimit(1)
                }
                Spacer()
                if br.current { Image(systemName: "checkmark").foregroundStyle(palette.accent).accessibilityLabel("Current") }
            }
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        do { branches = try await model.branches(); error = nil } catch { self.error = error.localizedDescription }
    }
}

/// What a branch has that another doesn't: commits and files, as a PR would show them.
struct GitCompareView: View {
    let model: GitModel
    @Environment(\.palette) private var palette
    @State private var names: [String] = []
    @State private var base = ""
    @State private var head = ""
    @State private var result: GitCompare?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Picker("Base", selection: $base) { ForEach(names, id: \.self) { Text($0).tag($0) } }
                Picker("Compare", selection: $head) { ForEach(names, id: \.self) { Text($0).tag($0) } }
                Button("Compare") { Task { await run() } }.disabled(base.isEmpty || head.isEmpty || base == head)
            }
            if let r = result {
                Section {
                    Text("\(r.ahead) \(r.ahead == 1 ? "commit" : "commits") on \(r.head) not on \(r.base) · \(r.behind) behind")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                    ForEach(r.commits) { c in NavigationLink { GitCommitView(model: model, commit: c) } label: { GitCommitRow(commit: c) } }
                } header: { Text("Commits") }
                Section {
                    ForEach(r.diff.files) { f in GitFileRow(file: f) }
                    if r.diff.omittedFiles > 0 {
                        Text("\(r.diff.omittedFiles) more files. See them on your computer.").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                } header: { Text("Files · +\(r.diff.additions) −\(r.diff.deletions)") }
            }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
        }
        .navigationTitle("Compare")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard names.isEmpty, let b = try? await model.branches() else { return }
            names = b.local.map(\.name) + b.remote.map(\.name)
            base = b.compareBase
            head = b.current ?? names.first ?? ""
        }
    }

    private func run() async {
        do { result = try await model.compare(base: base, head: head); error = nil } catch { self.error = error.localizedDescription }
    }
}

/// A pull request from the current branch, pushed first if it isn't yet.
struct CreatePrView: View {
    let model: GitModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var title = ""
    @State private var bodyText = ""
    @State private var base = ""
    @State private var draft = false
    @State private var opened: String?

    var body: some View {
        NavigationStack {
            Form {
                if let opened, let url = URL(string: opened) {
                    Section {
                        Label("Pull request opened", systemImage: "checkmark.circle").foregroundStyle(palette.success)
                        Link(destination: url) { Label("Open on GitHub", systemImage: "safari") }
                    }
                } else {
                    Section {
                        TextField("Title", text: $title).accessibilityIdentifier("pr.title")
                        TextField("Description", text: $bodyText, axis: .vertical).lineLimit(3...10)
                    }
                    Section {
                        TextField("Base branch (the repository’s default if empty)", text: $base)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Toggle("Draft", isOn: $draft)
                    } footer: {
                        Text("Opened from the branch the chat is on. Push it first if it isn’t on GitHub yet.")
                    }
                    if let n = model.notice, !n.ok {
                        Label(n.text, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
                    }
                }
            }
            .disabled(model.busy != nil)
            .navigationTitle("New pull request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(opened == nil ? "Cancel" : "Done") { dismiss() } }
                if opened == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Open") {
                            Task {
                                opened = await model.createPr(title: title, body: bodyText, base: base.isEmpty ? nil : base, draft: draft)
                            }
                        }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || model.busy != nil)
                        .accessibilityIdentifier("pr.create")
                    }
                }
            }
        }
    }
}

/// A pull request: its checks, its diff and the actions a phone may take.
struct PrDetailView: View {
    let model: GitModel
    let pr: PullRequest
    @Environment(\.palette) private var palette
    @State private var confirm: PrAction?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(pr.title).font(.headline).foregroundStyle(palette.ink)
                    Text(pr.summary).font(.subheadline).foregroundStyle(palette.inkSoft)
                }
                if let url = URL(string: pr.url) { Link(destination: url) { Label("Open on GitHub", systemImage: "safari") } }
            }
            Section {
                NavigationLink { PrChecksView(model: model, url: pr.url) } label: { Label("Checks", systemImage: "checklist") }
                NavigationLink { PrDiffView(model: model, url: pr.url) } label: { Label("Files changed", systemImage: "plusminus") }
            }
            Section {
                ForEach(actions, id: \.self) { a in
                    Button(role: a == .close ? .destructive : nil) { confirm = a } label: { Text(a.label) }
                        .accessibilityIdentifier("pr.action.\(a.rawValue)")
                }
            } footer: {
                Text("Asks for Face ID or your passcode. GitHub’s own rules (reviews, required checks) still apply.")
            }
            if let n = model.notice {
                Label(n.text, systemImage: n.ok ? "checkmark.circle" : "exclamationmark.triangle")
                    .foregroundStyle(n.ok ? palette.success : palette.danger)
            }
        }
        .disabled(model.busy != nil)
        .navigationTitle("#\(pr.number)")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("\(confirm?.label ?? "") #\(pr.number)?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                            titleVisibility: .visible) {
            Button(confirm?.label ?? "OK", role: confirm == .close ? .destructive : nil) {
                if let a = confirm { Task { await model.prAction(pr.url, a) } }
            }
        }
    }

    private var actions: [PrAction] {
        switch pr.state {
        case .open: [.approve, .merge, .close]
        case .closed: [.reopen]
        case .merged: []
        }
    }
}

struct PrChecksView: View {
    let model: GitModel
    let url: String
    @Environment(\.palette) private var palette
    @State private var list: PrCheckList?
    @State private var error: String?

    var body: some View {
        List {
            if let list {
                if list.items.isEmpty { Text("No checks on this pull request.").foregroundStyle(palette.inkSoft) }
                ForEach(list.items) { c in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: icon(c.state)).foregroundStyle(color(c.state)).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.name).font(.subheadline).foregroundStyle(palette.ink)
                            Text([c.label, c.workflow, c.description].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(palette.inkSoft).lineLimit(2)
                        }
                        Spacer()
                        if let link = c.link, let u = URL(string: link) {
                            Link(destination: u) { Image(systemName: "safari") }.accessibilityLabel("Open \(c.name)")
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                if list.omitted > 0 { Text("\(list.omitted) more checks on GitHub.").font(.footnote).foregroundStyle(palette.inkFaint) }
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Checks")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do { list = try await model.checks(url); error = nil } catch { self.error = error.localizedDescription }
    }

    private func icon(_ s: PrCheck.State) -> String {
        switch s {
        case .pass: "checkmark.circle.fill"
        case .fail: "xmark.circle.fill"
        case .pending: "clock"
        case .skipping: "minus.circle"
        case .cancel: "slash.circle"
        }
    }

    private func color(_ s: PrCheck.State) -> Color {
        switch s {
        case .pass: palette.success
        case .fail: palette.danger
        case .pending: palette.running
        default: palette.inkFaint
        }
    }
}

struct PrDiffView: View {
    let model: GitModel
    let url: String
    @Environment(\.palette) private var palette
    @State private var diff: GitDiff?
    @State private var error: String?

    var body: some View {
        List {
            if let diff {
                ForEach(diff.files) { f in NavigationLink { GitFileView(file: f) } label: { GitFileRow(file: f) } }
                if diff.omittedFiles > 0 {
                    Text("\(diff.omittedFiles) more files. See them on GitHub.").font(.footnote).foregroundStyle(palette.inkFaint)
                }
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Files changed")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { diff = try await model.prDiff(url) } catch { self.error = error.localizedDescription }
        }
    }
}
