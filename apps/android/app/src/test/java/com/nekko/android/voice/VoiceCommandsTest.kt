package com.nekko.android.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class VoiceCommandsTest {
    private fun fixture(): File = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .map { File(it, "packages/shared/fixtures/voice-commands.json") }.first { it.isFile }

    @Test fun `all shared non-desktop fixtures match Android grammar`() {
        val cases = Json.parseToJsonElement(fixture().readText()).jsonObject.getValue("cases").jsonArray
        var checked = 0
        for (item in cases) {
            val c = item.jsonObject
            if (c["platforms"] != null) continue
            checked++
            val say = c.getValue("say").jsonPrimitive.content
            val expected = c.getValue("intent").jsonObject
            fun value(key: String) = expected.getValue(key).jsonPrimitive.content
            val intent = when (value("kind")) {
                "dictation" -> VoiceIntent.Dictation(value("text"))
                "unknown" -> VoiceIntent.Unknown(value("text"))
                "navigate" -> VoiceIntent.Navigate(value("view"))
                "open-chat" -> VoiceIntent.OpenChat(value("query"), value("text"))
                "pick" -> VoiceIntent.Pick(value("n").toInt())
                "new-session" -> VoiceIntent.NewSession
                "complete-session" -> VoiceIntent.CompleteSession
                "erase" -> VoiceIntent.Erase
                "clear" -> VoiceIntent.Clear
                "send" -> VoiceIntent.Send
                "ship" -> VoiceIntent.Ship
                "status" -> VoiceIntent.Status
                "yes" -> VoiceIntent.Yes
                "no" -> VoiceIntent.No
                else -> error("Unhandled fixture kind")
            }
            assertEquals(say, intent, VoiceCommands.parse(say))
        }
        assertTrue(checked >= 40)
    }

    @Test fun `sentence splitting keeps dictate send and unknown in order`() {
        assertEquals(listOf(VoiceIntent.Dictation("Build it."), VoiceIntent.Send, VoiceIntent.Unknown("Nekko delete everything.")), VoiceCommands.split("Build it. Nekko. Send it. Nekko delete everything."))
        assertEquals(listOf(VoiceIntent.Dictation("First sentence. More words.")), VoiceCommands.split("First sentence. More words."))
    }

    @Test fun `wake only carries at sentence boundaries`() {
        assertEquals(VoiceCommands.WakeTail("Build it.", "Neko."), VoiceCommands.splitWakeTail("Build it. Neko."))
        assertEquals(VoiceCommands.WakeTail("Tell Neko", ""), VoiceCommands.splitWakeTail("Tell Neko"))
        assertEquals(VoiceCommands.WakeTail("", "Nekko"), VoiceCommands.splitWakeTail("Nekko"))
    }

    @Test fun `phone parses desktop navigation for an explicit unsupported response`() {
        assertEquals(VoiceIntent.Go("desktop:2"), VoiceCommands.parse("Neko go to desktop to"))
        assertEquals(VoiceIntent.Go("screen:3"), VoiceCommands.parse("Nekko show screen three"))
        assertEquals(VoiceIntent.Unknown("Nekko switch to desktop purple"), VoiceCommands.parse("Nekko switch to desktop purple"))
    }

    @Test fun `name normalization cannot match a substring`() {
        assertEquals("Nekko and Nekko, necklace", VoiceCommands.spellNekko("Neco and Necco, necklace"))
    }
}
