import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// IO-22 to IO-29: the queue editor, fork, saved prompts, Continue and search,
/// automations, pull requests through the agent, and usage and limits.
@MainActor
final class BeyondTests: XCTestCase {
    let room = "a1b2c3d4e5f60718"
    let key = "00112233445566778899aabbccddeeff"
    var connections: [FakeConnection] = []
    var refuseSteer = false
    var interruptTimesOut = false
    var queue: [JSONValue] = ["first", ["text": "with a photo", "images": [""]], ["text": "Review.\n\nnow", "skill": ["name": "review", "input": "now"]]]

    func session() -> JSONValue {
        [
            "id": "s1", "title": "Fix it", "providerId": "p", "modelId": "m", "queue": .array(queue),
            "messages": [
                ["id": "u1", "role": "user", "content": "Find the bug", "images": ["data:image/jpeg;base64,AAAA", ""]],
                ["id": "a1", "role": "assistant", "content": "Found it.", "toolCalls": [["id": "c1", "name": "bash", "input": ["command": "ls"]]]],
                ["id": "t1", "role": "tool", "content": "", "toolResult": ["toolCallId": "c1", "output": "ok"]],
                ["id": "u2", "role": "user", "content": "", "skill": ["name": "review", "input": "it"]],
                ["id": "a2", "role": "assistant", "content": "Looks good."],
            ],
        ]
    }

    func makeStore() async throws -> (ComputersStore, FakeConnection) {
        var n = 0
        let s = ComputersStore(
            store: MemoryStore(),
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                c.replies = self.replies()
                self.connections.append(c)
                return c
            },
            deviceName: { "iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { n += 1; return "id-\(n)" },
            now: { 1_000 },
            summariesDebounce: 0.01)
        s.load()
        await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        let c = try XCTUnwrap(connections.last)
        c.online()
        await settle()
        return (s, c)
    }

    func replies() -> [String: ([JSONValue]) throws -> JSONValue] {
        [
            Channels.sessionsSummaries: { _ in [
                ["id": "s1", "title": "Fix the login bug", "updatedAt": 5, "firstUserText": "Find the bug"],
                ["id": "s2", "title": "Café menu", "updatedAt": 9, "archivedAt": 10, "lastReplyText": "Done with the RÉSUMÉ"],
                ["id": "s3", "title": "Newest", "updatedAt": 7],
                ["id": "sub", "title": "x", "updatedAt": 99, "parentSessionId": "s1"],
            ] },
            Channels.providersList: { _ in [["id": "p", "kind": "openai", "label": "P", "enabled": true],
                                            ["id": "claude", "kind": "anthropic", "label": "Claude", "enabled": true],
                                            ["id": "off", "label": "Off", "enabled": false]] },
            Channels.settingsGet: { _ in [
                "defaultProviderId": "p", "defaultModelId": "m", "automationsPaused": true,
                "prompts": [["id": "fix", "name": "fix", "body": "Find and fix the bug."], ["name": "broken"]],
            ] },
            Channels.sessionGet: { _ in self.session() },
            Channels.chatEditQueued: { args in
                // Like the computer: only while the prompt still reads what the phone showed.
                guard args.count == 3, args[1].int64 == 0, let shown = self.queue.first?.string, args[2].str("expect") == shown else {
                    throw RelayError("Not allowed from a paired phone (value-invalid): That queued prompt already started or changed.", fromComputer: true)
                }
                if let text = args[2].str("text") { self.queue[0] = .string(text) } else { self.queue.removeFirst() }
                return ["id": "s1", "queue": .array(self.queue)]
            },
            Channels.chatSteer: { args in
                if self.refuseSteer { throw RelayError("Not allowed from a paired phone (channel-denied): chat:steer", fromComputer: true) }
                return self.session()
            },
            Channels.chatQueue: { args in
                self.queue.append(args[1])
                return self.session()
            },
            Channels.chatInterruptQueued: { args in
                if self.interruptTimesOut { throw RelayError("The computer didn't answer in time.") }
                return .null
            },
            Channels.sessionFork: { _ in ["id": "s_fork", "title": "New chat"] },
            Channels.tasksList: { _ in [["id": "t1", "title": "Nightly tests", "kind": "recurring", "intervalMs": 86_400_000, "status": "active",
                                         "runCount": 3, "lastResult": "All 40 passed.", "lastRunAt": 5]] },
            Channels.workflowsList: { _ in [["id": "w1", "name": "Review PRs", "category": "Code", "enabled": true, "stepCount": 2, "lastStatus": "failure"]] },
            Channels.prSessionList: { _ in [["url": "https://github.com/o/r/pull/12", "number": 12, "title": "Fix login", "state": "open",
                                             "isDraft": false, "checks": "failing", "additions": 3, "deletions": 1, "changedFiles": 2]] },
            Channels.usageSummary: { _ in ["totalInput": 1000, "totalOutput": 500, "totalCost": 1.25,
                                           "byModel": [["model": "claude-opus-5.5", "input": 600, "output": 300, "cost": 1]],
                                           "daily": [["date": "2026-10-19", "input": 10, "output": 5, "cost": 0.25]]] },
            Channels.limitsGet: { args in
                args.first?.string == "claude"
                    ? ["planType": "max", "windows": [["id": "w", "label": "5 hours", "usedPercent": 140, "resetAt": 9, "status": "warning"]]]
                    : .null
            },
        ]
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testEditsAndRemovesQueuedPromptsCheckedAgainstWhatWasShown() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        XCTAssertEqual(chat.queued, ["first", "with a photo", "/review now"], "a skill's prompt shows as /name input, never its instructions")
        XCTAssertEqual(chat.queuedPrompts.map(\.editable), [true, true, false])
        XCTAssertEqual(chat.queuedPrompts[1].images, 1)

        try await chat.editQueued(0, expect: "first", text: "first, edited")
        XCTAssertEqual(c.callsTo(Channels.chatEditQueued).last, [.string("s1"), .int(0), ["expect": "first", "text": "first, edited"]])
        XCTAssertEqual(chat.queued.first, "first, edited", "re-read after the edit")

        // The prompt moved on: the computer refuses, and the queue on screen is re-read.
        do {
            try await chat.editQueued(0, expect: "first", text: "late")
            XCTFail("a stale edit is refused")
        } catch let e as RelayError {
            XCTAssertTrue(e.fromComputer)
        }
        try await chat.editQueued(0, expect: "first, edited", text: nil)
        XCTAssertEqual(c.callsTo(Channels.chatEditQueued).last?[2], ["expect": "first, edited"], "no text removes it")

        // Offline: never sent later.
        c.status(RelayStatus(.offline))
        await settle()
        let before = c.callsTo(Channels.chatEditQueued).count
        do {
            try await chat.editQueued(0, expect: "x", text: "y")
            XCTFail("offline edits are refused on the phone")
        } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.reconnectToEditQueue)
        }
        XCTAssertEqual(c.callsTo(Channels.chatEditQueued).count, before)
    }

    func testNextStepTakesThePromptOffTheQueueThenSendsIt() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        XCTAssertEqual(chat.queuedPrompts.map(\.canTakeAtNextStep), [true, false, false], "text only: photos and skills wait their turn")

        try await chat.sendQueuedAtNextStep(0, expect: "first")
        XCTAssertEqual(c.callsTo(Channels.chatEditQueued).last, [.string("s1"), .int(0), ["expect": "first"]])
        XCTAssertEqual(c.callsTo(Channels.chatSteer).last, [.string("s1"), .string("first")])
        XCTAssertFalse(chat.queued.contains("first"))
    }

    func testNextStepOnAMovedQueueSendsNothing() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        do {
            try await chat.sendQueuedAtNextStep(0, expect: "already started")
            XCTFail("a stale prompt is refused")
        } catch let e as RelayError {
            XCTAssertTrue(e.fromComputer)
        }
        XCTAssertTrue(c.callsTo(Channels.chatSteer).isEmpty)
    }

    func testAComputerTooOldForNextStepKeepsThePromptQueued() async throws {
        let (s, c) = try await makeStore()
        refuseSteer = true
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        do {
            try await chat.sendQueuedAtNextStep(0, expect: "first")
            XCTFail("the refusal reaches the phone")
        } catch {}
        XCTAssertEqual(c.callsTo(Channels.chatQueue).last, [.string("s1"), .string("first")])
        XCTAssertTrue(chat.queued.contains("first"))
    }

    func testInterruptNamesThePromptAndTheChatsModel() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        try await chat.interruptQueued(1)
        let args = try XCTUnwrap(c.callsTo(Channels.chatInterruptQueued).last)
        XCTAssertEqual(Array(args.prefix(2)), [.string("s1"), .int(1)])
        XCTAssertNotNil(args[2].str("modelId"))
    }

    func testAnInterruptThatOutlastsTheRequestIsNotAnError() async throws {
        let (s, _) = try await makeStore()
        interruptTimesOut = true
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        try await chat.interruptQueued(0)
    }

    func testARunSettingGoesToTheComputerAndReadsBack() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        try await chat.setRunOption("workMode", "design")
        XCTAssertEqual(c.callsTo(Channels.sessionSetOptions).last, [.string("s1"), ["workMode": "design"]])
        XCTAssertEqual(RunOption.values(of: ["autoModel": true, "title": "x", "offline": .null]), ["autoModel": true], "only run settings, and only set ones")
    }

    func testForksBeforeAPromptWithItsTextOrAfterAReply() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        let blocks = chat.blocks
        let prompt = try XCTUnwrap(blocks.first { $0.id == "u2" })
        let reply = try XCTUnwrap(blocks.first { $0.id == "a1" })
        let step = try XCTUnwrap(blocks.first { $0.id == "c1" })
        let last = try XCTUnwrap(blocks.first { $0.id == "a2" })
        XCTAssertEqual(chat.forkPoint(prompt)?.before, "u2")
        XCTAssertEqual(chat.forkPoint(prompt)?.seed, "/review it", "a skill prompt comes back as /name input")
        XCTAssertEqual(chat.forkPoint(reply)?.before, "u2", "a reply keeps everything up to the next prompt")
        XCTAssertEqual(chat.forkPoint(step)?.before, "u2")
        let whole = try XCTUnwrap(chat.forkPoint(last))
        XCTAssertNil(whole.before, "the last reply forks the whole chat")
        XCTAssertNil(chat.forkPoint(.assistant(id: "live-1-0", text: "…", reasoning: nil, streaming: true, interrupted: false)))

        let id = try await chat.fork(from: try XCTUnwrap(blocks.first { $0.id == "u1" }))
        XCTAssertEqual(id, "s_fork")
        XCTAssertEqual(c.callsTo(Channels.sessionFork).last, [.string("s1"), .string("u1")])
        XCTAssertEqual(s.drafts.draft("s_fork").text, "Find the bug", "the forked prompt waits in the new chat's message box")
        _ = try await chat.fork(from: last)
        XCTAssertEqual(c.callsTo(Channels.sessionFork).last, [.string("s1")])
    }

    func testPhotosAndSavedPromptsAndAutomationsPaused() async throws {
        let (s, _) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        XCTAssertEqual(chat.photos("u1"), ["data:image/jpeg;base64,AAAA", ""])
        XCTAssertEqual(s.pcSettings.prompts, [SavedPrompt(id: "fix", name: "fix", body: "Find and fix the bug.")])
        XCTAssertEqual(s.pcSettings.prompts[0].text(input: "  in login.ts "), "Find and fix the bug.\n\nin login.ts")
        XCTAssertEqual(s.pcSettings.prompts[0].text(input: ""), "Find and fix the bug.")
        XCTAssertTrue(s.pcSettings.automationsPaused)
    }

    func testContinueAndSearchAcrossCompletedChats() async throws {
        let (s, _) = try await makeStore()
        XCTAssertEqual(ChatSearch.continueChat(s.summaries)?.id, "s3", "the most recent active chat, never a completed one or a sub-agent")
        XCTAssertEqual(ChatSearch.matches(s.summaries, "cafe resume").map(\.id), ["s2"], "accents and case don't matter; completed chats count")
        XCTAssertEqual(ChatSearch.matches(s.summaries, "BUG find").map(\.id), ["s1"], "every word, anywhere")
        XCTAssertEqual(ChatSearch.matches(s.summaries, "  ").count, s.summaries.count)
        XCTAssertTrue(ChatSearch.matches(s.summaries, "nothing like it").isEmpty)
    }

    func testAutomationsListAndRunNowOnly() async throws {
        let (s, c) = try await makeStore()
        let a = AutomationsModel(store: s)
        await a.load()
        XCTAssertNil(a.error)
        XCTAssertEqual(a.tasks.map(\.title), ["Nightly tests"])
        XCTAssertEqual(a.tasks[0].cadence, "Every day")
        XCTAssertEqual(a.tasks[0].lastResult, "All 40 passed.")
        XCTAssertEqual(a.workflows.map(\.name), ["Review PRs"])
        XCTAssertTrue(a.paused)
        try await a.run(task: "t1")
        try await a.run(workflow: "w1")
        XCTAssertEqual(c.callsTo(Channels.taskRunNow), [[.string("t1")]])
        XCTAssertEqual(c.callsTo(Channels.workflowRun), [[.string("w1")]])
        XCTAssertEqual(a.started, ["t1", "w1"])
        // Only reads and Run now: nothing that makes or changes an automation.
        XCTAssertFalse(c.calls.contains { ["task:create", "task:update", "task:delete", "workflow:update", "workflow:delete"].contains($0.0) })
        c.status(RelayStatus(.offline))
        await settle()
        do {
            try await a.run(task: "t1")
            XCTFail("Run now is never sent later")
        } catch {}
        XCTAssertEqual(c.callsTo(Channels.taskRunNow).count, 1)
    }

    func testPullRequestsAreReadAndGitGoesThroughTheAgent() async throws {
        let (s, c) = try await makeStore()
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        let prs = try await chat.pullRequests()
        XCTAssertEqual(prs.map(\.summary), ["#12 Open · checks failing"])
        XCTAssertEqual(c.callsTo(Channels.prSessionList).last, [.string("s1"), .bool(false)])
        // "Commit these changes" is a prompt the agent runs, so its approvals apply.
        try await chat.send(GitPrompt.commit.text)
        await settle()
        let sent = try XCTUnwrap(c.callsTo(Channels.chatSend).last?.first)
        XCTAssertEqual(sent.str("text"), GitPrompt.commit.text)
        XCTAssertFalse(c.calls.contains { $0.0.hasPrefix("pr:action") || $0.0.hasPrefix("workspace:git") })
    }

    func testUsageAndLimitsByProviderId() async throws {
        let (s, c) = try await makeStore()
        let u = UsageModel(store: s)
        await u.load()
        XCTAssertEqual(u.summary?.totalTokens, 1500)
        XCTAssertEqual(u.summary?.models.map(\.model), ["claude-opus-5.5"])
        XCTAssertEqual(u.summary?.days.first?.tokens, 15)
        XCTAssertEqual(u.limited.map(\.provider.id), ["claude"], "providers without limits leave no card")
        XCTAssertEqual(u.limited.first?.limits.windows.first?.usedPercent, 100, "clamped for the bar")
        let asked = c.callsTo(Channels.limitsGet).map { $0.first?.string ?? "" }.sorted()
        XCTAssertEqual(asked, ["claude", "p"], "enabled providers only, by id: the phone never has a key")
    }
}
