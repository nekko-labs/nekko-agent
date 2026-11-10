import SwiftUI
#if os(iOS)
import UIKit
#endif

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

    // Dark Nekko's state and ink tokens (`Palette.make(dark: true)`), for status glyphs on a
    // fixed dark surface that cannot read the theme: the Live Activity card and the watch.
    /// `--ink-faint` in dark: watching (Zz) and done (check), as in the app's list.
    static let inkFaintOnDark = Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x9B / 255)
    /// `--success` in dark: working (the rocket).
    static let successOnDark = Color(red: 0x4C / 255, green: 0xC3 / 255, blue: 0x8A / 255)
    /// `--warning` in dark: an agent waiting on you (the question mark).
    static let attentionOnDark = Color(red: 0xE3 / 255, green: 0xA4 / 255, blue: 0x46 / 255)
    /// `--danger` in dark: stopped on an error (the cross).
    static let dangerOnDark = Color(red: 0xEF / 255, green: 0x6A / 255, blue: 0x5B / 255)

    #if os(iOS)
    // The basic palette's state tokens in light and dark (`Palette.make`), for the Home
    // Screen widget, which follows the phone's appearance but cannot read the theme.
    /// `--success`: the computer is online.
    static let success = adaptive(light: (0x1A, 0x70, 0x43), dark: (0x4C, 0xC3, 0x8A))
    /// `--warning`: chats waiting on you.
    static let attention = adaptive(light: (0x87, 0x57, 0x09), dark: (0xE3, 0xA4, 0x46))

    private static func adaptive(light: (Int, Int, Int), dark: (Int, Int, Int)) -> Color {
        Color(UIColor { traits in
            let (r, g, b) = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
        })
    }
    #endif
}
