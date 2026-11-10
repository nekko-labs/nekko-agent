import NekkoKit
import SwiftUI

/// The desktop composer's own line icons (ComposerIcons in the asset catalog), tinted from the theme (#2448).
struct ComposerGlyph: View {
    let name: String
    var size: CGFloat = 20

    var body: some View {
        Image("composer-\(name)").renderingMode(.template).resizable().scaledToFit()
            .frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// Chat or Image as two icons at the composer's top right (#2448). The one on shows in the
/// theme's accent on a raised pill that slides between them; the other rests in soft ink.
struct ChatKindToggle: View {
    @Binding var image: Bool
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            segment(false, glyph: "chat", label: "Chat", id: "newChat.kind.chat")
            segment(true, glyph: "photo", label: "Image", id: "newChat.kind.image")
        }
        .padding(2)
        .background(palette.surface2, in: Capsule())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: image)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Chat kind")
        .accessibilityIdentifier("newChat.kind")
    }

    private func segment(_ value: Bool, glyph: String, label: LocalizedStringKey, id: String) -> some View {
        let on = image == value
        return Button { image = value } label: {
            ComposerGlyph(name: glyph, size: 16)
                .foregroundStyle(on ? palette.accent : palette.inkSoft)
                .frame(width: 44, height: 30)
                .background {
                    if on { Capsule().fill(palette.surface).matchedGeometryEffect(id: "pill", in: pill) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// The chat's folder after +, where the desktop composer has its folder picker. A phone can't
/// change a chat's folder, so the menu opens its files instead.
struct ComposerFolderMenu: View {
    let chat: ChatModel
    var openFiles: () -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        if let id = chat.session?.workspaceId {
            let name = store.workspaces.first { $0.id == id }?.name ?? String(localized: "Saved folder")
            Menu {
                Section(name) {
                    Button(action: openFiles) { Label("Files", systemImage: "folder") }
                        .disabled(chat.savedAt != nil)
                }
            } label: {
                HStack(spacing: 6) {
                    ComposerGlyph(name: "folder", size: 16).foregroundStyle(palette.inkSoft)
                    Text(name).font(.footnote.weight(.medium)).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                }
                .padding(.horizontal, 4).frame(minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("Folder")
            .accessibilityValue(name)
            .accessibilityIdentifier("composer.folder")
        }
    }
}
