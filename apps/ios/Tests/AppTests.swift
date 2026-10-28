import XCTest
import NekkoProtocol
import SwiftUI
@testable import NekkoNative

final class KeychainStoreTests: XCTestCase {
    func testRoundTripsOverwritesAndDeletes() {
        let s = KeychainStore(service: "dev.nekkolabs.nekkoagent.tests.\(UUID().uuidString)")
        defer { s.wipe() }
        XCTAssertNil(s.get("k"))
        s.set("k", "one")
        XCTAssertEqual(s.get("k"), "one")
        s.set("k", "two")
        XCTAssertEqual(s.get("k"), "two")
        s.set("k", nil)
        XCTAssertNil(s.get("k"))
        s.set("a", "1")
        s.set("b", "2")
        s.wipe()
        XCTAssertNil(s.get("a"))
        XCTAssertNil(s.get("b"))
    }
}

final class MarkdownTests: XCTestCase {
    // The block parser itself is NekkoProtocol's (MarkdownTests there, run on Linux too).
    func testTheRendererReadsTheParsersTree() {
        let blocks = MarkdownParser.blocks("- one\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |")
        guard case .list(let list) = blocks.first, case .table(let table) = blocks.last else { return XCTFail("a list and a table") }
        XCTAssertEqual(list.items.first?.children.first?.items.first?.text, "nested")
        XCTAssertEqual(table.rows, [["1", "2"]])
    }

    func testInlineMarkdownIsParsedOnceAndStaysTheSame() {
        let first = InlineMarkdown.attributed("Some **bold** and `code`")
        XCTAssertNotNil(first)
        XCTAssertEqual(String(first!.characters), "Some bold and code")
        XCTAssertEqual(InlineMarkdown.attributed("Some **bold** and `code`"), first, "a cache hit gives the same text")
        XCTAssertEqual(String(InlineMarkdown.attributed("plain")!.characters), "plain")
    }

    func testTablesAndPathLinksRender() {
        XCTAssertEqual(MarkdownParser.blocks("| a | b |\n|---|:-:|\n| 1 | 2 |"),
                       [.table(MarkdownTable(header: ["a", "b"], alignments: [.leading, .center], rows: [["1", "2"]]))])
        // A Windows path with a space would not be a URL: it is rewritten to a file: link that routes back to the path.
        let link = InlineMarkdown.attributed("Open [the design](C:\\p\\my work\\index.html)")?.runs.compactMap { $0.link }.first
        XCTAssertEqual(link.map { ChatLinks.classify($0) }, .artifact("C:/p/my work/index.html"))
        XCTAssertEqual(InlineMarkdown.plain("**Name**"), "Name")
    }

    func testAnUnclosedFenceStillShowsItsCode() {
        XCTAssertEqual(MarkdownParser.blocks("```\nstreaming…"), [.code(language: "", body: "streaming…", closed: false)])
    }
}

final class PaletteTests: XCTestCase {
    func testPicksReadableInkOnTheAccent() {
        XCTAssertGreaterThan(Palette.luminance(0xFFFFFF), 0.99)
        XCTAssertLessThan(Palette.luminance(0x6D5EFC), 0.45)
        XCTAssertEqual(Palette.contrast(0xFFFFFF, 0x000000), 21, accuracy: 0.01)
    }

    /// WCAG AA (4.5:1) for the text colours on the surfaces they sit on, in both themes.
    func testTextColoursMeetAA() {
        // Light: paper, surface, surface2. Dark: paper, surface, surface2.
        // Each also on the coloured ground's top, where the accent wash is strongest (AppBackdrop).
        func wash(_ paper: Int, _ accent: Int, _ share: Double) -> Int {
            // Split into typed steps: as one expression it timed out the CI type checker.
            func ch(_ shift: Int) -> Int {
                let p: Double = Double((paper >> shift) & 0xff)
                let a: Double = Double((accent >> shift) & 0xff)
                let mixed: Double = p * (1 - share) + a * share
                return Int(mixed.rounded()) << shift
            }
            return ch(16) | ch(8) | ch(0)
        }
        let light = [0xFBFBFD, 0xFFFFFF, 0xF2F2F7, wash(0xFBFBFD, 0x5A4AE8, AppBackdrop.lightWash)]
        let dark = [0x0C0C11, 0x16161C, 0x20202A, wash(0x0C0C11, 0x8B7DFF, AppBackdrop.darkWash)]
        for bg in light {
            for ink in [0x17171D, 0x52525E, 0x5E5E6A, 0x5A4AE8, 0xB42318, 0x875709, 0x1D4ED8, 0x1A7043] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, bg), 4.5, String(format: "%06X on %06X", ink, bg))
            }
        }
        for bg in dark {
            for ink in [0xECEAF3, 0xA3A1B0, 0x8E8E9B, 0x8B7DFF, 0xEF6A5B, 0xE3A446, 0x60A5FA, 0x4CC38A] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, bg), 4.5, String(format: "%06X on %06X", ink, bg))
            }
        }
        // Button labels on the default accents.
        XCTAssertGreaterThanOrEqual(Palette.contrast(0xFFFFFF, 0x5A4AE8), 4.5)
        XCTAssertGreaterThanOrEqual(Palette.contrast(0x0C0C11, 0x8B7DFF), 4.5)
    }
}

@MainActor
final class ThemePresetTests: XCTestCase {
    func testAPresetBringsItsSurfacesAndAccent() {
        let nord = ThemePreset.find("nord")!
        let p = Palette.make(dark: true, accent: nil, preset: nord)
        XCTAssertEqual(p.paper, Color(hex: 0x1E222A))
        XCTAssertEqual(p.accent, Color(hex: 0x88C0D0))
        // Its surfaces only fit the mode it was drawn for.
        XCTAssertEqual(Palette.make(dark: false, accent: nil, preset: nord).paper, Color(hex: 0xFBFBFD))
        // The computer's own accent wins over the preset's.
        XCTAssertEqual(Palette.make(dark: true, accent: 0x112233, preset: nord).accent, Color(hex: 0x112233))
        // System, Light and Dark keep the phone's contrast-tuned accent.
        XCTAssertEqual(Palette.make(dark: false, accent: nil, preset: ThemePreset.find("light")).accent, Color(hex: 0x5A4AE8))
    }

    func testMatchingTheComputerUsesItsPreset() {
        let look = Appearance(theme: .dark, preset: "autumn")
        XCTAssertEqual(Prefs.preset(Prefs.matchComputer, computer: look)?.id, "autumn")
        XCTAssertEqual(Prefs.preset("nebula", computer: look)?.id, "nebula")
        XCTAssertNil(Prefs.preset(Prefs.matchComputer, computer: Appearance(preset: "not-a-preset")))
        XCTAssertTrue(ThemePreset.find("autumn")!.isSpooky)
    }

    func testTheSpookyIconOnlyShowsInOctober() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        func day(_ m: Int, _ d: Int) -> Date { cal.date(from: DateComponents(year: 2026, month: m, day: d, hour: 12))! }
        XCTAssertTrue(SpookyIcon.inSeason(day(10, 1), calendar: cal))
        XCTAssertTrue(SpookyIcon.inSeason(day(10, 31), calendar: cal))
        XCTAssertFalse(SpookyIcon.inSeason(day(11, 1), calendar: cal))
        XCTAssertFalse(SpookyIcon.inSeason(day(9, 30), calendar: cal))
        XCTAssertNil(SpookyIcon.wanted(spooky: false, on: day(10, 15)))
    }
}

@MainActor
final class DeepLinkTests: XCTestCase {
    func testPairingAndChatLinksAreRouted() {
        let app = AppModel.shared
        app.pendingLink = nil
        app.handle(url: URL(string: "nekko-agent-pair:?relay=wss%3A%2F%2Frelay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff&pair=ABCD2345")!)
        XCTAssertEqual(app.pendingLink?.relayUrl, "wss://relay.example.com")
        XCTAssertEqual(app.pendingLink?.pair, "ABCD2345")
        app.pendingLink = nil
        app.handle(url: URL(string: "nekko-agent://chat/s_123")!)
        XCTAssertEqual(app.openChat, "s_123")
        XCTAssertNil(app.pendingLink)
        app.openChat = nil
        app.handle(url: URL(string: "nekko-agent-pair:?nothing=here")!)
        XCTAssertNil(app.pendingLink)
        // The Control Center control's link asks for New chat, and is not a pairing.
        app.newChatRequested = false
        app.handle(url: URL(string: "nekko-agent://new")!)
        XCTAssertTrue(app.newChatRequested)
        XCTAssertNil(app.pendingLink)
        app.newChatRequested = false
        // The Live Activity's "+N" only opens the app.
        app.handle(url: LiveCardView.chatsURL)
        XCTAssertNil(app.openChat)
        XCTAssertNil(app.pendingLink)
        XCTAssertFalse(app.newChatRequested)
        // The Home Screen quick action opens the same link; an unknown type does nothing.
        XCTAssertEqual(QuickAction.url(for: QuickAction.newChat)?.absoluteString, "nekko-agent://new")
        XCTAssertNil(QuickAction.url(for: "dev.nekkolabs.nekkoagent.other"))
        XCTAssertTrue(QuickAction.perform(QuickAction.newChat))
        XCTAssertTrue(app.newChatRequested)
        app.newChatRequested = false
    }
}

final class StatusWidgetTests: XCTestCase {
    func testTheWatchKeepsTheLastCountsForItsComplication() throws {
        let suite = "nekko.tests.watch.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(WatchStatus.load(defaults), .empty)
        let s = StatusSnapshot(computer: "Mac", online: false, needsYou: 0, running: 3, at: Date(timeIntervalSince1970: 1_800_000_000))
        WatchStatus.save(s, defaults)
        XCTAssertEqual(WatchStatus.load(defaults), s)
    }

    func testTheWatchGetsTheSameCountsAndNothingElse() throws {
        let s = StatusSnapshot(computer: "Mac", online: true, needsYou: 2, running: 1, at: Date(timeIntervalSince1970: 1_800_000_000))
        let context = s.watchContext
        XCTAssertEqual(Array(context.keys), [StatusSnapshot.watchKey])
        XCTAssertEqual(StatusSnapshot(watchContext: context), s)
        let json = String(decoding: try XCTUnwrap(context[StatusSnapshot.watchKey] as? Data), as: UTF8.self)
        for key in ["computer", "online", "needsYou", "running", "at"] { XCTAssertTrue(json.contains(key), key) }
        XCTAssertNil(StatusSnapshot(watchContext: ["status": Data("nope".utf8)]))
        XCTAssertNil(StatusSnapshot(watchContext: [:]))
    }

    func testHeadlineSaysWhatNeedsYouFirst() {
        func s(_ needs: Int, _ running: Int, online: Bool = true, computer: String? = "Mac") -> String {
            StatusSnapshot(computer: computer, online: online, needsYou: needs, running: running, at: .now).headline
        }
        XCTAssertEqual(s(0, 0, computer: nil), "Not paired")
        XCTAssertEqual(s(1, 3), "1 needs you")
        XCTAssertEqual(s(2, 0), "2 need you")
        XCTAssertEqual(s(0, 1), "1 working")
        XCTAssertEqual(s(0, 4), "4 working")
        XCTAssertEqual(s(0, 0), "All quiet")
        XCTAssertEqual(s(0, 0, online: false), "Offline")
    }

    func testPromptsWaitingToSendShowOnTheWidgetAndTheWatch() throws {
        let quiet = StatusSnapshot(computer: "Mac", online: false, needsYou: 0, running: 0, at: .now, waiting: 2)
        XCTAssertEqual(quiet.headline, "2 waiting to send")
        XCTAssertNil(quiet.waitingBesideHeadline, "said once")
        let busy = StatusSnapshot(computer: "Mac", online: false, needsYou: 1, running: 0, at: .now, waiting: 1)
        XCTAssertEqual(busy.headline, "1 needs you")
        XCTAssertEqual(busy.waitingBesideHeadline, "1 waiting to send")
        XCTAssertEqual(StatusSnapshot(watchContext: busy.watchContext), busy)
        // A snapshot an older version saved has no count, and still reads.
        let old = Data(#"{"computer":"Mac","online":true,"needsYou":0,"running":0,"at":0}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(StatusSnapshot.self, from: old).waitingCount, 0)
        let now = Date(timeIntervalSince1970: 10_000)
        XCTAssertEqual(StatusSnapshot(computer: "Mac", online: false, needsYou: 0, running: 0, at: now, waiting: 3).spoken(now: now),
                       "Mac was offline when Nekko Agent last checked. 3 waiting to send when Mac is back.")
    }

    func testWhatNeedsMeAnswersInASentence() {
        let now = Date(timeIntervalSince1970: 10_000)
        func say(_ needs: Int, _ running: Int, online: Bool = true, computer: String? = "Mac", ago: TimeInterval = 30) -> String {
            StatusSnapshot(computer: computer, online: online, needsYou: needs, running: running, at: now.addingTimeInterval(-ago)).spoken(now: now)
        }
        XCTAssertEqual(say(0, 0, computer: nil), "No computer is paired with Nekko Agent yet.")
        XCTAssertEqual(say(1, 0), "1 chat needs you on Mac.")
        XCTAssertEqual(say(2, 1), "2 chats need you on Mac, and 1 is working.")
        XCTAssertEqual(say(0, 3), "3 chats are working on Mac. Nothing needs you.")
        XCTAssertEqual(say(0, 0), "All quiet on Mac.")
        XCTAssertEqual(say(0, 0, online: false), "Mac was offline when Nekko Agent last checked.")
        XCTAssertTrue(say(1, 0, ago: 3600).hasPrefix("1 chat needs you on Mac. As of "), "old numbers say how old")
        XCTAssertEqual(StatusSnapshot(computer: "Mac", online: true, needsYou: 0, running: 0, at: .distantPast).spoken(now: now),
                       "Open Nekko Agent once so it can check Mac.")
    }

    func testSavesCountsOnlyAndReportsRealChanges() throws {
        let suite = "nekko.widget.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(StatusSnapshot.load(defaults), .empty)
        let a = StatusSnapshot(computer: "Mac", online: true, needsYou: 1, running: 0, at: Date(timeIntervalSince1970: 100))
        XCTAssertTrue(a.save(defaults))
        XCTAssertEqual(StatusSnapshot.load(defaults), a)
        // Only the time moved: no widget reload.
        var later = a
        later.at = Date(timeIntervalSince1970: 200)
        XCTAssertFalse(later.save(defaults))
        var answered = later
        answered.needsYou = 0
        XCTAssertTrue(answered.save(defaults))
        // Nothing but counts and the computer's name is stored.
        let raw = try XCTUnwrap(defaults.data(forKey: StatusSnapshot.key))
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any]).keys.sorted()
        XCTAssertEqual(keys, ["at", "computer", "needsYou", "online", "running"])
    }

    @MainActor
    func testRendersTheSmallWidget() throws {
        let snapshot = StatusSnapshot(computer: "Studio Mac", online: true, needsYou: 2, running: 1, at: .now.addingTimeInterval(-120))
        for scheme in [ColorScheme.light, .dark] {
            let view = StatusWidgetView(snapshot: snapshot, family: .systemSmall)
                .padding(16)
                .frame(width: 170, height: 170)
                .background(scheme == .dark ? Color(white: 0.11) : Color(white: 0.96))
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            let shot = XCTAttachment(image: image)
            shot.name = "widget-small-\(scheme == .dark ? "dark" : "light")"
            shot.lifetime = .keepAlways
            add(shot)
        }
    }
}

@MainActor
final class SavedListNoteTests: XCTestCase {
    func testTheNoteSaysWhenAndThatItIsNotLive() {
        let cal = Calendar(identifier: .gregorian)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let today = SavedListNote.text(savedAt: Int64((now.timeIntervalSince1970 - 600) * 1000), computer: "Mac", now: now, calendar: cal)
        XCTAssertTrue(today.hasPrefix("Saved list from "))
        XCTAssertTrue(today.hasSuffix("It updates when Mac answers."))
        let old = SavedListNote.text(savedAt: Int64((now.timeIntervalSince1970 - 3 * 86_400) * 1000), computer: "Mac", now: now, calendar: cal)
        XCTAssertGreaterThan(old.count, today.count, "an older list also names the day")
    }

    func testASavedChatSaysItIsACopy() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let text = SavedListNote.copy(savedAt: Int64((now.timeIntervalSince1970 - 600) * 1000), computer: "Mac", now: now,
                                      calendar: Calendar(identifier: .gregorian))
        XCTAssertTrue(text.hasPrefix("Saved copy from "))
        XCTAssertTrue(text.hasSuffix("It updates when Mac answers."))
    }
}

/// OF-9 and OF-5: both offline switches are on unless the user turned them off.
@MainActor
final class OfflinePrefsTests: XCTestCase {
    func testOnForANewInstallAndOffWhenTheUserTurnedThemOff() throws {
        let suite = "dev.nekkolabs.nekkoagent.tests.prefs.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let fresh = Prefs(defaults: defaults)
        XCTAssertTrue(fresh.keepChatList, "on for an install that never touched the switch")
        XCTAssertTrue(fresh.keepTranscripts)
        XCTAssertNil(defaults.object(forKey: "keepChatList"), "reading the default stores nothing")
        fresh.keepChatList = false
        fresh.keepTranscripts = false
        let again = Prefs(defaults: defaults)
        XCTAssertFalse(again.keepChatList, "a deliberate off stays off")
        XCTAssertFalse(again.keepTranscripts)
    }
}

/// TS-4: Open Tailscale. Without `tailscale` in LSApplicationQueriesSchemes,
/// canOpenURL always answers no and the action would only ever reach the App Store.
final class OpenTailscaleTests: XCTestCase {
    func testTheAppMayAskWhetherTailscaleIsInstalled() {
        let schemes = Bundle.main.object(forInfoDictionaryKey: "LSApplicationQueriesSchemes") as? [String]
        XCTAssertEqual(schemes?.contains("tailscale"), true)
    }

    @MainActor
    func testWithoutTailscaleInstalledItOpensTheAppStorePage() {
        // The simulator has no Tailscale app.
        var opened: URL?
        let url = AppModel.openTailscale(canOpen: { UIApplication.shared.canOpenURL($0) }, open: { opened = $0 })
        XCTAssertEqual(url.host, "apps.apple.com")
        XCTAssertEqual(opened, url)
        XCTAssertEqual(AppModel.openTailscale(canOpen: { _ in true }, open: { _ in }).absoluteString, "tailscale://")
    }
}

@MainActor
final class NotificationPrefsTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "nekko.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    /// IO-30: one switch per kind, and the relay is asked only for those.
    func testEachKindHasItsSwitchAndTheRelayGetsOnlyThoseOn() {
        let d = defaults()
        let p = Prefs(defaults: d)
        XCTAssertEqual(p.pushKinds, [.needsYou, .finished, .failed])
        p.notifyFinished = false
        XCTAssertEqual(p.pushKinds, [.needsYou, .failed])
        XCTAssertFalse(p.wants(.finished))
        XCTAssertTrue(p.wants(.test), "a test always shows")
        XCTAssertEqual(Prefs(defaults: d).pushKinds, [.needsYou, .failed], "saved")
        XCTAssertFalse(p.dictationHold, "tap to start and stop stays the default (IO-28)")
        XCTAssertFalse(p.onboarded)
    }

    /// Someone who had turned the old single switch off keeps every kind off.
    func testTheOldSingleSwitchSeedsEachKind() {
        let d = defaults()
        d.set(false, forKey: "notify")
        let p = Prefs(defaults: d)
        XCTAssertEqual(p.pushKinds, [])
    }
}

final class ChatStatusIconTests: XCTestCase {
    @MainActor
    func testArchivedDoneUsesTheSameGrayCheckAsUnarchivedDone() throws {
        func render(_ completed: Bool) throws -> Data {
            let icon = ChatStatusIcon(activity: nil, completed: completed)
                .frame(width: 32, height: 32)
            return try XCTUnwrap(ImageRenderer(content: icon).uiImage?.pngData())
        }
        let grayCheck = Image(systemName: "checkmark")
            .foregroundStyle(Palette.make(dark: false, accent: nil).inkFaint)
            .font(.caption.weight(.semibold))
            .frame(width: 32, height: 32)
        let expected = try XCTUnwrap(ImageRenderer(content: grayCheck).uiImage?.pngData())
        XCTAssertEqual(try render(true), expected)
        XCTAssertEqual(try render(false), expected)
    }

    func testStatusLabelsAndPrecedence() {
        XCTAssertEqual(ChatStatusIcon(activity: .running, completed: true, waiting: true).label, "Working")
        XCTAssertEqual(ChatStatusIcon(activity: .needsYou, completed: true, waiting: true).label, "Needs you")
        XCTAssertEqual(ChatStatusIcon(activity: nil, completed: true, waiting: true).label, "Waiting to send")
        XCTAssertEqual(ChatStatusIcon(activity: nil, completed: true).label, "Done")
        XCTAssertEqual(ChatStatusIcon(activity: nil).label, "Done")
        XCTAssertEqual(ChatStatusIcon(activity: nil, activeWatchCount: 1).label, "Idle")
        XCTAssertEqual(ChatStatusIcon(activity: nil, completed: true, activeWatchCount: 1).label, "Idle")
        XCTAssertEqual(ChatStatusIcon(activity: .running, completed: true, activeWatchCount: 1).label, "Working")
        XCTAssertEqual(ChatStatusIcon(activity: .needsYou, completed: true, activeWatchCount: 1).label, "Needs you")
        XCTAssertEqual(ChatStatusIcon(activity: nil, completed: true, waiting: true, activeWatchCount: 1).label, "Waiting to send")
    }
}

@MainActor
final class LiveCardViewTests: XCTestCase {
    static let chats = [
        LiveChat(id: "a", short: "Billing", state: .needsYou, step: "Needs your approval: Run npm test", reply: "Want me to run the tests?", closeWord: "Nice", finishedAt: nil, callId: "c1", severity: "low", startedAt: .now.addingTimeInterval(-75)),
        LiveChat(id: "b", short: "Login", state: .working, step: "Fixing merge conflicts", reply: "Got it. Working on it now.", closeWord: "Cool", finishedAt: nil, callId: nil, severity: nil, startedAt: .now.addingTimeInterval(-754)),
        LiveChat(id: "c", short: "iOS LA", state: .watching, step: "Watching PR #1211…", reply: "PR is up. Watching CI.", closeWord: "Perfect", finishedAt: nil, callId: nil, severity: nil),
        LiveChat(id: "d", short: "Docs", state: .done, step: "Done 12 min ago", reply: "Docs page added.", closeWord: "Looks good", finishedAt: .now, callId: nil, severity: nil),
        LiveChat(id: "e", short: "Relay", state: .failed, step: "Stopped with an error", reply: "The build broke.", closeWord: "Got it", finishedAt: .now, callId: nil, severity: nil),
    ]

    static func card(_ level: LiveLevel, focus: String? = nil, listening: Bool = false) -> LiveCardState {
        var card = buildCard(chats: chats, previous: nil, pinnedFocus: focus, level: level, now: .now)!
        if listening { card.listening = true; card.heard = "Go ahead and auto merge the PR" }
        return card
    }

    /// The default focus is "a", which waits on a tool approval.
    static let cases: [(String, LiveLevel, LiveCardState)] = [
        ("minimal", .minimal, card(.minimal)),
        ("standard", .standard, card(.standard)),
        ("detailed", .detailed, card(.detailed)),
        ("working-minimal", .minimal, card(.minimal, focus: "b")),
        ("working", .detailed, card(.detailed, focus: "b")),
        ("listening", .detailed, card(.detailed, listening: true)),
        ("done-focused", .detailed, card(.detailed, focus: "d")),
    ]

    func framed(_ state: LiveCardState, _ level: LiveLevel) -> some View {
        LiveCardView(state: state, level: level, interactive: false)
            .padding(14)
            .frame(width: 360)
            .background(LiveCardView.background)
    }

    func png(_ state: LiveCardState, _ level: LiveLevel) throws -> Data {
        try XCTUnwrap(ImageRenderer(content: framed(state, level)).uiImage?.pngData())
    }

    func testFitsTheLockScreenAtEveryLevel() throws {
        for (name, level, state) in Self.cases {
            let renderer = ImageRenderer(content: framed(state, level))
            let size = try XCTUnwrap(renderer.uiImage).size
            XCTAssertLessThanOrEqual(size.height, 160, "\(name) is \(size.height) pt tall")
        }
    }

    /// A unit test can't read SwiftUI's accessibility tree (it is only built
    /// for VoiceOver), so this checks the pixels: Minimal draws the same card
    /// whatever the chats say, while Standard does not. The state still carries
    /// the text, so it is the view that hides it, not `buildCard`.
    func testMinimalShowsNoChatText() throws {
        var real = Self.card(.detailed)
        // A ticking elapsed time could differ between the two renders.
        for i in real.chats.indices { real.chats[i].startedAt = nil }
        var other = real
        for i in other.chats.indices {
            other.chats[i].short = "Zebra"
            other.chats[i].step = "Something else entirely"
            other.chats[i].reply = "A different reply"
        }
        XCTAssertEqual(try png(real, .minimal), try png(other, .minimal))
        XCTAssertNotEqual(try png(real, .standard), try png(other, .standard))
    }

    func testTheStripShowsThePageWithTheFocusedChat() {
        let first = LiveCardView.page(Self.chats, focus: "b", size: 3)
        XCTAssertEqual(first.shown.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(first.next?.id, "d")
        let last = LiveCardView.page(Self.chats, focus: "d", size: 3)
        XCTAssertEqual(last.shown.map(\.id), ["d", "e"])
        XCTAssertEqual(last.next?.id, "a", "the last page steps back to the first")
        // Every chat fits: "+N" (chats past the eight) opens the app instead.
        XCTAssertNil(LiveCardView.page(Self.chats, focus: "d", size: 5).next)
        XCTAssertNil(LiveCardView.page([], focus: nil, size: 3).next)
    }

    /// Evidence for review: apps/ios/.shots/live-card/ (git-ignored). Runs only
    /// with `TEST_RUNNER_LIVE_CARD_SHOTS=1 xcodebuild test ...`.
    func testRendersEvidence() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CARD_SHOTS"] != nil, "set TEST_RUNNER_LIVE_CARD_SHOTS=1 to write the PNGs")
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(".shots/live-card")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, level, state) in Self.cases {
            for scheme in [ColorScheme.light, .dark] {
                let view = framed(state, level)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                    .padding(16)
                    .background(scheme == .dark ? Color.black : Color(white: 0.95))
                    .environment(\.colorScheme, scheme)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 3
                let png = try XCTUnwrap(renderer.uiImage?.pngData())
                try png.write(to: dir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png"))
            }
        }
    }
}

@MainActor
final class LiveActivityLevelPrefsTests: XCTestCase {
    private func defaults(_ set: [String: Any]) -> UserDefaults {
        let name = "nekko.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        for (k, v) in set { d.set(v, forKey: k) }
        return d
    }

    /// Before levels there was one switch, and app lock kept chat text off the Lock Screen.
    func testTheOldSwitchAndAppLockPickTheFirstLevel() {
        XCTAssertEqual(Prefs(defaults: defaults(["liveActivities": false])).liveActivityLevel, LiveLevel.none)
        XCTAssertEqual(Prefs(defaults: defaults(["liveActivities": true])).liveActivityLevel, .minimal, "app lock is on by default")
        XCTAssertEqual(Prefs(defaults: defaults(["appLock": false])).liveActivityLevel, .standard)
        let d = defaults(["appLock": false])
        let p = Prefs(defaults: d)
        p.liveActivityLevel = .detailed
        p.appLock = true
        XCTAssertEqual(Prefs(defaults: d).liveActivityLevel, .detailed, "a chosen level stays")
    }
}

@MainActor
final class RunActivitiesTests: XCTestCase {
    final class FakeCard: CardActivity {
        let attributes: NekkoCardAttributes
        var state: LiveCardState
        var updates = 0
        var ended = false
        init(_ attributes: NekkoCardAttributes, _ state: LiveCardState) { self.attributes = attributes; self.state = state }
        func update(_ state: LiveCardState) { self.state = state; updates += 1 }
        func end() { ended = true }
    }

    var started: [FakeCard] = []
    var level = LiveLevel.standard
    var summaries: [SessionSummary] = []
    var activity: [String: NekkoProtocol.Activity] = [:]

    func make() -> RunActivities {
        let r = RunActivities(request: { [unowned self] attributes, state in
            let card = FakeCard(attributes, state)
            started.append(card)
            return card
        }, adoptLeftover: false)
        r.level = { [unowned self] in level }
        r.source = { [unowned self] in .init(summaries: summaries, activity: activity, computerId: "pc", computerName: "Mac") }
        return r
    }

    func chat(_ id: String, _ title: String) -> SessionSummary {
        SessionSummary.from(["id": .string(id), "title": .string(title), "lastReplyText": "Got it. Working on it now."])!
    }

    func testTwoRunningChatsShareOneCard() throws {
        summaries = [chat("a", "Billing fix"), chat("b", "Login page")]
        activity = ["a": .running, "b": .running]
        let r = make()
        r.refresh()
        r.refresh()
        XCTAssertEqual(started.count, 1, "one card for every chat")
        let card = try XCTUnwrap(started.first)
        XCTAssertEqual(card.state.chats.map(\.id), ["a", "b"])
        XCTAssertEqual(card.state.chats.first?.short, "Billing")
        XCTAssertEqual(card.attributes.level, .standard)

        r.focus("b")
        XCTAssertEqual(card.state.focusId, "b", "a chip tap brings that chat up")

        level = .detailed
        r.refresh()
        XCTAssertTrue(card.ended, "the level is fixed for a card's life")
        XCTAssertEqual(started.count, 2)
        XCTAssertEqual(started.last?.attributes.level, .detailed)
        XCTAssertEqual(started.last?.state.chats.first?.reply, "Got it.")

        activity = [:]
        r.refresh()
        XCTAssertTrue(try XCTUnwrap(started.last).ended, "nothing running or finished: the card ends")
    }

    func testDismissingTheOnlyFinishedChatEndsTheCard() throws {
        summaries = [chat("a", "Billing fix")]
        let r = make()
        r.onEvent(.done(sessionId: "a", messageId: nil))
        r.refresh()
        let card = try XCTUnwrap(started.first)
        XCTAssertEqual(card.state.chats.first?.state, .done)
        XCTAssertEqual(card.state.chats.first?.step, "Finished")
        XCTAssertNotNil(card.state.chats.first?.finishedAt)
        XCTAssertFalse(card.state.chats.first?.closeWord.isEmpty ?? true)
        r.dismiss("a")
        XCTAssertTrue(card.ended)
        r.refresh()
        XCTAssertEqual(started.count, 1, "a dismissed chat stays off until it runs again")
    }

    func testAFinishedChatLeavesAfterTwoHours() throws {
        summaries = [chat("a", "Billing fix")]
        let r = make()
        r.onEvent(.done(sessionId: "a", messageId: nil))
        r.refresh()
        let card = try XCTUnwrap(started.first)
        r.refresh(now: Date().addingTimeInterval(LiveCardRules.finishedTail + 5))
        XCTAssertTrue(card.ended)
    }
}
