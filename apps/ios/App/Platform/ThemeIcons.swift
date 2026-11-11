import SwiftUI

/// Each theme's icon in the theme list, drawn like the desktop's picker
/// (theme-icons.tsx; the ThemeIcons assets come from scripts/phone-marks.mjs).
/// The desktop's nine keep their icons; the rows only the phones list (the mode
/// rows, the extra presets and the experimental families) have Gentleface ones
/// of their own. Android keeps the same table in ThemeIcons.kt.
enum ThemeIcons {
    /// Match my computer.
    static let computer = "theme-laptop"

    static let byId: [String: String] = [
        "system": "theme-sun-moon", "light": "theme-sun", "dark": "theme-moon",
        "nebula": "theme-galaxy", "terminal": "theme-terminal", "nord": "theme-mountain",
        "solar": "theme-sunrise", "lilac": "theme-flower", "lavender": "theme-sprout",
        "nekko-dark": "theme-cat", "ember": "theme-flame",
        "autumn": "theme-wizard-hat", "winter": "theme-beanie",
    ]

    /// Every version of a family shares its icon.
    static let byFamily: [String: String] = [
        "Nekko": "theme-cat", "Forest": "theme-tree-evergreen", "Blueberry": "theme-blueberry",
        "Raspberry": "theme-cherry", "Mulberry": "theme-grape", "Cyber": "theme-cpu",
        "Quantum": "theme-atom", "Clay": "theme-amphora", "Inkberry": "theme-feather",
        "Neon": "theme-lightbulb", "Arctic Mist": "theme-snowflake", "Indigo": "theme-moon-star",
        "Obsidian": "theme-gem", "Orchid Pulse": "theme-potted-plant",
        "Indigo Parchment": "theme-scroll", "Tidepool": "theme-waves",
    ]

    static func of(_ preset: ThemePreset?) -> String? {
        guard let preset else { return nil }
        return preset.family.flatMap { byFamily[$0] } ?? byId[preset.id]
    }

    /// The icon's colour: the theme's accent (or the computer's, for that row) when it
    /// reads on `background` at 3:1. A pale accent on a light phone (or a deep one on a
    /// dark phone) gives way to the theme's own page colour when that is a colour of its
    /// own (Blueberry Dark's navy), else to the accent deepened toward black (or lightened
    /// toward white) until it reads, keeping its hue as the desktop's light accents do.
    /// Nil leaves the caller's ink. Same rule as ThemeIcons.kt.
    static func tint(_ preset: ThemePreset?, accent: Int? = nil, on background: Int) -> Int? {
        guard let a = accent ?? preset?.accent else { return nil }
        if Palette.contrast(a, background) >= 3 { return a }
        if let paper = preset?.paper, chromatic(paper), Palette.contrast(paper, background) >= 3 { return paper }
        let toward = Palette.luminance(background) > 0.5 ? 0x000000 : 0xFFFFFF
        return (1...10).lazy.map { mix(a, toward, Double($0) / 10) }.first { Palette.contrast($0, background) >= 3 }
    }

    /// A colour rather than a near-black or near-white: its channels spread at least 0x30.
    static func chromatic(_ rgb: Int) -> Bool {
        let ch = [rgb >> 16 & 0xff, rgb >> 8 & 0xff, rgb & 0xff]
        return ch.max()! - ch.min()! >= 0x30
    }

    /// Straight sRGB blend, as Android does it.
    static func mix(_ a: Int, _ b: Int, _ f: Double) -> Int {
        [16, 8, 0].reduce(0) { out, shift in
            let x = Double(a >> shift & 0xff), y = Double(b >> shift & 0xff)
            return out | Int((x + (y - x) * f).rounded()) << shift
        }
    }
}

/// A theme's icon, in its colour (ThemeIcons.tint), on a list row.
struct ThemeGlyph: View {
    let icon: String
    var preset: ThemePreset?
    var accent: Int?
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // The grouped list's row colour in each mode.
        let row = scheme == .dark ? 0x1C1C1E : 0xFFFFFF
        Image(icon).renderingMode(.template).resizable().scaledToFit()
            .frame(width: 22, height: 22)
            .foregroundStyle(ThemeIcons.tint(preset, accent: accent, on: row).map { Color(hex: $0) } ?? palette.inkSoft)
            .accessibilityHidden(true)
    }
}
