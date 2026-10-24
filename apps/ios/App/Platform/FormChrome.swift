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

/// Put the keyboard away, wherever the focus is.
@MainActor
func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}
