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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.ChatState
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.PurposeGroupCard
import com.nekko.android.ui.screens.TranscriptCache
import com.nekko.android.ui.screens.TranscriptRow
import com.nekko.android.ui.screens.rowKey
import com.nekko.android.ui.screens.transcriptRows
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.ChatMessage
import com.nekko.protocol.PurposeRun
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.Session
import com.nekko.protocol.ToolCall
import com.nekko.protocol.ToolResult
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A 300-message chat drawn by the chat's real blocks, for the Macrobenchmark and the Baseline Profile
 * generator in `:baselineprofile`. Only in the `benchmarkRelease` and `nonMinifiedRelease` variants.
 */
class LongChatBenchmarkActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val session = longSession(300)
        setContent { NekkoTheme(dark = false) { LongChat(session) } }
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

@Composable
private fun LongChat(session: Session) {
    val env = remember { ChatEnv(RelayState.ONLINE, null, RemoteDefaults("openai", "gpt-x"), "Mac") }
    val ui = remember { ChatController.project(ChatState(session = session), env) }
    val cache = remember { TranscriptCache() }
    val keyed = cache.keyed(ui.blocks, ui.layout)
    val rows = cache.rows(transcriptRows(keyed, true, false, emptySet(), ui.footers))
    val voices = keyed.map { it.first }.zip(ReplyTopics.voices(ui.blocks, false, cache::midTurnVoice)).toMap()
    LazyColumn(
        Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding()
            .semantics { testTagsAsResourceId = true }.testTag("chat-list"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        itemsIndexed(rows, key = { _, row -> rowKey(row) }) { _, row ->
            when (val run = (row as? TranscriptRow.Run)?.run) {
                is PurposeRun.Single -> BlockView(run.item.second, voice = voices[run.item.first])
                is PurposeRun.Group -> PurposeGroupCard(run.purpose, run.items.map { it.second }, run.calls)
                else -> Unit
            }
        }
    }
}
