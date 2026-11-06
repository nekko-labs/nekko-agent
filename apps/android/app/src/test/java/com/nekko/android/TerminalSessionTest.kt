package com.nekko.android

import com.nekko.android.terminal.TerminalBackend
import com.nekko.android.terminal.TerminalSession
import com.nekko.android.terminal.TerminalsController
import com.nekko.protocol.PhoneTerminal
import com.nekko.protocol.RelayException
import com.nekko.protocol.SshHost
import com.nekko.protocol.TermColor
import com.nekko.protocol.TerminalChannels
import com.nekko.protocol.TerminalEvent
import com.nekko.protocol.TerminalKey
import com.nekko.protocol.TerminalRequest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A computer as the terminal screens see it: tokens bound to a terminal,
 * handed out by opening (a Change action), and ending when told to. The
 * iPhone's FakeTerminals.
 */
private class FakeTerminals : TerminalBackend {
    val reads = mutableListOf<TerminalRequest>()
    val changes = mutableListOf<TerminalRequest>()
    val emitted = MutableSharedFlow<TerminalEvent>(extraBufferCapacity = 64)
    var opened = 0
    var validToken: String? = null
    var refuseChange: Exception? = null
    var hostsError: Exception? = null
    var listeners = 0
    override val computerName = "Studio"
    override val events = emitted

    fun reply(id: String, token: String, buffer: String = "$ ", running: Boolean = true) = buildJsonObject {
        putJsonObject("terminal") { put("id", id); put("title", "zsh"); put("kind", "shell"); put("folder", "app"); put("shell", "zsh"); put("running", running); put("viewers", 1) }
        put("buffer", buffer); put("cols", 80); put("rows", 24); put("truncated", false); put("token", token)
        put("idleMs", 300_000); put("maxMs", 1_800_000)
    }

    override suspend fun read(r: TerminalRequest): JsonElement {
        reads += r
        return when (r.channel) {
            TerminalChannels.LIST -> buildJsonArray {
                add(buildJsonObject { put("id", "term_1"); put("title", "zsh"); put("kind", "shell"); put("folder", "app"); put("shell", "zsh"); put("running", true); put("viewers", 0) })
                add(buildJsonObject { put("id", "agent_s1"); put("title", "Agent commands"); put("kind", "agent"); put("folder", ""); put("shell", "agent"); put("running", false); put("viewers", 0) })
            }
            TerminalChannels.SSH_HOSTS -> {
                hostsError?.let { throw it }
                buildJsonArray { add(buildJsonObject { put("alias", "devbox"); put("hostName", "devbox.lan"); put("port", 22) }) }
            }
            TerminalChannels.TAIL -> buildJsonObject {
                putJsonObject("terminal") { put("id", r.args[0].jsonPrimitive.content); put("title", "Agent commands"); put("kind", "agent"); put("running", false); put("viewers", 0) }
                put("buffer", "$ npm test\r\nok\r\n"); put("cols", 40); put("rows", 10); put("truncated", false)
            }
            TerminalChannels.WRITE, TerminalChannels.RESIZE -> {
                val token = r.args.last().jsonPrimitive.content
                if (token != validToken) throw RelayException("Not allowed from a paired phone (token-expired): ${r.channel}")
                JsonNull
            }
            else -> JsonNull
        }
    }

    override suspend fun change(r: TerminalRequest): JsonElement {
        changes += r
        refuseChange?.let { throw it }
        return when (r.channel) {
            TerminalChannels.OPEN, TerminalChannels.CREATE, TerminalChannels.SSH_OPEN -> {
                opened += 1
                val token = "tok$opened"
                validToken = token
                val id = when (r.channel) {
                    TerminalChannels.OPEN -> r.args[0].jsonPrimitive.content
                    TerminalChannels.CREATE -> "term_9"
                    else -> "term_ssh"
                }
                reply(id, token)
            }
            else -> JsonNull
        }
    }

    fun writes(): List<String> = reads.filter { it.channel == TerminalChannels.WRITE }.map { JsonArray(it.args).toString() }
}

/** AN-31: the Terminals list and one open terminal. The iPhone's TerminalSessionTests, case for case. */
@OptIn(ExperimentalCoroutinesApi::class)
class TerminalSessionTest {
    private fun TestScope.session(c: FakeTerminals, id: String = "term_1", kind: PhoneTerminal.Kind = PhoneTerminal.Kind.SHELL) =
        TerminalSession(PhoneTerminal(id, "zsh", kind), c, backgroundScope)

    @Test fun `lists the chat's terminals and hosts`() = runTest {
        val c = FakeTerminals()
        val m = TerminalsController("s1", c, backgroundScope)
        m.load()
        assertEquals(listOf("term_1", "agent_s1"), m.state.value.terminals.map { it.id })
        assertEquals(listOf("devbox"), m.state.value.hosts.map { it.alias })
        assertEquals("always one chat's", """[{"sessionId":"s1"}]""", JsonArray(c.reads.first().args).toString())
        c.hostsError = RelayException(
            "Reading from this phone is turned off on Studio. Turn it on in Remote access → What phones can do.",
            com.nekko.protocol.PhoneRefusal("read-off", "ssh:hosts"),
        )
        m.load()
        assertEquals(emptyList<SshHost>(), m.state.value.hosts)
        assertEquals("Reading from this phone is turned off on Studio. Turn it on in Remote access → What phones can do.", m.state.value.hostsError)
    }

    @Test fun `opening attaches once and typing uses the token`() = runTest {
        val c = FakeTerminals()
        val s = session(c)
        s.start()
        runCurrent()
        assertEquals(TerminalSession.State.Live, s.state.value)
        assertEquals("one signed open", listOf("terminal:open"), c.changes.map { it.channel })
        assertEquals("$", s.screen.screenText.first())
        s.sendLine("ls -la")
        s.key(TerminalKey.Ctrl('c'))
        s.key(TerminalKey.Up)
        runCurrent()
        assertEquals(listOf("""["term_1","ls -la\r","tok1"]""", """["term_1","\u0003","tok1"]""", """["term_1","\u001b[A","tok1"]"""), c.writes())
        assertEquals("no proof per keystroke", 1, c.changes.size)
    }

    @Test fun `output arrives for this terminal only`() = runTest {
        val c = FakeTerminals()
        val s = session(c)
        s.start()
        runCurrent()
        val v = s.version.value
        c.emitted.emit(TerminalEvent.Data("term_1", "\u001b[32mhello\u001b[0m"))
        c.emitted.emit(TerminalEvent.Data("term_2", "not mine"))
        runCurrent()
        assertEquals("$ hello", s.screen.screenText.first())
        assertEquals(TermColor.Palette(2), s.screen.style(2, 0).fg)
        assertTrue(s.version.value > v)
        c.emitted.emit(TerminalEvent.Exit("term_1", 0))
        runCurrent()
        assertEquals(TerminalSession.State.Exited(0), s.state.value)
        assertFalse(s.canType)
    }

    @Test fun `an expired token opens again and retries`() = runTest {
        val c = FakeTerminals()
        val s = session(c)
        s.start()
        runCurrent()
        c.validToken = null // idle for five minutes on the computer
        s.send("x")
        runCurrent()
        assertEquals("the fingerprint again, once", listOf("terminal:open", "terminal:open"), c.changes.map { it.channel })
        assertEquals(listOf("tok1", "tok2"), c.reads.filter { it.channel == TerminalChannels.WRITE }.map { it.args.last().jsonPrimitive.content })
        assertNull(s.error.value)
    }

    @Test fun `a mode the program set changes the keys and paste`() = runTest {
        val c = FakeTerminals()
        val s = session(c)
        s.start()
        runCurrent()
        c.emitted.emit(TerminalEvent.Data("term_1", "\u001b[?1h\u001b[?2004h"))
        runCurrent()
        s.key(TerminalKey.Left)
        s.paste("a\nb")
        runCurrent()
        assertEquals(listOf("\u001bOD", "\u001b[200~a\rb\u001b[201~"), c.reads.filter { it.channel == TerminalChannels.WRITE }.map { it.args[1].jsonPrimitive.content })
    }

    @Test fun `resize follows the phone and leaving restores the size`() = runTest {
        val c = FakeTerminals()
        val s = session(c)
        s.start()
        runCurrent()
        s.resize(44, 30)
        s.resize(44, 30) // the same size again: nothing sent
        runCurrent()
        assertEquals(listOf("""["term_1",44,30,"tok1"]"""), c.reads.filter { it.channel == TerminalChannels.RESIZE }.map { JsonArray(it.args).toString() })
        s.leave()
        assertEquals("back to the desktop's size", """["term_1",80,24,"tok1"]""", JsonArray(c.reads.last { it.channel == TerminalChannels.RESIZE }.args).toString())
        assertEquals(TerminalChannels.LEAVE, c.reads.last().channel)
        assertFalse(s.canType)
        // No longer listening: output for it changes nothing.
        val v = s.version.value
        c.emitted.emit(TerminalEvent.Data("term_1", "late"))
        runCurrent()
        assertEquals(v, s.version.value)
    }

    @Test fun `the agent log is read only`() = runTest {
        val c = FakeTerminals()
        val s = session(c, "agent_s1", PhoneTerminal.Kind.AGENT)
        s.start()
        runCurrent()
        assertEquals(TerminalSession.State.ReadOnly, s.state.value)
        assertTrue("never attached", c.changes.isEmpty())
        assertEquals(listOf("$ npm test", "ok"), s.screen.screenText.take(2))
        s.send("x")
        runCurrent()
        assertTrue(c.writes().isEmpty())
    }

    @Test fun `a flood the computer dropped is read again`() = runTest {
        val c = FakeTerminals()
        val s = session(c)
        s.start()
        runCurrent()
        c.emitted.emit(TerminalEvent.Data("term_1", "", skipped = 300_000))
        runCurrent()
        assertEquals(1, c.reads.count { it.channel == TerminalChannels.TAIL })
    }

    @Test fun `a new terminal and SSH open attached`() = runTest {
        val c = FakeTerminals()
        val m = TerminalsController("s1", c, backgroundScope)
        val t = m.newTerminal(40, 20)
        assertEquals("term_9", t.terminalId)
        assertEquals(TerminalSession.State.Live, t.state.value)
        assertEquals("""[{"sessionId":"s1","cols":40,"rows":20}]""", JsonArray(c.changes.last().args).toString())
        val ssh = m.openSsh(SshHost("devbox"), 40, 20)
        assertEquals("term_ssh", ssh.terminalId)
        assertEquals("""["devbox",{"sessionId":"s1","cols":40,"rows":20}]""", JsonArray(c.changes.last().args).toString())
    }

    @Test fun `a refused open says why`() = runTest {
        val c = FakeTerminals()
        c.refuseChange = RelayException("Not allowed from a paired phone (terminal-hidden): term_x")
        val s = TerminalSession(PhoneTerminal("term_x", "x"), c, backgroundScope)
        s.start()
        assertEquals(TerminalSession.State.Failed("Studio doesn’t share that terminal with phones. Only a chat’s terminals open here."), s.state.value)
    }
}
