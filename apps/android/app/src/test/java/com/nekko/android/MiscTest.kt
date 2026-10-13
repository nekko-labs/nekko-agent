package com.nekko.android

import com.nekko.android.chat.approvalDetail
import com.nekko.android.util.ago
import com.nekko.android.util.plainText
import com.nekko.protocol.Approval
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiscTest {
    @Test
    fun `pairing deep links route to the pair flow`() {
        val raw = "nekko-agent-pair:?relay=wss%3A%2F%2Fr.dev&room=abcdef12&key=0011223344556677"
        assertEquals(DeepLink.Pair(raw), DeepLink.from(raw, "nekko-agent-pair", null, emptyList()))
        val alt = "nekko-agent://pair?relay=wss://r.dev&room=abcdef12&key=0011223344556677"
        assertEquals(DeepLink.Pair(alt), DeepLink.from(alt, "nekko-agent", "pair", emptyList()))
        assertEquals(DeepLink.Chat("s1"), DeepLink.from("nekko-agent://chat/s1", "nekko-agent", "chat", listOf("s1")))
        assertNull(DeepLink.from("https://example.com", "https", "example.com", emptyList()))
    }

    @Test
    fun `plain text strips markdown`() {
        assertEquals("Fix the build now", plainText("# **Fix** the `build`\n\nnow"))
        assertEquals("link here", plainText("[link](https://x.dev) here"))
    }

    @Test
    fun `ago uses short desktop wording`() {
        val now = 10_000_000_000L
        assertEquals("now", ago(now - 10_000, now))
        assertEquals("5 mins", ago(now - 5 * 60_000, now))
        assertEquals("1 hr", ago(now - 60 * 60_000, now))
        assertEquals("2 days", ago(now - 2 * 86_400_000L, now))
    }

    @Test
    fun `approval shows the exact command, else the tool input`() {
        val cmd = Approval(ToolCall("c", "bash", buildJsonObject { put("command", "rm -rf /tmp/x && echo ok") }), "", Severity.HIGH)
        assertEquals("rm -rf /tmp/x && echo ok", approvalDetail(cmd))
        val write = Approval(ToolCall("c", "write_file", buildJsonObject { put("path", "a.txt"); put("content", "hi") }), "", Severity.LOW)
        val detail = approvalDetail(write)
        assertTrue(detail.contains("\"path\": \"a.txt\""))
        assertTrue(detail.contains("\"content\": \"hi\""))
    }
}
