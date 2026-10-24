import UIKit

/// The Spooky theme's limited app icon: a fall night behind the cat, from
/// October 1 through Halloween. Outside the season, or on any other theme,
/// the app keeps its usual icon.
enum SpookyIcon {
    static let name = "AppIcon-Spooky"

    static func inSeason(_ date: Date = .now, calendar: Calendar = .current) -> Bool {
        calendar.component(.month, from: date) == 10
    }

    /// The icon the app should show; nil is the usual one.
    static func wanted(spooky: Bool, on date: Date = .now) -> String? {
        spooky && inSeason(date) ? name : nil
    }

    /// Switch only when it changes: iOS tells the user each time it does.
    @MainActor
    static func sync(spooky: Bool) {
        let app = UIApplication.shared
        let want = wanted(spooky: spooky)
        guard app.supportsAlternateIcons, app.applicationState == .active, app.alternateIconName != want else { return }
        app.setAlternateIconName(want)
    }
}
