package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.ChatProjector
import com.nekko.android.chat.ChatState
import com.nekko.android.chat.DeltaCoalescer
import com.nekko.android.ui.screens.TranscriptCache
import com.nekko.android.ui.screens.transcriptRows
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Block
import com.nekko.protocol.ChatMessage
import com.nekko.protocol.LiveTurn
import com.nekko.protocol.QuestionReplies
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.Session
import com.nekko.protocol.ToolCall
import com.nekko.protocol.ToolResult
import com.nekko.protocol.Transcript
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Test

class ChatProjectorTest {
    private val env = ChatEnv(RelayState.ONLINE, null, RemoteDefaults("openai", "gpt-x"), "Mac")

    private fun session(turns: Int = 3): Session {
        val messages = ArrayList<ChatMessage>()
        for (i in 0 until turns) {
            messages += ChatMessage("u$i", "user", "prompt $i")
            messages += ChatMessage("a$i", "assistant", "looking $i", toolCalls = listOf(ToolCall("c$i", "bash", buildJsonObject { put("command", "ls $i") })))
            messages += ChatMessage("t$i", "tool", "", toolResult = ToolResult("c$i", "out $i", false))
            messages += ChatMessage("r$i", "assistant", "reply $i")
        }
        return Session("s1", "Chat", "openai", "gpt-x", null, messages, 0, emptyList(), 1L)
    }

    /** What the screen showed before the projector: the whole merge, every time. */
    private fun full(session: Session, turn: LiveTurn) =
        QuestionReplies.project(Transcript.mergeLive(Transcript.fromMessages(session.messages), turn.blocks))

    @Test
    fun savedTranscriptIsParsedOncePerSessionNotPerToken() {
        val s = session()
        val projector = ChatProjector()
        var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "next")))
        repeat(50) { k ->
            turn = Transcript.apply(turn, AgentEvent.Text("s1", "w$k "))
            ChatController.project(ChatState(session = s, turn = turn), env, projector)
        }
        assertEquals(1, projector.parses)
        // A re-read session is a new instance: parsed again, once.
        ChatController.project(ChatState(session = session(), turn = turn), env, projector)
        assertEquals(2, projector.parses)
    }

    @Test
    fun patchedBlocksAlwaysEqualTheFullMerge() {
        val s = session()
        val projector = ChatProjector()
        var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "next")))
        val events = buildList<AgentEvent> {
            repeat(5) { add(AgentEvent.Text("s1", "w$it ")) }
            add(AgentEvent.ToolCallStarted("s1", ToolCall("live-c", "bash", buildJsonObject { put("command", "pwd") })))
            add(AgentEvent.ToolResultReady("s1", ToolResult("live-c", "/tmp", false)))
            repeat(5) { add(AgentEvent.Reasoning("s1", "r$it ")) }
            repeat(5) { add(AgentEvent.Text("s1", "x$it ")) }
            add(AgentEvent.Done("s1", null))
        }
        for (e in events) {
            turn = Transcript.apply(turn, e)
            val ui = ChatController.project(ChatState(session = s, turn = turn), env, projector)
            assertEquals(full(s, turn), ui.blocks)
        }
    }

    @Test
    fun layoutHoldsWhileOneReplyGrowsAndChangesWhenAnythingElseDoes() {
        val s = session()
        val projector = ChatProjector()
        var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "next")))
        fun step(e: AgentEvent): Int {
            turn = Transcript.apply(turn, e)
            return ChatController.project(ChatState(session = s, turn = turn), env, projector).layout
        }
        val first = step(AgentEvent.Text("s1", "a "))
        assertEquals(first, step(AgentEvent.Text("s1", "b ")))
        assertEquals(first, step(AgentEvent.Text("s1", "c ")))
        val tool = step(AgentEvent.ToolCallStarted("s1", ToolCall("live-c", "bash", buildJsonObject { put("command", "pwd") })))
        assertNotEquals(first, tool)
        assertEquals(tool, step(AgentEvent.Usage("s1", 1, 1)))
        val next = step(AgentEvent.Text("s1", "after "))
        assertNotEquals(tool, next)
        assertEquals(next, step(AgentEvent.Text("s1", "more ")))
    }

    @Test
    fun aGrowingReplyThatEqualsASavedReplyOfThisTurnIsStillHidden() {
        // mergeLive hides a live reply the saved turn already holds; the patch must not bring it back.
        val saved = Session("s1", "Chat", "openai", "gpt-x", null, listOf(
            ChatMessage("u0", "user", "prompt"),
            ChatMessage("r0", "assistant", "Done"),
        ), 0, emptyList(), 1L)
        val projector = ChatProjector()
        var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "prompt")))
        for (delta in listOf("Do", "ne", " and more")) {
            turn = Transcript.apply(turn, AgentEvent.Text("s1", delta))
            val ui = ChatController.project(ChatState(session = saved, turn = turn), env, projector)
            assertEquals(full(saved, turn), ui.blocks)
        }
    }

    @Test
    fun savedBlocksKeepTheirInstancesAcrossTokens() {
        val s = session()
        val projector = ChatProjector()
        var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "next")))
        turn = Transcript.apply(turn, AgentEvent.Text("s1", "a "))
        val a = ChatController.project(ChatState(session = s, turn = turn), env, projector).blocks
        turn = Transcript.apply(turn, AgentEvent.Text("s1", "b "))
        val b = ChatController.project(ChatState(session = s, turn = turn), env, projector).blocks
        for (i in 0 until a.size - 1) assertSame(a[i], b[i])
        assertNotEquals(a.last(), b.last())
    }

    @Test
    fun screenKeepsKeysRowsAndVoicesOfEarlierBlocks() {
        val s = session()
        val projector = ChatProjector()
        val cache = TranscriptCache()
        var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "next")))
        fun frame(delta: String): Pair<List<Pair<String, Block>>, List<com.nekko.android.ui.screens.TranscriptRow>> {
            turn = Transcript.apply(turn, AgentEvent.Text("s1", delta))
            val ui = ChatController.project(ChatState(session = s, turn = turn), env, projector)
            val keyed = cache.keyed(ui.blocks, ui.layout)
            // The same keys the screen would build from scratch.
            assertEquals(TranscriptCache().keyed(ui.blocks, 0), keyed)
            val rows = cache.rows(transcriptRows(keyed, true, ui.running, emptySet(), ui.footers))
            assertEquals(transcriptRows(keyed, true, ui.running, emptySet(), ui.footers), rows)
            assertEquals(ReplyTopics.voices(ui.blocks, ui.running), ReplyTopics.voices(ui.blocks, ui.running, cache::midTurnVoice))
            return keyed to rows
        }
        val (k1, r1) = frame("a ")
        val (k2, r2) = frame("b ")
        for (i in 0 until k1.size - 1) assertSame(k1[i], k2[i])
        for (i in 0 until r1.size - 1) assertSame(r1[i], r2[i])
        assertNotEquals(r1.last(), r2.last())
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun wordsBetweenFramesAreJoinedAndOrderIsKept() = runTest {
        val applied = ArrayList<AgentEvent>()
        var frames = CompletableDeferred<Unit>()
        val c = DeltaCoalescer(backgroundScope, "s1", { frames.await() }) { applied += it }
        c.accept(AgentEvent.Text("s1", "a"))
        c.accept(AgentEvent.Text("s1", "b"))
        c.accept(AgentEvent.Text("s1", "c"))
        runCurrent()
        assertEquals(emptyList<AgentEvent>(), applied)
        frames.complete(Unit)
        runCurrent()
        assertEquals(listOf<AgentEvent>(AgentEvent.Text("s1", "abc")), applied)

        // Another kind of event, or reasoning after text, flushes the words before it.
        applied.clear()
        frames = CompletableDeferred()
        c.accept(AgentEvent.Text("s1", "x"))
        c.accept(AgentEvent.Reasoning("s1", "think"))
        c.accept(AgentEvent.Text("s1", "y"))
        c.accept(AgentEvent.Done("s1", null))
        assertEquals(
            listOf(AgentEvent.Text("s1", "x"), AgentEvent.Reasoning("s1", "think"), AgentEvent.Text("s1", "y"), AgentEvent.Done("s1", null)),
            applied,
        )
        // Another chat's events pass straight through.
        applied.clear()
        c.accept(AgentEvent.Text("other", "z"))
        assertEquals(listOf<AgentEvent>(AgentEvent.Text("other", "z")), applied)
    }
}
