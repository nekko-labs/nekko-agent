import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit

// MARK: Pull requests

/// The selected git provider's pull requests (decision 0052): Mine (authored,
/// to review, assigned) and Projects (the repositories in the paired computers'
/// folders, plus pinned ones). Each has one-tap prompts that open New chat with
/// the words filled in, on the computer that holds the repository.
struct PullRequestsView: View {
    @Binding var path: [Route]
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(ConnectorsModel.self) private var connectors
    @Environment(\.palette) private var palette
    @Environment(\.openURL) private var openURL
    @State private var model: PullRequestsModel?
    @AppStorage("pullRequests.scope") private var scope = PullRequestsModel.Scope.mine.rawValue
    @State private var filter: PhonePullRequest.Role?
    @State private var query = ""
    @State private var opened: PhonePullRequest?
    @State private var pinning = false
    @State private var notice: String?

    private var currentScope: PullRequestsModel.Scope { PullRequestsModel.Scope(rawValue: scope) ?? .mine }

    var body: some View {
        List {
            if connectors.gitProvider == nil { noProvider } else if let model { content(model) }
        }
        .listStyle(.insetGrouped)
        .appBackground()
        .navigationTitle("Pull requests")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: Text("Filter by title, repository or author"))
        .overlay {
            if let model, model.provider != nil, model.loading, !model.loaded.contains(currentScope) { ProgressView() }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if connectors.git.count > 1 {
                        Picker("Pull requests from", selection: Binding(get: { connectors.gitProvider?.kind ?? "" }, set: { connectors.selectGit($0) })) {
                            ForEach(connectors.git) { c in Text(c.label).tag(c.kind) }
                        }
                    }
                    if currentScope == .projects { Button { pinning = true } label: { Label("Add a repository", systemImage: "pin") } }
                    Button { path.append(.connectors) } label: { Label("Connectors", systemImage: "point.3.connected.trianglepath.dotted") }
                } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Pull request options")
                    .accessibilityIdentifier("pullRequests.menu")
            }
        }
        .pawRefreshable { await load(force: true) }
        .task {
            if model == nil { model = PullRequestsModel(connectors: connectors, files: app.offlineFiles) }
            await load()
        }
        .onChange(of: scope) { _, _ in Task { await load() } }
        .onChange(of: connectors.gitProvider?.kind) { _, _ in Task { await load(force: true) } }
        .sheet(item: $opened) { pr in PullRequestSheet(pr: pr, start: start) }
        .sheet(isPresented: $pinning) { if let model { PinRepoSheet(model: model, refresh: { Task { await load(force: true) } }) } }
        .alert("Pull requests", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(notice ?? "") }
        .accessibilityIdentifier("pullRequests.view")
    }

    private func load(force: Bool = false) async {
        guard let model else { return }
        if !force && model.loaded.contains(currentScope) { return }
        await model.load(currentScope, folders: store.folders(on: nil))
    }

    private var noProvider: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Label("Connect a git provider", systemImage: "arrow.triangle.branch").font(.headline).foregroundStyle(palette.ink)
                Text("Connect GitHub, GitLab or Bitbucket on this iPhone to see your pull requests and start a chat about one.")
                    .font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                Button { path.append(.connectors) } label: { Text("Open Connectors") }
                    .buttonStyle(.borderedProminent).tint(palette.accent)
                    .accessibilityIdentifier("pullRequests.connect")
            }
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder private func content(_ model: PullRequestsModel) -> some View {
        Section {
            Picker("Show", selection: $scope) {
                Text("Mine").tag(PullRequestsModel.Scope.mine.rawValue)
                Text("Projects").tag(PullRequestsModel.Scope.projects.rawValue)
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            .accessibilityIdentifier("pullRequests.scope")
            if currentScope == .mine { roleChips(model) }
        } footer: {
            if let p = model.provider {
                Text(p.account.map { String(localized: "From \(p.label) as \($0)") } ?? String(localized: "From \(p.label)"))
                    .foregroundStyle(palette.inkFaint)
            }
        }
        if let e = model.error {
            Section { Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger) }
        }
        let list = shown(model)
        if currentScope == .projects {
            if model.loaded.contains(.projects) && model.projectRepos.isEmpty {
                Section {
                    Text("No repositories yet. Projects lists the repositories your computers’ folders hold, and any you add.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                    Button { pinning = true } label: { Label("Add a repository", systemImage: "pin") }
                }
            }
            ForEach(model.projectRepos) { repo in
                let rows = list.filter { $0.repo.lowercased() == repo.fullName.lowercased() }
                Section {
                    if rows.isEmpty {
                        Text("No open pull requests.").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                    ForEach(rows) { pr in row(pr, showRepo: false) }
                } header: {
                    HStack {
                        SectionHeader(LocalizedStringKey(repo.fullName))
                        Spacer()
                        if model.pinned.contains(repo) {
                            Button { model.unpin(repo) } label: { Image(systemName: "pin.slash") }
                                .accessibilityLabel("Remove \(repo.fullName)")
                        }
                    }
                }
            }
        } else if model.loaded.contains(.mine) && list.isEmpty && model.error == nil {
            Section {
                Text(query.isEmpty ? String(localized: "Nothing open that involves you.") : String(localized: "No pull request matches."))
                    .font(.subheadline).foregroundStyle(palette.inkSoft)
            }
        } else {
            Section { ForEach(list) { pr in row(pr, showRepo: true) } }
        }
    }

    private func roleChips(_ model: PullRequestsModel) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(nil, String(localized: "All"), count: model.mine.count)
                ForEach([PhonePullRequest.Role.reviewRequested, .authored, .assigned], id: \.self) { r in
                    chip(r, roleName(r), count: model.mine.filter { $0.roles.contains(r) }.count)
                }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }

    private func chip(_ role: PhonePullRequest.Role?, _ title: String, count: Int) -> some View {
        let on = filter == role
        return Button { filter = role } label: {
            Text("\(title) \(count)")
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(on ? palette.accent : palette.surface, in: Capsule())
                .foregroundStyle(on ? palette.onAccent : palette.ink)
                .overlay(Capsule().stroke(on ? Color.clear : palette.line))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func shown(_ model: PullRequestsModel) -> [PhonePullRequest] {
        var list = currentScope == .mine ? model.mine : model.projects
        if currentScope == .mine, let filter { list = list.filter { $0.roles.contains(filter) } }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            list = list.filter { [$0.title, $0.repo, $0.author ?? "", "#\($0.number)"].contains { $0.lowercased().contains(q) } }
        }
        return list
    }

    private func row(_ pr: PhonePullRequest, showRepo: Bool) -> some View {
        Button { opened = pr } label: { PullRequestRow(pr: pr, showRepo: showRepo) }
            .buttonStyle(.plain)
            .contextMenu {
                ForEach(PullRequestPrompt.allCases.filter { $0.fits(pr) }) { p in
                    Button { start(p, pr) } label: { Label(p.label, systemImage: p.systemImage) }
                }
                Divider()
                Button { if let u = URL(string: pr.url) { openURL(u) } } label: { Label("Open in browser", systemImage: "safari") }
                Button { UIPasteboard.general.string = pr.url } label: { Label("Copy link", systemImage: "link") }
            }
            .swipeActions(edge: .leading) {
                Button { start(.review, pr) } label: { Label(PullRequestPrompt.review.label, systemImage: "eye") }.tint(palette.accent)
            }
            .swipeActions(edge: .trailing) {
                if pr.checks == .failing {
                    Button { start(.fixChecks, pr) } label: { Label(PullRequestPrompt.fixChecks.label, systemImage: "wrench.and.screwdriver") }.tint(palette.danger)
                }
            }
            .accessibilityIdentifier("pullRequests.row")
    }

    /// Open New chat with the prompt, on the computer that holds the repository.
    private func start(_ prompt: PullRequestPrompt, _ pr: PhonePullRequest) {
        opened = nil
        guard store.stageChat(prompt.text(for: pr), repo: pr.repo) != nil else {
            notice = String(localized: "Pair a computer first: chats about a pull request run on a computer, where the code is.")
            return
        }
        path.append(.newChat)
    }

    private func roleName(_ r: PhonePullRequest.Role) -> String {
        switch r {
        case .reviewRequested: return String(localized: "To review")
        case .authored: return String(localized: "Opened by me")
        case .assigned: return String(localized: "Assigned")
        case .project: return String(localized: "Project")
        }
    }
}

/// One pull request: repository and number, title, and what state it is in.
struct PullRequestRow: View {
    let pr: PhonePullRequest
    var showRepo = true
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(showRepo ? "\(pr.repo) #\(pr.number)" : "#\(pr.number)")
                    .font(.caption.monospacedDigit()).foregroundStyle(palette.inkSoft).lineLimit(1)
                Spacer(minLength: 4)
                if let at = pr.updatedAt {
                    Text(Date(timeIntervalSince1970: Double(at) / 1000), format: .relative(presentation: .named))
                        .font(.caption2).foregroundStyle(palette.inkFaint)
                }
            }
            Text(pr.title).font(.subheadline.weight(.medium)).foregroundStyle(palette.ink).lineLimit(2)
            HStack(spacing: 8) {
                if pr.isDraft { badge(String(localized: "Draft"), palette.inkSoft) }
                checks
                review
                if pr.roles.contains(.reviewRequested) { badge(String(localized: "To review"), palette.running) }
                Spacer(minLength: 0)
                if let a = pr.author { Text(a).font(.caption2).foregroundStyle(palette.inkFaint).lineLimit(1) }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var checks: some View {
        switch pr.checks {
        case .passing: icon("checkmark.circle.fill", palette.success, String(localized: "Checks passing"))
        case .failing: icon("xmark.circle.fill", palette.danger, String(localized: "Checks failing"))
        case .pending: icon("clock.fill", palette.warning, String(localized: "Checks running"))
        case .none: EmptyView()
        }
    }

    @ViewBuilder private var review: some View {
        switch pr.review {
        case .approved?: badge(String(localized: "Approved"), palette.success)
        case .changesRequested?: badge(String(localized: "Changes requested"), palette.danger)
        default: EmptyView()
        }
    }

    private func icon(_ name: String, _ color: Color, _ label: String) -> some View {
        Image(systemName: name).font(.caption).foregroundStyle(color).accessibilityLabel(label)
    }

    private func badge(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
    }
}

/// A pull request's sheet: what it is, and the prompts to start a chat about it.
struct PullRequestSheet: View {
    let pr: PhonePullRequest
    var start: (PullRequestPrompt, PhonePullRequest) -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section { PullRequestRow(pr: pr) }
                if let head = pr.head, let base = pr.base {
                    Section {
                        LabeledContent("Branch", value: head)
                        LabeledContent("Into", value: base)
                    }
                }
                Section {
                    ForEach(PullRequestPrompt.allCases.filter { $0.fits(pr) }) { p in
                        Button { start(p, pr) } label: { Label(p.label, systemImage: p.systemImage).foregroundStyle(palette.ink) }
                            .accessibilityIdentifier("pullRequest.prompt.\(p.rawValue)")
                    }
                } header: { SectionHeader("Start a chat") } footer: {
                    Text(placeLine).foregroundStyle(palette.inkSoft)
                }
                Section {
                    Button { if let u = URL(string: pr.url) { openURL(u) } } label: { Label("Open in browser", systemImage: "safari") }
                    ShareLink(item: pr.url) { Label("Share link", systemImage: "square.and.arrow.up") }
                }
            }
            .appBackground()
            .navigationTitle("#\(pr.number)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    /// Where the chat will run, said before it starts.
    private var placeLine: String {
        let places = store.computers.map { c in (id: c.id, folders: store.folders(on: c.id)) }
        guard let m = PullRequestPlace.find(repo: pr.repo, computers: places, active: store.activeId),
              let name = store.computers.first(where: { $0.id == m.computer })?.name else {
            return String(localized: "Pair a computer to run chats about pull requests.")
        }
        if let f = m.folder, let folder = store.folders(on: m.computer).first(where: { $0.id == f })?.name {
            return String(localized: "Opens New chat on \(name), in \(folder). Nothing is sent until you tap Start.")
        }
        return String(localized: "Opens New chat on \(name); no folder there is named \(pr.repoName), so pick one. Nothing is sent until you tap Start.")
    }
}

/// Add a repository to Projects, from the ones the provider lists for you.
struct PinRepoSheet: View {
    let model: PullRequestsModel
    var refresh: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if model.repos.isEmpty {
                    Text("No repositories listed yet. Pull to refresh Projects, then try again.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                }
                ForEach(model.repos.filter { query.isEmpty || $0.fullName.lowercased().contains(query.lowercased()) }) { r in
                    Button {
                        if model.pinned.contains(r) { model.unpin(r) } else { model.pin(r) }
                    } label: {
                        HStack {
                            Text(r.fullName).foregroundStyle(palette.ink)
                            Spacer()
                            if model.pinned.contains(r) || model.projectRepos.contains(r) {
                                Image(systemName: "checkmark").foregroundStyle(palette.accent).accessibilityLabel("In Projects")
                            }
                        }
                    }
                    .disabled(model.projectRepos.contains(r) && !model.pinned.contains(r))
                }
            }
            .searchable(text: $query)
            .appBackground()
            .navigationTitle("Add a repository")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        refresh()
                        dismiss()
                    }
                }
            }
        }
    }
}
