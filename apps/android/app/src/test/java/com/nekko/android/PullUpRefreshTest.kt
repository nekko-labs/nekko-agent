package com.nekko.android

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import com.nekko.android.ui.chat.PullUpRefreshState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2117: pull up past the newest message to refresh a chat (the iPhone's #1779). */
class PullUpRefreshTest {
    private var atEnd = true
    private var refreshes = 0
    private val state = PullUpRefreshState(threshold = 100f, atEnd = { atEnd }).apply { onRefresh = { refreshes++ } }
    private fun drag(dy: Float, source: NestedScrollSource = NestedScrollSource.UserInput) =
        state.connection.onPostScroll(Offset.Zero, Offset(0f, dy), source)

    @Test fun `a pull past the threshold at the end refreshes once on release`() {
        drag(-150f)
        assertEquals(75f, state.pulled)
        assertFalse(state.armed)
        drag(-60f)
        assertTrue(state.armed)
        state.release()
        assertEquals(1, refreshes)
        assertTrue(state.refreshing)
        assertEquals(0f, state.pulled)
    }

    @Test fun `a short pull does nothing`() {
        drag(-100f)
        state.release()
        assertEquals(0, refreshes)
        assertFalse(state.refreshing)
    }

    @Test fun `scrolling history or a fling's leftover never pulls`() {
        atEnd = false
        drag(-300f)
        assertEquals(0f, state.pulled)
        atEnd = true
        drag(-300f, NestedScrollSource.SideEffect)
        assertEquals(0f, state.pulled)
        // Dragging down (toward older messages) is not a pull either.
        drag(300f)
        assertEquals(0f, state.pulled)
    }

    @Test fun `dragging back down takes the pull back before the list moves`() {
        drag(-240f)
        assertTrue(state.armed)
        val taken = state.connection.onPreScroll(Offset(0f, 100f), NestedScrollSource.UserInput)
        assertEquals(100f, taken.y)
        assertEquals(70f, state.pulled)
        state.release()
        assertEquals(0, refreshes)
    }

    @Test fun `one refresh at a time, from the pull or the mascot`() {
        state.refresh()
        state.refresh()
        drag(-300f)
        assertEquals("No pull while refreshing", 0f, state.pulled)
        state.release()
        assertEquals(1, refreshes)
        state.refreshing = false
        state.refresh()
        assertEquals(2, refreshes)
    }
}
