package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class WireTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)

    /** Every channel the phone calls must exist in the shared IPC contract. */
    @Test fun `channel names match packages shared ipc`() {
        val ipc = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "packages/shared/src/ipc.ts")
        if (!ipc.exists()) return // running outside the monorepo
        val text = ipc.readText()
        for (ch in Channels.ALL + Events.AGENT_EVENT) assertTrue("missing $ch in ipc.ts", text.contains("'$ch'"))
    }

    @Test fun `phone changes decode hunks, hidden, binary and too-large files`() {
        val c = PhoneChanges.from(json("""
            {"files":[
              {"path":"…/src/main.ts","status":"modified","added":2,"removed":1,"hunks":[{"oldStart":2,"newStart":2,"lines":[" b","-e","+E","+j"," f"]}]},
              {"path":"new.txt","status":"added","added":1,"removed":0,"hunks":[]},
              {"path":".env","status":"modified","added":1,"removed":1,"hunks":[],"hidden":true},
              {"path":"blob.bin","status":"modified","added":1,"removed":1,"hunks":[],"binary":true},
              {"path":"big.txt","status":"modified","added":900,"removed":0,"hunks":[],"tooLarge":true,"lines":903},
              {"status":"added"}
            ],"omittedFiles":3}
        """))
        assertEquals(listOf("…/src/main.ts", "new.txt", ".env", "blob.bin", "big.txt"), c.files.map { it.path })
        assertEquals(3, c.omittedFiles)
        assertEquals(905, c.linesAdded)
        assertTrue(c.files[1].added)
        assertEquals(
            listOf(PhoneChanges.Shown.Diff, PhoneChanges.Shown.Diff, PhoneChanges.Shown.Hidden, PhoneChanges.Shown.Binary, PhoneChanges.Shown.TooLarge(903)),
            c.files.map { it.shown },
        )
        val lines = c.files[0].hunks[0].lines
        assertEquals(listOf(PhoneChanges.Kind.SAME, PhoneChanges.Kind.REMOVED, PhoneChanges.Kind.ADDED, PhoneChanges.Kind.ADDED, PhoneChanges.Kind.SAME), lines.map { it.kind })
        assertEquals(listOf(2, 3, 3, 4, 5), lines.map { it.number })
        assertEquals("E", lines[2].text)
        assertEquals(PhoneChanges(emptyList()), PhoneChanges.from(null))
        assertEquals("About `…/src/main.ts` lines 3–4:\n```diff\n-e\n+E\n+j\n```\n\n", PhoneChanges.quote(c.files[0], c.files[0].hunks[0]))
        val big = PhoneChanges.Hunk.of(1, 1, (1..20).map { "+l$it" })
        assertTrue(PhoneChanges.quote(c.files[0], big).contains("+l12\n… 8 more\n```"))
        assertEquals("About `new.txt` (new, +1 −0):\n\n", PhoneChanges.quote(c.files[1]))
        assertTrue(PcSettings.from(json("""{"phoneChanges":true}""")).phoneChanges)
        assertFalse(PcSettings.from(json("""{"phoneChanges":"yes"}""")).phoneChanges)
    }

    @Test fun `providers drop secrets and keep only public fields`() {
        val list = PublicProvider.list(json("""[{"id":"fake","kind":"openai-compat","label":"Fake","baseUrl":"http://x","apiKey":"sk-secret","enabled":true},{"nope":1}]"""))
        assertEquals(listOf(PublicProvider("fake", "openai-compat", "Fake", true)), list)
        assertFalse(list.toString().contains("sk-"))
    }

    @Test fun `summaries keep real top-level chats, completed ones too, newest first`() {
        val list = SessionSummary.visible(json("""[
          {"id":"a","title":"A","updatedAt":1},
          {"id":"b","title":"B","updatedAt":3,"workspaceId":"w1","order":2.5},
          {"id":"c","title":"C","updatedAt":5,"archivedAt":4},
          {"id":"d","title":"D","updatedAt":6,"parentSessionId":"a"},
          {"id":"e","title":"E","updatedAt":7,"taskId":"t"},
          {"id":"f","title":"F","updatedAt":8,"trainingRunId":"r"},
          {"id":"g","title":"G","updatedAt":2,"archivedAt":null}
        ]"""))
        assertEquals(listOf("c", "b", "g", "a"), list.map { it.id })
        val c = list.first { it.id == "c" }
        assertTrue(c.archived)
        assertEquals(4L, c.archivedAt)
        assertFalse(list.first { it.id == "g" }.archived)
        assertNull(list.first { it.id == "g" }.archivedAt)
        assertEquals("w1", list.first { it.id == "b" }.workspaceId)
        assertEquals(2.5, list.first { it.id == "b" }.order!!, 0.0)
    }

    @Test fun `chat groups follow the desktop sidebar - General, then each folder, active and completed apart`() {
        val chats = SessionSummary.visible(json("""[
          {"id":"g1","title":"G1","updatedAt":10},
          {"id":"g2","title":"G2","updatedAt":20,"archivedAt":30},
          {"id":"lost","title":"Lost","updatedAt":5,"workspaceId":"gone"},
          {"id":"p1","title":"P1","updatedAt":40,"workspaceId":"w1"},
          {"id":"p2","title":"P2","updatedAt":50,"workspaceId":"w1"},
          {"id":"p3","title":"P3","updatedAt":1,"workspaceId":"w1","order":1},
          {"id":"p4","title":"P4","updatedAt":60,"workspaceId":"w1","archivedAt":70},
          {"id":"p5","title":"P5","updatedAt":61,"workspaceId":"w1","archivedAt":90}
        ]"""))
        val folders = listOf(WorkspaceFolder("w1", "app"), WorkspaceFolder("w2", "site"))
        val groups = ChatGroup.of(chats, folders)
        assertEquals(listOf(ChatGroup.GENERAL, "w1", "w2"), groups.map { it.key })
        assertEquals(listOf("General", "app", "site"), groups.map { it.name })
        // A chat filed under a folder the computer no longer has falls back to General, like the desktop.
        assertEquals(listOf("g1", "lost"), groups[0].active.map { it.id })
        assertEquals(listOf("g2"), groups[0].completed.map { it.id })
        // Dragged order first, then the most recent; completed by when they were completed.
        assertEquals(listOf("p3", "p2", "p1"), groups[1].active.map { it.id })
        assertEquals(listOf("p5", "p4"), groups[1].completed.map { it.id })
        // An empty folder is still listed; an empty General is not.
        assertTrue(groups[2].active.isEmpty() && groups[2].completed.isEmpty())
        assertEquals(listOf("w1"), ChatGroup.of(chats.filter { it.workspaceId == "w1" }, folders.take(1)).map { it.key })
    }

    @Test fun `session decodes messages, tool calls and mixed queue entries`() {
        val s = Session.from(json("""{"id":"s_1","title":"T","providerId":"p","modelId":"m","updatedAt":9,
          "queue":["one",{"text":"two","images":["data:"]}],
          "messages":[
            {"id":"u","role":"user","content":"hi","createdAt":1,"images":["x","y"]},
            {"id":"a","role":"assistant","content":"","toolCalls":[{"id":"c1","name":"bash","input":{"command":"ls"}}]},
            {"id":"t","role":"tool","content":"","toolResult":{"toolCallId":"c1","output":"file","isError":false}}
          ]}"""))!!
        assertEquals(listOf("one", "two"), s.queue)
        assertEquals(2, s.messages[0].imageCount)
        assertEquals("bash", s.messages[1].toolCalls.single().name)
        assertEquals("file", s.messages[2].toolResult!!.output)
        assertNull(Session.from(json("null")))
    }

    @Test fun `defaults read only the model fields`() {
        assertEquals(RemoteDefaults("p", "m"), RemoteDefaults.from(json("""{"defaultProviderId":"p","defaultModelId":"m","providers":[{"apiKey":"sk"}]}""")))
    }

    @Test fun `pending map decodes approvals and questions`() {
        val m = PendingInput.map(json("""{"s1":{"sessionId":"s1","approval":{"call":{"id":"c","name":"bash","input":{"command":"rm -rf x"}},"reason":"deletes files","severity":"high","requestedAt":1}},
          "s2":{"sessionId":"s2","question":{"callId":"q","askedAt":2,"questions":[{"id":"q1","header":"Scope","question":"Which?","options":[{"label":"A","description":"a"},{"label":"B"}],"multiSelect":true}]}}}"""))
        assertEquals(Severity.HIGH, m["s1"]!!.approval!!.severity)
        val q = m["s2"]!!.question!!
        assertEquals("q", q.callId)
        assertTrue(q.questions.single().multiSelect)
        assertEquals(listOf("A", "B"), q.questions.single().options.map { it.label })
    }

    @Test fun `agent events decode, unknown types are tolerated`() {
        assertEquals(AgentEvent.Text("s", "hi"), AgentEvent.from(json("""{"type":"text","sessionId":"s","delta":"hi"}""")))
        assertTrue(AgentEvent.from(json("""{"type":"tool_approval_required","sessionId":"s","call":{"id":"c","name":"bash","input":{}},"reason":"r","severity":"medium"}""")) is AgentEvent.ApprovalRequired)
        assertEquals(AgentEvent.Other("s", "compaction"), AgentEvent.from(json("""{"type":"compaction","sessionId":"s","progress":{}}""")))
        assertNull(AgentEvent.from(json("""{"type":"text"}""")))
    }

    @Test fun `answers encode like shared AskAnswer`() {
        assertEquals("""{"questionId":"q1","labels":["A"],"note":"more"}""", AskAnswer("q1", listOf("A"), "more").toJson().toString())
        assertEquals("""{"questionId":"q1","labels":[]}""", AskAnswer("q1", emptyList(), " ").toJson().toString())
    }

    @Test fun `skills decode from the computer's phone view, skipping nameless entries`() {
        val list = SkillSummary.list(json("""[{"name":"review","description":"Review","category":"Code quality","source":"builtin"},{"description":"x"},{"name":"tidy"}]"""))
        assertEquals(listOf(SkillSummary("review", "Review", "Code quality", "builtin"), SkillSummary("tidy", "", "", "")), list)
        assertEquals(emptyList<SkillSummary>(), SkillSummary.list(json("null")))
    }

    @Test fun `a skill turn sends the name and the input, never a template`() {
        val review = SkillSummary("review", "", "", "builtin")
        assertEquals(
            """{"sessionId":"s","providerId":"p","modelId":"m","text":"this file","skill":{"name":"review","input":"this file"}}""",
            sendOptions("s", "p", "m", "this file", review).toString(),
        )
        assertEquals("""{"sessionId":"s","providerId":"p","modelId":"m","text":"hi"}""", sendOptions("s", "p", "m", "hi").toString())
        assertEquals("""{"text":"","skill":{"name":"review","input":""}}""", queuePrompt("", review).toString())
        assertEquals("\"plain\"", queuePrompt("plain").toString())
    }

    /** Every channel the phone calls must be one the computer lets a phone call (#529's allowlist). */
    @Test fun `the computer allows every channel and setting the phone uses`() {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/src/phone-access.json")
        if (!f.exists()) return
        val policy = json(f.readText()).obj()!!
        val channels = policy["channels"].arr()!!.map { (it as kotlinx.serialization.json.JsonPrimitive).content }.toSet()
        for (ch in Channels.ALL) assertTrue("the computer refuses $ch from a phone", ch in channels)
        val keys = policy["settingsKeys"].arr()!!.map { (it as kotlinx.serialization.json.JsonPrimitive).content }.toSet()
        val patch = PcSettings.patch(PcSettings.ChatMode.YOLO, PcSettings.ChatAction.DELETE, skipConfirm = true)
        for (k in patch.keys) assertTrue("the computer refuses setting $k from a phone", k in keys)
        val modes = policy["chatModes"].arr()!!.map { (it as kotlinx.serialization.json.JsonPrimitive).content }.toSet()
        for (m in PcSettings.ChatMode.entries) assertTrue("the computer refuses chat mode ${m.wire} from a phone", m.wire in modes)
        val skill = SkillSummary("r", "", "", "")
        val sendKeys = policy["chatSendKeys"].arr()!!.map { (it as kotlinx.serialization.json.JsonPrimitive).content }.toSet()
        for (k in sendOptions("s", "p", "m", "x", skill).keys) assertTrue("the computer refuses chat:send $k", k in sendKeys)
        val queueKeys = policy["queueKeys"].arr()!!.map { (it as kotlinx.serialization.json.JsonPrimitive).content }.toSet()
        for (k in queuePrompt("x", skill).obj()!!.keys) assertTrue("the computer refuses chat:queue $k", k in queueKeys)
    }

    @Test fun `pc settings read only the phone-visible keys, unset keys use the computer's defaults`() {
        val full = PcSettings.from(json("""{"defaultChatMode":"yolo","chatPaneAction":"delete","skipDeleteConfirmation":true,"providers":[{"apiKey":"sk-x"}]}"""))
        assertEquals(PcSettings.ChatMode.YOLO, full.defaultChatMode)
        assertEquals(PcSettings.ChatAction.DELETE, full.effectiveAction)
        assertFalse(full.confirmDelete)
        assertFalse("nothing heard yet", PcSettings().known)
        assertTrue(full.known)
        val empty = PcSettings.from(json("""{"defaultChatMode":"sideways","skipDeleteConfirmation":"yes"}"""))
        assertNull(empty.defaultChatMode)
        assertEquals(PcSettings.ChatMode.GUARDRAILS, empty.effectiveMode)
        assertEquals(PcSettings.ChatAction.COMPLETE, empty.effectiveAction)
        assertTrue(empty.confirmDelete)
    }

    @Test fun `a settings patch carries only what changed`() {
        assertEquals("""{"defaultChatMode":"yolo"}""", PcSettings.patch(mode = PcSettings.ChatMode.YOLO).toString())
        assertEquals("""{"skipDeleteConfirmation":false}""", PcSettings.patch(skipConfirm = false).toString())
    }

    @Test fun `voice reads only whether Whisper is installed and switched on`() {
        assertTrue(VoiceInstall.from(json("""{"installed":true,"installing":false,"progress":1,"modelPath":"/Users/me/x.bin"}""")).installed)
        assertFalse(VoiceInstall.from(json("""{"installing":true}""")).installed)
        assertTrue(PcSettings.from(json("""{"voice":{"enabled":true,"language":"it"}}""")).voiceEnabled)
        assertFalse(PcSettings.from(json("""{"voice":{}}""")).voiceEnabled)
        assertFalse(PcSettings.from(json("""{}""")).voiceEnabled)
    }

    @Test fun `the wav goes as unsigned byte values, like the desktop`() {
        assertEquals("[82,73,255,0,128]", wavArg(byteArrayOf(82, 73, -1, 0, -128)).toString())
    }
}
