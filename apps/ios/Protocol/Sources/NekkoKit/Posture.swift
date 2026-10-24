import CoreGraphics
import Foundation

/// How the phone is held, which decides the folding-phone layout
/// (spec/phone/folding-phones-two-chats-and-monitors.md, *Postures*). Read
/// from the system, never from a device list. The Android app has the same
/// model (`Posture.kt`); both are held to `Fixtures/posture.json`.
public enum Posture: String, Equatable, Sendable, CaseIterable {
    /// One column: any phone, a Fold's cover screen, anything under 600 pt wide.
    case closed
    /// Two panes side by side (landscape or near-square).
    case openWide
    /// Two panes stacked ("vertical mode").
    case openTall
    /// Half opened with a horizontal hinge: transcript above, composer below.
    case tabletop
    /// Half opened with a vertical hinge: as open, wide, the divider on the hinge.
    case book
}

/// A size class as SwiftUI reports it, without importing SwiftUI here.
public enum PostureSizeClass: String, Equatable, Sendable {
    case compact
    case regular
}

/// The hinge (fold) the system reports, in the window's points.
public struct PostureHinge: Equatable, Sendable {
    public enum State: String, Equatable, Sendable {
        case flat
        case halfOpened
    }

    public enum Orientation: String, Equatable, Sendable {
        case horizontal
        case vertical
    }

    public var rect: CGRect
    public var state: State
    /// Two screens with a gap between them (Surface Duo): the divider is the gap.
    public var isSeparating: Bool

    public init(rect: CGRect, state: State, isSeparating: Bool = false) {
        self.rect = rect
        self.state = state
        self.isSeparating = isSeparating
    }

    /// A hinge as tall as it is wide or taller runs top to bottom (a zero-width fold is vertical).
    public var orientation: Orientation { rect.height >= rect.width ? .vertical : .horizontal }
}

/// Everything the posture is worked out from.
public struct PostureInput: Equatable, Sendable {
    public var horizontal: PostureSizeClass
    public var vertical: PostureSizeClass
    public var size: CGSize
    public var hinge: PostureHinge?

    public init(horizontal: PostureSizeClass, vertical: PostureSizeClass, size: CGSize, hinge: PostureHinge? = nil) {
        self.horizontal = horizontal
        self.vertical = vertical
        self.size = size
        self.hinge = hinge
    }
}

extension Posture {
    /// Below this width the app is always one column (a Flip's open inner screen).
    public static let minOpenWidth: CGFloat = 600
    /// Taller than this (height / width) is open, tall; anything squarer is open, wide.
    public static let tallAspect: CGFloat = 1.3

    /// Where the hinge comes from: nothing today. When Apple ships a fold API the
    /// app sets this to read it; tests and the faked-hinge launch argument set it too.
    nonisolated(unsafe) public static var hingeSource: @Sendable () -> PostureHinge? = { nil }

    /// The posture for these inputs (pure; the same rules as `Posture.kt`).
    public static func from(_ input: PostureInput) -> Posture {
        let size = input.size
        if size.width < minOpenWidth || input.horizontal == .compact || input.vertical == .compact { return .closed }
        if let hinge = input.hinge, hinge.state == .halfOpened {
            return hinge.orientation == .horizontal ? .tabletop : .book
        }
        return size.height / size.width > tallAspect ? .openTall : .openWide
    }

    /// `from(_:)` with the hinge read from `hingeSource`.
    public static func current(horizontal: PostureSizeClass, vertical: PostureSizeClass, size: CGSize) -> Posture {
        from(PostureInput(horizontal: horizontal, vertical: vertical, size: size, hinge: hingeSource()))
    }
}
