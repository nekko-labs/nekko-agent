import XCTest
@testable import NekkoKit

@MainActor
final class VoiceConversationTests: XCTestCase {
    func testOpeningDoesNotStartAudio() {
        let voice = VoiceConversation()
        XCTAssertEqual(voice.phase, .ready)
        XCTAssertFalse(voice.active)
        XCTAssertEqual(voice.heard, "")
    }

    func testListenSendSpeakThenListenWithoutOverlap() async throws {
        let voice = VoiceConversation()
        var events: [String] = []
        var captures = 0
        voice.start(capture: {
            captures += 1
            events.append("listen")
            if captures > 1 { throw CancellationError() }
            return "Hello"
        }, respond: { words in
            XCTAssertEqual(voice.phase, .waiting)
            XCTAssertEqual(words, "Hello")
            events.append("send")
            return "**Hello back**"
        }, speak: { words in
            XCTAssertEqual(voice.phase, .speaking)
            XCTAssertEqual(words, "Hello back")
            events.append("speak")
        }, stopAudio: { events.append("stop") })
        try await finish(voice)
        XCTAssertEqual(events, ["listen", "send", "speak", "listen", "stop"])
        XCTAssertNil(voice.error)
    }

    func testStoppingDuringRecognitionNeverSendsLateWords() async throws {
        let voice = VoiceConversation()
        var recognition: CheckedContinuation<String, Never>?
        var sent = false
        voice.start(capture: { await withCheckedContinuation { recognition = $0 } },
                    respond: { _ in sent = true; return "Wrong" }, speak: { _ in XCTFail("Must not speak") }, stopAudio: {})
        try await waitUntil { recognition != nil }
        voice.stop()
        recognition?.resume(returning: "Late private speech")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(sent)
        XCTAssertFalse(voice.active)
        XCTAssertEqual(voice.phase, .stopped)
    }

    func testStoppingDuringReplyNeverPlaysLateReply() async throws {
        let voice = VoiceConversation()
        var response: CheckedContinuation<String, Never>?
        voice.start(capture: { "Hello" }, respond: { _ in await withCheckedContinuation { response = $0 } },
                    speak: { _ in XCTFail("Must not speak after stop") }, stopAudio: {})
        try await waitUntil { response != nil }
        voice.stop()
        response?.resume(returning: "Late reply")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(voice.reply, "")
        XCTAssertFalse(voice.active)
    }

    func testFailureStopsWithoutSendingOrCloudFallback() async throws {
        let voice = VoiceConversation()
        var stopped = false
        voice.start(capture: { throw NSError(domain: "On-device speech unavailable", code: 1) },
                    respond: { _ in XCTFail("Must not send"); return "" }, speak: { _ in XCTFail("Must not speak") },
                    stopAudio: { stopped = true })
        try await finish(voice)
        XCTAssertNotNil(voice.error)
        XCTAssertTrue(stopped)
    }

    func testEmptyAudioDoesNotSendOrSpin() async throws {
        let voice = VoiceConversation()
        var calls = 0
        voice.start(capture: { calls += 1; return "  " }, respond: { _ in XCTFail("Must not send silence"); return "" },
                    speak: { _ in XCTFail("Must not speak") }, stopAudio: {})
        try await finish(voice)
        XCTAssertEqual(calls, 1)
        XCTAssertNotNil(voice.error)
    }

    func testRestartIgnoresTheOldSessionCompletion() async throws {
        let voice = VoiceConversation()
        var old: CheckedContinuation<String, Never>?
        voice.start(capture: { await withCheckedContinuation { old = $0 } }, respond: { _ in XCTFail(); return "" }, speak: { _ in }, stopAudio: {})
        try await waitUntil { old != nil }
        voice.stop()
        var current: CheckedContinuation<String, Never>?
        voice.start(capture: { await withCheckedContinuation { current = $0 } }, respond: { _ in "New answer" }, speak: { _ in }, stopAudio: {})
        try await waitUntil { current != nil }
        old?.resume(returning: "Old speech")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(voice.active)
        XCTAssertEqual(voice.phase, .listening)
        voice.stop()
        current?.resume(returning: "")
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), "Voice callback was not reached before its deadline")
    }

    private func finish(_ voice: VoiceConversation) async throws {
        let deadline = Date().addingTimeInterval(2)
        while voice.active, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(voice.active, "Voice test did not settle before its deadline")
    }
}
