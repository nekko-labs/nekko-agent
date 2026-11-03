package com.nekko.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.PurposeGroupCard
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Block
import com.nekko.protocol.Purpose
import com.nekko.protocol.PurposeRun
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.ToolStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Offline evidence for spec/chat/thinking-and-replies.md: a working turn and a
 * plain one, drawn by the chat's real BlockView with the chat's own padding.
 * Debug source set only; `--ez dark true` for the dark theme.
 */
class ReplyVoicesEvidenceActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val dark = intent.getBooleanExtra("dark", false)
        val blocks = listOf(
            Block.User("prompt", "The login test is flaky on CI. Fix it."),
            Block.Assistant("note", "I'll read the test and the page it waits on first."),
            tool("read1", "read_file", "tests/login.spec.ts"),
            tool("read2", "grep", "waitForTimeout"),
            Block.Assistant("ask", "The signup test has the same fixed timer.\n\nShould I fix it there too, or keep this change to login?"),
            tool("test1", "bash", "npm test -- login"),
            Block.Assistant(
                "reply",
                "**Changes**\n- The login test waits for the sign-in request instead of a fixed 500 ms timer.\n\n" +
                    "**Verified**\n- `npm test -- login` passed 5 runs in a row.\n\n" +
                    "**Decision**: kept the 10 s overall timeout.\n\n" +
                    "**Run this**\n```bash\nnpm test -- login\n```\n\nWant me to open the PR?",
            ),
            Block.User("prompt2", "What did the old timer do?"),
            Block.Assistant("plain", "It waited half a second and hoped the page had loaded. On a slow runner it often had not."),
        )
        val voices = ReplyTopics.voices(blocks)
        setContent {
            NekkoTheme(dark = dark) {
                LazyColumn(
                    Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Purpose.group(blocks.withIndex().toList()) { Purpose.role(it.value) }.forEach { run ->
                        item {
                            when (run) {
                                is PurposeRun.Single -> BlockView(run.item.value, voice = voices[run.item.index])
                                is PurposeRun.Group -> PurposeGroupCard(run.purpose, run.items.map { it.value }, run.calls)
                            }
                        }
                    }
                }
            }
        }
    }

    private fun tool(id: String, name: String, value: String): Block.Tool =
        Block.Tool(id, name, value, ToolStatus.OK, "ok", input = JsonObject(mapOf((if (name == "bash") "command" else if (name == "grep") "pattern" else "path") to JsonPrimitive(value))))
}
