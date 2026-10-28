package com.nekko.android

import com.nekko.android.chat.TurnSteps
import com.nekko.android.chat.TurnSteps.Row
import com.nekko.protocol.Block
import com.nekko.protocol.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/** Simple's one line per turn for its reasoning and tool steps. */
class TurnStepsTest {
    @Test fun `the summary line`() {
        assertEquals("Took 4 steps · 12s", TurnSteps.label(4, running = false, durationMs = 12_300))
        assertEquals("Took 1 step", TurnSteps.label(1, running = false, durationMs = null))
        assertEquals("Working · 2 steps so far", TurnSteps.label(2, running = true, durationMs = 5_000))
        assertEquals("Working · 1 step so far", TurnSteps.label(1, running = true, durationMs = null))
    }

    @Test fun `durations`() {
        assertEquals("1s", TurnSteps.duration(200))
        assertEquals("59s", TurnSteps.duration(59_000))
        assertEquals("1m 5s", TurnSteps.duration(65_000))
        assertEquals("2m", TurnSteps.duration(120_000))
        assertEquals("1h 3m", TurnSteps.duration(3_780_000))
        assertEquals("2h", TurnSteps.duration(7_200_000))
    }

    private val turn = listOf(
        Block.User("u1", "Make the tests pass", at = 1_000),
        Block.Assistant("a1", "", reasoning = "Look at the tests first.", at = 2_000),
        Block.Tool("t1", "bash", "Ran npm test", ToolStatus.OK),
        Block.Tool("t2", "edit", "Edited login.ts", ToolStatus.OK),
        Block.Assistant("a2", "All 42 tests pass now.", at = 13_000),
        Block.User("u2", "Thanks"),
        Block.Assistant("a3", "You're welcome."),
    )

    private fun fold(blocks: List<Block>, running: Boolean = false, open: Set<String> = emptySet()) =
        TurnSteps.fold(blocks, { it }, { it.id }, running, open)

    @Test fun `a turn's steps fold into one line where the first step was`() {
        val rows = fold(turn)
        assertEquals(
            listOf("u1", "steps:a1", "a2", "u2", "a3"),
            rows.map { if (it is Row.Summary) "steps:${it.turn}" else ((it as Row.Item).item.id) },
        )
        val s = rows[1] as Row.Summary
        assertEquals(3, s.steps)
        assertEquals(12_000L, s.durationMs)
        assertEquals(false, s.open)
    }

    @Test fun `an open turn shows its steps in place, the rest stays folded`() {
        val rows = fold(turn, open = setOf("a1"))
        assertEquals(listOf("u1", "steps:a1", "a1", "t1", "t2", "a2", "u2", "a3"), rows.map { if (it is Row.Summary) "steps:${it.turn}" else (it as Row.Item).item.id })
        assertEquals(true, (rows[2] as Row.Item).stepsOpen)
        assertEquals(false, (rows.last() as Row.Item).stepsOpen)
    }

    @Test fun `a running turn counts its steps so far and has no duration`() {
        val live = listOf(Block.User("u1", "Go", at = 1_000), Block.Tool("t1", "bash", "Ran ls", ToolStatus.RUNNING))
        val s = fold(live, running = true).filterIsInstance<Row.Summary<Block>>().single()
        assertEquals(1, s.steps)
        assertEquals(true, s.running)
        assertEquals(null, s.durationMs)
    }
}
