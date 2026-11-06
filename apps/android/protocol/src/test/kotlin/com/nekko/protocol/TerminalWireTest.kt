package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** The terminal wire (AN-31): the iPhone's TerminalWireTests, and the computer's own projections decoded. */
class TerminalWireTest {
    private fun json(s: String) = Json.parseToJsonElement(s)
    private fun repoFile(path: String) = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", path)
    private fun args(r: TerminalRequest) = JsonArray(r.args).toString()

    @Test fun `decodes terminals, hosts and the open reply`() {
        val t = PhoneTerminal.list(json("""
            [{"id":"term_1","title":"zsh","kind":"shell","folder":"app","shell":"zsh","running":true,"viewers":1,"createdAt":5,"sessionId":"s1"},
             {"id":"agent_s1","title":"Agent commands","kind":"agent","folder":"","shell":"agent","running":false,"viewers":0},
             {"id":"term_2","title":"devbox","kind":"ssh","folder":"philip","shell":"ssh","running":false,"exitCode":255,"viewers":0},
             {"title":"no id"}]
        """))
        assertEquals(listOf("term_1", "agent_s1", "term_2"), t.map { it.id })
        assertEquals("zsh · app", t[0].detail)
        assertTrue(t[1].readOnly)
        assertEquals("Agent commands · exited", t[1].detail)
        assertEquals("SSH · philip · exited (255)", t[2].detail)
        assertEquals(1, t[0].viewers)

        val hosts = SshHost.list(json("""[{"alias":"devbox","hostName":"devbox.lan","port":2222},{"alias":"pi"},{"alias":""}]"""))
        assertEquals(listOf("devbox", "pi"), hosts.map { it.alias })
        assertEquals("devbox.lan:2222", hosts[0].detail)
        assertNull(hosts[1].detail)

        val opened = TerminalOpened.from(json("""
            {"terminal":{"id":"term_1","title":"zsh","kind":"shell","folder":"app","shell":"zsh","running":true,"viewers":1},
             "buffer":"$ ","cols":80,"rows":24,"truncated":true,"token":"tok","idleMs":300000,"maxMs":1800000}
        """))!!
        assertEquals("tok", opened.token)
        assertEquals("$ ", opened.tail.buffer)
        assertTrue(opened.tail.truncated)
        assertEquals("term_1", opened.tail.terminal?.id)
        assertNull("no token, not opened", TerminalOpened.from(json("""{"buffer":"x"}""")))
    }

    @Test fun `decodes events`() {
        assertEquals(TerminalEvent.Data("t", "hi", 0), TerminalEvent.from(json("""{"type":"data","terminalId":"t","data":"hi"}""")))
        assertEquals(TerminalEvent.Data("t", "", 900), TerminalEvent.from(json("""{"type":"data","terminalId":"t","data":"","skipped":900}""")))
        assertEquals(TerminalEvent.Exit("t", 0), TerminalEvent.from(json("""{"type":"exit","terminalId":"t","code":0}""")))
        assertEquals(TerminalEvent.Exit("t", null), TerminalEvent.from(json("""{"type":"exit","terminalId":"t","code":null}""")))
        assertNull(TerminalEvent.from(json("""{"type":"data"}""")))
    }

    @Test fun `builds requests the computer accepts`() {
        assertEquals("""[{"sessionId":"s1"}]""", args(TerminalRequest.list("s1")))
        assertEquals("""[{"sessionId":"s1","cols":500,"rows":1}]""", args(TerminalRequest.create("s1", 900, 0)))
        val ssh = TerminalRequest.sshOpen("devbox", "s1", 80, 24)
        assertEquals("ssh:open", ssh.channel)
        assertEquals("""["devbox",{"sessionId":"s1","cols":80,"rows":24}]""", args(ssh))
        assertEquals("""["t","ls\r","tok"]""", args(TerminalRequest.write("t", "ls\r", "tok")))
        assertEquals("""["t",60,20,"tok"]""", args(TerminalRequest.resize("t", 60, 20, "tok")))
        assertEquals("terminal:open", TerminalRequest.open("t").channel)
        assertEquals("terminal:leave", TerminalRequest.leave("t").channel)
        assertEquals("[]", args(TerminalRequest.hosts()))
        // Every signed one can be signed (canonical JSON: no fractions).
        for (r in listOf(TerminalRequest.open("t"), TerminalRequest.create("s1", 80, 24), TerminalRequest.sshOpen("d", "s1", 80, 24),
            TerminalRequest.signal("t"), TerminalRequest.close("t"))) ChangeProof.canonicalJson(JsonArray(r.args))
    }

    @Test fun `key row bytes`() {
        assertEquals("\u001b", TerminalKeys.bytes(TerminalKey.Escape))
        assertEquals("\t", TerminalKeys.bytes(TerminalKey.Tab))
        assertEquals("\u001b[A", TerminalKeys.bytes(TerminalKey.Up))
        assertEquals("\u001bOA", TerminalKeys.bytes(TerminalKey.Up, appCursor = true))
        assertEquals("\u001b[D", TerminalKeys.bytes(TerminalKey.Left))
        assertEquals("\u001b[6~", TerminalKeys.bytes(TerminalKey.PageDown))
        assertEquals("\u0003", TerminalKeys.bytes(TerminalKey.Ctrl('c')))
        assertEquals("\u0004", TerminalKeys.bytes(TerminalKey.Ctrl('D')))
        assertEquals("\u001b", TerminalKeys.bytes(TerminalKey.Ctrl('[')))
        assertEquals("\u007f", TerminalKeys.bytes(TerminalKey.Ctrl('?')))
        assertNull(TerminalKeys.bytes(TerminalKey.Ctrl('é')))
    }

    @Test fun `paste and the command line`() {
        assertEquals("a\rb\rc", TerminalKeys.paste("a\nb\r\nc", bracketed = false))
        assertEquals("\u001b[200~a\rb\u001b[201~", TerminalKeys.paste("a\nb", bracketed = true))
        assertEquals("a pasted end marker can't end the paste", "\u001b[200~xrm -rf ~\r\u001b[201~", TerminalKeys.paste("x\u001b[201~rm -rf ~\n", bracketed = true))
        assertEquals("git status\r", TerminalKeys.line("git status"))
        assertEquals("dictation is one line", "two lines\r", TerminalKeys.line("two\nlines"))
    }

    @Test fun `long input is sent in parts`() {
        val text = "é".repeat(40_000) // 80,000 bytes
        val parts = TerminalKeys.chunks(text)
        assertEquals(2, parts.size)
        assertTrue(parts.all { it.toByteArray(Charsets.UTF_8).size <= TerminalLimits.WRITE_BYTES })
        assertEquals(text, parts.joinToString(""))
        assertEquals(listOf("ls"), TerminalKeys.chunks("ls"))
        assertEquals(emptyList<String>(), TerminalKeys.chunks(""))
        // An emoji (two UTF-16 units) is never split.
        assertEquals(listOf("😀", "😀"), TerminalKeys.chunks("😀😀", maxBytes = 4))
    }

    @Test fun `the classes and limits match the computer`() {
        val f = repoFile("crates/nekko-remote/src/phone-access.json")
        assumeTrue("running outside the monorepo", f.exists())
        val policy = json(f.readText()).jsonObject
        fun set(k: String) = policy[k]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        val terminal = TerminalChannels.ALL.toSet()
        assertEquals(TerminalChannels.CHANGE, set("changeChannels").intersect(terminal))
        assertEquals(setOf(TerminalChannels.WRITE, TerminalChannels.RESIZE), set("tokenChannels"))
        assertEquals(setOf(TerminalChannels.LIST, TerminalChannels.TAIL, TerminalChannels.SSH_HOSTS), set("readChannels").intersect(terminal))
        val t = policy["terminal"]!!.jsonObject
        assertEquals(TerminalChannels.OPEN, t["openChannel"]!!.jsonPrimitive.content)
        assertEquals(TerminalChannels.LEAVE, t["leaveChannel"]!!.jsonPrimitive.content)
        assertEquals(TerminalLimits.WRITE_BYTES.toLong(), t["writeBytes"]!!.jsonPrimitive.long)
        assertEquals(TerminalLimits.MAX_COLS.toLong(), t["maxCols"]!!.jsonPrimitive.long)
        assertEquals(TerminalLimits.MAX_ROWS.toLong(), t["maxRows"]!!.jsonPrimitive.long)
    }

    /** What the computer projects for phones (phone-terminal.json) reads without dropping a row. */
    @Test fun `decodes the computer's projections`() {
        val f = repoFile("crates/nekko-remote/tests/golden/phone-terminal.json")
        assumeTrue("running outside the monorepo", f.exists())
        val g = json(f.readText()).jsonObject
        for (case in g["terminals"]!!.jsonArray) {
            val out = case.jsonObject["output"]!!.jsonArray
            assertEquals(out.size, PhoneTerminal.list(out).size)
        }
        for (case in g["tails"]!!.jsonArray) {
            val out = case.jsonObject["output"] as? JsonObject ?: continue
            val tail = TerminalTail.from(out)!!
            assertEquals(out["buffer"]!!.jsonPrimitive.content, tail.buffer)
        }
        for (case in g["hosts"]!!.jsonArray) {
            val out = case.jsonObject["output"]!!.jsonArray
            assertEquals(out.size, SshHost.list(out).size)
        }
        // The list a phone sends is the one the computer forwards.
        val list = g["screens"]!!.jsonArray.map { it.jsonObject }.first { it["channel"]!!.jsonPrimitive.content == TerminalChannels.LIST && it["forwarded"] != null }
        assertEquals(list["args"].toString(), args(TerminalRequest.list("s1")))
    }

    @Test fun `refusals that opening again fixes`() {
        assertTrue(TerminalRefusal.needsReopen(RelayException("Not allowed from a paired phone (token-expired): terminal:write")))
        assertTrue(TerminalRefusal.needsReopen(RelayException("Not allowed from a paired phone (token-invalid): terminal:write")))
        assertFalse(TerminalRefusal.needsReopen(RelayException("Not allowed from a paired phone (change-off): terminal:write")))
        assertFalse(TerminalRefusal.needsReopen(RelayException("timed out")))
        assertEquals("Studio doesn’t share that terminal with phones. Only a chat’s terminals open here.", TerminalRefusal.message("terminal-hidden", "Studio"))
    }
}
