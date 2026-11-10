import XCTest

/// Overlay this file AND SecurityEvidenceFixture.swift identically on both app revisions.
/// TEST_RUNNER_NEKKO_EVIDENCE_BASELINE=1 on xcodebuild becomes NEKKO_EVIDENCE_BASELINE
/// in the runner. Baseline mode requires the original offline rejection, not a pass on missing UI.
@MainActor
final class PendingResponsesUITests: XCTestCase {
    func testPendingQuestionEvidence() {
        exercise(question: true)
    }

    func testPendingApprovalEvidence() {
        exercise(question: false)
    }

    private func exercise(question: Bool) {
        let app = launch(question: question)
        defer { app.terminate() }
        let name = question ? "question" : "approval"
        let submit = app.buttons[question ? "Send answers" : "Allow"]
        let response = app.descendants(matching: .any)["chat.response"].firstMatch
        let retry = app.buttons["response.retry"]
        let cancel = app.buttons["response.cancel"]
        let originalError = app.staticTexts.containing(NSPredicate(
            format: "label CONTAINS %@", "Reconnect to answer. Approvals and answers are never sent later."
        )).firstMatch

        guard require(submit, "The real \(name) card loads") else { return }
        XCTAssertTrue(wait { app.staticTexts["securityEvidence.status"].label == "Link: offline" })
        attach(app, "response-\(name)-ready")
        submitResponse(app, question: question, submit: submit)
        // Wait for a semantic state, not a fixed sleep or a long pending-only baseline timeout.
        guard wait({ response.exists || originalError.exists }) else {
            XCTFail("Submission produced neither a response message nor the original baseline error")
            attach(app, "response-\(name)-unexpected")
            return
        }
        attach(app, "response-\(name)-pending")

        if ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] == "1" {
            XCTAssertTrue(originalError.exists, "Baseline must show its original offline rejection")
            XCTAssertFalse(response.exists)
            XCTAssertTrue(submit.exists, "The baseline keeps the original form")
            checkCalls(app, attempts: 0, accepted: 0)
            let error = XCTAttachment(string: originalError.exists ? originalError.label : app.debugDescription)
            error.name = "response-\(name)-baseline-error"
            error.lifetime = .keepAlways
            add(error)
            return
        }

        guard require(response, "Offline submission becomes chat.response"),
              require(cancel, "An unsent response can be cancelled"),
              require(retry, "An unsent response can be retried") else { return }
        XCTAssertTrue(app.staticTexts["Pending · sends when connected"].exists)
        XCTAssertFalse(submit.exists, "Do not show the original form alongside its response")
        let requestId = question ? "answer:release-question" : "approval:post"
        XCTAssertTrue(app.staticTexts["Request identifier: \(requestId)"].exists)
        XCTAssertTrue(app.staticTexts[question ? "Destination: Releases" : "Allow mcp__slack__post_message"].exists)
        checkCalls(app, attempts: 0, accepted: 0)

        retry.tap()
        guard require(cancel, "An offline retry keeps the unsent response") else { return }
        checkCalls(app, attempts: 0, accepted: 0)
        attach(app, "response-\(name)-offline-retry")
        cancel.tap()
        XCTAssertTrue(wait { !response.exists && submit.exists })
        checkCalls(app, attempts: 0, accepted: 0)
        attach(app, "response-\(name)-cancelled")

        // A second real submission exercises reconnect delivery, not a fixture-created response.
        submitResponse(app, question: question, submit: submit)
        guard require(cancel, "Resubmission is pending") else { return }
        app.buttons["securityEvidence.failure"].tap()
        guard require(app.staticTexts["Synthetic response call failed."], "Reconnect attempts the real response channel") else { return }
        XCTAssertTrue(app.staticTexts["Couldn't send response"].exists)
        checkCalls(app, attempts: 1, accepted: 0)
        attach(app, "response-\(name)-failed")

        // Keep the transport failing to prove Retry dispatches once and retains the response.
        retry.tap()
        // Inspect calls is an explicit fixture control. Polling its snapshot waits for dispatch
        // even if a fast failure never leaves the accessibility tree between XCTest queries.
        guard waitForCalls(app, attempts: 2, accepted: 0) else { return }
        guard require(cancel, "A failed retry stays cancellable") else { return }
        XCTAssertTrue(app.staticTexts["Synthetic response call failed."].exists)
        attach(app, "response-\(name)-failed-retry")

        app.buttons["securityEvidence.success"].tap()
        guard require(app.staticTexts["Sent"], "Reconnect successfully sends the retained response") else { return }
        checkCalls(app, attempts: 3, accepted: 1)
        XCTAssertTrue(response.exists, "The sent response stays in the transcript")
        XCTAssertFalse(retry.exists)
        XCTAssertFalse(cancel.exists)
        XCTAssertFalse(submit.exists)
        attach(app, "response-\(name)-sent")

        // A further connection notification must not replay an acknowledged response.
        app.buttons["securityEvidence.offline"].tap()
        XCTAssertTrue(wait { app.staticTexts["securityEvidence.status"].label == "Link: offline" })
        app.buttons["securityEvidence.success"].tap()
        XCTAssertTrue(wait { app.staticTexts["securityEvidence.status"].label == "Link: online" })
        checkCalls(app, attempts: 3, accepted: 1)
    }

    private func submitResponse(_ app: XCUIApplication, question: Bool, submit: XCUIElement) {
        if question {
            let option = app.buttons["Releases"]
            guard require(option, "The synthetic question offers Releases") else { return }
            option.tap()
        }
        XCTAssertTrue(submit.isEnabled)
        submit.tap()
    }

    private func launch(question: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestSecurityEvidence", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "NO", "-simpleChoices", "{}",
                               "-securityEvidenceQuestion", question ? "YES" : "NO", "-securityEvidenceControls", "YES",
                               "-securityEvidenceCard", "NO", "-securityEvidenceOpen", "",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        return app
    }

    @discardableResult
    private func require(_ element: XCUIElement, _ message: String) -> Bool {
        let found = element.waitForExistence(timeout: 5)
        XCTAssertTrue(found, message)
        return found
    }

    private func wait(_ predicate: @escaping () -> Bool) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in predicate() }, object: nil)
        return XCTWaiter.wait(for: [expectation], timeout: 3) == .completed
    }

    private func checkCalls(_ app: XCUIApplication, attempts: Int, accepted: Int) {
        app.buttons["securityEvidence.inspect"].tap()
        XCTAssertTrue(wait { app.staticTexts["securityEvidence.calls"].label == "Calls: \(attempts); accepted: \(accepted)" })
    }

    private func waitForCalls(_ app: XCUIApplication, attempts: Int, accepted: Int) -> Bool {
        let found = wait {
            app.buttons["securityEvidence.inspect"].tap()
            return app.staticTexts["securityEvidence.calls"].label == "Calls: \(attempts); accepted: \(accepted)"
        }
        XCTAssertTrue(found, "Retry must dispatch exactly once")
        return found
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
