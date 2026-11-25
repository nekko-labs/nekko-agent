package com.nekko.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.ChatProjector
import com.nekko.android.chat.ChatState
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.PurposeGroupCard
import com.nekko.android.ui.screens.TranscriptCache
import com.nekko.android.ui.screens.TranscriptRow
import com.nekko.android.ui.screens.rowKey
import com.nekko.android.ui.screens.transcriptRows
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Block
import com.nekko.protocol.ChatMessage
import com.nekko.protocol.LiveTurn
import com.nekko.protocol.PurposeRun
import com.nekko.protocol.QuestionReplies
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.Session
import com.nekko.protocol.ToolCall
import com.nekko.protocol.ToolResult
import com.nekko.protocol.Transcript
import com.nekko.protocol.TurnDetails
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A 300-message chat drawn by the chat's real blocks, for the Macrobenchmark and the Baseline Profile
 * generator in `:baselineprofile`. Only in the `benchmarkRelease` and `nonMinifiedRelease` variants.
 *
 * Extra `mode`:
 * - `scroll` (default): the list as is; the benchmark flings it.
 * - `stream`: streams a long reply into the chat, a few tokens per frame, through the app's own path
 *   (`ChatProjector`, `TranscriptCache`).
 * - `stream-legacy`: the same, redoing everything per token as the app did before #3410 (parse the saved
 *   chat, merge, key and group every block, scan every reply's voice).
 * Shows "done" (test tag `done`) when the stream has ended.
 */
class LongChatBenchmarkActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mode = intent.getStringExtra("mode") ?: "scroll"
        val session = longSession(300)
        setContent { NekkoTheme(dark = false) { LongChat(session, mode) } }
    }
}

private fun longSession(n: Int): Session {
    val messages = ArrayList<ChatMessage>()
    var i = 0
    while (messages.size < n) {
        messages += ChatMessage("u$i", "user", "Please look at the build and fix the failing step number $i, then run the tests.")
        messages += ChatMessage(
            "a$i", "assistant", "I will check it.\n\n## Summary\n- Reads the failing step\n- Runs the tests again\n\n" + "Some prose about the change, with `code` and **bold**. ".repeat(12),
            toolCalls = listOf(ToolCall("c$i", "bash", buildJsonObject { put("command", "npm test -- $i") })),
        )
        messages += ChatMessage("t$i", "tool", "", toolResult = ToolResult("c$i", "line of output\n".repeat(40), false))
        messages += ChatMessage("r$i", "assistant", "Done. " + "The tests pass and the build is green again. ".repeat(10))
        i++
    }
    return Session("bench", "Fix the build", "openai", "gpt-x", null, messages, 0, emptyList(), 1L)
}

private const val STREAM_FRAMES = 300
private const val TOKENS_PER_FRAME = 3

@Composable
private fun LongChat(session: Session, mode: String) {
    val legacy = mode == "stream-legacy"
    val streaming = mode.startsWith("stream")
    val env = remember { ChatEnv(RelayState.ONLINE, null, RemoteDefaults("openai", "gpt-x"), "Mac") }
    val projector = remember { ChatProjector() }
    val cache = remember { TranscriptCache() }
    var turn by remember { mutableStateOf(LiveTurn(running = streaming, blocks = if (streaming) listOf(Block.User("pending", "Now fix the next one")) else emptyList())) }
    var done by remember { mutableStateOf(!streaming) }
    val list = rememberLazyListState()

    // What the screen shows: the new path keeps the saved blocks between tokens, the legacy one redoes it all.
    val ui = ChatController.project(ChatState(session = session, turn = turn), env, projector)
    val blocks: List<Block>
    val footers: Map<String, TurnDetails>
    if (legacy) {
        val saved = Transcript.fromMessages(session.messages)
        blocks = QuestionReplies.project(Transcript.mergeLive(saved, turn.blocks))
        footers = TurnDetails.footers(session.messages)
    } else {
        blocks = ui.blocks
        footers = ui.footers
    }
    val keyed = if (legacy) legacyKeyed(blocks) else cache.keyed(blocks, ui.layout)
    val rows = transcriptRows(keyed, true, ui.running, emptySet(), footers).let { if (legacy) it else cache.rows(it) }
    val voices = if (legacy) keyed.map { it.first }.zip(ReplyTopics.voices(blocks, ui.running)).toMap()
    else keyed.map { it.first }.zip(ReplyTopics.voices(blocks, ui.running, cache::midTurnVoice)).toMap()

    if (streaming) {
        LaunchedEffect(Unit) {
            list.scrollToItem(rows.size)
            repeat(STREAM_FRAMES) { f ->
                androidx.compose.runtime.withFrameNanos { }
                var t = turn
                repeat(TOKENS_PER_FRAME) { k -> t = Transcript.apply(t, AgentEvent.Text("bench", "token${f * TOKENS_PER_FRAME + k} ")) }
                turn = t
            }
            done = true
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding()
            .semantics { testTagsAsResourceId = true }.testTag("chat-list"),
        state = list,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        itemsIndexed(rows, key = { _, row -> rowKey(row) }) { _, row ->
            val run = (row as? TranscriptRow.Run)?.run
            when (run) {
                is PurposeRun.Single -> BlockView(run.item.second, voice = voices[run.item.first])
                is PurposeRun.Group -> PurposeGroupCard(run.purpose, run.items.map { it.second }, run.calls)
                else -> Unit
            }
        }
        if (done && streaming) item(key = "done") { Text("done", Modifier.testTag("done")) }
    }
}

/** The keys as the screen built them before the cache. */
private fun legacyKeyed(blocks: List<Block>): List<Pair<String, Block>> {
    val seen = HashMap<String, Int>()
    return blocks.map { b ->
        val base = "${b::class.simpleName}:${b.id}"
        val n = seen.getOrDefault(base, 0)
        seen[base] = n + 1
        (if (n > 0) "$base#$n" else base) to b
    }
}
