import Foundation
import NekkoKit
import UIKit

/// Where the folding-phone layout reads the hinge from (`Posture.hingeSource`,
/// FD-6). No iOS SDK reports a fold yet, so on a device there is none and the
/// layout follows the size classes and the window's shape alone. The UI tests
/// fake one with a launch argument, read through UserDefaults like the
/// app's other test switches: `-fakeHinge tabletop` (half opened, across the
/// middle), `book` (half opened, down the middle), `flat-vertical` or
/// `flat-horizontal` (opened flat, a hinge the divider snaps to).
enum Hinge {
    /// The faked hinge's thickness, in points: what no control may sit under.
    static let thickness: CGFloat = 24

    enum Fake: String {
        case tabletop
        case book
        case flatVertical = "flat-vertical"
        case flatHorizontal = "flat-horizontal"
    }

    static let fake: Fake? = UserDefaults.standard.string(forKey: "fakeHinge").flatMap(Fake.init(rawValue:))

    /// The window the faked hinge is placed in; the pane host keeps it current.
    nonisolated(unsafe) static var windowSize: CGSize = .zero

    /// At launch: point `Posture.hingeSource` at the faked hinge, if a test asked for one.
    /// When Apple ships a fold API, this is where it is read.
    static func install() {
        guard let fake else { return }
        Posture.hingeSource = { rect(fake, in: windowSize) }
    }

    /// The faked hinge in a window of `size`, centred.
    static func rect(_ fake: Fake, in size: CGSize) -> PostureHinge? {
        guard size.width > 0, size.height > 0 else { return nil }
        let across = CGRect(x: 0, y: (size.height - thickness) / 2, width: size.width, height: thickness)
        let down = CGRect(x: (size.width - thickness) / 2, y: 0, width: thickness, height: size.height)
        switch fake {
        case .tabletop: return PostureHinge(rect: across, state: .halfOpened)
        case .book: return PostureHinge(rect: down, state: .halfOpened)
        case .flatVertical: return PostureHinge(rect: down, state: .flat)
        case .flatHorizontal: return PostureHinge(rect: across, state: .flat)
        }
    }
}
