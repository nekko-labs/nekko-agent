package com.nekko.android

import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.settings.SettingsSections
import com.nekko.android.ui.settings.computersDetail
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsSectionsTest {
    private fun pc(id: String, name: String) = Computer(id, name, "wss://r.dev", 0)

    @Test
    fun `settings render computers first, then models on this phone, appearance, simple mode, security, device access, new chats, connectors, connection, connection status, vibration, dictation, the computer's, its automations and usage, this computer, feedback, about`() {
        // #2940: Computers first and Models on This phone second, as on the iPhone (#2929).
        assertEquals(17, SettingsSections.size)
    }

    @Test
    fun `computers row says what is paired`() {
        assertEquals("None paired yet", computersDetail(ComputersState()))
        assertEquals("Mac", computersDetail(ComputersState(computers = listOf(pc("a", "Mac")), activeId = "a")))
        assertEquals(
            "2 paired · using Mac",
            computersDetail(ComputersState(computers = listOf(pc("a", "Mac"), pc("b", "Windows PC")), activeId = "a")),
        )
    }
}
