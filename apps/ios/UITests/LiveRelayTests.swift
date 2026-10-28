import XCTest

/// The app in the simulator against a real relay + headless agent + fake model
/// (apps/ios/scripts/itest-stack.sh): pair from a deep link, start a chat,
/// watch the reply stream in, get an approval card for a guarded tool and deny
/// it. Each step is a screenshot attachment (the PR's visual evidence).
///
/// Opt-in: the CI passes `TEST_RUNNER_NEKKO_ITEST_LINK`; without it this skips.
final class LiveRelayTests: XCTestCase {
    /// How long a step the computer drives may take to reach the phone: a
    /// reply from the fake model, an approval or question card, a tool step,
    /// a changed file, a queued prompt's turn. On a loaded runner each of these
    /// has arrived after a 20 to 45 s wait ran out, a different one each run,
    /// with the rest of the journey green (#831); the edited queued prompt,
    /// which follows a whole slow reply, gets twice this.
    private let computerWait: TimeInterval = 120
    /// How long the phone itself may take to react (a card or sheet closing, a
    /// line appearing) while a run is in flight: on a loaded runner one query of
    /// the tree has taken 3 to 12 s there, so a 10 or 15 s wait saw two reads (#1019).
    private let busyWait: TimeInterval = 60

    func testPairStreamAndApproveFromThePhone() throws {
        guard let raw = ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"], let link = URL(string: raw) else {
            throw XCTSkip("set NEKKO_ITEST_LINK (apps/ios/scripts/itest-stack.sh)")
        }
        let theme = ProcessInfo.processInfo.environment["NEKKO_ITEST_THEME"] ?? "light"
        let app = XCUIApplication()
        // Settings persist across runs on one simulator: start each from the defaults it checks.
        // Live Activities stay off until the step that checks one (see there).
        let defaults = ["-splash", "NO", "-appLock", "NO", "-notifyFinished", "YES", "-dictationHold", "NO", "-theme", theme == "dark" ? "dark" : "light"]
        app.launchArguments = defaults + ["-onboarded", "NO", "-liveActivityLevel", "none", "-uiTestReset", "YES"]
        app.launch()
        allowSystemAlerts()

        // The first run (IO-31): what the app does, then pairing, then notifications.
        let intro = app.buttons["firstRun.continue"]
        XCTAssertTrue(intro.waitForExistence(timeout: 10))
        intro.tap()
        // Pair through the paste field; testPairFromADeepLink covers the link path.
        // On a freshly made simulator the first tap after install can land while
        // the screen is still settling (the light pass, #831): tap Continue again
        // while the intro is still showing.
        let start = app.buttons["Pair with your computer"]
        var taps = 1
        while !start.waitForExistence(timeout: 5), taps < 4, intro.exists { intro.tap(); taps += 1 }
        XCTAssertTrue(start.exists, "pairing follows the intro")
        attach(app, "\(theme)-0-welcome")
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link.absoluteString)
        attach(app, "\(theme)-1-pair")
        app.buttons["Pair"].firstMatch.tap()
        // Step 3 follows the first pairing; only then does iOS ask.
        let allowNotifications = app.buttons["firstRun.allowNotifications"]
        XCTAssertTrue(allowNotifications.waitForExistence(timeout: 20), "the notification step follows pairing")
        attach(app, "\(theme)-1b-notifications-step")
        allowNotifications.tap()
        tapSystemAlertIfShown()
        XCTAssertTrue(waitGone(allowNotifications, 10))

        let newChat = app.navigationBars.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 20))
        XCTAssertTrue(waitOnline(app, 20), "connected to the computer")
        // Same protocol on both sides (IO-32): no banner.
        XCTAssertFalse(app.descendants(matching: .any)["protocol-banner"].exists)
        attach(app, "\(theme)-2-chats")
        auditAccessibility(app, "\(theme)-chats")

        newChat.tap()
        let prompt = app.input("What should your computer do?")
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Say hello")
        attach(app, "\(theme)-3-new-chat")
        auditAccessibility(app, "\(theme)-new-chat")
        app.buttons["Start"].tap()

        XCTAssertTrue(app.staticTexts["Hello from your computer."].waitForExistence(timeout: computerWait), "the reply streamed in")
        attach(app, "\(theme)-4-reply")

        // + sits inside the message box and offers another agent or a terminal, as on the desktop.
        // A Menu's label has no hit point for XCTest (the tap failed scrolling it into view,
        // run 40562362238), so tap its centre, as the chats view menu.
        let plus = app.buttons["composer.add"]
        XCTAssertTrue(waitForFrame(plus, in: app, 10), "the + button never got a frame")
        let newAgent = app.buttons["New agent"]
        for _ in 0..<3 where !newAgent.exists {
            plus.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            _ = newAgent.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(newAgent.exists, "the + menu opens")
        XCTAssertTrue(app.buttons["Terminal"].exists, "the + menu offers a terminal")
        attach(app, "\(theme)-4b-plus-menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        XCTAssertTrue(waitGone(app.buttons["New agent"], busyWait), "the + menu closes")

        let message = app.input("chat.message")
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        message.tap()
        message.typeText("please approve a cleanup")
        app.buttons["Send"].tap()
        // The Live Activity starts in this stretch and the simulator slows down
        // with it: the card took 15 s in one pass and over 30 s in the next (#831).
        let card = app.staticTexts["Approve this tool?"]
        XCTAssertTrue(card.waitForExistence(timeout: computerWait), "the guarded tool asks the phone")
        attach(app, "\(theme)-5-approval")
        // Known, unresolved: with the card up, the audit reports the transcript's
        // "Run rm -rf …" step as clipped (approval) or low-contrast (question),
        // though the capture shows it whole and readable. Unchanged by four fixes
        // (two-line labels, scrolling after layout, a minimum-height transcript,
        // waiting for the keyboard to settle). Excluded only here; see the PR.
        auditAccessibility(app, "\(theme)-approval", ignoring: ["Run rm -rf ./nekko-itest-dist"])
        // Deny and Answer are tapped again if a busy app dropped the tap (run 40447057708).
        XCTAssertTrue(app.buttons["Deny"].tapUntil { !card.exists }, "the card closes after Deny")
        attach(app, "\(theme)-6-denied")

        // The agent asks; the phone answers.
        message.tap()
        message.typeText("ask me which platform")
        app.buttons["Send"].tap()
        let question = app.staticTexts["Which platform should I build first?"]
        XCTAssertTrue(question.waitForExistence(timeout: computerWait), "the question reaches the phone")
        attach(app, "\(theme)-6b-question")
        // Known, unresolved: with the card up, the audit reports the transcript's
        // "Run rm -rf …" step as clipped (approval) or low-contrast (question),
        // though the capture shows it whole and readable. Unchanged by four fixes
        // (two-line labels, scrolling after layout, a minimum-height transcript,
        // waiting for the keyboard to settle). Excluded only here; see the PR.
        auditAccessibility(app, "\(theme)-question", ignoring: ["Run rm -rf ./nekko-itest-dist"])
        // A busy app can drop the option's tap, and Answer stays disabled until one is picked.
        let ios = app.buttons["iOS"].firstMatch
        XCTAssertTrue(ios.tapUntil { ios.isSelected }, "the option is picked")
        XCTAssertTrue(app.buttons["Answer"].tapUntil { !question.exists }, "the question closes after Answer")
        XCTAssertTrue(app.staticTexts["Hello from your computer."].firstMatch.waitForExistence(timeout: computerWait))

        // The agent writes a file; the phone reads the change, read only (the
        // stack turns the computer's "Let phones see changes" on).
        message.tap()
        message.typeText("write a note")
        app.buttons["Send"].tap()
        let step = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "nekko-itest-note.txt")).firstMatch
        XCTAssertTrue(step.waitForExistence(timeout: computerWait), "the write step shows in the chat")
        sleep(2)
        app.buttons["More"].tap()
        app.buttons["Changes"].tap()
        let note = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "nekko-itest-note.txt", "new file, 2 added")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: computerWait), "the changed file reaches the phone")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Read only")).firstMatch.exists)
        XCTAssertFalse(app.buttons["Accept"].exists)
        attach(app, "\(theme)-6d-changes")
        auditAccessibility(app, "\(theme)-changes")
        // Ask about a change: the quote lands in the message box, unsent, and the sheet closes.
        let line = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Added line 2")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: busyWait), "the diff shows its lines")
        let ask = app.buttons["Ask about this change"].firstMatch
        XCTAssertTrue(contextMenuItem(ask, afterLongPressOn: line), "the line's menu offers to ask about it")
        XCTAssertTrue(ask.tapUntil { !note.exists }, "the changes sheet closes after Ask")
        XCTAssertTrue(message.waitForExistence(timeout: busyWait))
        XCTAssertTrue((message.value as? String ?? "").contains("+written by the agent"), "the quote is in the message box: \(message.value ?? "")")
        attach(app, "\(theme)-6e-asked")

        // A longer run, then Home: the Live Activity takes over in the Dynamic Island.
        // In a launch of its own with Live Activities on: on for the whole journey, every
        // run started one, and on a loaded runner the simulator then stopped answering
        // XCTest's queries for 30 s or more right after Send (the approval card, the
        // question, the slow reply; #1019). The request itself took under 0.7 s.
        app.terminate()
        app.launchArguments = defaults + ["-onboarded", "YES", "-liveActivityLevel", "standard"]
        app.launch()
        XCTAssertTrue(waitOnline(app, busyWait), "back online after the relaunch")
        let chatRow = app.descendants(matching: .any).matching(identifier: "chats.row").firstMatch
        XCTAssertTrue(chatRow.waitForExistence(timeout: busyWait))
        chatRow.tap()
        XCTAssertTrue(message.waitForExistence(timeout: busyWait))
        message.tap()
        message.typeText("a slow one please")
        app.buttons["Send"].tap()
        // A slow simulator can take 15 s just to deliver the tap; the reply itself starts within seconds.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "word2")).firstMatch.waitForExistence(timeout: computerWait),
                      "the slow reply never started streaming")
        XCUIDevice.shared.press(.home)
        sleep(3)
        // The whole screen, without querying SpringBoard: on a loaded simulator finding it timed out.
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(theme)-6c-live-activity"
        shot.lifetime = .keepAlways
        add(shot)
        app.activate()

        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Computers and settings")).firstMatch
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: busyWait))
        XCTAssertTrue(back.tapUntil { menu.exists }, "back to the chats")
        attach(app, "\(theme)-7-chats-after")

        // Settings → Connection: the route, Tailscale on this phone, and what happened.
        // A coordinate tap: right after going back, XCTest can't "scroll to" the nav bar button.
        // Mid-transition the button exists with no frame yet, and asking XCTest whether it is
        // hittable then fails the test outright; wait for a real frame instead.
        XCTAssertTrue(waitForFrame(menu, in: app, 10), "the computer menu never got a frame")
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Settings"].firstMatch.tapUntil { app.navigationBars["Settings"].exists }, "the menu opens Settings")
        let connection = app.buttons["Connection"].firstMatch
        XCTAssertTrue(reveal(connection, in: app), "Settings → Connection")
        connection.tap()
        // LabeledContent reads as one element: "Status" with the value "Online".
        let online = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "Online", "Online")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 10), "the status reads online")
        attach(app, "\(theme)-7b-connection")
        auditAccessibility(app, "\(theme)-connection")

        // The link carries a second route (IO-20): the screen names both, and
        // Check routes looks each one up, connects and says hello (IO-21).
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Other routes")).firstMatch.exists)
        let check = app.buttons["check-routes"].firstMatch
        for _ in 0..<3 where !(check.exists && check.isHittable) { app.swipeUp() }
        check.tap()
        let answered = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "answered")).firstMatch
        XCTAssertTrue(answered.waitForExistence(timeout: computerWait), "a relay hello came back")
        attach(app, "\(theme)-7c-checks")
        // The results push Share diagnostics below the fold; a List only builds what's on screen.
        let share = app.buttons["share-diagnostics"].firstMatch
        for _ in 0..<4 where !(share.exists && share.isHittable) { app.swipeUp() }
        XCTAssertTrue(share.exists, "Share diagnostics is offered")
        attach(app, "\(theme)-7d-share")
        // Settings → Notify me about (IO-30) and Dictation (IO-28).
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let finished = app.switches["settings.notify.finished"]
        XCTAssertTrue(reveal(finished, in: app), "Settings → Notify me about")
        settle()
        XCTAssertEqual(finished.value as? String, "1")
        // iOS 17's SwiftUI toggle is a row-wide switch holding the real one; tapping the row does nothing.
        let knob = finished.switches.firstMatch
        (knob.exists ? knob : finished).tap()
        XCTAssertTrue(waitValue(finished, "0", 5), "finished replies switched off")
        // Through the computer and the test stack's relay, which has no Apple push key:
        // the app shows it, and says so.
        let test = app.buttons["settings.notify.test"]
        XCTAssertTrue(reveal(test, in: app))
        settle()
        test.tap()
        let result = app.staticTexts["settings.notify.testResult"]
        XCTAssertTrue(result.waitForExistence(timeout: 20), "the test reports which path it took")
        XCTAssertTrue(result.label.contains("shown by the app"), result.label)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Test notification")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 10), "the test notification shows over the app")
        let bannerShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        bannerShot.name = "\(theme)-7e-test-notification"
        bannerShot.lifetime = .keepAlways
        add(bannerShot)
        sleep(6) // the banner goes up before the audit samples the screen
        auditAccessibility(app, "\(theme)-settings-notifications")
        let hold = app.buttons["Hold to talk"].firstMatch
        XCTAssertTrue(reveal(hold, in: app), "Settings → Dictation")
        settle()
        hold.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Hold the microphone while you speak")).firstMatch
            .waitForExistence(timeout: 5))
        attach(app, "\(theme)-7f-settings-dictation")
        auditAccessibility(app, "\(theme)-settings-dictation")

        // Shared from another app: relaunch with what the share extension leaves
        // in the App Group. New chat opens with the text; nothing is sent.
        app.terminate()
        let shared = "Summarise https://example.com/release-notes"
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", theme == "dark" ? "dark" : "light", "-uiTestShare", shared]
        app.launch()
        let prefilled = app.input("newChat.prompt")
        XCTAssertTrue(prefilled.waitForExistence(timeout: 15), "New chat opened for the share")
        XCTAssertEqual(prefilled.value as? String, shared)
        XCTAssertTrue(app.navigationBars["New chat"].exists)
        attach(app, "\(theme)-8-shared")
    }

    /// The computer's QR opens `nekko-agent-pair:` from the Camera app: iOS asks
    /// "Open in Nekko Agent?", the app shows the confirmation sheet, and pairing
    /// from it connects.
    /// Offline mode (IO-18): with the relay down, a prompt is written and sent
    /// "when online"; it waits in the transcript, and once the relay is back it
    /// is delivered exactly once and answered.
    func testSendWithTheRelayDownAndSeeItDelivered() throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["NEKKO_ITEST_LINK"], let link = URL(string: raw), let ctl = env["NEKKO_ITEST_RELAY_CTL"] else {
            throw XCTSkip("set NEKKO_ITEST_LINK and NEKKO_ITEST_RELAY_CTL (apps/ios/scripts/itest-stack.sh)")
        }
        let app = XCUIApplication()
        // Past the first run (IO-31), which the live journey walks; this test is about the outbox.
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-theme", "light", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()
        allowSystemAlerts()
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link.absoluteString)
        app.buttons["Pair"].firstMatch.tap()
        tapSystemAlertIfShown()
        XCTAssertTrue(waitOnline(app, 30), "connected to the computer")

        app.navigationBars.buttons["New chat"].tap()
        let prompt = app.input("What should your computer do?")
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Say hello")
        app.buttons["Start"].tap()
        XCTAssertTrue(app.staticTexts["Hello from your computer."].waitForExistence(timeout: computerWait), "the first reply streamed in")

        // The relay goes away: the composer stays usable and says the prompt will wait.
        relay(ctl, "stop")
        let later = app.buttons["chat.sendLater"]
        XCTAssertTrue(later.waitForExistence(timeout: computerWait), "the composer offers Send when online")
        let message = app.input("chat.message")
        message.tap()
        message.typeText("written while offline")
        XCTAssertTrue(app.descendants(matching: .any)["chat.offlineNote"].exists)
        later.tap()
        let waiting = app.staticTexts["Waiting to send"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 10), "the prompt waits in the transcript")
        attach(app, "offline-1-waiting")
        auditAccessibility(app, "offline-waiting")

        // Back: it goes on its own, once. (Not tapping Try now: the app often
        // reconnects and delivers first, and the row vanishes mid-tap.)
        XCTAssertTrue(app.buttons["Try now"].exists, "the waiting row offers Try now while offline")
        relay(ctl, "start")
        XCTAssertTrue(waitGone(waiting, 90), "the waiting prompt was delivered")
        // A user bubble reads as one element, "You: …".
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "You: written while offline"))
        XCTAssertTrue(sent.firstMatch.waitForExistence(timeout: computerWait))
        let replies = app.staticTexts.matching(NSPredicate(format: "label == %@", "Hello from your computer."))
        let answered = expectation(for: NSPredicate(format: "count == 2"), evaluatedWith: replies)
        wait(for: [answered], timeout: computerWait)
        sleep(2)
        XCTAssertEqual(sent.count, 1, "delivered exactly once")
        XCTAssertEqual(replies.count, 2, "answered once")
        attach(app, "offline-2-delivered")

        // Read offline and instant paint (OF-5, OF-6, on by default): the relay
        // goes away and the app starts cold. The list and the chat are on screen
        // from the phone's saved copies, marked as saved, before any answer.
        relay(ctl, "stop")
        app.terminate()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-theme", "light", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["chats.savedList"].waitForExistence(timeout: 10), "the saved list, at once")
        let row = app.descendants(matching: .any).matching(identifier: "chats.row").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.savedCopy"].waitForExistence(timeout: 5), "the saved copy, marked as one")
        XCTAssertTrue(app.staticTexts["Hello from your computer."].firstMatch.exists, "what the computer said, readable offline")
        attach(app, "offline-3-saved-copy")
    }

    /// IO-22 to IO-29 in the app: edit a queued prompt while a reply runs, fork
    /// from a prompt into a new chat, Continue on the chat list, the computer's
    /// automation run from the phone, and usage. Each screen is audited.
    func testQueueForkAutomationsAndUsageFromThePhone() throws {
        guard let raw = ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"], let link = URL(string: raw) else {
            throw XCTSkip("set NEKKO_ITEST_LINK (apps/ios/scripts/itest-stack.sh)")
        }
        let app = XCUIApplication()
        // Past the first run (IO-31): testPairStreamAndApproveFromThePhone walks it.
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-theme", "light", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()
        allowSystemAlerts()
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link.absoluteString)
        app.buttons["Pair"].firstMatch.tap()
        tapSystemAlertIfShown()
        XCTAssertTrue(waitOnline(app, 30), "connected to the computer")

        app.navigationBars.buttons["New chat"].tap()
        let prompt = app.input("What should your computer do?")
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Say hello")
        app.buttons["Start"].tap()
        XCTAssertTrue(app.staticTexts["Hello from your computer."].waitForExistence(timeout: computerWait), "the first reply streamed in")

        // IO-22: a slow reply runs; a follow-up waits in the queue and is edited before it runs.
        let message = app.input("chat.message")
        message.tap()
        // "long run" streams for 90 s on the fake model: time for a slow simulator to type and edit.
        message.typeText("a long run please")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "word1")).firstMatch.waitForExistence(timeout: computerWait))
        message.tap()
        message.typeText("next one")
        let queue = app.buttons["Queue"]
        XCTAssertTrue(queue.waitForExistence(timeout: 10), "mid-run, Send queues")
        queue.tap()
        let edit = app.buttons["chat.queue.edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 10), "the queued prompt shows with Edit")
        attach(app, "beyond-1-queued")
        edit.tap()
        let editor = app.input("queue.editor.text")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(", edited")
        attach(app, "beyond-2-queue-editor")
        app.buttons["queue.editor.save"].tap()
        let edited = app.staticTexts["next one, edited"]
        XCTAssertTrue(edited.waitForExistence(timeout: computerWait), "the edit reached the computer's queue")
        attach(app, "beyond-3-queue-edited")
        auditAccessibility(app, "beyond-queue")
        // The edited prompt runs after the slow reply, as edited.
        let ranEdited = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "You: next one, edited"))
        XCTAssertTrue(ranEdited.firstMatch.waitForExistence(timeout: 2 * computerWait), "the edited prompt ran")
        // Its reply streams on, and while it does the transcript keeps scrolling to the
        // end, which cancels a long press (no menu after two presses, run 40447057708).
        XCTAssertTrue(waitGone(app.buttons["Stop"].firstMatch, computerWait), "the edited prompt's reply finished")

        // IO-23: fork from the first prompt; the new chat has it in its message box.
        let first = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "You: Say hello")).firstMatch
        // The transcript only draws what is near the screen, and the message box (taller since
        // #1250) and keyboard leave it a strip: scroll back up to the first prompt. Drag near
        // the top, where the transcript is; the middle of the screen is the message box.
        // XCTest calls the bubble hittable while it is still under the navigation bar, where a
        // long press opens nothing, so scroll until it is below the bar.
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let barBottom = app.navigationBars.firstMatch.frame.maxY
        for _ in 0..<12 where !(first.exists && first.frame.minY > barBottom + 8) {
            top.press(forDuration: 0.05, thenDragTo: top.withOffset(CGVector(dx: 0, dy: 160)))
        }
        settle()
        XCTAssertTrue(first.waitForExistence(timeout: 10), "the first prompt is on screen")
        // The menu item carries the identifier `chat.fork` (#868); XCTest matches
        // an element's identifier, not its label, once one is set.
        let fork = app.buttons["chat.fork"].firstMatch
        XCTAssertTrue(contextMenuItem(fork, afterLongPressOn: first), "the prompt's menu offers a fork")
        attach(app, "beyond-4-fork-menu")
        fork.tap()
        let forkedBox = app.input("chat.message")
        let seeded = expectation(for: NSPredicate(format: "value == %@", "Say hello"), evaluatedWith: forkedBox)
        wait(for: [seeded], timeout: computerWait)
        attach(app, "beyond-5-forked")

        // The chat list, with its view menu (group, sort, show) in place of the old Continue card.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chats.row").firstMatch.waitForExistence(timeout: 15), "the chats")
        // A navigation-bar button: no hit point for XCTest, so tap its centre (as the computer menu).
        let viewMenu = app.buttons["chats.view"].firstMatch
        XCTAssertTrue(viewMenu.waitForExistence(timeout: 5), "the view menu")
        XCTAssertTrue(waitForFrame(viewMenu, in: app, 10), "the view menu never got a frame")
        viewMenu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Group by"].firstMatch.waitForExistence(timeout: 5) || app.staticTexts["Group by"].firstMatch.exists, "Group by")
        attach(app, "beyond-6-view-menu")
        // Close the menu.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        auditAccessibility(app, "beyond-chats")

        // IO-26: the computer's automation, run from the phone; its answer comes back.
        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Computers and settings")).firstMatch
        XCTAssertTrue(waitForFrame(menu, in: app, 10))
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Automations"].firstMatch.tapUntil { app.navigationBars["Automations"].exists }, "the menu opens Automations")
        let run = app.buttons["Run Say hello nightly now"]
        XCTAssertTrue(run.waitForExistence(timeout: 15), "the task is listed with Run now")
        attach(app, "beyond-7-automations")
        auditAccessibility(app, "beyond-automations")
        run.tap()
        let result = app.staticTexts["Hello from your computer."]
        XCTAssertTrue(result.waitForExistence(timeout: computerWait), "the run's answer shows as the last result")
        attach(app, "beyond-8-ran")

        // IO-29: usage, read only.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(waitForFrame(menu, in: app, 10))
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Usage and limits"].firstMatch.tapUntil { app.navigationBars["Usage and limits"].exists }, "the menu opens Usage and limits")
        XCTAssertTrue(app.navigationBars["Usage and limits"].waitForExistence(timeout: 10))
        sleep(2)
        attach(app, "beyond-9-usage")
        auditAccessibility(app, "beyond-usage")

        // IO-33 FA-5: the computer's logs, read only.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(waitForFrame(menu, in: app, 10))
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["computer.logs"].firstMatch.tapUntil { app.navigationBars["Logs"].exists }, "the menu opens Logs")
        XCTAssertTrue(app.navigationBars["Logs"].waitForExistence(timeout: 10))
        let log = app.buttons["logs.row"].firstMatch
        XCTAssertTrue(log.waitForExistence(timeout: computerWait), "the computer lists its logs")
        attach(app, "beyond-10-logs")
        log.tap()
        XCTAssertTrue(app.buttons["log.refresh"].waitForExistence(timeout: 10), "a log opens with Refresh")
        attach(app, "beyond-11-log")
    }

    /// Simple and Expert (2026-10-24): the composer's model and effort control
    /// and context gauge, the effort sheet, Expert's monitor panel and the whole
    /// monitor with the computer's real hardware.
    func testSimpleAndExpertModes() throws {
        guard let raw = ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"], let link = URL(string: raw) else {
            throw XCTSkip("set NEKKO_ITEST_LINK (apps/ios/scripts/itest-stack.sh)")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", "light", "-expertMode", "NO", "-uiTestReset", "YES"]
        app.launch()
        allowSystemAlerts()
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link.absoluteString)
        app.buttons["Pair"].firstMatch.tap()
        tapSystemAlertIfShown()
        XCTAssertTrue(waitOnline(app, 30), "connected to the computer")

        app.navigationBars.buttons["New chat"].tap()
        let prompt = app.input("What should your computer do?")
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Say hello")
        app.buttons["Start"].tap()
        XCTAssertTrue(app.staticTexts["Hello from your computer."].waitForExistence(timeout: 30), "the first reply streamed in")

        // Simple: the model and effort control and the context gauge, and no monitor.
        let modelEffort = app.buttons["chat.modelEffort"]
        XCTAssertTrue(modelEffort.waitForExistence(timeout: 10), "the composer has the model and effort control")
        XCTAssertTrue(app.buttons["chat.context"].exists, "the context gauge shows in Simple mode")
        XCTAssertFalse(app.buttons["chat.monitor"].exists, "Simple mode has no monitor")
        settle()
        attach(app, "modes-1-simple")
        auditAccessibility(app, "modes-simple")

        // The effort sheet: pick High, and the control says so.
        modelEffort.tap()
        let high = app.buttons["modelEffort.high"]
        XCTAssertTrue(high.waitForExistence(timeout: 10), "the sheet offers the model's effort levels")
        high.tap()
        XCTAssertTrue(app.staticTexts["High"].waitForExistence(timeout: 10), "the chat's effort is now High")
        attach(app, "modes-2-model-effort")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(modelEffort.waitForExistence(timeout: 5))

        // Expert: the monitor panel under the title, then the whole monitor.
        app.buttons["chat.mode"].tap()
        let expert = app.buttons["Expert"]
        XCTAssertTrue(expert.waitForExistence(timeout: 5))
        expert.tap()
        let panel = app.buttons["chat.monitor"]
        XCTAssertTrue(panel.waitForExistence(timeout: 15), "Expert shows the monitor panel")
        XCTAssertTrue(app.buttons["chat.context"].exists, "the context gauge stays in Expert mode")
        // A reading or two: the panel reads every 3 seconds.
        RunLoop.current.run(until: Date().addingTimeInterval(4))
        attach(app, "modes-3-expert")
        auditAccessibility(app, "modes-expert")
        panel.tap()
        XCTAssertTrue(app.navigationBars["Monitor"].waitForExistence(timeout: 10), "the whole monitor opens")
        // A list section header can read in capitals, so match its identifier or its words in any case.
        let models = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ OR label ==[c] %@", "monitor.models", "Loaded models")).firstMatch
        XCTAssertTrue(models.waitForExistence(timeout: 10), "the monitor lists the loaded models")
        settle()
        attach(app, "modes-4-monitor")
        app.buttons["Done"].firstMatch.tap()

        // Back to Simple: the panel goes.
        app.buttons["chat.mode"].tap()
        let simple = app.buttons["Simple"]
        XCTAssertTrue(simple.waitForExistence(timeout: 5))
        simple.tap()
        XCTAssertTrue(waitGone(panel, 10), "Simple mode hides the monitor")
    }

    func testPairFromADeepLink() throws {
        guard let raw = ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"], let link = URL(string: raw) else {
            throw XCTSkip("set NEKKO_ITEST_LINK (apps/ios/scripts/itest-stack.sh)")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["Pair with your computer"].waitForExistence(timeout: 10))

        XCUIDevice.shared.system.open(link)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }

        let sheet = app.navigationBars["Pair with a computer?"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the link opens the confirmation sheet")
        attach(app, "deeplink-1-confirm")
        // The sheet is still sliding up when its bar first exists; a tap then lands
        // where the button was and is lost. Tap once it has stopped moving.
        let pair = sheet.buttons["Pair"]
        XCTAssertTrue(waitForSteadyFrame(pair, in: app, 10), "the sheet's Pair button never settled")
        pair.tap()
        tapSystemAlertIfShown()

        let newChat = app.navigationBars.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 20))
        XCTAssertTrue(waitOnline(app, 20), "paired from the link and connected")
        attach(app, "deeplink-2-connected")
    }

    private func allowSystemAlerts() {
        addUIInterruptionMonitor(withDescription: "system alerts") { alert in
            for label in ["Allow", "OK", "Allow While Using App"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    /// Notification permission is asked right after pairing.
    private func tapSystemAlertIfShown() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
    }

    /// Scrolls a long form until `e` can be tapped: down first, then back up
    /// (a form loads its rows lazily, so an off-screen row may not exist yet).
    private func reveal(_ e: XCUIElement, in app: XCUIApplication) -> Bool {
        if e.waitForExistence(timeout: 3), e.isHittable { return true }
        for up in [true, false] {
            for _ in 0..<8 {
                if up { app.swipeUp() } else { app.swipeDown() }
                if e.exists, e.isHittable { return true }
            }
        }
        return false
    }

    /// A tap while a swipe is still decelerating only stops the scroll; let it finish.
    private func settle() { RunLoop.current.run(until: Date().addingTimeInterval(1.2)) }

    private func waitValue(_ e: XCUIElement, _ value: String, _ seconds: TimeInterval) -> Bool {
        let p = expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: e)
        return XCTWaiter.wait(for: [p], timeout: seconds) == .completed
    }

    /// Connected to the computer, as the computer menu says (New chat works offline too).
    private func waitOnline(_ app: XCUIApplication, _ seconds: TimeInterval) -> Bool {
        connectionMenu(app, "online").waitForExistence(timeout: seconds)
    }

    /// The computer pill reads "Computers and settings, <state>", where the state
    /// is the localized `stateName` ("Online", "Computer offline"), so match the
    /// end of the label without regard to case (#831).
    private func connectionMenu(_ app: XCUIApplication, _ state: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH[c] %@", "Computers and settings", state)).firstMatch
    }

    /// `GET <NEKKO_ITEST_RELAY_CTL>/stop` or `/start` (apps/ios/scripts/relay-ctl.mjs): kill or restart the relay.
    private func relay(_ ctl: String, _ action: String) {
        let done = expectation(description: "relay \(action)")
        var status = 0
        URLSession.shared.dataTask(with: URL(string: "\(ctl)/\(action)")!) { _, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        XCTAssertEqual(status, 200, "relay \(action)")
    }

    /// Polls until the element has a non-empty frame inside the app's window.
    private func waitForFrame(_ e: XCUIElement, in app: XCUIApplication, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            let f = e.frame
            if e.exists, !f.isEmpty, app.frame.contains(CGPoint(x: f.midX, y: f.midY)) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }

    /// Like `waitForFrame`, and the frame is the same on two reads half a second apart.
    private func waitForSteadyFrame(_ e: XCUIElement, in app: XCUIApplication, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        var last: CGRect?
        repeat {
            if waitForFrame(e, in: app, max(0.5, deadline.timeIntervalSinceNow)) {
                let f = e.frame
                if f == last { return true }
                last = f
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        } while Date() < deadline
        return false
    }

    /// Long-presses `target` for its context menu and waits for `item` to show.
    /// On a loaded simulator the first press sometimes lands while the app is
    /// still busy and no menu opens (the fork step in run 40140666823, the
    /// "Ask about this change" step in run 40154800339); the item is given
    /// 10 s, and the press is made once more if it never showed (#1048).
    private func contextMenuItem(_ item: XCUIElement, afterLongPressOn target: XCUIElement) -> Bool {
        for attempt in 1...2 {
            target.press(forDuration: 1.0)
            if item.waitForExistence(timeout: 10) { return true }
            if attempt == 1 { _ = target.waitForExistence(timeout: 5) }
        }
        return false
    }

    private func waitGone(_ e: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let p = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: e)
        return XCTWaiter.wait(for: [p], timeout: seconds) == .completed
    }

    /// The simulator's screen rather than the app's own screenshot: the app
    /// cannot answer a screenshot request while it is busy starting a Live
    /// Activity, and that timeout failed the test, not the journey (#831).
    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
