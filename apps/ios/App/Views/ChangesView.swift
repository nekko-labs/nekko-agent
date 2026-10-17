import NekkoKit
import NekkoProtocol
import SwiftUI

/// What the agent changed in a chat, read only. The computer works out the
/// diff and caps it (`phoneChangesView`); a phone can't accept, revert or
/// open anything else, and secret files arrive as a count only.
struct ChangesView: View {
    let chat: ChatModel
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var changes: PhoneChanges?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let changes {
                    if changes.files.isEmpty {
                        ContentUnavailableView("No changes", systemImage: "doc.text.magnifyingglass",
                                               description: Text("The agent hasn’t changed any files in this chat."))
                    } else {
                        list(changes)
                    }
                } else if let error {
                    ContentUnavailableView("Couldn’t load changes", systemImage: "exclamationmark.triangle",
                                           description: Text(error))
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.paper)
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                }
            }
            .task { await load() }
        }
    }

    private func list(_ changes: PhoneChanges) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                Text(summary(changes))
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                ForEach(changes.files) { FileChangeView(file: $0) }
                if changes.omittedFiles > 0 {
                    Text("\(changes.omittedFiles) more \(changes.omittedFiles == 1 ? "file" : "files") changed. See them on your computer.")
                        .font(.footnote).foregroundStyle(palette.inkFaint)
                }
                Text("Read only. Accept or revert changes on your computer.")
                    .font(.caption).foregroundStyle(palette.inkFaint)
            }
            .padding(16)
        }
    }

    private func summary(_ c: PhoneChanges) -> String {
        let n = c.files.count + c.omittedFiles
        return "\(n) \(n == 1 ? "file" : "files") · +\(c.linesAdded) −\(c.linesRemoved)"
    }

    private func load() async {
        do {
            changes = try await chat.changes()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct FileChangeView: View {
    let file: PhoneChanges.File
    @Environment(\.palette) private var palette
    @State private var open = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open.toggle() } label: {
                HStack(spacing: 8) {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(palette.inkFaint)
                        .accessibilityHidden(true)
                    Text(file.path).font(.subheadline.monospaced()).foregroundStyle(palette.ink)
                        .lineLimit(1).truncationMode(.head)
                    if file.added {
                        Text("new").font(.caption2.weight(.semibold)).foregroundStyle(palette.success)
                    }
                    Spacer(minLength: 4)
                    Text("+\(file.linesAdded)").font(.caption.monospacedDigit()).foregroundStyle(palette.success)
                    Text("−\(file.linesRemoved)").font(.caption.monospacedDigit()).foregroundStyle(palette.danger)
                }
                .padding(12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.path), \(file.added ? "new file, " : "")\(file.linesAdded) added, \(file.linesRemoved) removed")
            .accessibilityValue(open ? "Expanded" : "Collapsed")

            if open {
                Divider().overlay(palette.line)
                content
            }
        }
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.line))
    }

    @ViewBuilder private var content: some View {
        switch file.shown {
        case .diff:
            if file.hunks.isEmpty {
                note("Empty file.")
            } else {
                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(file.hunks.enumerated()), id: \.offset) { i, hunk in
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
                .background(palette.code)
            }
        case .hidden:
            note("May hold secrets, so it isn’t shown on phones.")
        case .binary:
            note("Not a text file.")
        case .tooLarge(let lines):
            note("Too big to show here (\(lines) changed lines). See it on your computer.")
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(palette.inkSoft).padding(12)
    }
}

private struct LineView: View {
    let line: PhoneChanges.Hunk.Line
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(line.number)").font(.caption2.monospacedDigit()).foregroundStyle(palette.inkFaint)
                .frame(minWidth: 28, alignment: .trailing)
            Text(mark).font(.footnote.monospaced()).foregroundStyle(tint)
            Text(line.text.isEmpty ? " " : line.text).font(.footnote.monospaced()).foregroundStyle(palette.ink)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 12).padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(kindName) line \(line.number): \(line.text.isEmpty ? "blank" : line.text)")
    }

    private var mark: String {
        switch line.kind { case .added: "+"; case .removed: "−"; case .same: " " }
    }
    private var tint: Color {
        switch line.kind { case .added: palette.success; case .removed: palette.danger; case .same: palette.inkFaint }
    }
    private var background: Color {
        switch line.kind { case .added: palette.success.opacity(0.12); case .removed: palette.danger.opacity(0.12); case .same: .clear }
    }
    private var kindName: String {
        switch line.kind { case .added: "Added"; case .removed: "Removed"; case .same: "Unchanged" }
    }
}
