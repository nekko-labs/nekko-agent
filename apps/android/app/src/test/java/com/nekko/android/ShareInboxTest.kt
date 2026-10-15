package com.nekko.android

import com.nekko.android.share.ShareInbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShareInboxTest {
    @Test
    fun `a share waits for new chat, then moves to the created chat's composer once`() {
        val inbox = ShareInbox()
        inbox.offer("https://example.com")
        assertEquals("https://example.com", inbox.shared.value)
        inbox.handOff("s1")
        assertNull(inbox.shared.value)
        assertEquals("https://example.com", inbox.takeDraft("s1"))
        assertNull(inbox.takeDraft("s1"))
    }

    @Test
    fun `edits on new chat are what reaches the composer`() {
        val inbox = ShareInbox()
        inbox.offer("draft")
        inbox.edit("draft, but better")
        inbox.handOff("s1")
        assertEquals("draft, but better", inbox.takeDraft("s1"))
    }

    @Test
    fun `blanking the text or leaving new chat drops it`() {
        val inbox = ShareInbox()
        inbox.offer("a")
        inbox.edit("   ")
        assertNull(inbox.shared.value)
        inbox.offer("b")
        inbox.clear()
        inbox.handOff("s1")
        assertNull(inbox.takeDraft("s1"))
    }

    @Test
    fun `a newer share replaces an unused one`() {
        val inbox = ShareInbox()
        inbox.offer("old")
        inbox.offer("new")
        inbox.handOff("s1")
        assertEquals("new", inbox.takeDraft("s1"))
    }

    @Test
    fun `other chats are untouched`() {
        val inbox = ShareInbox()
        inbox.offer("x")
        inbox.handOff("s1")
        assertNull(inbox.takeDraft("s2"))
        assertEquals("x", inbox.takeDraft("s1"))
    }
}
