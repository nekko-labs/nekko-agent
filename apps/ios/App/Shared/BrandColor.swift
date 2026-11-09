import SwiftUI

/// The brand's fixed colours (spec/brand/colour-palette.md), for what does not follow
/// the theme: the launch screen and opening animation, the app lock cover, the pixel
/// mascot and the Live Activity's cat. Themed surfaces use `Palette` instead.
/// Shared with the widget extension. Keep in step with the launch storyboard's ground,
/// the desktop (splash.ts, Mascot.tsx) and Android (res/values/colors.xml).
enum BrandColor {
    /// The main plum, the app icon's tile: `#190019`.
    static let plum = Color(red: 0x19 / 255, green: 0x00 / 255, blue: 0x19 / 255)
    /// The secondary as a small accent on dark: `#C99BB3` (the dark app icon's cat).
    static let plumLight = Color(red: 0xC9 / 255, green: 0x9B / 255, blue: 0xB3 / 255)
    /// Dark Nekko's accent, `#C084B5`: small accents and filled buttons on a fixed dark
    /// card (the Live Activity), 5.8:1 on its ground and 6.7:1 under its dark text.
    static let accentOnDark = Color(red: 0xC0 / 255, green: 0x84 / 255, blue: 0xB5 / 255)
    /// The cat's line on plum: white, as on the app icon.
    static let mark = Color.white
}
