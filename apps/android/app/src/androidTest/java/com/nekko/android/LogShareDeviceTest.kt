package com.nekko.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.protocol.LogShare
import com.nekko.protocol.LogText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * AN-34: Share's redaction on Android's own regex engine (ICU, not the JVM's
 * the protocol tests use), held to the computer's cases in
 * `crates/nekkod/tests/golden/log-redact.json`.
 */
@RunWith(AndroidJUnit4::class)
class LogShareDeviceTest {
    @Test fun redactsLikeTheComputerOnTheDevice() {
        val text = InstrumentationRegistry.getInstrumentation().context.assets.open("log-redact.json").bufferedReader().readText()
        val f = Json.parseToJsonElement(text).jsonObject
        val cases = f["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val (input, out) = c.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(input, out, LogShare.redact(input))
        }
        for (k in f["keep"]!!.jsonArray) {
            val line = k.jsonPrimitive.content
            assertEquals(line, LogShare.redact(line))
        }
    }

    @Test fun sharesWithoutCrashing() {
        val log = LogText("daemon", 10, text = "OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234\n")
        assertTrue(LogShare.text("Engine", log).endsWith("OPENAI_API_KEY=[redacted]"))
    }
}
