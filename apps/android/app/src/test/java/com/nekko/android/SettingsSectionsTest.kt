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
    fun `settings render appearance, security, new chats, connection, vibration, the computer's, computers, about`() {
        assertEquals(8, SettingsSections.size)
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
