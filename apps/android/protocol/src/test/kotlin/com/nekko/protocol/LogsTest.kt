package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** AN-34: log requests and views from the computer's phone-files cases, and Share's redaction held to the computer's (the iPhone's LogShareTests). */
class LogsTest {
    private fun golden(path: String): JsonObject {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", path)
        assumeTrue("running outside the monorepo", f.exists())
        return Json.parseToJsonElement(f.readText()).jsonObject
    }

    private val files by lazy { golden("crates/nekko-remote/tests/golden/phone-files.json") }

    private fun view(channel: String, n: Int = 0): JsonElement =
        files["views"]!!.jsonArray.map { it.jsonObject }.filter { it["channel"]?.jsonPrimitive?.content == channel }[n]["view"]!!

    private fun args(r: FilesRequest) = JsonArray(r.args).toString()

    @Test fun `log requests are the ones the computer accepts`() {
        assertEquals("[]", args(FilesRequest.logs()))
        assertEquals("""["daemon",{}]""", args(FilesRequest.log("daemon", query = "")))
        assertEquals("""["app",{"query":"err","tailBytes":10}]""", args(FilesRequest.log("app", query = "err", tailBytes = 10)))
        val ok = files["screens"]!!.jsonArray.map { it.jsonObject }.filter { it["error"] == null }
        val accepted = ok.flatMap { c -> listOfNotNull(c["args"], c["callArgs"]).map { c["channel"]!!.jsonPrimitive.content to it.toString() } }.toSet()
        for (r in listOf(FilesRequest.logs(), FilesRequest.log("app", tailBytes = 65536), FilesRequest.log("daemon"))) {
            assertTrue("${r.channel} ${args(r)}", (r.channel to args(r)) in accepted)
        }
        assertTrue(Channels.LOGS_READ !in Channels.CHANGE)
    }

    @Test fun `decodes the computer's logs`() {
        val logs = LogInfo.list(view("logs:list"))
        assertEquals(listOf("app", "daemon", "agent:s1"), logs.map { it.id })
        assertEquals("s1", logs[2].sessionId)
        assertEquals(LogInfo.Kind.AGENT, logs[2].kind)
        assertNull(logs[1].updatedAt)
        assertEquals("line one\nline two\n", LogText.from(view("logs:read"))!!.text)
        assertEquals(listOf("line one", "line two"), LogText.from(view("logs:read"))!!.lines)
        val found = LogText.from(view("logs:read", 1))!!
        assertEquals(listOf(4, 9), found.matches.map { it.line })
        assertEquals(2000, found.matches[1].text.length)
    }

    @Test fun `redacts like the computer`() {
        val f = golden("crates/nekkod/tests/golden/log-redact.json")
        for (c in f["cases"]!!.jsonArray) {
            val (input, out) = c.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(input, out, LogShare.redact(input))
        }
        for (k in f["keep"]!!.jsonArray) {
            val line = k.jsonPrimitive.content
            assertEquals(line, LogShare.redact(line))
        }
    }

    @Test fun `shares the tail redacted with a header`() {
        val log = LogText("daemon", 100, truncated = true, text = "started\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop1234\n")
        assertEquals(
            """
            Nekko Agent log: Engine
            Shared: 1970-01-01T00:00:00Z
            Secrets were removed on the computer and again on this phone. Check before you send it on.

            (older lines are on the computer)
            started
            OPENAI_API_KEY=[redacted]
            """.trimIndent(),
            LogShare.text("Engine", log, atMs = 0),
        )
    }

    @Test fun `shares search matches with line numbers`() {
        val log = LogText(
            "app", 10, query = "token", moreMatches = true,
            matches = listOf(LogText.Match(12, "token ghp_abcdefghijklmnopqrstuvwxyz0123 ok"), LogText.Match(40, "fine")),
        )
        assertEquals(
            listOf("Lines matching \"token\":", "12: token [redacted] ok", "40: fine", "(more lines match)"),
            LogShare.text("App", log).split("\n").takeLast(4),
        )
    }
}
