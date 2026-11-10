package com.nekko.android.ui.screens

import com.nekko.protocol.Block
import com.nekko.protocol.ToolStatus
import com.nekko.protocol.TurnDetails
import com.nekko.protocol.TurnStats
import org.junit.Assert.assertEquals
import org.junit.Test

/** #2112: where a finished reply's metrics sit among the chat's rows (the iPhone's TurnDetailsRowTests). */
class TurnFootersRowsTest {
    private val stats = TurnStats("anthropic", "claude", null, 10.0, 5.0, null, null, null, 1000.0, 1.0, "complete")
    private fun details(id: String) = TurnDetails(id, stats, true)
    private val keyed = listOf(
        "user:u1" to Block.User("u1", "Fix the build", 1),
        "assistant:r1" to Block.Assistant("r1", "", reasoning = "Thinking", at = 2),
        "tool:t1" to Block.Tool("t1", "bash", "Run tests", ToolStatus.OK),
        "tool:t2" to Block.Tool("t2", "bash", "Run tests again", ToolStatus.OK),
        "user:u2" to Block.User("u2", "Thanks", 3),
        "assistant:r2" to Block.Assistant("r2", "You're welcome", at = 4),
    )
    private val footers = mapOf("t2" to details("r1"), "r2" to details("r2"))

    private fun kinds(rows: List<TranscriptRow>) = rows.map {
        when (it) {
            is TranscriptRow.Footer -> "footer:" + it.details.id
            is TranscriptRow.Steps -> "steps"
            is TranscriptRow.Run -> "run"
        }
    }

    @Test fun `detailed shows one footer after each reply's last block and it ends the purpose group`() {
        val rows = transcriptRows(keyed, showSteps = true, running = false, open = emptySet(), footers = footers)
        assertEquals(listOf("run", "run", "run", "footer:r1", "run", "run", "footer:r2"), kinds(rows))
    }

    @Test fun `simple's folded steps keep the footer, once, and opening them does not repeat it`() {
        val closed = kinds(transcriptRows(keyed, showSteps = false, running = false, open = emptySet(), footers = footers))
        assertEquals(1, closed.count { it == "footer:r1" })
        assertEquals("footer:r1", closed[closed.indexOf("steps") + 1])
        val opened = kinds(transcriptRows(keyed, showSteps = false, running = false, open = setOf("assistant:r1"), footers = footers))
        assertEquals(1, opened.count { it == "footer:r1" })
        assertEquals(listOf("footer:r1", "footer:r2"), opened.filter { it.startsWith("footer") })
    }

    @Test fun `no stats, no footer`() {
        assertEquals(0, kinds(transcriptRows(keyed, showSteps = true, running = false, open = emptySet())).count { it.startsWith("footer") })
    }
}
