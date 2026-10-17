import SwiftUI
import UIKit

extension View {
    /// A Done key above the keyboard, so the transcript and forms are never stuck behind it.
    func keyboardDoneButton() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }
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
