package com.nekko.protocol

import com.nekko.protocol.ConnectChecklist.Item
import com.nekko.protocol.ConnectChecklist.Shown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The iPhone's ConnectChecklistTests (#2921), case for case. */
class ConnectChecklistTest {
    private fun checklist(s: Shown) = (s as? Shown.Checklist)?.rows ?: error("expected the checklist, got $s")

    @Test fun `first message with nothing connected shows every row and the folder waits`() {
        val rows = checklist(ConnectChecklist.shown(null, null, null, null, sentBefore = false, closed = false))
        assertEquals(listOf(Item.COMPUTER, Item.FOLDER, Item.GIT, Item.TASKS), rows.map { it.item })
        assertEquals(0, rows.count { it.isDone })
        assertTrue(rows.first { it.item == Item.FOLDER }.waiting)
    }

    @Test fun `done rows name what got connected`() {
        val rows = checklist(ConnectChecklist.shown("MacBook Pro", "nekko-agent", null, null, sentBefore = false, closed = false))
        assertEquals(listOf("MacBook Pro", "nekko-agent", null, null), rows.map { it.done })
        assertFalse(rows.any { it.waiting })
    }

    @Test fun `all done or closed shows nothing`() {
        assertEquals(Shown.Nothing, ConnectChecklist.shown("Mac", "app", "GitHub", "Linear", sentBefore = false, closed = false))
        assertEquals(Shown.Nothing, ConnectChecklist.shown(null, null, null, null, sentBefore = false, closed = true))
        assertEquals(Shown.Nothing, ConnectChecklist.shown(null, null, null, null, sentBefore = true, closed = true))
    }

    @Test fun `after the first message the note shows only while nothing is connected`() {
        assertEquals(Shown.Note, ConnectChecklist.shown(null, null, null, null, sentBefore = true, closed = false))
        // A task tool alone gives Nekko no files or tools to use.
        assertEquals(Shown.Note, ConnectChecklist.shown(null, null, null, "Linear", sentBefore = true, closed = false))
        assertEquals(Shown.Nothing, ConnectChecklist.shown("gomi", null, null, null, sentBefore = true, closed = false))
        assertEquals(Shown.Nothing, ConnectChecklist.shown(null, null, "GitHub", null, sentBefore = true, closed = false))
    }

    @Test fun `sent before counts any exchange and unknown counts`() {
        assertFalse(ConnectChecklist.sentBefore(false, emptyList()))
        assertFalse(ConnectChecklist.sentBefore(false, listOf(0L, 0L)))
        assertTrue(ConnectChecklist.sentBefore(false, listOf(0L, 3L)))
        assertTrue(ConnectChecklist.sentBefore(false, listOf(null)))
        assertTrue(ConnectChecklist.sentBefore(true, emptyList()))
    }
}
