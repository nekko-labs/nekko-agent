package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.ChatState
import com.nekko.android.ui.screens.savedCopyNote
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.*
import org.junit.Test

class QuietReconnectTest {
    @Test fun `composer names the active computer and says only sent prompts wait`() {
        for ((state, word) in listOf(RelayState.CONNECTING to "reconnecting", RelayState.OFFLINE to "offline")) {
            val env = ChatEnv(state, null, RemoteDefaults(), "Studio Mac", canQueue = true)
            val ui = ChatController.project(ChatState(), env)
            assertNull(ui.blocked)
            assertEquals(listOf("Studio Mac is $word.", "Prompts you send wait on this phone."), ui.sendsLater?.lines())
            assertNull(ChatController.project(ChatState(), env.copy(canQueue = false)).sendsLater)
        }
        for (state in listOf(RelayState.ONLINE, RelayState.DENIED)) {
            assertNull(ChatController.project(ChatState(), ChatEnv(state, null, RemoteDefaults(), "Mac", canQueue = true)).sendsLater)
        }
    }

    @Test fun `saved copy timestamp keeps date for older copies without another reconnect explanation`() {
        val locale = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            val now = Instant.parse("2026-11-10T14:42:00Z").toEpochMilli()
            assertEquals("Updated last on 2:42 PM", savedCopyNote(now, "Studio Mac", now, ZoneId.of("UTC")))
            assertEquals("Updated last on Nov 9, 2026, 2:42 PM", savedCopyNote(now - 86_400_000, "Other computer", now, ZoneId.of("UTC")))
        } finally {
            Locale.setDefault(locale)
        }
    }
}
