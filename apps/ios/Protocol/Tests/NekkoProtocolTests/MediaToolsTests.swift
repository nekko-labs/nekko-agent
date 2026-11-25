import XCTest
@testable import NekkoProtocol

/// What the phone does with agent-made pictures and clips (#2973, #3038), held to
/// the desktop's `agentWatches.ts` and `ClipPicker.tsx`.
final class MediaToolsTests: XCTestCase {
    // MARK: Clip watches

    func testDecodesAClipWatchWithItsStage() throws {
        let raw = try JSONValue.parse(#"[{"id":"c1","kind":"clip","status":"active","deadlineAt":9,"pending":false,"failures":0,"clipStage":"step:3/20"},{"id":"c2","kind":"clip","status":"active","deadlineAt":9}]"#)
        let list = AgentWatch.list(raw)
        XCTAssertEqual(list.map(\.kind), [.clip, .clip])
        XCTAssertEqual(list[0].clipStage, "step:3/20")
        XCTAssertNil(list[1].clipStage)
        XCTAssertFalse(list[0].isTimedWakeUp)
        XCTAssertTrue(AgentWatch(id: "t", kind: .timer, status: .active, deadlineAt: 1).isTimedWakeUp)
    }

    func testClipStageWords() {
        XCTAssertEqual(AgentRows.clipStage(nil), "starting")
        XCTAssertEqual(AgentRows.clipStage(""), "starting")
        XCTAssertEqual(AgentRows.clipStage("waiting"), "waiting for another picture or clip")
        XCTAssertEqual(AgentRows.clipStage("loading"), "loading the video model")
        XCTAssertEqual(AgentRows.clipStage("generating"), "starting")
        XCTAssertEqual(AgentRows.clipStage("step:3/20"), "step 3 of 20")
        XCTAssertEqual(AgentRows.clipStage("step:x/20"), "starting")
    }

    func testClipChipHasNoCountdown() throws {
        let call = AgentRows.WatchCall(action: .create, kind: .clip, url: nil, seconds: nil, prompt: "", id: nil)
        func clip(pending: Bool, status: AgentWatch.Status = .active) -> AgentWatch {
            AgentWatch(id: "c", kind: .clip, status: status, deadlineAt: 1, pending: pending, clipStage: "loading")
        }
        // Long past its deadline, a running clip is still just "in progress", never overdue.
        let running = try XCTUnwrap(AgentRows.watchClock(call, view: clip(pending: false), now: 10_000_000))
        XCTAssertEqual(running.text, "in progress")
        XCTAssertEqual(running.tone, .normal)
        XCTAssertEqual(try XCTUnwrap(AgentRows.watchClock(call, view: clip(pending: true), now: 10_000_000)).text, "finished · waiting for the chat")
        XCTAssertEqual(AgentRows.watchClock(call, view: clip(pending: false, status: .done), now: 5)?.text, "triggered")
        XCTAssertEqual(AgentRows.watchName(.clip), "Making a clip")
        XCTAssertEqual(AgentRows.watchHeadline(call), "Making a clip")
        XCTAssertEqual(AgentRows.cancelLabel(.clip), "Cancel clip")
        XCTAssertEqual(AgentRows.cancelLabel(.pr), "Cancel watcher")
        XCTAssertEqual(AgentRows.watchProgress(clip(pending: false)), "loading the video model")
        XCTAssertNil(AgentRows.watchProgress(clip(pending: true)))
        XCTAssertEqual(AgentRows.chips([clip(pending: false), clip(pending: false, status: .cancelled)]).count, 1)
    }

    func testCancelWatchIsAnAgentCall() {
        XCTAssertFalse(Channels.change.contains(Channels.sessionCancelWatch), "the computer treats it as an agent call, not a signed change")
        XCTAssertTrue(Channels.all.contains(Channels.sessionCancelWatch))
    }

    // MARK: Pictures

    private func message(_ id: String, _ role: String, calls: [ToolCall] = [], result: ToolResult? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, content: "", reasoning: nil, createdAt: 0, imageCount: 0, skill: nil,
                    toolCalls: calls, toolResult: result, interrupted: false)
    }

    func testFindsOnlyAPictureToolsPictures() {
        let messages = [
            message("a", "assistant", calls: [ToolCall(id: "c1", name: "generate_image", input: [:]), ToolCall(id: "c2", name: "computer_screenshot", input: [:])]),
            message("r1", "tool", result: ToolResult(toolCallId: "c1", output: "ok", isError: false, outputChars: nil, omittedImages: 2)),
            message("r2", "tool", result: ToolResult(toolCallId: "c2", output: "ok", isError: false, outputChars: nil, omittedImages: 1)),
        ]
        XCTAssertEqual(ToolPictures.find(messages, callId: "c1", tool: "generate_image"), ToolPictures.Found(messageId: "r1", count: 2))
        XCTAssertNil(ToolPictures.find(messages, callId: "c2", tool: "computer_screenshot"), "a screenshot stays on the computer")
        XCTAssertNil(ToolPictures.find(messages, callId: "c1", tool: "other"))
        XCTAssertNil(ToolPictures.find(messages, callId: "missing", tool: "edit_image"))
        let failed = [message("r", "tool", result: ToolResult(toolCallId: "c", output: "no", isError: true, outputChars: nil, omittedImages: 1))]
        XCTAssertNil(ToolPictures.find(failed, callId: "c", tool: "generate_image"))
    }

    func testOmittedImagesDecodeFromAToolResult() throws {
        let raw = try JSONValue.parse(#"{"toolCallId":"c","output":"ok","isError":false,"omittedImages":1}"#)
        XCTAssertEqual(ToolResult.from(raw)?.omittedImages, 1)
    }

    // MARK: The paid clip picker

    private func request(withClip: Bool = true) throws -> AskRequest {
        let clip = withClip ? #","clip":{"model":"acme/video-1","via":"OpenRouter","sendsPicture":true,"prices":{"5 seconds|With audio|720p":2.4,"5 seconds|No audio|720p":1.2,"10 seconds|With audio|720p":4.8,"10 seconds|No audio|720p":2.4}}"# : ""
        let json = #"{"callId":"k","askedAt":1,"questions":["#
            + #"{"id":"q1","header":"Length","question":"How long?","options":[{"label":"5 seconds"},{"label":"10 seconds"}]},"#
            + #"{"id":"q2","header":"Audio","question":"Sound?","options":[{"label":"With audio"},{"label":"No audio"}]},"#
            + #"{"id":"q3","header":"Resolution","question":"Size?","options":[{"label":"720p"}]}]"# + clip + "}"
        return try XCTUnwrap(AskRequest.from(JSONValue.parse(json)))
    }

    func testParsesTheClipOffer() throws {
        let offer = try XCTUnwrap(request().clip)
        XCTAssertEqual(offer.model, "acme/video-1")
        XCTAssertEqual(offer.via, "OpenRouter")
        XCTAssertTrue(offer.sendsPicture)
        XCTAssertEqual(offer.prices.count, 4)
        XCTAssertNil(try request(withClip: false).clip, "an ordinary question has no picker")
        XCTAssertNil(ClipOffer.from(try JSONValue.parse(#"{"model":"m"}"#)))
    }

    func testTotalFollowsThePicks() throws {
        let r = try request()
        var picks = ClipPicker.suggested(r)
        XCTAssertEqual(picks, ["q1": "5 seconds", "q2": "With audio", "q3": "720p"])
        XCTAssertEqual(ClipPicker.total(r, picks: picks), 2.4)
        picks["q2"] = "No audio"
        XCTAssertEqual(ClipPicker.total(r, picks: picks), 1.2)
        picks["q1"] = "10 seconds"
        XCTAssertEqual(ClipPicker.total(r, picks: picks), 2.4)
        picks["q3"] = "4k"
        XCTAssertNil(ClipPicker.total(r, picks: picks), "a combination with no price")
        XCTAssertNil(ClipPicker.total(try request(withClip: false), picks: ClipPicker.suggested(try request(withClip: false))))
    }

    func testAnAbsentQuestionIsAnEmptyLabelInThePriceKey() throws {
        let json = #"{"callId":"k","questions":[{"id":"q1","header":"Length","options":[{"label":"5 seconds"}]}],"clip":{"model":"m","via":"v","sendsPicture":false,"prices":{"5 seconds||":0.5}}}"#
        let r = try XCTUnwrap(AskRequest.from(JSONValue.parse(json)))
        XCTAssertEqual(ClipPicker.total(r, picks: ClipPicker.suggested(r)), 0.5)
    }

    func testAnswersCarryTheTotalWithTwoDecimals() throws {
        let r = try request()
        let answers = ClipPicker.answers(r, picks: ClipPicker.suggested(r), total: 2.4)
        XCTAssertEqual(answers.map(\.questionId), ["q1", "q2", "q3", "total"])
        XCTAssertEqual(answers.map(\.labels), [["5 seconds"], ["With audio"], ["720p"], ["2.40"]])
        XCTAssertEqual(ClipPicker.amount(12), "12.00")
        XCTAssertEqual(ClipPicker.dollars(0.5), "$0.50")
    }

    func testWordsBeforePaying() throws {
        let offer = try XCTUnwrap(request().clip)
        XCTAssertEqual(ClipPicker.leaves(offer), "The prompt and the first picture leave this computer for OpenRouter and the model’s provider.")
        XCTAssertEqual(ClipPicker.leaves(ClipOffer(model: "m", via: "v", sendsPicture: false, prices: [:])), "The prompt leaves this computer for v and the model’s provider.")
        XCTAssertEqual(ClipPicker.makeTitle(total: 2.4, sending: false), "Make clip · $2.40")
        XCTAssertEqual(ClipPicker.makeTitle(total: nil, sending: false), "Make clip")
        XCTAssertEqual(ClipPicker.makeTitle(total: 2.4, sending: true), "Starting…")
    }
}
