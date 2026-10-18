package com.nekko.android

import com.nekko.android.chat.PhotoTray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoTrayTest {
    @Test fun `at most four photos, the extra ones dropped with a note`() {
        val t = PhotoTray<Unit>()
        assertEquals(3, t.begin(3))
        repeat(3) { t.added("data:$it", Unit) }
        assertEquals(1, t.begin(5))
        assertEquals("Up to 4 photos per message.", t.state.value.error)
        t.added("data:3", Unit)
        assertEquals(4, t.state.value.photos.size)
        assertEquals(0, t.state.value.room)
        assertEquals(0, t.begin(1))
    }

    @Test fun `a photo being read keeps Send waiting, a failure says why`() {
        val t = PhotoTray<Unit>()
        t.begin(2)
        assertTrue(t.state.value.busy)
        t.added("data:a", Unit)
        assertTrue(t.state.value.busy)
        t.failed("Couldn’t read that image.")
        assertFalse(t.state.value.busy)
        assertEquals(listOf("data:a"), t.state.value.photos.map { it.dataUrl })
        assertEquals("Couldn’t read that image.", t.state.value.error)
    }

    @Test fun `remove, take for sending and restore after a failed send`() {
        val t = PhotoTray<Unit>()
        t.begin(3)
        listOf("a", "b", "c").forEach { t.added("data:$it", Unit) }
        t.remove(t.state.value.photos[1].id)
        assertEquals(listOf("data:a", "data:c"), t.state.value.photos.map { it.dataUrl })

        val sent = t.take()
        assertTrue(t.state.value.photos.isEmpty())
        t.restore(sent)
        assertEquals(listOf("data:a", "data:c"), t.state.value.photos.map { it.dataUrl })
        assertNull(t.state.value.error)
    }

    @Test fun `photos that would not fit in one relay frame together are refused`() {
        val t = PhotoTray<Unit>()
        t.begin(2)
        t.added("x".repeat(PhotoTray.MAX_TOTAL_CHARS - 10), Unit)
        t.added("y".repeat(20), Unit)
        assertEquals(1, t.state.value.photos.size)
        assertEquals("That photo is too large to send with the others.", t.state.value.error)
        assertFalse(t.state.value.busy)
    }
}
