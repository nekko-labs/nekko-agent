import XCTest
import NekkoKit
import NekkoProtocol
import AVFoundation
import Speech
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

@MainActor
final class PaletteTests: XCTestCase {
    func testPicksReadableInkOnTheAccent() {
        XCTAssertGreaterThan(Palette.luminance(0xFFFFFF), 0.99)
        XCTAssertLessThan(Palette.luminance(0x5A2352), 0.45)
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
        let light = [0xFBFBFD, 0xFFFFFF, 0xF2F2F7, wash(0xFBFBFD, 0x5A2352, AppBackdrop.lightWash)]
        let dark = [0x0C0C11, 0x16161C, 0x20202A, wash(0x0C0C11, 0xC084B5, AppBackdrop.darkWash)]
        for bg in light {
            for ink in [0x17171D, 0x52525E, 0x5E5E6A, 0x5A2352, 0xB42318, 0x875709, 0x1D4ED8, 0x1A7043] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, bg), 4.5, String(format: "%06X on %06X", ink, bg))
            }
        }
        for bg in dark {
            for ink in [0xECEAF3, 0xA3A1B0, 0x8E8E9B, 0xC084B5, 0xEF6A5B, 0xE3A446, 0x60A5FA, 0x4CC38A] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, bg), 4.5, String(format: "%06X on %06X", ink, bg))
            }
        }
        // Button labels on the default accents.
        XCTAssertGreaterThanOrEqual(Palette.contrast(0xFFFFFF, 0x5A2352), 4.5)
        XCTAssertGreaterThanOrEqual(Palette.contrast(0x0C0C11, 0xC084B5), 4.5)
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
        XCTAssertEqual(Palette.make(dark: false, accent: nil, preset: ThemePreset.find("light")).accent, Color(hex: 0x5A2352))
        // A computer from before the plum palette sends its old violet: the phone keeps plum.
        XCTAssertEqual(Palette.make(dark: false, accent: 0x6D5EFC, preset: ThemePreset.find("system")).accent, Color(hex: 0x5A2352))
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
        // Routing consumes an approval only after unlock; do not depend on the shared test app’s saved lock setting.
        let savedAppLock = app.prefs.appLock
        defer { app.prefs.appLock = savedAppLock }
        app.prefs.appLock = false
        app.pendingLink = nil
        app.handle(url: URL(string: "nekko-agent-pair:?relay=wss%3A%2F%2Frelay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff&host=BJ7go4GGB9flqEQfjn77eO%2BWT5J%2Bxi8WJkMUlZycp%2BJNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE%3D&pair=ABCD2345")!)
        XCTAssertEqual(app.pendingLink?.relayUrl, "wss://relay.example.com")
        XCTAssertEqual(app.pendingLink?.pair, "ABCD2345")
        app.pendingLink = nil
        app.handle(url: URL(string: "nekko-agent://chat/s_123")!)
        XCTAssertEqual(app.openChat, "s_123")
        XCTAssertNil(app.pendingLink)
        app.openChat = nil
        // The Live Activity mic on iOS 17 (no AudioRecordingIntent): the chat opens listening.
        XCTAssertNil(app.listenIn)
        app.handle(url: LiveCardView.listenURL("s_123"))
        XCTAssertEqual(app.openChat, "s_123")
        XCTAssertEqual(app.listenIn, "s_123")
        app.openChat = nil
        app.listenIn = nil
        app.handle(url: LiveCardView.listenURL("s_123"))
        app.handle(url: URL(string: "nekko-agent://chat/s_123")!)
        XCTAssertNil(app.listenIn, "a plain chat link opens no microphone, and clears one still waiting")
        app.openChat = nil
        // Taken only by that chat's composer, and only for a chat the phone's list has.
        app.handle(url: LiveCardView.listenURL("s_unknown"))
        XCTAssertFalse(app.takeListen("s_other"))
        XCTAssertFalse(app.takeListen("s_unknown"), "not a chat this computer has")
        app.openChat = nil
        app.listenIn = nil
        app.handle(url: URL(string: "nekko-agent-pair:?nothing=here")!)
        XCTAssertNil(app.pendingLink)
        // "Always allow this tool" from a notification or the Live Activity: the chat
        // opens and its card runs it once, for that call only.
        app.handle(url: LiveCardView.alwaysAllowURL("s_123", callId: "call_7"))
        XCTAssertEqual(app.openChat, "s_123")
        XCTAssertEqual(app.alwaysAllowIn, AppModel.AlwaysAllowRequest(chatId: "s_123", callId: "call_7"))
        XCTAssertNil(app.listenIn)
        XCTAssertFalse(app.takeAlwaysAllow("s_other", callId: "call_7"), "another chat")
        XCTAssertFalse(app.takeAlwaysAllow("s_123", callId: "call_8"), "another call in the same chat")
        XCTAssertTrue(app.takeAlwaysAllow("s_123", callId: "call_7"))
        XCTAssertFalse(app.takeAlwaysAllow("s_123", callId: "call_7"), "taken once")
        app.handle(url: LiveCardView.alwaysAllowURL("s_123", callId: "call_7"))
        app.handle(url: URL(string: "nekko-agent://chat/s_123")!)
        XCTAssertNil(app.alwaysAllowIn, "a plain chat link allows nothing, and clears one still waiting")
        app.handle(url: URL(string: "nekko-agent://chat/s_123?alwaysAllow=")!)
        XCTAssertNil(app.alwaysAllowIn, "an empty call id is no request")
        app.openChat = nil
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
        // UTC: west of it, ten minutes before `now` falls on the previous day.
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let today = SavedListNote.text(savedAt: Int64((now.timeIntervalSince1970 - 600) * 1000), computer: "Mac", now: now, calendar: cal)
        XCTAssertTrue(today.hasPrefix("Saved list from "))
        XCTAssertTrue(today.hasSuffix("It updates when Mac answers."))
        let old = SavedListNote.text(savedAt: Int64((now.timeIntervalSince1970 - 3 * 86_400) * 1000), computer: "Mac", now: now, calendar: cal)
        XCTAssertGreaterThan(old.count, today.count, "an older list also names the day")
    }

    func testASavedChatShowsOnlyItsLastUpdate() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let text = SavedListNote.copy(savedAt: Int64((now.timeIntervalSince1970 - 600) * 1000), computer: "Mac", now: now,
                                      calendar: Calendar(identifier: .gregorian))
        XCTAssertTrue(text.hasPrefix("Updated last on "))
        XCTAssertFalse(text.contains("Mac"))
        XCTAssertFalse(text.contains("Saved copy"))
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

/// IO-28: the first tap of the mic shows the how-voice-works video and does not listen.
@MainActor
final class VoiceIntroTests: XCTestCase {
    private func prefs() throws -> (Prefs, () -> Void) {
        let suite = "dev.nekkolabs.nekkoagent.tests.voiceintro.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        return (Prefs(defaults: defaults), { defaults.removePersistentDomain(forName: suite) })
    }

    func testTheFirstMicTapShowsTheVideoInsteadOfListening() throws {
        let (prefs, cleanup) = try prefs()
        defer { cleanup() }
        let gate = VoiceIntroGate()
        let dictation = Dictation()
        XCTAssertFalse(prefs.voiceIntroSeen)
        XCTAssertTrue(gate.intercept(prefs), "the tap went to the video")
        XCTAssertTrue(gate.showing)
        XCTAssertFalse(dictation.recording, "nothing listens yet")
        XCTAssertFalse(prefs.voiceIntroSeen, "seen only once it is closed")
    }

    func testNotNowAndSwipingAwayMarkItSeenWithoutListening() throws {
        let (prefs, cleanup) = try prefs()
        defer { cleanup() }
        let gate = VoiceIntroGate()
        _ = gate.intercept(prefs)
        var listened = false
        gate.closed(prefs) { listened = true }
        XCTAssertTrue(prefs.voiceIntroSeen)
        XCTAssertFalse(listened)
        XCTAssertFalse(gate.intercept(prefs), "later taps listen")
        XCTAssertFalse(gate.showing)
    }

    func testTurnOnListensOnceAndIsRemembered() throws {
        let (prefs, cleanup) = try prefs()
        defer { cleanup() }
        let gate = VoiceIntroGate()
        _ = gate.intercept(prefs)
        gate.turnOn()
        var listened = 0
        gate.closed(prefs) { listened += 1 }
        XCTAssertEqual(listened, 1)
        XCTAssertTrue(prefs.voiceIntroSeen)
        gate.replay()
        gate.closed(prefs) { listened += 1 }
        XCTAssertEqual(listened, 1, "a replay from Settings never starts listening")
    }

    func testItStaysSeenAcrossLaunches() throws {
        let suite = "dev.nekkolabs.nekkoagent.tests.voiceintro.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        Prefs(defaults: defaults).voiceIntroSeen = true
        XCTAssertTrue(Prefs(defaults: defaults).voiceIntroSeen)
    }

    func testBothCutsAreBundledAndSmall() throws {
        for theme in ["light", "dark"] {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "voice-intro-\(theme)", withExtension: "mp4")
                                    ?? Bundle.main.url(forResource: "voice-intro-\(theme)", withExtension: "mp4"), "voice-intro-\(theme).mp4 is an app resource")
            let size = try XCTUnwrap(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
            XCTAssertLessThan(size, 3 * 1024 * 1024)
        }
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

@MainActor
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
        XCTAssertEqual(ChatStatusIcon(activity: nil, activeWatchCount: 1).label, "Watching")
        XCTAssertEqual(ChatStatusIcon(activity: nil, completed: true, activeWatchCount: 1).label, "Watching")
        XCTAssertEqual(ChatStatusIcon(activity: .running, completed: true, activeWatchCount: 1).label, "Working")
        XCTAssertEqual(ChatStatusIcon(activity: .needsYou, completed: true, activeWatchCount: 1).label, "Needs you")
        XCTAssertEqual(ChatStatusIcon(activity: nil, completed: true, waiting: true, activeWatchCount: 1).label, "Waiting to send")
    }
}

@MainActor
final class LiveCardViewTests: XCTestCase {
    static let chats = [
        LiveChat(id: "a", short: "Billing", state: .needsYou, step: "Needs your approval: Run npm test", reply: "Want me to run the tests?", closeWord: "Nice", finishedAt: nil, callId: "c1", severity: "low", startedAt: .now.addingTimeInterval(-75), title: "Billing page redesign"),
        LiveChat(id: "b", short: "Login", state: .working, step: "Fixing merge conflicts", reply: "Got it. Working on it now.", closeWord: "Cool", finishedAt: nil, callId: nil, severity: nil, startedAt: .now.addingTimeInterval(-754), title: "Fix the login redirect loop on Safari"),
        LiveChat(id: "c", short: "iOS LA", state: .watching, step: "Watching PR #1211…", reply: "PR is up. Watching CI.", closeWord: "Perfect", finishedAt: nil, callId: nil, severity: nil, title: "iOS Live Activity rows"),
        LiveChat(id: "d", short: "Docs", state: .done, step: "Done 12 min ago", reply: "Docs page added.", closeWord: "Looks good", finishedAt: .now, callId: nil, severity: nil, title: "Docs for the relay"),
        LiveChat(id: "e", short: "Relay", state: .failed, step: "Stopped with an error", reply: "The build broke.", closeWord: "Got it", finishedAt: .now, callId: nil, severity: nil, title: "Relay reconnect backoff"),
    ]

    /// Twelve chats: two needing you, then a crowd the count line has to sum up.
    static let crowd: [LiveChat] = chats + (0..<6).map { (i: Int) -> LiveChat in
        LiveChat(id: "x\(i)", short: "Task \(i)", state: i < 3 ? .working : .done, step: "Running the tests", reply: "",
                 closeWord: "Cool", finishedAt: i < 3 ? nil : .now, callId: nil, severity: nil,
                 startedAt: i < 3 ? .now.addingTimeInterval(-60) : nil, title: "A long running task number \(i) with a long title")
    } + [LiveChat(id: "q", short: "Pricing", state: .needsYou, step: "Asks: monthly or yearly first?", reply: "", closeWord: "Nice",
                  finishedAt: nil, callId: nil, severity: nil, startedAt: .now.addingTimeInterval(-30), title: "Pricing page copy")]

    static func card(_ level: LiveLevel, focus: String? = nil, listening: Bool = false, sent: String? = nil, chats: [LiveChat] = chats) -> LiveCardState {
        var card = buildCard(chats: chats, previous: nil, pinnedFocus: focus, level: level, now: .now)!
        if listening { card.listening = true; card.heard = "Go ahead and auto merge the PR" }
        if let sent { card.heard = "Sent: \(sent)" }
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
        ("sent", .detailed, card(.detailed, focus: "b", sent: "Go ahead and auto merge the PR")),
        ("done-focused", .detailed, card(.detailed, focus: "d")),
        ("crowd-minimal", .minimal, card(.minimal, chats: crowd)),
        ("crowd", .standard, card(.standard, chats: crowd)),
        ("crowd-detailed", .detailed, card(.detailed, chats: crowd)),
        ("one-chat", .standard, card(.standard, chats: [chats[1]])),
        ("processing", .detailed, LiveCardState(chats: [], focusId: nil, more: 0, listening: true, heard: "Processing…", counts: [:])),
        ("empty-voice", .minimal, LiveCardState(chats: [], focusId: nil, more: 0, listening: true, heard: "", counts: [:])),
        ("voice-result", .standard, LiveCardState(chats: [], focusId: nil, more: 0, listening: false,
                                                 heard: "Nothing sent yet. To confirm, say confirm send to, then the same exact chat name, saying, and message. Or say cancel. Open app to review.", counts: [:])),
        ("legacy-partial", .standard, LiveCardState(chats: chats, focusId: "a", more: 12, listening: false, heard: "")),
        ("large-counts", .detailed, LiveCardState(chats: [], focusId: nil, more: 9999, listening: false, heard: "",
                                                counts: ["working": 9999, "needsYou": 1234, "done": 5678, "watching": 999, "failed": 42])),
    ]

    func framed(_ state: LiveCardState, _ level: LiveLevel) -> some View {
        LiveCardView(state: state, level: level, interactive: false)
            .padding(14)
            .frame(width: 360)
            .background(LiveCardView.wash)
            .background(LiveCardView.background)
    }

    func png(_ state: LiveCardState, _ level: LiveLevel) throws -> Data {
        try XCTUnwrap(ImageRenderer(content: framed(state, level)).uiImage?.pngData())
    }

    func testFitsTheLockScreenAtEveryLevel() throws {
        for (name, level, state) in Self.cases {
            let renderer = ImageRenderer(content: framed(state, level))
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertLessThanOrEqual(image.size.height, 160, "\(name) is \(image.size.height) pt tall")
            // Kept in the result bundle, which CI exports as the PR's screenshots.
            let shot = XCTAttachment(image: image)
            shot.name = "live-card-\(name)"
            shot.lifetime = .keepAlways
            add(shot)
        }
    }

    /// Compare pixels with deliberately different private text. Every enabled
    /// level is a count dashboard, even when its payload still carries details.
    func testEveryLevelShowsNoChatText() throws {
        var real = Self.card(.detailed)
        // A ticking elapsed time could differ between the two renders.
        for i in real.chats.indices { real.chats[i].startedAt = nil }
        var other = real
        for i in other.chats.indices {
            other.chats[i].short = "Zebra"
            other.chats[i].title = "Zebra crossing at noon"
            other.chats[i].step = "Something else entirely"
            other.chats[i].reply = "A different reply"
        }
        for level in [LiveLevel.minimal, .standard, .detailed] {
            XCTAssertEqual(try png(real, level), try png(other, level), "\(level) must hide chat text")
        }
    }

    func testDashboardCountsEveryChatIncludingClippedDetails() {
        for level in [LiveLevel.minimal, .standard, .detailed] {
            let card = Self.card(level, chats: Self.crowd)
            XCTAssertLessThan(card.chats.count, Self.crowd.count)
            for status in [LiveChatState.working, .needsYou, .done, .watching, .failed] {
                XCTAssertEqual(LiveCardView.count(status, in: card), Self.crowd.filter { $0.state == status }.count)
            }
        }
    }

    func testDashboardLegacyCountsIncludeAllCachedChatsAndClampInvalidTotals() {
        var card = LiveCardState(chats: Self.chats, focusId: "a", more: 4, listening: false, heard: "")
        for status in [LiveChatState.working, .needsYou, .done, .watching, .failed] {
            XCTAssertEqual(LiveCardView.count(status, in: card), 1)
        }
        card.counts = ["working": 12, "failed": -1]
        XCTAssertEqual(LiveCardView.count(.working, in: card), 12)
        XCTAssertEqual(LiveCardView.count(.needsYou, in: card), 0)
        XCTAssertEqual(LiveCardView.count(.failed, in: card), 0)
    }

    /// Protocol fallback remains generic even though the dashboard draws counts.
    func testMinimalNeedsYouLineIsGeneric() {
        XCTAssertEqual(LiveChatState.needsYou.phaseLine, "Needs you")
    }

    /// The two that need you are the first chips (sorted to the top from the
    /// end of the list); the rest, and the chats past the eight the card
    /// carries, are one "+N".
    func testTheCrowdShowsWhatNeedsYouFirst() {
        let card = Self.card(.standard, chats: Self.crowd)
        let all = cardChips(card)
        XCTAssertEqual(all.chips.prefix(2).map(\.id), ["a", "q"])
        XCTAssertEqual(all.chips.count, 5)
        XCTAssertEqual(all.more, 7)
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
        var isLive = true
        let id = UUID().uuidString
        var onPushToken: ((String) -> Void)?
        init(_ attributes: NekkoCardAttributes, _ state: LiveCardState) { self.attributes = attributes; self.state = state }
        func update(_ state: LiveCardState) { self.state = state; updates += 1 }
        func end() { ended = true }
    }

    var started: [FakeCard] = []
    var level = LiveLevel.standard
    var summaries: [SessionSummary] = []
    var activity: [String: NekkoProtocol.Activity] = [:]
    /// False: the computer's list hasn't loaded (`source()` is nil).
    var loaded = true

    func make() -> RunActivities {
        // The cards "iOS" has up: every one started here (or put up by a test) that has not ended.
        let up = CardsUp(ids: { [unowned self] in started.filter { !$0.ended && $0.isLive }.map(\.id) },
                         end: { [unowned self] id in started.first { $0.id == id }?.ended = true },
                         take: { [unowned self] id in started.first { $0.id == id } })
        let r = RunActivities(request: { [unowned self] attributes, state in
            let card = FakeCard(attributes, state)
            started.append(card)
            return card
        }, adoptLeftover: false, cardsUp: up)
        r.level = { [unowned self] in level }
        r.source = { [unowned self] in loaded ? .init(summaries: summaries, activity: activity, computerId: "pc", computerName: "Mac") : nil }
        return r
    }

    func chat(_ id: String, _ title: String, reply: String = "Got it. Working on it now.") -> SessionSummary {
        SessionSummary.from(["id": .string(id), "title": .string(title), "lastReplyText": .string(reply)])!
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

    /// The card's ActivityKit push token goes to the relay (Part 4) until the card is gone.
    func testTheCardsPushTokenGoesToTheRelayUntilItEnds() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        let r = make()
        var tokens: [String?] = []
        r.onCardToken = { tokens.append($0) }
        r.refresh()
        let card = try XCTUnwrap(started.first)
        card.onPushToken?("ab12")
        XCTAssertEqual(tokens, ["ab12"])
        card.isLive = false
        r.refresh(urgent: true)
        XCTAssertEqual(tokens, ["ab12", nil], "a swiped card's token is dead")
        r.refresh(urgent: true)
        XCTAssertEqual(tokens, ["ab12", nil], "said once")
    }

    /// A card the relay started (push-to-start) becomes the one card; a second is ended.
    func testACardTheRelayStartedIsAdopted() throws {
        let r = make()
        var tokens: [String?] = []
        r.onCardToken = { tokens.append($0) }
        let state = LiveCardState(chats: [LiveChat(id: "a", short: "Fix", state: .working, step: "Run tests", reply: "", closeWord: "Cool",
                                                    finishedAt: nil, callId: nil, severity: nil)], focusId: "a", more: 0, listening: false, heard: "")
        let attributes = NekkoCardAttributes(computerId: "pc", computerName: "Mac", level: .standard)
        let pushed = FakeCard(attributes, state)
        r.adopt(pushed)
        XCTAssertTrue(r.card === pushed)
        pushed.onPushToken?("cd34")
        XCTAssertEqual(tokens, ["cd34"])
        r.adopt(pushed)
        XCTAssertFalse(pushed.ended, "the same card again is no second card")
        let extra = FakeCard(attributes, state)
        r.adopt(extra)
        XCTAssertTrue(extra.ended, "one card: a second is ended")
        XCTAssertTrue(r.card === pushed)
    }

    /// One card (#1912): a second card iOS has up that the app never heard of (a
    /// push-to-start while it was suspended, an earlier launch's) ends on the next refresh.
    func testARefreshEndsEveryOtherCardThatIsUp() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        let r = make()
        r.refresh()
        let mine = try XCTUnwrap(started.first)
        let stray = FakeCard(mine.attributes, mine.state)
        started.append(stray)
        r.refresh()
        XCTAssertTrue(stray.ended)
        XCTAssertFalse(mine.ended)
        XCTAssertTrue(r.card === mine)
    }

    /// With no card of its own the app carries on with the one that is up
    /// (the last listed) instead of starting another, and ends the rest.
    func testWithNoCardOfItsOwnTheAppCarriesOnWithTheOneUp() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        let r = make()
        let attributes = NekkoCardAttributes(computerId: "pc", computerName: "Mac", level: .standard)
        let state = LiveCardState(chats: [], focusId: nil, more: 0, listening: false, heard: "")
        let old = FakeCard(attributes, state), pushed = FakeCard(attributes, state)
        started = [old, pushed]
        r.refresh()
        XCTAssertTrue(old.ended)
        XCTAssertTrue(r.card === pushed)
        XCTAssertFalse(pushed.ended)
        XCTAssertEqual(started.count, 2, "no new card")
        XCTAssertEqual(pushed.state.chats.map(\.id), ["a"], "brought up to date")
    }

    /// A card another computer started (it was active before) is not this one's: it ends and one for the active computer starts.
    func testACardForAnotherComputerIsReplaced() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        let r = make()
        let theirs = FakeCard(NekkoCardAttributes(computerId: "other", computerName: "Laptop", level: .standard),
                              LiveCardState(chats: [], focusId: nil, more: 0, listening: false, heard: ""))
        started = [theirs]
        r.refresh()
        XCTAssertTrue(theirs.ended)
        XCTAssertEqual(started.count, 2)
        XCTAssertEqual(r.card?.attributes.computerId, "pc")
        XCTAssertEqual(started.filter { !$0.ended }.count, 1)
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

    /// Reconnecting empties `activity` and the list load restores only needs-you:
    /// a run the events saw keeps its chat as working for a while.
    func testAReconnectKeepsARecentRunningChat() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        let r = make()
        r.onEvent(.text(sessionId: "a", delta: "Hi"))
        r.refresh()
        let card = try XCTUnwrap(started.first)
        activity = [:]
        r.refresh(urgent: true)
        XCTAssertFalse(card.ended, "the run is still going as far as the phone knows")
        XCTAssertEqual(card.state.chats.map(\.state), [.working])
        XCTAssertEqual(card.state.chats.first?.step, "Writing…")
        r.refresh(now: Date().addingTimeInterval(31 * 60))
        XCTAssertTrue(card.ended, "no event for 30 minutes: the chat drops")
    }

    func testNoneStartsNoCardAndEndsARunningOne() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        level = .none
        let r = make()
        r.refresh()
        XCTAssertTrue(started.isEmpty)
        level = .standard
        r.refresh()
        let card = try XCTUnwrap(started.first)
        level = .none
        r.refresh()
        XCTAssertTrue(card.ended)
        XCTAssertEqual(started.count, 1)
    }

    /// A tap on the card can launch the app before the list loads.
    func testBeforeTheListLoadsTheCardKeepsItsOwnChats() throws {
        summaries = [chat("a", "Billing fix"), chat("b", "Login page")]
        activity = ["a": .running, "b": .running]
        let r = make()
        r.refresh()
        let card = try XCTUnwrap(started.first)
        loaded = false
        summaries = []
        activity = [:]
        r.refresh(urgent: true)
        r.focus("b")
        XCTAssertFalse(card.ended)
        XCTAssertEqual(card.state.chats.map(\.id), ["a", "b"])
        XCTAssertEqual(card.state.focusId, "b")
        XCTAssertEqual(started.count, 1)
    }

    func testCountOnlyChangesAreNotThrottled() throws {
        summaries = (0..<9).map { chat("\($0)", "Task \($0)") }
        activity = Dictionary(uniqueKeysWithValues: (0..<8).map { ("\($0)", NekkoProtocol.Activity.running) })
        activity["8"] = .failed
        let r = make()
        r.refresh()
        defer { r.endAll() }
        let card = try XCTUnwrap(started.first)
        let before = card.state
        activity["8"] = nil
        summaries[8] = SessionSummary.from(["id": .string("8"), "title": .string("Task 8"), "activeWatchCount": .int(1)])!
        r.refresh()
        XCTAssertEqual(card.state.chats, before.chats, "only the hidden ninth chat changed")
        XCTAssertEqual(card.state.more, before.more)
        XCTAssertEqual(card.state.counts?["watching"], 1)
        XCTAssertNil(card.state.counts?["failed"])
        XCTAssertEqual(card.updates, 1, "dashboard count changes are visible immediately")
    }

    func testUnloadedRefreshPreservesFullCountsAndLegacyUnknownCounts() throws {
        loaded = false
        for counts: [String: Int]? in [["working": 21, "watching": 4], nil] {
            let r = make()
            let cached = LiveCardState(chats: [LiveCardViewTests.chats[1]], focusId: "b", more: 24,
                                       listening: false, heard: "", counts: counts)
            let card = FakeCard(.init(computerId: "pc", computerName: "Mac", level: level), cached)
            r.adopt(card)
            r.refresh(urgent: true)
            r.focus("b")
            XCTAssertEqual(card.state.counts, counts, "clipped details cannot replace authoritative or unknown totals")
            XCTAssertEqual(card.state.more, 24)
            XCTAssertFalse(card.ended)
            r.endAll()
        }
    }

    func testUnloadedDismissSubtractsOnlyTheKnownChat() throws {
        loaded = false
        let r = make()
        let cached = LiveCardState(chats: [LiveCardViewTests.chats[3]], focusId: "d", more: 12,
                                   listening: false, heard: "", counts: ["done": 5, "working": 8])
        let card = FakeCard(.init(computerId: "pc", computerName: "Mac", level: level), cached)
        r.adopt(card)
        defer { r.endAll() }
        r.dismiss("d")
        XCTAssertFalse(card.ended, "hidden chats still own the dashboard")
        XCTAssertTrue(card.state.chats.isEmpty)
        XCTAssertEqual(card.state.counts, ["done": 4, "working": 8])
        XCTAssertEqual(card.state.more, 12)
    }

    func testActiveVoiceSurvivesLastChatExpiryUntilProcessingFinishes() throws {
        summaries = [chat("a", "Billing fix")]
        let r = make()
        r.onEvent(.done(sessionId: "a", messageId: nil))
        r.refresh()
        let card = try XCTUnwrap(started.first)
        let expired = Date().addingTimeInterval(LiveCardRules.finishedTail + 5)
        r.talk(listening: true, heard: "")
        r.refresh(now: expired, urgent: true)
        XCTAssertTrue(r.card === card)
        XCTAssertFalse(card.ended)
        XCTAssertTrue(card.state.chats.isEmpty)
        XCTAssertEqual(card.state.counts, [:])
        r.talk(listening: true, heard: "Processing…", now: expired)
        r.refresh(now: expired, urgent: true)
        XCTAssertTrue(card.state.listening, "the active flag spans dispatch, not just capture")
        XCTAssertEqual(card.state.heard, "Processing…")
        r.talk(listening: false, heard: "Finished.", now: expired)
        XCTAssertTrue(card.ended, "voice no longer owns an otherwise empty card")
        XCTAssertNil(r.card)
    }

    func testVoiceRunnerKeepsCardActiveDuringDispatch() async throws {
        summaries = [chat("a", "Billing fix")]
        let r = make()
        r.onEvent(.done(sessionId: "a", messageId: nil))
        r.refresh()
        defer { r.endAll() }
        let card = try XCTUnwrap(started.first)
        let expired = Date().addingTimeInterval(LiveCardRules.finishedTail + 5)
        let runner = NekkoVoiceRunner()
        runner.capture = { "status" }
        runner.show = { active, reply in r.talk(listening: active, heard: reply, now: expired) }
        var routed = false
        runner.route = { _ in
            routed = true
            XCTAssertTrue(card.state.listening, "the actual runner must keep voice active while dispatching")
            XCTAssertEqual(card.state.heard, "Processing…")
            r.refresh(now: expired, urgent: true)
            XCTAssertTrue(r.card === card)
            XCTAssertFalse(card.ended)
            return "Status checked."
        }
        await runner.talk()
        XCTAssertTrue(routed)
        XCTAssertFalse(runner.busy)
        XCTAssertTrue(card.ended, "dispatch completion releases the otherwise empty card")
    }

    func testExpiredCachedChatDuringVoiceDoesNotScheduleARefreshLoop() async throws {
        loaded = false
        let r = make()
        var calls = 0
        r.source = { calls += 1; return nil }
        var chat = LiveCardViewTests.chats[3]
        chat.finishedAt = Date().addingTimeInterval(-LiveCardRules.finishedTail - 5)
        let cached = LiveCardState(chats: [chat], focusId: chat.id, more: 0,
                                   listening: true, heard: "Processing…", counts: ["done": 1])
        let card = FakeCard(.init(computerId: "pc", computerName: "Mac", level: level), cached)
        r.adopt(card)
        defer { r.endAll() }
        r.refresh(urgent: true)
        XCTAssertFalse(card.ended)
        XCTAssertTrue(card.state.chats.isEmpty)
        XCTAssertEqual(card.state.counts?["done"], 0)
        XCTAssertEqual(card.state.heard, "Processing…")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(calls, 1, "an elapsed expiry must not wake itself repeatedly")
        r.talk(listening: false, heard: "Finished.")
        XCTAssertTrue(card.ended)
    }

    func testADismissedChatComesBackWhenItRunsAgain() throws {
        summaries = [chat("a", "Billing fix")]
        let r = make()
        r.onEvent(.done(sessionId: "a", messageId: nil))
        r.refresh()
        r.dismiss("a")
        XCTAssertTrue(try XCTUnwrap(started.first).ended)
        r.onEvent(.text(sessionId: "a", delta: "Again"))
        activity = ["a": .running]
        r.refresh()
        XCTAssertEqual(started.count, 2)
        XCTAssertEqual(started.last?.state.chats.map(\.state), [.working])
    }

    /// The user swiped the card away (or iOS ended it at 8 hours): a step tick
    /// leaves it gone, an approval brings a new one.
    func testASwipedCardComesBackOnlyForAnApproval() throws {
        summaries = [chat("a", "Billing fix"), chat("b", "Login page")]
        activity = ["a": .running, "b": .running]
        let r = make()
        r.onEvent(.toolCall(sessionId: "a", call: ToolCall(id: "1", name: "bash")))
        r.refresh(urgent: true)
        let card = try XCTUnwrap(started.first)
        card.isLive = false
        r.onEvent(.toolCall(sessionId: "a", call: ToolCall(id: "2", name: "read")))
        r.refresh(urgent: true)
        XCTAssertNil(r.card, "a card that is no longer live is dropped")
        XCTAssertEqual(started.count, 1, "a step tick does not undo a swipe")
        XCTAssertEqual(card.updates, 0)
        r.onEvent(.approvalRequired(sessionId: "b", approval: Approval(call: ToolCall(id: "3", name: "bash"), reason: "", severity: .low)))
        activity["b"] = .needsYou
        r.refresh()
        XCTAssertEqual(started.count, 2, "an approval starts a new card")
        XCTAssertEqual(started.last?.state.focusId, "b")
    }

    func testASwipedCardComesBackForANewChat() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        let r = make()
        r.refresh()
        try XCTUnwrap(started.first).isLive = false
        r.refresh(urgent: true)
        XCTAssertEqual(started.count, 1)
        summaries.append(chat("b", "Login page"))
        activity["b"] = .running
        r.refresh()
        XCTAssertEqual(started.count, 2, "a chat that was not on the swiped card starts a new one")
        XCTAssertEqual(started.last?.state.chats.map(\.id), ["a", "b"])
    }

    /// The card's mic: listening shows at once, then "Sent: ..." until that chat's reply line changes.
    func testTheMicShowsListeningThenWhatWasSentUntilTheReply() throws {
        summaries = [chat("a", "Billing fix", reply: "First.")]
        activity = ["a": .running]
        level = .detailed
        let r = make()
        r.refresh()
        let card = try XCTUnwrap(started.first)
        r.talk(listening: true, heard: "")
        XCTAssertTrue(card.state.listening)
        XCTAssertEqual(card.updates, 1, "not throttled: the tap must show")
        r.talk(listening: false, heard: "Sent: Fix it.", sentTo: "a")
        XCTAssertFalse(card.state.listening)
        XCTAssertEqual(card.state.heard, "Sent: Fix it.")
        r.refresh(now: Date().addingTimeInterval(3))
        XCTAssertEqual(card.state.heard, "Sent: Fix it.", "a rebuild keeps it")
        summaries = [chat("a", "Billing fix", reply: "On it.")]
        r.refresh(now: Date().addingTimeInterval(6))
        XCTAssertEqual(card.state.heard, "", "the reply line takes its place")
        XCTAssertEqual(card.state.chats.first?.reply, "On it.")
    }

    func testWhatWasSentLeavesWhenAnotherChatTakesTheCard() throws {
        summaries = [chat("a", "Billing fix"), chat("b", "Login page")]
        activity = ["a": .running, "b": .running]
        level = .detailed
        let r = make()
        r.refresh()
        let card = try XCTUnwrap(started.first)
        r.talk(listening: false, heard: "Sent: Fix it.", sentTo: "a")
        r.focus("b")
        XCTAssertEqual(card.state.focusId, "b")
        XCTAssertEqual(card.state.heard, "", "it said what went to a, not b")
    }

    /// "Not sent: ..." has no reply to wait for: it leaves a minute after it was said.
    func testNotSentLeavesAfterAMinute() throws {
        summaries = [chat("a", "Billing fix")]
        activity = ["a": .running]
        level = .detailed
        let r = make()
        let start = Date()
        r.refresh(now: start)
        let card = try XCTUnwrap(started.first)
        r.talk(listening: false, heard: "Not sent: Model gone.", now: start)
        r.refresh(now: start.addingTimeInterval(30), urgent: true)
        XCTAssertEqual(card.state.heard, "Not sent: Model gone.")
        r.refresh(now: start.addingTimeInterval(61), urgent: true)
        XCTAssertEqual(card.state.heard, "")
    }

    /// Pushed cards carry listening false and heard "": while the mic listens the app puts its own back.
    func testAPushWhileListeningKeepsTheMic() {
        var local = LiveCardState(chats: [], focusId: nil, more: 0, listening: true, heard: "")
        var pushed = local
        pushed.listening = false
        pushed.more = 3
        let kept = SystemCard.keepingVoice(pushed: pushed, local: local)
        XCTAssertEqual(kept?.listening, true)
        XCTAssertEqual(kept?.more, 3, "the rest is the push")
        XCTAssertNil(SystemCard.keepingVoice(pushed: local, local: local), "nothing to put back")
        local.listening = false
        local.heard = "Sent: Fix it."
        XCTAssertNil(SystemCard.keepingVoice(pushed: pushed, local: local), "after the send a push may replace it")
    }

    func testOrdinaryPushedContentReplacesCachedCardWithoutEcho() {
        let old = LiveCardState(chats: [], focusId: nil, more: 6, listening: false, heard: "Sent: Fix it.")
        let chat = LiveChat(id: "a", short: "Fix", state: .done, step: "Finished", reply: "", closeWord: "Cool",
                            finishedAt: Date(), callId: nil, severity: nil)
        let pushed = LiveCardState(chats: [chat], focusId: "a", more: 0, listening: false, heard: "")
        var content = CardContent(state: old)
        XCTAssertNil(content.receive(pushed), "ordinary pushes never write back to ActivityKit")
        XCTAssertEqual(content.state, pushed, "a later card action must use the pushed count, focus and status")
        XCTAssertNil(content.receive(pushed), "duplicate content is not echoed")
        let ended = LiveCardState(chats: [], focusId: nil, more: 0, listening: false, heard: "")
        XCTAssertNil(content.receive(ended))
        XCTAssertEqual(content.state, ended, "an empty pushed card cannot retain old chats")
    }

    /// A card the phone built from every computer's chats outranks one computer's push while the app runs.
    func testFleetCardKeepsItsCountsOverOneComputersPush() {
        var local = LiveCardState(chats: [], focusId: nil, more: 0, listening: false, heard: "", counts: ["working": 3])
        local.scope = "All computers"
        var content = CardContent(state: local)
        var pushed = local
        pushed.scope = nil
        pushed.counts = ["working": 1]
        XCTAssertEqual(content.receive(pushed), local, "the phone's whole-list card is written back")
        XCTAssertEqual(content.state, local)
        XCTAssertNil(content.receive(local), "observing our own write is not echoed")
    }

    func testListeningTimerStartsWithTheMicAndClearsAfter() throws {
        summaries = [chat("a", "Billing fix")]
        let r = make()
        r.onEvent(.text(sessionId: "a", delta: "Hi"))
        r.refresh()
        defer { r.endAll() }
        let card = try XCTUnwrap(started.first)
        let opened = Date()
        r.talk(listening: true, heard: LiveCardVoice.listening, now: opened)
        XCTAssertEqual(card.state.listeningSince, opened)
        r.talk(listening: true, heard: LiveCardVoice.hearing, now: opened.addingTimeInterval(2))
        XCTAssertEqual(card.state.listeningSince, opened, "one timer across the listening phases")
        r.refresh(now: opened.addingTimeInterval(3), urgent: true)
        XCTAssertEqual(card.state.listeningSince, opened, "a rebuild keeps it")
        r.talk(listening: false, heard: "Cancelled. Nothing sent.", now: opened.addingTimeInterval(4))
        XCTAssertNil(card.state.listeningSince)
    }

    func testCountOnlyPushReplacesTotalsWithoutEcho() {
        let old = LiveCardState(chats: [], focusId: nil, more: 20, listening: false, heard: "", counts: ["working": 20])
        var content = CardContent(state: old)
        var pushed = old
        pushed.counts = ["working": 11, "done": 9]
        XCTAssertNil(content.receive(pushed))
        XCTAssertEqual(content.state.counts, pushed.counts)
        XCTAssertEqual(content.state.more, 20)
        XCTAssertNil(content.receive(pushed))
    }

    func testCardActionBeforeChatsLoadUsesPushedChats() throws {
        loaded = false
        let r = make()
        let attributes = NekkoCardAttributes(computerId: "pc", computerName: "Mac", level: .standard)
        let working = LiveChat(id: "a", short: "Fix", state: .working, step: "Writing…", reply: "", closeWord: "Cool",
                               finishedAt: nil, callId: nil, severity: nil)
        let old = LiveCardState(chats: [working], focusId: "a", more: 6, listening: false, heard: "")
        let card = FakeCard(attributes, old)
        r.adopt(card)
        var pushed = old
        pushed.more = 0
        pushed.chats[0].state = .done
        pushed.chats[0].step = "Finished"
        pushed.chats[0].finishedAt = Date()
        var content = CardContent(state: old)
        _ = content.receive(pushed)
        card.state = content.state
        r.focus("a")
        XCTAssertEqual(card.state.chats.first?.state, .done, "focusing must not restore the old rocket")
        XCTAssertEqual(card.state.chats.first?.step, "Finished")
        r.dismiss("a")
        XCTAssertTrue(card.ended, "closing the last pushed chat ends the card before the list loads")
    }

    func testPushedContentCachesVoiceCorrectionWithoutAnEchoLoop() {
        let local = LiveCardState(chats: [], focusId: nil, more: 6, listening: true, heard: "Processing…", counts: ["working": 6])
        var pushed = local
        pushed.more = 0
        pushed.counts = ["done": 12, "needsYou": 2]
        pushed.listening = false
        pushed.heard = ""
        var content = CardContent(state: local)
        let correction = content.receive(pushed)
        XCTAssertEqual(correction?.more, 0)
        XCTAssertEqual(correction?.counts, pushed.counts)
        XCTAssertEqual(content.state.counts, pushed.counts, "new totals win while local processing survives")
        XCTAssertEqual(content.state.more, 0)
        XCTAssertEqual(content.state.heard, "Processing…")
        XCTAssertTrue(content.state.listening)
        XCTAssertNil(content.receive(content.state), "observing our correction must not write it again")
        content.state.listening = false
        XCTAssertNil(content.receive(pushed))
        XCTAssertEqual(content.state, pushed, "after listening stops the push is authoritative")
    }

    /// A throttled update is sent once the 2 s are up, not dropped.
    func testAThrottledUpdateArrivesLater() async throws {
        summaries = [chat("a", "Billing fix", reply: "First.")]
        activity = ["a": .running]
        level = .detailed
        let r = make()
        r.refresh()
        let card = try XCTUnwrap(started.first)
        summaries = [chat("a", "Billing fix", reply: "Second.")]
        r.refresh()
        r.refresh()
        XCTAssertEqual(card.updates, 0, "throttled")
        try await Task.sleep(nanoseconds: 2_600_000_000)
        XCTAssertEqual(card.updates, 1, "one trailing update")
        XCTAssertEqual(card.state.chats.first?.reply, "Second.")
    }
}

/// Always-on dictation (IO-28): the segments' words, and the Nekko commands in them.
@MainActor
final class VoiceTests: XCTestCase {
    /// A composer's draft and what voice did with it.
    final class Box {
        var text = ""
        var sent: [String] = []
        var toasts: [String] = []
        var merged: [String] = []
        var opened: [String] = []
    }

    private func runner(_ box: Box, prs: String = "[]", chats: String = "[]") -> VoiceRunner {
        let r = VoiceRunner()
        let prList = PullRequest.list(try? JSONValue.parse(Data(prs.utf8)))
        let summaries = ((try? JSONValue.parse(Data(chats.utf8)))?.array ?? []).compactMap(SessionSummary.from)
        r.host = VoiceRunner.Host(
            text: Binding(get: { box.text }, set: { box.text = $0 }),
            send: { box.sent.append(box.text); box.text = ""; return true },
            toast: { box.toasts.append($0) },
            tap: {},
            chats: { summaries },
            open: { box.opened.append($0) },
            ship: { VoiceRunner.ShipFacts(prs: prList, running: false, question: nil) },
            merge: { box.merged.append($0.url); return nil })
        return r
    }

    /// Each segment's transcript, in the order the segments were cut.
    private func hear(_ transcripts: [String]) async -> Dictation {
        var left = transcripts
        let d = Dictation()
        d.transcribe = { _ in left.removeFirst() }
        for _ in transcripts { d.enqueue([Float](repeating: 0.1, count: 8_000)) }
        await d.drain()
        return d
    }

    func testSendItSendsWhatWasSaidBeforeIt() async {
        let box = Box()
        let d = await hear(["Fix it. Nekko, send it."])
        await runner(box).hear(d.heard)
        XCTAssertEqual(box.sent, ["Fix it."])
        XCTAssertEqual(box.text, "")
        XCTAssertEqual(box.toasts, ["Sent"])
    }

    func testEraseThatTakesBackOnlyTheLastSegment() async {
        let box = Box()
        let r = runner(box)
        await r.hear(await hear(["Fix the login bug.", "Add a test.", "[BLANK_AUDIO]"]).heard)
        XCTAssertEqual(box.text, "Fix the login bug. Add a test.")
        await r.hear([Dictation.Words(text: "Nekko erase that")])
        XCTAssertEqual(box.text, "Fix the login bug.")
        XCTAssertEqual(box.toasts, ["Erased"])
        // Nothing left to take back: no "Erased".
        await r.hear([Dictation.Words(text: "Nekko erase that")])
        XCTAssertEqual(box.text, "Fix the login bug.")
        XCTAssertEqual(box.toasts, ["Erased", "Nothing to erase"])
    }

    func testCommandsWithNothingToDoSaySo() async {
        let box = Box()
        let r = runner(box)
        await r.hear([Dictation.Words(text: "Nekko, send it."), Dictation.Words(text: "Nekko, yes."), Dictation.Words(text: "Nekko, the second one.")])
        XCTAssertEqual(box.sent, [])
        XCTAssertEqual(box.toasts, ["Nothing to send", "Nothing to confirm", "Nothing to confirm"])
        // A send the composer turns down (a blocked chat, photos still loading) says so too.
        r.host.send = { false }
        box.text = "Fix it."
        await r.hear([Dictation.Words(text: "Nekko, send it.")])
        XCTAssertEqual(box.toasts.last, "Not sent")
    }

    func testAHoldsReleaseKeepsAConfirmForTheNextHold() async {
        let box = Box()
        let r = runner(box, prs: #"[{"url":"https://github.com/acme/app/pull/12","number":12,"state":"open"}]"#)
        await r.hear([Dictation.Words(text: "Nekko, ship it.")])
        // Hold to talk: the confirm is answered in the next hold, so letting go keeps it.
        await r.stopped(afterHold: true, after: {})
        XCTAssertNotNil(r.pending)
        await r.hear([Dictation.Words(text: "Nekko, yes.")])
        XCTAssertEqual(box.merged, ["https://github.com/acme/app/pull/12"])
        // Tap mode: stopping clears it, once the words already heard are applied.
        await r.hear([Dictation.Words(text: "Nekko, ship it.")])
        XCTAssertNotNil(r.pending)
        await r.stopped(afterHold: false, after: {})
        XCTAssertNil(r.pending)
    }

    func testAnOldStopDoesNotClearANewSessionsConfirm() async {
        let box = Box()
        let r = runner(box, prs: #"[{"url":"https://github.com/acme/app/pull/12","number":12,"state":"open"}]"#)
        await r.hear([Dictation.Words(text: "Nekko, ship it.")])
        var drained = false
        // Stopped, and the last words are still being transcribed...
        let stop = Task { await r.stopped(afterHold: false, after: { while !drained { try? await Task.sleep(for: .milliseconds(10)) } }) }
        await Task.yield()
        // ...when listening starts again and a new confirm comes up.
        r.started()
        await r.hear([Dictation.Words(text: "Nekko, ship it.")])
        let fresh = r.pending?.id
        drained = true
        await stop.value
        XCTAssertNotNil(fresh)
        XCTAssertEqual(r.pending?.id, fresh, "the old stop's clear is skipped")
    }

    func testAPermissionPromptDoesNotCancelStartingButLeavingDoes() {
        // The microphone and speech prompts make the scene inactive while listening starts.
        XCTAssertFalse(Dictation.leavesScreen(.inactive, starting: true))
        XCTAssertTrue(Dictation.leavesScreen(.inactive, starting: false))
        XCTAssertTrue(Dictation.leavesScreen(.background, starting: true))
        XCTAssertFalse(Dictation.leavesScreen(.active, starting: false))
        let d = Dictation()
        d.sink = { _ in }
        d.startingWithoutPrompts()
        XCTAssertTrue(d.mayOpenMicrophone)
        d.abort()
        XCTAssertFalse(d.mayOpenMicrophone, "a lock during the waits opens nothing")
        d.startingWithoutPrompts()
        d.sink = nil
        XCTAssertFalse(d.mayOpenMicrophone, "the chat closed during the waits")
    }

    func testShipItLeavesDraftPrsAlone() {
        let prs = PullRequest.list(try? JSONValue.parse(Data(#"[{"url":"https://github.com/acme/app/pull/3","number":3,"state":"open","isDraft":true},{"url":"https://github.com/acme/app/pull/4","number":4,"state":"open"}]"#.utf8)))
        XCTAssertEqual(VoiceRunner.shipAction(.init(prs: prs, running: false, question: nil)), .merge(prs[1]))
        XCTAssertEqual(VoiceRunner.shipAction(.init(prs: [prs[0]], running: false, question: nil)), .nothing)
    }

    func testAWakeWordAloneAddressesTheNextSegment() async {
        let box = Box()
        let r = runner(box)
        box.text = "Fix it."
        await r.hear([Dictation.Words(text: "Nekko."), Dictation.Words(text: "Send it.")])
        XCTAssertEqual(box.sent, ["Fix it."])
    }

    func testShipItMergesTheOpenPrOnlyAfterYes() async {
        let box = Box()
        let r = runner(box, prs: #"[{"url":"https://github.com/acme/app/pull/12","number":12,"state":"open"}]"#)
        await r.hear([Dictation.Words(text: "Nekko, ship it.")])
        XCTAssertEqual(r.pending?.message, "Merge acme/app#12? Say 'Nekko, yes' or tap Confirm.")
        XCTAssertEqual(box.merged, [])
        await r.hear([Dictation.Words(text: "Nekko, yes.")])
        XCTAssertEqual(box.merged, ["https://github.com/acme/app/pull/12"])
        XCTAssertNil(r.pending)
    }

    func testShipItWithNoPrSaysGoAhead() async {
        let box = Box()
        await runner(box).hear([Dictation.Words(text: "Nekko ship it")])
        XCTAssertEqual(box.sent, ["Go ahead and build it."])
    }

    func testOpenAChatByWhatItIsAbout() async {
        let box = Box()
        let chats = #"[{"id":"a","title":"Login bug"},{"id":"b","title":"Dark mode","firstUserText":"make the login page dark"},{"id":"c","title":"Billing"}]"#
        let r = runner(box, chats: chats)
        await r.hear([Dictation.Words(text: "Nekko open billing")])
        XCTAssertEqual(box.opened, ["c"])
        await r.hear([Dictation.Words(text: "Nekko open the one about login")])
        XCTAssertEqual(r.pending?.options.map(\.label), ["Login bug", "Dark mode"])
        await r.hear([Dictation.Words(text: "Nekko, the second one")])
        XCTAssertEqual(box.opened, ["c", "b"])
        // No chat by that name: the words are typed, never dropped.
        await r.hear([Dictation.Words(text: "Nekko open the pod bay doors")])
        XCTAssertEqual(box.text, "Nekko open the pod bay doors")
    }

    func testDesktopPlacesWorkOnlyOnTheComputer() async {
        let box = Box()
        await runner(box).hear([Dictation.Words(text: "Nekko switch to desktop 2"), Dictation.Words(text: "Nekko open models")])
        XCTAssertEqual(box.toasts, ["That one works on the computer", "That one works on the computer"])
        XCTAssertEqual(box.text, "")
    }

    func testAFailedTranscriptionIsSaidOnce() async {
        let d = Dictation()
        d.transcribe = { _ in throw RelayError("Engine busy") }
        d.enqueue([0.1])
        d.enqueue([0.1])
        await d.drain()
        XCTAssertEqual(d.error, "Couldn’t turn speech into text: Engine busy")
        XCTAssertEqual(d.heard, [])
    }

    final class StubRecognizer: SpeechRecognizing {
        let supportsOnDeviceRecognition: Bool
        let isAvailable = true
        let locale = Locale(identifier: "en-US")
        var requests: [SFSpeechURLRecognitionRequest] = []
        var failure: Error?
        init(onDevice: Bool) { supportsOnDeviceRecognition = onDevice }
        func text(for request: SFSpeechURLRecognitionRequest) async throws -> String? {
            requests.append(request)
            if let failure { throw failure }
            return "hello"
        }
    }

    func testPhoneSpeechNeverLeavesThePhone() async throws {
        let wav = Dictation.wav([Float](repeating: 0, count: 1_600))
        let off = StubRecognizer(onDevice: false)
        do {
            _ = try await Dictation.transcribeOnPhone(wav, with: off)
            XCTFail("a phone without on-device speech must refuse")
        } catch let e as DictationError {
            XCTAssertEqual(e, .noOnDevice(language: "English (United States)"))
            XCTAssertEqual(e.localizedDescription, "This phone can't turn speech into text on the phone for English (United States), so dictation is off. Turn on Nekko Voice on your computer to dictate.")
        }
        XCTAssertTrue(off.requests.isEmpty, "nothing is sent to a server")

        let on = StubRecognizer(onDevice: true)
        let text = try await Dictation.transcribeOnPhone(wav, with: on)
        XCTAssertEqual(text, "hello")
        XCTAssertEqual(on.requests.map(\.requiresOnDeviceRecognition), [true])
    }

    // MARK: The Live Activity mic (Part 5)

    private func speech(_ seconds: Double) -> [Float] { [Float](repeating: 0.5, count: Int(seconds * Dictation.sampleRate)) }
    private func quiet(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * Dictation.sampleRate)) }

    func testCaptureOnceReturnsTheFirstSegmentsWords() async throws {
        let d = Dictation()
        var segments = 0
        d.transcribe = { _ in segments += 1; return "Fix the login bug." }
        let text = try await d.captureOnce {
            d.listenWithoutMicrophone()
            d.consume(self.speech(1) + self.quiet(1.5))
        }
        XCTAssertEqual(text, "Fix the login bug.")
        XCTAssertFalse(d.recording, "the first pause ends it")
        XCTAssertEqual(segments, 1)
        XCTAssertNil(d.sink, "the card's capture leaves nothing bound")
    }

    func testCaptureOnceRefusesWithoutOnDeviceSpeech() async {
        let d = Dictation()
        let off = StubRecognizer(onDevice: false)
        d.transcribe = { try await Dictation.transcribeOnPhone($0, with: off) }
        do {
            _ = try await d.captureOnce {
                d.listenWithoutMicrophone()
                d.consume(self.speech(1) + self.quiet(1.5))
            }
            XCTFail("a phone without on-device speech must refuse")
        } catch let e as DictationError {
            XCTAssertEqual(e, .noOnDevice(language: "English (United States)"))
        } catch {
            XCTFail("\(error)")
        }
        XCTAssertTrue(off.requests.isEmpty, "nothing is sent to a server")
    }

    func testCaptureOnceSaysAFailedTranscription() async {
        let d = Dictation()
        d.transcribe = { _ in throw RelayError("Engine busy") }
        do {
            _ = try await d.captureOnce {
                d.listenWithoutMicrophone()
                d.consume(self.speech(1) + self.quiet(1.5))
            }
            XCTFail("the card says why nothing was sent")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Couldn’t turn speech into text: Engine busy")
        }
    }

    /// Cancel or Send to on the card while the microphone is still starting: it never opens.
    func testCancelOrSendWhileStartingKeepsTheMicrophoneShut() {
        for stop in [{ (d: Dictation) in d.discard() }, { (d: Dictation) in d.stopListening() }] {
            let d = Dictation()
            d.sink = { _ in }
            d.startingWithoutPrompts()
            stop(d)
            XCTAssertFalse(d.mayOpenMicrophone)
        }
    }

    func testCaptureOnceStopsAfter30SecondsOfSilence() async throws {
        let d = Dictation()
        d.transcribe = { _ in XCTFail("silence is not transcribed"); return nil }
        let text = try await d.captureOnce {
            d.listenWithoutMicrophone()
            d.consume(self.quiet(Dictation.maxSeconds + 1))
        }
        XCTAssertEqual(text, "")
        XCTAssertFalse(d.recording)
    }

    func testTheCardsMicSendsOneMessageToThatChat() async {
        var sent: [String] = []
        var shown: [String] = []
        let t = TalkRunner()
        t.capture = { "  Fix the login bug. " }
        t.send = { sent.append("\($0): \($1)") }
        t.show = { listening, heard, to in shown.append("\(listening) \(heard) \(to ?? "-")") }
        await t.talk("b")
        XCTAssertEqual(sent, ["b: Fix the login bug."])
        XCTAssertEqual(shown, ["true  -", "false Sent: Fix the login bug. b"])
    }

    func testTheSecondTapSendsNowAndCancelSendsNothing() async {
        var sent: [String] = []
        var finished = 0
        var discarded = 0
        let t = TalkRunner()
        var release: CheckedContinuation<Void, Never>?
        t.capture = {
            await withCheckedContinuation { release = $0 }
            return "Fix it."
        }
        t.finish = { finished += 1; release?.resume() }
        t.discard = { discarded += 1; release?.resume() }
        t.send = { sent.append($1) }
        t.show = { _, _, _ in }
        let first = Task { await t.talk("b") }
        while release == nil { await Task.yield() }
        // "Send to": the same intent again, while listening.
        await t.talk("b")
        await first.value
        XCTAssertEqual(finished, 1)
        XCTAssertEqual(sent, ["Fix it."], "one message, not two")

        release = nil
        let again = Task { await t.talk("b") }
        while release == nil { await Task.yield() }
        t.cancel()
        await again.value
        XCTAssertEqual(discarded, 1)
        XCTAssertEqual(sent, ["Fix it."], "Cancel sends nothing, even words already heard")
    }

    func testTheCardsMicSaysWhyNothingWasSent() async {
        var sent = 0
        var heard: [String] = []
        let t = TalkRunner()
        t.send = { _, _ in sent += 1 }
        t.show = { _, h, _ in heard.append(h) }
        t.capture = { "" }
        await t.talk("b")
        t.capture = { throw DictationError.noOnDevice(language: "English") }
        await t.talk("b")
        XCTAssertEqual(sent, 0)
        XCTAssertEqual(heard, ["", "", "", "Not sent: " + DictationError.noOnDevice(language: "English").localizedDescription])
        var to: [String?] = []
        t.show = { _, _, chat in to.append(chat) }
        await t.talk("b")
        XCTAssertEqual(to, [nil, nil], "a refusal waits for no reply: it leaves on its own")
    }

    func testSegmentsAreWrittenAs16kHzMonoPcm() {
        let wav = Dictation.wav([0, 1, -1])
        XCTAssertEqual(wav.count, 44 + 6)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(wav.subdata(in: 24..<28).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }, 16_000)
        XCTAssertEqual((0..<3).map { i in wav.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 44 + 2 * i, as: Int16.self) } }, [0, 32_767, -32_767])
    }

    func testOnlyNoSpeechReadsAsNoWordsOnThePhone() async throws {
        XCTAssertTrue(Dictation.isNoSpeech(NSError(domain: "kAFAssistantErrorDomain", code: 1110)))
        XCTAssertFalse(Dictation.isNoSpeech(NSError(domain: "kAFAssistantErrorDomain", code: 1101)))
        let broken = StubRecognizer(onDevice: true)
        broken.failure = NSError(domain: "kAFAssistantErrorDomain", code: 1101, userInfo: [NSLocalizedDescriptionKey: "Recognizer died"])
        do {
            _ = try await Dictation.transcribeOnPhone(Dictation.wav([0]), with: broken)
            XCTFail("a real recognizer failure is said, not read as silence")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Recognizer died")
        }
    }

    func testThePhoneRefusesBeforeListeningStarts() {
        let unavailable = "Speech recognition isn’t available. Allow it in Settings → Nekko Agent."
        XCTAssertEqual(Dictation.phoneRefusal(authorized: false, recognizer: StubRecognizer(onDevice: true)), unavailable)
        XCTAssertEqual(Dictation.phoneRefusal(authorized: true, recognizer: nil), unavailable)
        let off = StubRecognizer(onDevice: false)
        XCTAssertEqual(Dictation.phoneRefusal(authorized: true, recognizer: off), DictationError.noOnDevice(language: "English (United States)").localizedDescription)
        XCTAssertTrue(off.requests.isEmpty)
        XCTAssertNil(Dictation.phoneRefusal(authorized: true, recognizer: StubRecognizer(onDevice: true)))
    }

    func testComputerDeadlineIncludesColdStartInferenceAndTransport() async throws {
        // The daemon loops 150 times, each with a 500 ms health timeout and 200 ms sleep.
        let startup = 150.0 * (0.5 + 0.2)
        XCTAssertGreaterThan(Dictation.computerTranscriptionTimeout, startup + 120 + 10)
        XCTAssertEqual(Dictation.computerTranscriptionTimeout, 300)
        let wav = Dictation.wav([0, 0.5])
        let responses: [JSONValue] = [.string("computer"), ["text": "computer"]]
        for response in responses {
            var calls = 0
            let text = try await Dictation.transcribeOnComputer(wav) { channel, args, timeout in
                calls += 1
                XCTAssertEqual(channel, Channels.voiceTranscribe)
                XCTAssertEqual(args, [wavArg(wav)])
                XCTAssertEqual(timeout, Dictation.computerTranscriptionTimeout)
                return response
            }
            XCTAssertEqual(text, "computer")
            XCTAssertEqual(calls, 1)
        }
    }

    func testAComputerTimeoutIsNotRetriedOrSentToThePhoneWhileOnline() async throws {
        var calls = 0
        var phoned = 0
        let phone: (Data) async throws -> String? = { _ in phoned += 1; return "phone" }
        let down: (Data) async throws -> String = { _ in calls += 1; throw RelayError("Timed out") }
        do {
            _ = try await Dictation.transcribe(Data(), computer: down, online: { true }, phone: phone)
            XCTFail("the computer's failure is said")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Timed out")
        }
        XCTAssertEqual(calls, 1, "a timed-out request may still be running on the computer")
        XCTAssertEqual(phoned, 0)
        let offline = try await Dictation.transcribe(Data(), computer: down, online: { false }, phone: phone)
        XCTAssertEqual(offline, "phone")
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(phoned, 1)
        let noWhisper = try await Dictation.transcribe(Data(), computer: nil, online: { true }, phone: phone)
        XCTAssertEqual(noWhisper, "phone")
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(phoned, 2)
    }

    func testComputerCancellationNeverRetriesOrFallsBackEvenWhenOffline() async {
        for online in [true, false] {
            var calls = 0
            var phoned = 0
            do {
                _ = try await Dictation.transcribe(Data(), computer: { _ in
                    calls += 1
                    throw CancellationError()
                }, online: { online }, phone: { _ in phoned += 1; return "phone" })
                XCTFail("cancellation must propagate")
            } catch is CancellationError {
            } catch {
                XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(calls, 1)
            XCTAssertEqual(phoned, 0)
        }
    }

    func testAlreadyCancelledTranscriptionNeverStartsEitherEngine() async {
        for hasComputer in [true, false] {
            var calls = 0
            var phoned = 0
            let task = Task { () throws -> String? in
                withUnsafeCurrentTask { $0?.cancel() }
                let computer: ((Data) async throws -> String)? = hasComputer ? { _ in
                    calls += 1
                    return "computer"
                } : nil
                return try await Dictation.transcribe(Data(), computer: computer, online: { false }, phone: { _ in
                    phoned += 1
                    return "phone"
                })
            }
            do {
                _ = try await task.value
                XCTFail("cancellation must propagate before either engine starts")
            } catch is CancellationError {
            } catch {
                XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(calls, 0)
            XCTAssertEqual(phoned, 0)
        }
    }

    func testCancellationDuringComputerRequestRejectsLateSuccessAndFailure() async {
        for fails in [false, true] {
            var calls = 0
            var phoned = 0
            let task = Task { () throws -> String? in
                try await Dictation.transcribe(Data(), computer: { _ in
                    calls += 1
                    withUnsafeCurrentTask { $0?.cancel() }
                    if fails { throw RelayError("Connection lost") }
                    return "late computer words"
                }, online: { false }, phone: { _ in phoned += 1; return "phone" })
            }
            do {
                _ = try await task.value
                XCTFail("cancellation must win over a late result or transport error")
            } catch is CancellationError {
            } catch {
                XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(calls, 1)
            XCTAssertEqual(phoned, 0)
        }
    }

    func testCancellationDuringPhoneRequestRejectsLateSuccessAndFailure() async {
        for fails in [false, true] {
            var phoned = 0
            let task = Task { () throws -> String? in
                try await Dictation.transcribe(Data(), computer: nil, online: { false }, phone: { _ in
                    phoned += 1
                    withUnsafeCurrentTask { $0?.cancel() }
                    if fails { throw RelayError("Recognizer stopped") }
                    return "late phone words"
                })
            }
            do {
                _ = try await task.value
                XCTFail("phone cancellation must propagate")
            } catch is CancellationError {
            } catch {
                XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(phoned, 1)
        }
    }

    func testSuccessfulComputerTranscriptionUsesOneRequest() async throws {
        var calls = 0
        let text = try await Dictation.transcribe(Data(), computer: { _ in
            calls += 1
            return "computer"
        }, online: { true }, phone: { _ in
            XCTFail("no fallback after success")
            return "phone"
        })
        XCTAssertEqual(text, "computer")
        XCTAssertEqual(calls, 1)
    }

    func testWordsAfterTheComposerIsGoneGoToTheChatsDraft() async {
        let d = Dictation()
        var sunk: [String] = []
        var parked: [String] = []
        d.park = { parked.append($0) }
        d.sink = { sunk.append($0.text) }
        d.transcribe = { _ in "Fix the login bug." }
        d.enqueue([0.1])
        await d.drain()
        // The chat closed while the next segment was still being transcribed.
        d.sink = nil
        d.transcribe = { _ in "Nekko, send it." }
        d.enqueue([0.1])
        await d.drain()
        XCTAssertEqual(sunk, ["Fix the login bug."])
        XCTAssertEqual(parked, ["Nekko, send it."], "typed as words, the command not run")
    }

    func testWordsAfterACommandThatLeftTheChatGoToItsDraft() async {
        let box = Box()
        let r = runner(box, chats: #"[{"id":"c","title":"Billing"}]"#)
        var parked: [String] = []
        r.host.park = { parked.append($0) }
        await r.hear([Dictation.Words(text: "Nekko, open billing. Fix it.")])
        XCTAssertEqual(box.opened, ["c"])
        XCTAssertEqual(parked, ["Fix it."])
        XCTAssertEqual(box.text, "", "not typed into the composer that is leaving")
        // The next segment goes to the composer as usual (it is still on screen in a split view).
        await r.hear([Dictation.Words(text: "Add a test.")])
        XCTAssertEqual(box.text, "Add a test.")
    }

    func testParkedWordsFollowTheSavedDraft() {
        let drafts = DraftStore(files: nil, debounce: 0)
        Composer.park("Fix it.", in: "c", drafts)
        XCTAssertEqual(drafts.draft("c").text, "Fix it.")
        drafts.set("c", Draft(text: "Fix it.", images: ["data:image/jpeg;base64,AA=="]))
        Composer.park("Add a test.", in: "c", drafts)
        XCTAssertEqual(drafts.draft("c").text, "Fix it. Add a test.")
        XCTAssertEqual(drafts.draft("c").images, ["data:image/jpeg;base64,AA=="], "the draft's photos stay")
    }

    func testAParkedRunnerRunsNoCommand() async {
        let box = Box()
        let r = runner(box)
        var parked: [String] = []
        r.park = { parked.append($0) }
        await r.hear([Dictation.Words(text: "Fix it. Nekko, send it.")])
        XCTAssertEqual(box.sent, [])
        XCTAssertEqual(box.text, "")
        XCTAssertEqual(parked, ["Fix it. Nekko, send it."])
    }

    func testACallOrAMediaResetStopsListeningAndKeepsTheWords() async {
        let began = Notification(name: AVAudioSession.interruptionNotification, object: nil,
                                 userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        let ended = Notification(name: AVAudioSession.interruptionNotification, object: nil,
                                 userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
        let reset = Notification(name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        for stop in [began, reset] {
            let d = Dictation()
            d.transcribe = { _ in "kept" }
            d.listenWithoutMicrophone()
            d.consume([Float](repeating: 0.5, count: 8_000))
            NotificationCenter.default.post(ended)
            await Task.yield()
            XCTAssertTrue(d.recording, "an interruption ending is not a reason to stop")
            NotificationCenter.default.post(stop)
            for _ in 0..<50 where d.recording { try? await Task.sleep(for: .milliseconds(20)) }
            XCTAssertFalse(d.recording, "\(stop.name.rawValue) stops listening")
            XCTAssertEqual(d.notice, "Stopped listening", "an unasked-for stop is said")
            await d.drain()
            XCTAssertEqual(d.heard.map(\.text), ["kept"])
        }
    }

    func testListeningKeepsTheScreenOnAndPutsItBack() {
        for before in [false, true] {
            UIApplication.shared.isIdleTimerDisabled = before
            let d = Dictation()
            d.listenWithoutMicrophone()
            XCTAssertTrue(UIApplication.shared.isIdleTimerDisabled, "Auto-Lock would end listening")
            d.stopListening()
            XCTAssertEqual(UIApplication.shared.isIdleTimerDisabled, before)
            XCTAssertNil(d.notice, "a tap on stop is not announced")
        }
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func testListeningInOnePaneStopsTheOther() {
        let left = Dictation(), right = Dictation()
        left.listenWithoutMicrophone()
        right.listenWithoutMicrophone()
        XCTAssertFalse(left.recording, "one microphone for the app")
        XCTAssertTrue(right.recording)
        XCTAssertEqual(left.notice, "Stopped listening")
        right.stopListening()
        XCTAssertFalse(UIApplication.shared.isIdleTimerDisabled)
    }

    func testLeavingTheScreenWithWordsInFlightAsksForTimeToFinishThem() async {
        let d = Dictation()
        var release = false
        d.transcribe = { _ in
            while !release { try await Task.sleep(for: .milliseconds(10)) }
            return "kept"
        }
        d.listenWithoutMicrophone()
        // The last segment was cut at a pause and is on its way; nothing is left un-cut.
        d.enqueue([0.1])
        d.abort()
        XCTAssertTrue(d.finishingInBackground, "the in-flight words need background time too")
        release = true
        await d.drain()
        for _ in 0..<50 where d.finishingInBackground { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertFalse(d.finishingInBackground, "ended once the queue drains")
        XCTAssertEqual(d.heard.map(\.text), ["kept"])
    }
}

@MainActor
final class LastFolderPrefsTests: XCTestCase {
    func testFolderSurvivesRelaunchAndStaysSeparatePerComputer() throws {
        let suite = "dev.nekkolabs.nekkoagent.tests.folders.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: defaults)
        XCTAssertTrue(prefs.lastFolder.isEmpty)
        prefs.lastFolder["mac"] = "work"
        prefs.lastFolder["studio"] = "personal"
        XCTAssertEqual(prefs.newChatFolder(computer: "mac", draft: Draft()), "work")
        XCTAssertEqual(prefs.newChatFolder(computer: "studio", draft: Draft()), "personal")
        XCTAssertNil(prefs.newChatFolder(computer: nil, draft: Draft()))
        XCTAssertEqual(prefs.newChatFolder(computer: "mac", draft: Draft(workspaceId: "draft-folder")), "draft-folder")
        XCTAssertNil(prefs.newChatFolder(computer: "mac", draft: Draft(text: "No folder draft")))
        let relaunched = Prefs(defaults: defaults)
        XCTAssertEqual(relaunched.lastFolder["mac"], "work")
        XCTAssertEqual(relaunched.lastFolder["studio"], "personal")
        relaunched.lastFolder["mac"] = nil
        let again = Prefs(defaults: defaults)
        XCTAssertNil(again.lastFolder["mac"], "No folder is remembered too")
        XCTAssertEqual(again.lastFolder["studio"], "personal")
    }
}

final class WidgetLanguageTests: XCTestCase {
    /// The Live Activity runs in the extension, which resolves its language on its own: without
    /// English declared there, an English-first phone got its second language.
    func testTheExtensionFollowsAnEnglishFirstPhone() throws {
        let url = try XCTUnwrap(Bundle.main.builtInPlugInsURL?.appendingPathComponent("NekkoWidgets.appex"))
        let widgets = try XCTUnwrap(Bundle(url: url))
        XCTAssertEqual(Bundle.preferredLocalizations(from: widgets.localizations, forPreferences: ["en-US", "ja-US"]).first, "en")
        XCTAssertEqual(Bundle.preferredLocalizations(from: widgets.localizations, forPreferences: ["en-US"]).first, "en")
        XCTAssertEqual(Bundle.preferredLocalizations(from: widgets.localizations, forPreferences: ["ja-JP", "en-US"]).first, "ja")
    }
}
