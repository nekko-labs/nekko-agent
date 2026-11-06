package com.nekko.android

import com.nekko.android.chat.PhoneEvent
import com.nekko.android.connection.EventNotice
import com.nekko.android.connection.KeepAlive
import com.nekko.android.connection.NetworkChanges
import com.nekko.android.connection.Notices
import com.nekko.protocol.NetworkPath
import com.nekko.protocol.RelayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionTest {
    @Test
    fun `the first network after registering is not a change`() {
        var n = 0
        val c = NetworkChanges { n++ }
        c.onAvailable("wifi")
        assertEquals(0, n)
        c.onAvailable("wifi") // repeated callback for the same network
        assertEquals(0, n)
    }

    @Test
    fun `switching network reconnects once`() {
        var n = 0
        val c = NetworkChanges { n++ }
        c.onAvailable("wifi")
        c.onAvailable("cell") // Wi-Fi to mobile data, without a loss in between
        assertEquals(1, n)
        c.onLost("wifi") // the old network going away afterwards is not another change
        assertEquals(1, n)
    }

    @Test
    fun `a network coming back after none reconnects`() {
        var n = 0
        val c = NetworkChanges { n++ }
        c.onAvailable("wifi")
        c.onLost("wifi") // airplane mode on
        assertEquals(0, n)
        c.onAvailable("wifi") // off again: same network, but the socket died meanwhile
        assertEquals(1, n)
    }

    @Test
    fun `each network says its kind, for the route choice`() {
        val same = mutableListOf<NetworkPath>()
        val changed = mutableListOf<NetworkPath>()
        val c = NetworkChanges(same = { same += it }, changed = { changed += it })
        c.onAvailable("wifi", NetworkPath.LOCAL)
        c.onPath("wifi", NetworkPath.LOCAL)
        c.onPath("old", NetworkPath.CELLULAR) // a network that is not the default
        assertEquals(listOf(NetworkPath.LOCAL, NetworkPath.LOCAL), same)
        c.onAvailable("cell", NetworkPath.CELLULAR)
        assertEquals(listOf(NetworkPath.CELLULAR), changed)
    }

    @Test
    fun `starting with no network then getting one reconnects`() {
        var n = 0
        val c = NetworkChanges { n++ }
        c.onLost("none-yet")
        c.onAvailable("cell")
        assertEquals(1, n)
    }

    @Test
    fun `keep-alive runs only while a chat runs, the relay is up and the setting is on`() {
        assertTrue(KeepAlive.wanted(true, RelayState.ONLINE, 1, 0))
        assertTrue(KeepAlive.wanted(true, RelayState.CONNECTING, 2, 0)) // reconnecting mid-run
        assertFalse(KeepAlive.wanted(false, RelayState.ONLINE, 1, 0))
        assertFalse(KeepAlive.wanted(true, RelayState.ONLINE, 0, 0))
        assertFalse(KeepAlive.wanted(true, RelayState.OFFLINE, 1, 0)) // computer asleep: nothing to wait for
        assertFalse(KeepAlive.wanted(true, RelayState.DENIED, 1, 0))
        assertFalse(KeepAlive.wanted(true, RelayState.IDLE, 1, 0))
    }

    @Test
    fun `a run that went silent stops the keep-alive`() {
        assertTrue(KeepAlive.wanted(true, RelayState.ONLINE, 1, KeepAlive.IDLE_LIMIT_MS - 1))
        assertFalse(KeepAlive.wanted(true, RelayState.ONLINE, 1, KeepAlive.IDLE_LIMIT_MS))
    }

    @Test
    fun `keep-alive line counts chats`() {
        assertEquals("1 chat running on Mac", KeepAlive.line(1, "Mac"))
        assertEquals("3 chats running on Mac", KeepAlive.line(3, "Mac"))
        // The Live Update chip has room for a few characters only.
        assertEquals("Running", KeepAlive.chip(1))
        assertEquals("3 running", KeepAlive.chip(3))
        assertEquals(KeepAlive.Status("1 chat running on Mac", "Running"), KeepAlive.status(1, "Mac"))
    }

    @Test
    fun `notices carry what happened and where, never content`() {
        val n = EventNotice.of("s1", PhoneEvent.APPROVAL, "Fix the build", "Mac", hideContent = false)
        assertEquals("Approval needed", n.title)
        assertEquals("Fix the build · Mac", n.text)
        assertTrue(n.needsYou)
        assertEquals(Notices.CHANNEL_NEEDS_YOU, Notices.channelOf(n.event))

        val done = EventNotice.of("s1", PhoneEvent.FINISHED, "  ", "Mac", hideContent = false)
        assertEquals("Reply ready", done.title)
        assertEquals("A chat on Mac", done.text)
        assertFalse(done.needsYou)
        assertEquals(Notices.CHANNEL_REPLIES, Notices.channelOf(PhoneEvent.FAILED))
        assertEquals("Question waiting", EventNotice.of("s1", PhoneEvent.NEEDS_INPUT, null, "Mac", false).title)
        assertEquals("Reply failed", EventNotice.of("s1", PhoneEvent.FAILED, null, "Mac", false).title)
    }

    @Test
    fun `only an approval with its call offers deny`() {
        assertTrue(EventNotice.of("s1", PhoneEvent.APPROVAL, "Fix", "Mac", hideContent = true, callId = "call_1").canDeny)
        assertFalse(EventNotice.of("s1", PhoneEvent.APPROVAL, "Fix", "Mac", hideContent = false).canDeny)
        val question = EventNotice.of("s1", PhoneEvent.NEEDS_INPUT, "Fix", "Mac", hideContent = false, callId = "call_1")
        assertFalse(question.canDeny)
        assertEquals(null, question.callId)
    }

    @Test
    fun `with the app lock on a notice does not name the chat`() {
        val n = EventNotice.of("s1", PhoneEvent.APPROVAL, "Rotate prod keys", "Mac", hideContent = true)
        assertEquals("Open Nekko to see it.", n.text)
        assertFalse(n.text.contains("Rotate"))
    }

    @Test
    fun `one notice per chat, tagged for push to replace`() {
        assertEquals("chat:s1", EventNotice.tag("s1"))
    }
}
