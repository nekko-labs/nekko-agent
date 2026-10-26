package com.nekko.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Block
import com.nekko.protocol.ToolStatus
import com.nekko.android.ui.chat.PurposeGroupCard
import com.nekko.protocol.Purpose
import com.nekko.protocol.PurposeRun
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Offline renderer evidence. Debug source set only; no pairing or relay calls. */
class PurposeEvidenceActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val blocks = listOf(
            Block.User("prompt", "Read the guidance, inspect the files, and run the tests."),
            tool("guide1", "read_file", "AGENTS.md", "Project rules loaded."),
            tool("guide2", "read_file", "CLAUDE.md", "See AGENTS.md."),
            Block.Assistant("thought", "I’ll inspect the implementation next."),
            tool("read1", "read_file", "src/chat.ts", "export const chat = true;"),
            tool("read2", "read_file", "src/tools.ts", "export const tools = [];"),
            Block.Assistant("check", "Now I’ll check the result."),
            tool("test1", "bash", "npm test", "12 tests passed"),
            tool("test2", "bash", "npm run lint", "Lint failed: unused import", ToolStatus.ERROR),
            Block.Assistant("reply", "The guidance and implementation are reviewed. Lint needs a small fix."),
        )
        setContent {
            NekkoTheme(dark = false) {
                Column(Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding()) {
                    Text("Purpose grouping", style = MaterialTheme.typography.titleLarge,
                        color = Nekko.palette.ink, modifier = Modifier.padding(16.dp))
                    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Purpose.group(blocks) { Purpose.role(it) }.forEach { run ->
                            item {
                                when (run) {
                                    is PurposeRun.Single -> BlockView(run.item)
                                    is PurposeRun.Group -> PurposeGroupCard(run.purpose, run.items, run.calls)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun tool(id: String, name: String, value: String, output: String,
        status: ToolStatus = ToolStatus.OK): Block.Tool =
        Block.Tool(id, name, value, status, output , input = JsonObject(mapOf((if (name == "bash") "command" else "path") to JsonPrimitive(value))))
}
