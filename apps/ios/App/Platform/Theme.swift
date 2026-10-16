import NekkoProtocol
import SwiftUI
import UIKit

/// Nekko Agent's palette (same values as Android's `Theme.kt` and the desktop),
/// with the computer's accent when it sends one.
struct Palette {
    let paper, surface, surface2, line, ink, inkSoft, inkFaint, accent, onAccent: Color
    let success, danger, warning, running, userBubble, userInk, code: Color

    static func make(dark: Bool, accent: UInt32?) -> Palette {
        let base = dark ? 0x8B7DFF : 0x5A4AE8
        let a = accent.map { Int($0) } ?? base
        // Whichever of white or near-black reads better on the accent (WCAG contrast).
        let onAccent = contrast(a, 0xFFFFFF) >= contrast(a, 0x0C0C11) ? Color.white : Color(hex: 0x0C0C11)
        if dark {
            return Palette(paper: Color(hex: 0x0C0C11), surface: Color(hex: 0x16161C), surface2: Color(hex: 0x20202A),
                           line: Color(hex: 0x26262F), ink: Color(hex: 0xECEAF3), inkSoft: Color(hex: 0xA3A1B0),
                           inkFaint: Color(hex: 0x8E8E9B), accent: Color(hex: a), onAccent: onAccent,
                           success: Color(hex: 0x4CC38A), danger: Color(hex: 0xEF6A5B), warning: Color(hex: 0xE3A446),
                           running: Color(hex: 0x60A5FA), userBubble: accent == nil ? Color(hex: 0x2A2550) : Color(hex: a).opacity(0.28),
                           userInk: Color(hex: 0xECEAF3), code: Color(hex: 0x101016))
        }
        return Palette(paper: Color(hex: 0xFBFBFD), surface: .white, surface2: Color(hex: 0xF2F2F7),
                       line: Color(hex: 0xE8E8EF), ink: Color(hex: 0x17171D), inkSoft: Color(hex: 0x52525E),
                       inkFaint: Color(hex: 0x6A6A76), accent: Color(hex: a), onAccent: onAccent,
                       success: Color(hex: 0x1E7A4A), danger: Color(hex: 0xB42318), warning: Color(hex: 0x8F5C0A),
                       running: Color(hex: 0x1D4ED8), userBubble: Color(hex: a), userInk: onAccent, code: Color(hex: 0xF2F2F7))
    }

    /// WCAG 2 contrast ratio between two sRGB colours (1...21).
    static func contrast(_ a: Int, _ b: Int) -> Double {
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    static func luminance(_ rgb: Int) -> Double {
        func ch(_ v: Int) -> Double {
            let c = Double(v) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(rgb >> 16 & 0xff) + 0.7152 * ch(rgb >> 8 & 0xff) + 0.0722 * ch(rgb & 0xff)
    }
}

extension Color {
    init(hex: Int) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.make(dark: false, accent: nil)
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Resolves the app's color scheme and palette from the phone's choice and the computer's look.
struct Themed: ViewModifier {
    let choice: Prefs.ThemeChoice
    let appearance: Appearance?
    @Environment(\.colorScheme) private var system

    func body(content: Content) -> some View {
        let scheme = resolved
        content
            .environment(\.palette, Palette.make(dark: (scheme ?? system) == .dark, accent: choice == .computer ? appearance?.accent : nil))
            .preferredColorScheme(scheme)
            .tint(Palette.make(dark: (scheme ?? system) == .dark, accent: choice == .computer ? appearance?.accent : nil).accent)
    }

    private var resolved: ColorScheme? {
        switch choice {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        case .computer:
            switch appearance?.theme {
            case .light?: return .light
            case .dark?: return .dark
            default: return nil
            }
        }
    }
}
