package com.nekko.android

import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.ui.security.YoloWarning
import com.nekko.protocol.PcSettings.ChatMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class YoloWarningTest {
    @Test
    fun `warns only when switching to YOLO from another mode`() {
        assertTrue(YoloWarning.needed(ChatMode.GUARDRAILS, ChatMode.YOLO, skip = false))
        assertTrue(YoloWarning.needed(ChatMode.ASK, ChatMode.YOLO, skip = false))
        // A mode the phone doesn't know yet counts as not YOLO.
        assertTrue(YoloWarning.needed(null, ChatMode.YOLO, skip = false))
        assertFalse(YoloWarning.needed(ChatMode.YOLO, ChatMode.YOLO, skip = false))
        assertFalse(YoloWarning.needed(ChatMode.YOLO, ChatMode.GUARDRAILS, skip = false))
        assertFalse(YoloWarning.needed(ChatMode.ASK, ChatMode.GUARDRAILS, skip = false))
        // Don't warn me again.
        assertFalse(YoloWarning.needed(ChatMode.GUARDRAILS, ChatMode.YOLO, skip = true))
    }

    @Test
    fun `don't warn me again is kept on the phone as skipYoloWarning, off by default`() {
        val map = HashMap<String, String>()
        val store = object : PrefStore {
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        }
        val prefs = PhonePrefs(store)
        assertFalse(prefs.get(YoloWarning.SKIP))
        prefs.set(YoloWarning.SKIP, true)
        assertEquals("true", map["skipYoloWarning"])
        // Settings → Security → Warn before YOLO turns it back on.
        assertTrue(PhonePrefs(store).get(YoloWarning.SKIP))
        prefs.set(YoloWarning.SKIP, false)
        assertFalse(PhonePrefs(store).get(YoloWarning.SKIP))
    }
}
