package com.nekko.android

import com.nekko.android.data.PhonePrefs
import com.nekko.android.ui.screens.FirstPromptIntro
import com.nekko.protocol.SessionSummary
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2234: "Send your first prompt" opens once, over someone's first ever New chat (the iPhone's rule). */
class FirstPromptIntroTest {
    private fun chat(id: String, exchanges: Long?) = SessionSummary(id, "", 0, null, null, null, false, null, null, null, exchangeCount = exchanges)

    @Test fun `opens for a first ever chat once the computer's list is read`() {
        assertTrue(FirstPromptIntro.shouldShow(seen = false, listLoaded = true, chats = emptyList()))
        // A chat started but never sent to (an empty one) is still a first chat.
        assertTrue(FirstPromptIntro.shouldShow(seen = false, listLoaded = true, chats = listOf(chat("a", 0))))
    }

    @Test fun `never once seen, before the list is read, or after a chat`() {
        assertFalse(FirstPromptIntro.shouldShow(seen = true, listLoaded = true, chats = emptyList()))
        assertFalse(FirstPromptIntro.shouldShow(seen = false, listLoaded = false, chats = emptyList()))
        assertFalse(FirstPromptIntro.shouldShow(seen = false, listLoaded = true, chats = listOf(chat("a", 0), chat("b", 2))))
    }

    @Test fun `a chat whose count the computer doesn't send counts as used`() {
        assertFalse(FirstPromptIntro.shouldShow(seen = false, listLoaded = true, chats = listOf(chat("a", null))))
    }

    @Test fun `seen is a phone preference that starts unset`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        assertFalse(prefs.get(FirstPromptIntro.SEEN))
        prefs.set(FirstPromptIntro.SEEN, true)
        assertTrue(PhonePrefs(store).get(FirstPromptIntro.SEEN))
    }

    @Test fun `three steps with a demo for each theme`() {
        assertEquals(listOf("start", "add", "send"), FirstPromptIntro.steps.map { it.id })
        assertEquals(R.string.intro_send_title, FirstPromptIntro.steps.last().title)
        val videos = FirstPromptIntro.steps.flatMap { listOf(FirstPromptIntro.video(it.id, false), FirstPromptIntro.video(it.id, true)) }
        assertEquals(6, videos.toSet().size)
    }

    @Test fun `the computer's exchange count is read, a negative one is not`() {
        assertEquals(4L, SessionSummary.from(buildJsonObject { put("id", "a"); put("title", "t"); put("exchangeCount", 4) })!!.exchangeCount)
        assertNull(SessionSummary.from(buildJsonObject { put("id", "a"); put("title", "t") })!!.exchangeCount)
        assertNull(SessionSummary.from(buildJsonObject { put("id", "a"); put("title", "t"); put("exchangeCount", -1) })!!.exchangeCount)
    }
}
