package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatProjector
import com.nekko.android.ui.screens.TranscriptCache
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.ChatState
import com.nekko.android.ui.screens.transcriptRows
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Block
import com.nekko.protocol.ChatMessage
import com.nekko.protocol.LiveTurn
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.Session
import com.nekko.protocol.ToolCall
import com.nekko.protocol.ToolResult
import com.nekko.protocol.Transcript
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import java.io.File

class StreamingProjectionBench {
    private val env = ChatEnv(RelayState.ONLINE, null, RemoteDefaults("openai", "gpt-x"), "Mac")

    private fun longSession(n: Int): Session {
        val messages = ArrayList<ChatMessage>()
        var i = 0
        while (messages.size < n) {
            messages += ChatMessage("u$i", "user", "Please look at the build and fix the failing step number $i, then run the tests.")
            messages += ChatMessage("a$i", "assistant", "I will check it.\n\n## Summary\n" + "Some prose about the change. ".repeat(30), toolCalls = listOf(ToolCall("c$i", "bash", buildJsonObject { put("command", "npm test -- $i") })))
            messages += ChatMessage("t$i", "tool", "", toolResult = ToolResult("c$i", "line of output\n".repeat(150), false))
            messages += ChatMessage("a$i-b", "assistant", "Done. " + "The tests pass and the build is green again. ".repeat(25))
            i++
        }
        return Session("s1", "Fix the build", "openai", "gpt-x", null, messages, 0, emptyList(), 1L)
    }

    @Test
    fun perTokenProjection() {
        val session = longSession(300)
        // The full measurement only when asked for (NEKKO_BENCH_OUT=<file>); otherwise a quick smoke run.
        val measure = System.getenv("NEKKO_BENCH_OUT") != null
        val tokens = if (measure) 3000 else 200
        val report = StringBuilder()
        for (showSteps in listOf(true, false)) {
            fun run(): Double {
                var turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-1", "Now fix the next one")))
                // What the view model and the screen keep for the chat's life.
                val projector = ChatProjector()
                val cache = TranscriptCache()
                var open = 0
                val bean = java.lang.management.ManagementFactory.getThreadMXBean()
                val t0 = bean.currentThreadCpuTime
                for (k in 0 until tokens) {
                    turn = Transcript.apply(turn, AgentEvent.Text("s1", "word$k "))
                    val ui = ChatController.project(ChatState(session = session, turn = turn), env, projector)
                    // What ChatScreen recomputes per frame on a new ChatUi.
                    val keyed = cache.keyed(ui.blocks, ui.layout)
                    val rows = cache.rows(transcriptRows(keyed, showSteps, ui.running, emptySet(), ui.footers))
                    keyed.map { it.first }.zip(ReplyTopics.voices(ui.blocks, ui.running, cache::midTurnVoice)).toMap()
                    open += rows.size
                }
                return (bean.currentThreadCpuTime - t0) / 1e6 / tokens
            }
            if (measure) repeat(2) { run() } // warm up the JIT
            val samples = List(if (measure) 5 else 1) { run() }.sorted().let { if (it.size == 1) List(5) { _ -> it[0] } else it }
            report.append("showSteps=$showSteps messages=${session.messages.size} median_cpu_ms_per_token=%.3f min=%.3f max=%.3f\n".format(samples[2], samples[0], samples[4]))
        }
        println(report)
        System.getenv("NEKKO_BENCH_OUT")?.let { File(it).writeText(report.toString()) }
    }
}
