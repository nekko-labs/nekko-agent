import NekkoKit
import NekkoProtocol
import SwiftUI

/// New chat's connect checklist and note (#2921; nekko-designs/iphone-new-chat-design.html §2).
/// The rows say what Nekko gains from each; a done row ticks and names what got connected.
struct ConnectChecklistRows: View {
    let rows: [ConnectChecklist.Row]
    var open: (ConnectChecklist.Item) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                // A waiting folder opens pairing, the step it waits on.
                Button { open(row.waiting ? .computer : row.item) } label: { label(row) }
                    .buttonStyle(.plain)
                    .disabled(row.isDone)
                    .accessibilityIdentifier("connectChecklist.\(row.item.rawValue)")
            }
        }
        .animation(.easeOut(duration: 0.2), value: rows)
    }

    private func label(_ row: ConnectChecklist.Row) -> some View {
        HStack(spacing: 12) {
            Image(systemName: row.isDone ? "checkmark.circle.fill" : "circle")
                .font(.body)
                .foregroundStyle(row.isDone ? palette.success : palette.inkFaint)
                .contentTransition(.symbolEffect(.replace))
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.title(row.item)).font(.subheadline.weight(.medium)).foregroundStyle(palette.ink)
                Text(row.done ?? Self.detail(row)).font(.caption).foregroundStyle(palette.inkSoft).lineLimit(1)
            }
            Spacer(minLength: 8)
            if !row.isDone {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.inkFaint)
            }
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.title(row.item))
        .accessibilityValue(row.done.map { String(localized: "Done, \($0)") } ?? Self.detail(row))
    }

    static func title(_ item: ConnectChecklist.Item) -> String {
        switch item {
        case .computer: String(localized: "Pair a computer")
        case .folder: String(localized: "Add a folder")
        case .git: String(localized: "Connect a git provider")
        case .tasks: String(localized: "Connect a task tool")
        }
    }

    static func detail(_ row: ConnectChecklist.Row) -> String {
        switch row.item {
        case .computer: String(localized: "Let Nekko use tools and your files")
        case .folder: row.waiting ? String(localized: "After you pair a computer") : String(localized: "A project for Nekko to work in")
        case .git: String(localized: "GitHub, GitLab or Bitbucket")
        case .tasks: String(localized: "Linear, Jira, Floop and more")
        }
    }
}

/// Over someone's first message: Nekko leads the four rows, with a count and a close.
struct ConnectChecklistGroup: View {
    let rows: [ConnectChecklist.Row]
    var open: (ConnectChecklist.Item) -> Void
    var close: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                PixelCat().frame(width: 24, height: 24).accessibilityHidden(true)
                Text("Nekko can do more with these").font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Text("\(rows.filter(\.isDone).count) of \(rows.count)").font(.caption.monospacedDigit()).foregroundStyle(palette.inkFaint)
                    .contentTransition(.numericText())
                CloseGlyphButton(label: String(localized: "Close checklist"), action: close)
                    .accessibilityIdentifier("connectChecklist.close")
            }
            ConnectChecklistRows(rows: rows, open: open)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connectChecklist")
    }
}

/// After the first message, while nothing is connected: one closeable line.
struct ConnectNote: View {
    var connect: () -> Void
    var close: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle").font(.footnote).foregroundStyle(palette.inkSoft).accessibilityHidden(true)
            Text("Nekko can’t use your files or tools yet.").font(.footnote).foregroundStyle(palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Button("Connect", action: connect).font(.footnote.weight(.semibold)).foregroundStyle(palette.accent)
                .accessibilityIdentifier("connectNote.connect")
            Spacer(minLength: 0)
            CloseGlyphButton(label: String(localized: "Close"), action: close)
                .accessibilityIdentifier("connectNote.close")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connectNote")
    }
}

/// Undo for a closed checklist or note, for a few seconds where it was.
struct ConnectUndoLine: View {
    var undo: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Text("Checklist hidden.").font(.footnote).foregroundStyle(palette.inkSoft)
            Button("Undo", action: undo).font(.footnote.weight(.semibold)).foregroundStyle(palette.accent)
                .accessibilityIdentifier("connectChecklist.undo")
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
    }
}

/// The note's Connect: the same rows as a sheet.
struct ConnectChecklistSheet: View {
    let rows: [ConnectChecklist.Row]
    var open: (ConnectChecklist.Item) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Nekko can do more with these").font(.subheadline).foregroundStyle(palette.inkSoft)
                    ConnectChecklistRows(rows: rows) { item in
                        open(item)
                        dismiss()
                    }
                }
                .padding(20)
            }
            .appBackground()
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

/// A quiet × with a full touch target.
struct CloseGlyphButton: View {
    let label: String
    var action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(palette.inkSoft)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// "Model ⟶ device" (#2922): a faint dot and arrow between the two halves; VoiceOver reads the halves.
struct PlaceConnector: View {
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 1) {
            Circle().frame(width: 3, height: 3)
            Image(systemName: "arrow.right").font(.system(size: 9, weight: .semibold))
        }
        .foregroundStyle(palette.inkFaint)
        .padding(.horizontal, 2)
        .accessibilityHidden(true)
    }
}
