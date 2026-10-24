package com.nekko.protocol

import com.nekko.protocol.PaneContent.Chat
import com.nekko.protocol.PaneContent.Chats
import com.nekko.protocol.PaneContent.Monitors
import com.nekko.protocol.PaneSide.FIRST
import com.nekko.protocol.PaneSide.SECOND
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pane rules of spec/phone/folding-phones-two-chats-and-monitors.md, *Panes* and *Vertical mode*. */
class PanesTest {
    private val vertical = Hinge(Hinge.Bounds(420f, 0f, 0f, 840f), Hinge.State.FLAT, Hinge.Orientation.VERTICAL)
    private val tabletop = Hinge(Hinge.Bounds(0f, 420f, 840f, 0f), Hinge.State.HALF_OPENED, Hinge.Orientation.HORIZONTAL)

    @Test fun `the first open is Chats + Chat`() {
        assertEquals(PaneArrangement.CHATS_CHAT, PaneLayout.DEFAULT.arrangement)
        assertEquals(Chats, PaneLayout.DEFAULT.first)
        assertEquals(SECOND, PaneLayout.DEFAULT.focused)
    }

    @Test fun `arrangements read either way round`() {
        assertEquals(PaneArrangement.CHAT_CHAT, PaneArrangement.of(Chat("a"), Chat(null)))
        assertEquals(PaneArrangement.CHAT_MONITORS, PaneArrangement.of(Monitors, Chat("a")))
        assertEquals(PaneArrangement.CHATS_CHAT, PaneArrangement.of(Chat("a"), Chats))
        assertEquals(PaneArrangement.MONITORS_CHATS, PaneArrangement.of(Chats, Monitors))
        assertNull(PaneArrangement.of(Chats, Chats))
    }

    @Test fun `each posture gets its mode, a separating hinge always divides the panes`() {
        assertEquals(PaneMode.ONE, PaneMode.of(Posture.CLOSED, null))
        assertEquals(PaneMode.SIDE_BY_SIDE, PaneMode.of(Posture.OPEN_WIDE, null))
        assertEquals(PaneMode.SIDE_BY_SIDE, PaneMode.of(Posture.BOOK, vertical.copy(state = Hinge.State.HALF_OPENED)))
        assertEquals(PaneMode.STACKED, PaneMode.of(Posture.OPEN_TALL, null))
        assertEquals(PaneMode.TABLETOP, PaneMode.of(Posture.TABLETOP, tabletop))
        // Surface Duo: two screens side by side with the gap down the middle, though the window is tall.
        val duoTall = Hinge(Hinge.Bounds(540f, 0f, 34f, 720f), Hinge.State.FLAT, Hinge.Orientation.VERTICAL, isSeparating = true)
        assertEquals(PaneMode.SIDE_BY_SIDE, PaneMode.of(Posture.OPEN_TALL, duoTall))
        val duoWide = Hinge(Hinge.Bounds(0f, 540f, 720f, 34f), Hinge.State.FLAT, Hinge.Orientation.HORIZONTAL, isSeparating = true)
        assertEquals(PaneMode.STACKED, PaneMode.of(Posture.OPEN_WIDE, duoWide))
    }

    @Test fun `the divider sits on a hinge along the split, else drags between 35 and 65`() {
        val onFold = PaneSplit.of(PaneMode.SIDE_BY_SIDE, 840f, 840f, vertical, 0.3f)
        assertEquals(PaneSplit(420f, 0f, onHinge = true), onFold)
        val duo = Hinge(Hinge.Bounds(540f, 0f, 34f, 720f), Hinge.State.FLAT, Hinge.Orientation.VERTICAL, isSeparating = true)
        val gap = PaneSplit.of(PaneMode.SIDE_BY_SIDE, 1114f, 720f, duo, 0.5f)
        assertEquals(540f, gap.first)
        assertEquals(574f, gap.secondStart)
        assertTrue(gap.onHinge)
        // Tabletop: the hinge across the screen is where the transcript stops.
        assertEquals(PaneSplit(420f, 0f, onHinge = true), PaneSplit.of(PaneMode.TABLETOP, 840f, 840f, tabletop, 0.5f))
        // A hinge across a side-by-side split can't be the divider: drag it, held to 35–65.
        val across = PaneSplit.of(PaneMode.SIDE_BY_SIDE, 1000f + PaneSplit.DIVIDER_DP, 900f, tabletop.copy(state = Hinge.State.FLAT), 0.9f)
        assertFalse(across.onHinge)
        assertEquals(650f, across.first, 0.01f)
        assertEquals(350f, PaneSplit.of(PaneMode.STACKED, 1000f, 1000f + PaneSplit.DIVIDER_DP, null, 0.1f).first, 0.01f)
        assertEquals(0.65f, PaneLayout.DEFAULT.withSplit(2f).split)
        assertEquals(0.5f, PaneLayout.clampSplit(Float.NaN))
    }

    @Test fun `swap trades the panes with their focus`() {
        val l = PaneLayout(Chat("a"), Monitors, focused = FIRST, zoomed = FIRST, split = 0.375f).swap()
        assertEquals(PaneLayout(Monitors, Chat("a"), focused = SECOND, zoomed = SECOND, split = 0.625f), l)
    }

    @Test fun `focus fills the screen with one pane and gives it the keyboard`() {
        val l = PaneLayout(Chat("a"), Chat("b"), focused = FIRST).zoom(SECOND)
        assertEquals(SECOND, l.zoomed)
        assertEquals(SECOND, l.focused)
        assertNull(l.zoom(null).zoomed)
        assertEquals(SECOND, l.zoom(null).focused)
    }

    @Test fun `replace never shows one chat in both panes`() {
        val l = PaneLayout(Chat("a"), Chat("b"))
        assertEquals(PaneLayout(Chat("a"), Monitors, focused = SECOND), l.replace(SECOND, Monitors))
        // Asking the left pane for b, which the right pane shows, trades them instead.
        val traded = l.replace(FIRST, Chat("b"))
        assertEquals(Chat("b"), traded.first)
        assertEquals(Chat("a"), traded.second)
        assertEquals(FIRST, traded.focused)
        assertEquals(PaneLayout(Chats, Chat("b"), focused = FIRST), l.back(FIRST))
    }

    @Test fun `a chat tapped in the list opens beside the list`() {
        val l = PaneLayout.DEFAULT.open("a", from = FIRST)
        assertEquals(PaneLayout(Chats, Chat("a"), focused = SECOND), l)
        // Monitors' running chats open in the other pane too.
        assertEquals(PaneLayout(Chat("x"), Monitors, focused = FIRST), PaneLayout(Chat("a"), Monitors).open("x", from = SECOND))
        // Monitors + Chats: the list's own pane becomes the chat, Monitors stays.
        assertEquals(PaneLayout(Monitors, Chat("x"), focused = SECOND), PaneLayout(Monitors, Chats).open("x", from = SECOND))
        // A chat already on screen only takes the focus.
        assertEquals(FIRST, PaneLayout(Chat("a"), Chat("b"), focused = SECOND).open("a", from = SECOND).focused)
    }

    @Test fun `a chat from outside the panes fills an empty or focused chat pane`() {
        assertEquals(Chat("x"), PaneLayout.DEFAULT.open("x").second)
        assertEquals(PaneLayout(Chat("x"), Monitors, focused = FIRST), PaneLayout(Chat("a"), Monitors).open("x"))
        assertEquals(PaneLayout(Chat("x"), Chat("b"), focused = FIRST), PaneLayout(Chat("a"), Chat("b"), focused = FIRST).open("x"))
        assertEquals(PaneLayout(Monitors, Chat("x"), focused = SECOND), PaneLayout(Monitors, Chats, focused = FIRST).open("x"))
    }

    @Test fun `rotating keeps both chats and makes the focused one the primary`() {
        val wide = PaneLayout(Chat("a"), Chat("b"), focused = SECOND)
        val tall = wide.forMode(PaneMode.STACKED, PaneMode.SIDE_BY_SIDE)
        assertEquals(PaneLayout(Chat("b"), Chat("a"), focused = FIRST, split = 0.5f), tall)
        // First open or the same mode: nothing moves.
        assertEquals(wide, wide.forMode(PaneMode.SIDE_BY_SIDE, null))
        assertEquals(wide, wide.forMode(PaneMode.SIDE_BY_SIDE, PaneMode.SIDE_BY_SIDE))
    }

    @Test fun `stacked, the chat list is never the bottom pane`() {
        // Chats + Chat → Chat over Monitors.
        assertEquals(PaneLayout(Chat("a"), Monitors, focused = FIRST), PaneLayout(Chats, Chat("a"), focused = SECOND).forMode(PaneMode.STACKED, null))
        // Monitors + Chats → Chats over Monitors.
        assertEquals(PaneLayout(Chats, Monitors, focused = SECOND), PaneLayout(Monitors, Chats, focused = FIRST).stacked())
        // Chat over Chats → Chat over Monitors.
        assertEquals(PaneLayout(Chat("a"), Monitors, focused = FIRST), PaneLayout(Chat("a"), Chats, focused = SECOND).stacked())
        // The list over an empty chat pane is fine: nothing lists under a chat.
        assertEquals(PaneLayout.DEFAULT, PaneLayout.DEFAULT.stacked())
        // Back in the top chat brings the list there, and a tap opens the chat in its place.
        val top = PaneLayout(Chat("a"), Monitors, focused = FIRST)
        val list = top.back(FIRST).normalized(PaneMode.STACKED)
        assertEquals(PaneLayout(Chats, Monitors, focused = FIRST), list)
        assertEquals(PaneLayout(Chat("b"), Monitors, focused = FIRST), list.open("b", from = FIRST).normalized(PaneMode.STACKED))
        // Side by side has no such rule.
        assertEquals(PaneLayout(Monitors, Chats), PaneLayout(Monitors, Chats).normalized(PaneMode.SIDE_BY_SIDE))
    }

    @Test fun `tabletop shows the focused pane alone, opening flat brings both back`() {
        val l = PaneLayout(Chat("a"), Chat("b"), focused = SECOND)
        val table = l.forMode(PaneMode.TABLETOP, PaneMode.SIDE_BY_SIDE)
        assertEquals(SECOND, table.zoomed)
        assertNull(table.forMode(PaneMode.SIDE_BY_SIDE, PaneMode.TABLETOP).zoomed)
    }

    @Test fun `the chat plus chat tip comes when a second chat opens over a running one`() {
        val before = PaneLayout(Chats, Chat("a"))
        val after = before.open("b", from = FIRST)
        assertEquals("a", before.tipFor(after, running = setOf("a")))
        assertNull(before.tipFor(after, running = emptySet()))
        assertNull(PaneLayout.DEFAULT.tipFor(PaneLayout.DEFAULT.open("b", FIRST), running = setOf("a")))
        val taken = after.chatBeside("a")
        assertEquals(PaneArrangement.CHAT_CHAT, taken.arrangement)
        assertEquals(listOf("a", "b"), taken.chatIds)
    }

    @Test fun `a forgotten chat leaves an empty chat pane`() {
        assertEquals(PaneLayout(Chat(null), Monitors), PaneLayout(Chat("a"), Monitors).forget("a"))
    }

    @Test fun `layouts are stored per computer, one line each`() {
        val m = mapOf(
            "pc-1" to PaneLayout(Chat("s-1"), Monitors, focused = FIRST, split = 0.4f),
            "pc-2" to PaneLayout(Monitors, Chats),
            "bad\tid" to PaneLayout.DEFAULT,
        )
        val text = PaneLayout.encodeAll(m)
        val back = PaneLayout.decodeAll(text)
        assertEquals(setOf("pc-1", "pc-2"), back.keys)
        assertEquals(m["pc-1"], back["pc-1"])
        assertEquals(m["pc-2"], back["pc-2"])
        // Focus (zoom) is not kept; a chat id that can't be stored becomes an empty chat pane.
        assertNull(PaneLayout.decode(PaneLayout(Chat("a"), Chats, zoomed = FIRST).encode())!!.zoomed)
        assertEquals(Chat(null), PaneLayout.decode(PaneLayout(Chat("a\nb"), Chats).encode())!!.first)
        // Lines this version can't read are skipped, a split out of range is held to it.
        assertTrue(PaneLayout.decodeAll("pc\tfiles\tchats\nnope\n").isEmpty())
        assertEquals(0.35f, PaneLayout.decode("chats\tmonitors\t0.01")!!.split)
        assertEquals(PaneLayout(Chats, Monitors), PaneLayout.decode("chats\tmonitors"))
    }
}
