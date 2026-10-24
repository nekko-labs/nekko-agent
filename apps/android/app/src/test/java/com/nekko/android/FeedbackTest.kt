package com.nekko.android

import com.nekko.android.feedback.Feedback
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress

class FeedbackTest {
    private val pixel = Feedback.AppInfo(version = "1.4.0", osVersion = "15", arch = "arm64-v8a")

    @Test
    fun `the agent prompt ends with the app line`() {
        val prompt = Feedback.agentPrompt(pixel)
        assertTrue(prompt.startsWith("I want to send feedback about Nekko Agent to the team that makes it (Nekko Labs). Please help me file it as a GitHub issue on https://github.com/nekko-labs/nekko-agent.\n\n1. Ask me"))
        assertTrue(prompt.contains("`gh issue create --repo nekko-labs/nekko-agent`"))
        assertTrue(prompt.contains("paste into https://github.com/nekko-labs/nekko-agent/issues/new/choose.\n4. Leave out"))
        assertTrue(prompt.endsWith("chat contents.\n\nApp: Nekko Agent 1.4.0 (android, Android 15, arm64-v8a)"))
    }

    @Test
    fun `unknown parts of the app line are left out`() {
        assertEquals("App: Nekko Agent (android, Android)", Feedback.appLine(Feedback.AppInfo(null, null, null)))
        assertEquals("App: Nekko Agent 0.1.0 (android, Android 16)", Feedback.appLine(Feedback.AppInfo("0.1.0", "16", " ")))
    }

    @Test
    fun `app info is cut to what the server accepts`() {
        val i = Feedback.AppInfo(version = "0.1.0-debug<script>", osVersion = "16 QPR2 ✓", arch = "arm64-v8a-and-a-very-long-name").sanitized()
        assertEquals("0.1.0-debugscript", i.version)
        assertEquals("16 QPR2", i.osVersion)
        assertEquals("arm64-v8a-and-a-", i.arch)
        assertEquals(32, Feedback.AppInfo("1".repeat(50), null, null).sanitized().version!!.length)
    }

    @Test
    fun `the body has app info only when asked`() {
        assertEquals("""{"message":"It froze"}""", Feedback.body("It froze", null))
        assertEquals(
            """{"message":"It froze","app":{"app":"android","version":"1.4.0","os":"Android","osVersion":"15","arch":"arm64-v8a"}}""",
            Feedback.body("It froze", pixel),
        )
        // Quotes and newlines are escaped, never spliced into the JSON.
        val tricky = Feedback.body("say \"hi\"\nthen }", null)
        assertEquals("say \"hi\"\nthen }", Json.parseToJsonElement(tricky).jsonObject["message"]!!.jsonPrimitive.content)
        assertFalse(Json.parseToJsonElement(Feedback.body("x", Feedback.AppInfo(null, null, null))).jsonObject["app"]!!.jsonObject.containsKey("version"))
    }

    @Test
    fun `the note is trimmed and capped, and blank is nothing to send`() {
        assertNull(Feedback.message("  \n "))
        assertEquals("Hi", Feedback.message("  Hi\n"))
        assertEquals(Feedback.MAX_CHARS, Feedback.message("a".repeat(5000))!!.length)
    }

    @Test
    fun `the counter only shows near the limit`() {
        assertNull(Feedback.counter(3599))
        assertEquals("3600 / 4000", Feedback.counter(3600))
    }

    @Test
    fun `only 202 is a success, and rate limits say so`() {
        assertEquals(Feedback.Outcome.Sent, Feedback.outcome(202))
        assertEquals(Feedback.Outcome.Failed("Too many notes. Try again later."), Feedback.outcome(429))
        assertTrue(Feedback.outcome(400) is Feedback.Outcome.Failed)
        assertTrue(Feedback.outcome(200) is Feedback.Outcome.Failed)
        assertTrue(Feedback.outcome(500) is Feedback.Outcome.Failed)
    }

    @Test
    fun `send posts JSON and maps the answer`() = runTest {
        var seen: Triple<String, String?, String>? = null
        var status = 202
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/feedback") { ex ->
            seen = Triple(ex.requestMethod, ex.requestHeaders.getFirst("Content-Type"), ex.requestBody.readBytes().decodeToString())
            val reply = if (status == 202) """{"ok":true}""" else """{"error":"rate-limited"}"""
            ex.sendResponseHeaders(status, reply.length.toLong())
            ex.responseBody.use { it.write(reply.toByteArray()) }
        }
        server.start()
        try {
            val url = "http://127.0.0.1:${server.address.port}/v1/feedback"
            assertEquals(Feedback.Outcome.Sent, Feedback.send(Feedback.body("Hi", null), url))
            val (method, type, body) = seen!!
            assertEquals("POST", method)
            assertTrue(type!!.startsWith("application/json"))
            assertEquals("""{"message":"Hi"}""", body)
            status = 429
            assertEquals(Feedback.Outcome.Failed("Too many notes. Try again later."), Feedback.send(Feedback.body("Hi", null), url))
        } finally {
            server.stop(0)
        }
        // Nothing listening is a failure, not a crash.
        assertTrue(Feedback.send("{}", "http://127.0.0.1:1/v1/feedback") is Feedback.Outcome.Failed)
    }
}
