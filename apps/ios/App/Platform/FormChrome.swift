import SwiftUI
import UIKit

extension View {
    /// A Done key above the keyboard, so a form is never stuck behind it. Not for a
    /// screen with a bar pinned above the keyboard: on iOS 26 the key floats over it.
    func keyboardDoneButton() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done", action: hideKeyboard)
                    .accessibilityIdentifier("keyboard.done")
            }
        }
    }
}

/// A separate trailing control above the software keyboard, outside composer actions.
private struct FloatingKeyboardDismiss: ViewModifier {
    @Environment(\.palette) private var palette
    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if visible {
                    HStack {
                        Spacer()
                        Button(action: hideKeyboard) {
                            Image(systemName: "keyboard.chevron.compact.down")
                                .font(.system(size: 20))
                                .foregroundStyle(palette.ink)
                                .frame(width: 44, height: 44)
                                .background(.regularMaterial, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Hide keyboard")
                        .accessibilityIdentifier("composer.hideKeyboard")
                    }
                    .padding(.trailing, 12).padding(.vertical, 4)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
                guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
                // A hardware keyboard's small assistant bar isn't an open software keyboard.
                visible = frame.height > 100 && frame.minY < UIScreen.main.bounds.maxY
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in visible = false }
    }
}

extension View {
    func floatingKeyboardDismiss() -> some View { modifier(FloatingKeyboardDismiss()) }
}

/// A Form section header in the app's ink, in sentence case: the system's
/// small grey capitals fall short of WCAG AA contrast.
struct SectionHeader: View {
    let title: LocalizedStringKey
    @Environment(\.palette) private var palette

    init(_ title: LocalizedStringKey) { self.title = title }

    var body: some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).textCase(nil)
    }
}

/// A row's leading symbol at rest, in `inkSoft` rather than the accent a List gives a
/// Label's icon (docs/design-system.md, Icons: the accent only when a control is on).
/// For navigation and information rows; menus and swipe actions keep the system's look.
struct QuietLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View { QuietLabel(configuration: configuration) }

    private struct QuietLabel: View {
        let configuration: LabelStyleConfiguration
        @Environment(\.palette) private var palette

        var body: some View {
            Label { configuration.title } icon: { configuration.icon.foregroundStyle(palette.inkSoft) }
                .labelStyle(.titleAndIcon)
        }
    }
}

extension LabelStyle where Self == QuietLabelStyle {
    static var quietRow: QuietLabelStyle { QuietLabelStyle() }
}

/// Put the keyboard away, wherever the focus is.
@MainActor
func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}
