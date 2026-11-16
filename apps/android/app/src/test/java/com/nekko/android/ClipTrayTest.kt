package com.nekko.android

import com.nekko.android.chat.ClipTray
import com.nekko.android.chat.ClipTray.Status
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayException
import java.io.ByteArrayInputStream
import java.util.Base64
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Videos from the message box (#2777): pieces in order to `attachment:upload`, then Send. */
class ClipTrayTest {
    private var n = 0
    private fun tray() = ClipTray { "id-${++n}" }

    @Test fun aClipGoesInOrderedPiecesOfAtMost3MiB() = runTest {
        val bytes = ByteArray(ClipTray.CHUNK * 2 + 10) { (it % 251).toByte() }
        val caller = FakeCaller { JsonNull }
        val t = tray()
        val clip = t.add("beach.mp4", bytes.size.toLong(), online = true)!!
        assertTrue(t.state.value.sending)
        t.upload(clip, "s1", caller) { ByteArrayInputStream(bytes) }
        val calls = caller.calls.filter { it.channel == Channels.ATTACHMENT_UPLOAD }
        assertEquals(3, calls.size)
        assertEquals(listOf(0L, ClipTray.CHUNK.toLong(), ClipTray.CHUNK * 2L), calls.map { it.args[3].jsonPrimitive.long })
        // One upload id for every piece, the chat, the name and the whole size each time.
        assertEquals(1, calls.map { it.args[1].jsonPrimitive.content }.toSet().size)
        calls.forEach { c ->
            assertEquals("s1", c.args[0].jsonPrimitive.content)
            assertEquals("beach.mp4", c.args[2].jsonPrimitive.content)
            assertEquals(bytes.size.toLong(), c.args[4].jsonPrimitive.long)
        }
        val joined = calls.flatMap { Base64.getDecoder().decode(it.args[5].jsonPrimitive.content).toList() }.toByteArray()
        assertTrue(joined.contentEquals(bytes))
        assertEquals(Status.ARRIVED, t.state.value.clips.single().status)
        assertFalse(t.state.value.sending)
        // Arrived clips can't be removed (the computer has them), and go with the next message.
        t.remove(clip.id)
        assertEquals(1, t.state.value.clips.size)
        t.sent()
        assertTrue(t.state.value.clips.isEmpty())
    }

    @Test fun tooLargeOfflineOrAThirdClipIsTurnedDownBeforeAnythingGoes() {
        val t = tray()
        assertNull(t.add("big.mp4", ClipTray.MAX_BYTES + 1, online = true))
        assertEquals("That video is larger than 50 MB. Trim it or send a shorter one.", t.state.value.error)
        assertNull(t.add("a.mp4", 10, online = false))
        assertEquals("Videos go only while your computer is connected.", t.state.value.error)
        assertNull(t.add("a.mp4", null, online = true))
        t.add("1.mp4", 10, online = true)!!
        t.add("2.mp4", 10, online = true)!!
        assertNull(t.add("3.mp4", 10, online = true))
        assertEquals("Up to 2 videos per message.", t.state.value.error)
    }

    @Test fun aRefusalKeepsTheClipWithTheComputersReasonAndRemoveDropsIt() = runTest {
        val caller = FakeCaller { throw RelayException("This chat holds too many attachments.") }
        val t = tray()
        val clip = t.add("a.mp4", 4, online = true)!!
        t.upload(clip, "s1", caller) { ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)) }
        val failed = t.state.value.clips.single()
        assertEquals(Status.FAILED, failed.status)
        assertEquals("This chat holds too many attachments.", failed.error)
        // A failed clip frees its place for another.
        assertEquals(2, t.state.value.room)
        t.remove(clip.id)
        assertTrue(t.state.value.clips.isEmpty())
    }

    @Test fun aClipShorterThanItsSizeFails() = runTest {
        val t = tray()
        val clip = t.add("a.mp4", 10, online = true)!!
        t.upload(clip, "s1", FakeCaller { JsonNull }) { ByteArrayInputStream(byteArrayOf(1, 2)) }
        assertEquals("The video ended early. Pick it again.", t.state.value.clips.single().error)
    }

    @Test fun aPieceFitsTheRelaysFrame() {
        assertTrue((ClipTray.CHUNK + 2) / 3 * 4 < 9 * 1024 * 1024)
    }
}
