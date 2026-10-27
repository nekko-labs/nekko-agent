import NekkoProtocol
import SwiftUI
import UIKit

/// A desktop theme preset (`ThemePreset`, packages/shared/src/themes.ts); the
/// catalog itself is `ThemePresets.swift`, written from the desktop's.
struct ThemePreset: Identifiable {
    enum Mode { case system, light, dark }
    let id, label: String
    let mode: Mode
    let accent, accent2: Int
    /// The experimental family this is a version of; `label` then names the version.
    let family: String?
    let paper, surface, surface2, ink, inkSoft, inkFaint, line: Int?

    static func find(_ id: String?) -> ThemePreset? { all.first { $0.id == id } }
    /// System, Light and Dark keep the phone's own palette (its accents are tuned for contrast).
    var isBasic: Bool { ["system", "light", "dark"].contains(id) }
    var isSpooky: Bool { id == "autumn" }
}

/// Nekko Agent's palette (same values as Android's `Theme.kt` and the desktop),
/// with the computer's accent when it sends one, and a preset's surfaces and ink.
struct Palette {
    var paper, surface, surface2, line, ink, inkSoft, inkFaint, accent, onAccent: Color
    var success, danger, warning, running, userBubble, userInk, code: Color

    static func make(dark: Bool, accent: UInt32?, preset: ThemePreset? = nil) -> Palette {
        let base = dark ? 0x8B7DFF : 0x5A4AE8
        let tinted = accent.map { Int($0) } ?? preset.flatMap { $0.isBasic ? nil : $0.accent }
        let a = tinted ?? base
        // Whichever of white or near-black reads better on the accent (WCAG contrast).
        let onAccent = contrast(a, 0xFFFFFF) >= contrast(a, 0x0C0C11) ? Color.white : Color(hex: 0x0C0C11)
        var p: Palette
        if dark {
            p = Palette(paper: Color(hex: 0x0C0C11), surface: Color(hex: 0x16161C), surface2: Color(hex: 0x20202A),
                        line: Color(hex: 0x26262F), ink: Color(hex: 0xECEAF3), inkSoft: Color(hex: 0xA3A1B0),
                        inkFaint: Color(hex: 0x8E8E9B), accent: Color(hex: a), onAccent: onAccent,
                        success: Color(hex: 0x4CC38A), danger: Color(hex: 0xEF6A5B), warning: Color(hex: 0xE3A446),
                        running: Color(hex: 0x60A5FA), userBubble: tinted == nil ? Color(hex: 0x2A2550) : Color(hex: a).opacity(0.28),
                        userInk: Color(hex: 0xECEAF3), code: Color(hex: 0x101016))
        } else {
            p = Palette(paper: Color(hex: 0xFBFBFD), surface: .white, surface2: Color(hex: 0xF2F2F7),
                        line: Color(hex: 0xE8E8EF), ink: Color(hex: 0x17171D), inkSoft: Color(hex: 0x52525E),
                        inkFaint: Color(hex: 0x5E5E6A), accent: Color(hex: a), onAccent: onAccent,
                        success: Color(hex: 0x1A7043), danger: Color(hex: 0xB42318), warning: Color(hex: 0x875709),
                        running: Color(hex: 0x1D4ED8), userBubble: Color(hex: a), userInk: onAccent, code: Color(hex: 0xF2F2F7))
        }
        // A preset's surfaces only fit the mode it was drawn for.
        guard let preset, (preset.mode == .dark) == dark else { return p }
        func set(_ k: WritableKeyPath<Palette, Color>, _ v: Int?) { if let v { p[keyPath: k] = Color(hex: v) } }
        set(\.paper, preset.paper)
        set(\.surface, preset.surface)
        set(\.surface2, preset.surface2)
        set(\.ink, preset.ink)
        set(\.inkSoft, preset.inkSoft)
        set(\.inkFaint, preset.inkFaint)
        set(\.line, preset.line)
        if dark { set(\.userInk, preset.ink) }
        return p
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

/// The app's ground: the theme's paper washed with its accent, strongest at the top, so
/// every theme has its own colour (the default is Nekko purple). Lists and forms sit on it
/// as the desktop's panels sit on its paper.
struct AppBackdrop: View {
    /// The accent's share at the top: faint ink and coloured text keep 4.5:1 on it (`PaletteTests`).
    static let lightWash = 0.14, darkWash = 0.16
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        LinearGradient(colors: [palette.accent.opacity(dark ? Self.darkWash : Self.lightWash), palette.accent.opacity(dark ? 0.05 : 0.04)],
                       startPoint: .top, endPoint: .bottom)
            .background(palette.paper)
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

extension View {
    /// A screen on the app's coloured ground (`AppBackdrop`), its list or form background hidden.
    func appBackground() -> some View {
        scrollContentBackground(.hidden).background { AppBackdrop() }
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
    let choice: String
    let appearance: Appearance?
    @Environment(\.colorScheme) private var system

    func body(content: Content) -> some View {
        let scheme = resolved
        let palette = Palette.make(dark: (scheme ?? system) == .dark, accent: choice == Prefs.matchComputer ? appearance?.accent : nil, preset: preset)
        content
            .environment(\.palette, palette)
            .preferredColorScheme(scheme)
            .tint(palette.accent)
    }

    private var preset: ThemePreset? { Prefs.preset(choice, computer: appearance) }

    private var resolved: ColorScheme? {
        if choice == Prefs.matchComputer {
            switch appearance?.theme {
            case .light?: return .light
            case .dark?: return .dark
            default: return nil
            }
        }
        switch preset?.mode {
        case .light?: return .light
        case .dark?: return .dark
        default: return nil
        }
    }
}
