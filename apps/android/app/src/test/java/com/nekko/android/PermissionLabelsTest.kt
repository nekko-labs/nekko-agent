package com.nekko.android

import com.nekko.android.ui.chat.asksTitleRes
import com.nekko.android.ui.components.permissionIconRes
import com.nekko.android.ui.settings.modeTitle
import com.nekko.android.ui.settings.modeTitleRes
import com.nekko.android.ui.settings.stepUpAction
import com.nekko.protocol.PcSettings
import com.nekko.protocol.PcSettings.ChatMode
import org.junit.Assert.assertEquals
import org.junit.Test

class PermissionLabelsTest {
    @Test fun `permission display names and icons preserve wire values`() {
        assertEquals(listOf("ask", "guardrails", "yolo"), ChatMode.entries.map { it.wire })
        val names = listOf("Always ask", "Ask when it matters", "No restrictions")
        assertEquals(names, ChatMode.entries.map(::modeTitle))
        assertEquals(listOf(R.string.permission_always_ask, R.string.permission_ask_when_matters, R.string.permission_no_restrictions), ChatMode.entries.map(::modeTitleRes))
        assertEquals(listOf(R.string.permission_simple_always_ask, R.string.permission_simple_ask_when_matters, R.string.permission_simple_no_restrictions), ChatMode.entries.map(::asksTitleRes))
        assertEquals(listOf(R.drawable.permission_hand, R.drawable.permission_shield_check, R.drawable.permission_running), ChatMode.entries.map(::permissionIconRes))
        ChatMode.entries.forEachIndexed { index, mode ->
            assertEquals("Switch new chats on Studio to ${names[index]}", stepUpAction(PcSettings.patch(mode = mode), "Studio"))
            assertEquals("{\"defaultChatMode\":\"${mode.wire}\"}", PcSettings.patch(mode = mode).toString())
        }
    }
}
