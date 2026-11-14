package com.nekko.android

import com.nekko.android.connection.ConnectionFacts
import com.nekko.android.connection.ConnectionNote
import com.nekko.android.connection.ConnectionNote.Action
import com.nekko.android.connection.ConnectionNote.Tone
import com.nekko.android.connection.ConnectionNotes
import com.nekko.android.connection.ExitKind
import com.nekko.android.connection.Msg
import com.nekko.android.connection.Names
import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersState
import com.nekko.android.data.Peer
import com.nekko.protocol.DenyReason
import com.nekko.protocol.ProtocolCheck
import com.nekko.protocol.RelayHint
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The connection row's words and rules (spec/phone/iphone-connection-strip.md), as the iPhone's ConnectionNotesTests. */
class ConnectionNotesTest {
    private fun facts(
        id: String = "studio", state: RelayState = RelayState.ONLINE, route: RelayRoute = RelayRoute.INTERNET,
        active: Boolean = false, detail: String? = null, denied: DenyReason? = null, disabled: Boolean = false,
        protocolCheck: ProtocolCheck = ProtocolCheck.SAME, exit: ExitKind? = null, waiting: Int = 0,
    ) = ConnectionFacts(
        id = id, name = id.replaceFirstChar { it.uppercase() }, route = route, relayHost = "relay.example.dev", state = state,
        detail = detail, denied = denied, active = active, disabled = disabled, protocolCheck = protocolCheck,
        exit = exit, exitAt = if (exit != null) 1L else null, waiting = waiting,
    )

    private fun make(vararg c: ConnectionFacts, tailscale: Boolean = true) = ConnectionNotes.make(c.toList(), tailscale) { "9:41" }
    private fun word(n: ConnectionNote) = (n.word as? Msg.Res)?.res
    private fun res(n: Msg?) = (n as? Msg.Res)?.res

    @Test fun `online computers are a filled dot and a name, nothing to open`() {
        val notes = make(facts("studio"), facts("gomi"), facts("laptop"))
        assertEquals(listOf("studio", "gomi", "laptop"), notes.map { it.id })
        notes.forEach {
            assertEquals(Tone.OK, it.tone)
            assertNull(it.word)
            assertFalse(it.opens)
        }
        assertTrue(ConnectionNotes.problems(notes).isEmpty())
    }

    @Test fun `dialing for the first time and a switch turned off say nothing`() {
        val (dialing, off, idle) = make(facts("a", RelayState.CONNECTING), facts("b", disabled = true, state = RelayState.OFFLINE), facts("c", RelayState.IDLE))
        assertEquals(Tone.WAITING, dialing.tone); assertNull(dialing.word)
        assertEquals(Tone.OFF, off.tone); assertNull(off.word)
        assertEquals(Tone.OFF, idle.tone); assertNull(idle.word)
    }

    @Test fun `offline is one word, one line and Retry`() {
        val n = make(facts(state = RelayState.OFFLINE)).single()
        assertEquals(Tone.WARNING, n.tone)
        assertEquals(R.string.conn_word_offline, word(n))
        assertEquals(R.string.conn_offline_line, res(n.line))
        assertEquals(listOf(Action.RETRY), n.actions)
        assertFalse(n.more)
    }

    @Test fun `the active computer also gets Details and the safety exits`() {
        val n = make(facts(state = RelayState.OFFLINE, active = true, waiting = 2)).single()
        assertEquals(listOf(Action.RETRY, Action.DETAILS), n.actions)
        assertTrue(n.more)
        assertEquals(listOf(R.string.conn_offline_fix, R.string.conn_waits_other), n.tail.map(::res))
    }

    @Test fun `Tailscale off leads the row and the tailnet computer waits quietly`() {
        val notes = make(facts("studio", RelayState.CONNECTING, RelayRoute.TAILSCALE, active = true, waiting = 1), facts("gomi"), tailscale = false)
        val (ts, studio, gomi) = notes
        assertTrue(ts.isTailscale)
        assertEquals(R.string.conn_word_tailscale_off, word(ts))
        assertEquals(Msg.Res(R.string.conn_tailscale_line, listOf(Names(listOf("Studio")))), ts.line)
        assertEquals(listOf(Action.OPEN_TAILSCALE, Action.DETAILS), ts.actions)
        assertEquals(listOf(R.string.conn_waits_one), ts.tail.map(::res))
        assertEquals(Tone.WAITING, studio.tone); assertNull(studio.word)
        assertEquals(Tone.OK, gomi.tone)
    }

    @Test fun `Tailscale off only counts for enabled tailnet computers that are dialing or offline`() {
        assertEquals(1, make(facts("a", RelayState.ONLINE, RelayRoute.TAILSCALE), tailscale = false).size)
        assertEquals(1, make(facts("a", RelayState.OFFLINE, RelayRoute.INTERNET), tailscale = false).size)
        assertEquals(1, make(facts("a", RelayState.OFFLINE, RelayRoute.TAILSCALE, disabled = true), tailscale = false).size)
        assertEquals(1, make(facts("a", RelayState.DENIED, RelayRoute.TAILSCALE, denied = DenyReason.REVOKED), tailscale = false).size)
        assertTrue(make(facts("a", RelayState.OFFLINE, RelayRoute.TAILSCALE), tailscale = false).first().isTailscale)
    }

    @Test fun `several blocked computers are named together and Details needs the active one`() {
        val ts = make(facts("a", RelayState.OFFLINE, RelayRoute.TAILSCALE), facts("b", RelayState.CONNECTING, RelayRoute.TAILSCALE), tailscale = false).first()
        assertEquals(Names(listOf("A", "B")), (ts.line as Msg.Res).args.single())
        assertEquals(listOf(Action.OPEN_TAILSCALE), ts.actions)
    }

    @Test fun `Tailscale on and the computer silent moves the word to the computer`() {
        val notes = make(facts("studio", RelayState.CONNECTING, RelayRoute.TAILSCALE, detail = "timeout"), tailscale = true)
        assertEquals(1, notes.size)
        val n = notes.single()
        assertEquals(R.string.conn_word_no_answer, word(n))
        assertEquals(R.string.conn_no_answer_tailnet_line, res(n.line))
        assertEquals(listOf(Action.RETRY, Action.OPEN_TAILSCALE), n.actions)
    }

    @Test fun `a silent computer off the tailnet has no Tailscale fix`() {
        val n = make(facts(state = RelayState.CONNECTING, detail = "timeout")).single()
        assertEquals(R.string.conn_word_no_answer, word(n))
        assertEquals(listOf(Action.RETRY), n.actions)
    }

    @Test fun `a relay name that does not resolve is not found`() {
        val n = make(facts(state = RelayState.CONNECTING, detail = RelayStatus.HOST_NOT_FOUND)).single()
        assertEquals(Tone.DANGER, n.tone)
        assertEquals(R.string.conn_word_not_found, word(n))
        assertEquals(Msg.Res(R.string.conn_not_found_line, listOf("relay.example.dev")), n.line)
    }

    @Test fun `an address a phone can never reach is not found, with its own sentence`() {
        val c = facts(state = RelayState.CONNECTING).copy(addressProblem = RelayHint.Problem.LOOPBACK)
        val n = make(c).single()
        assertEquals(R.string.conn_word_not_found, word(n))
        assertEquals(Msg.Text(RelayHint.message(RelayHint.Problem.LOOPBACK, "Studio")), n.line)
    }

    @Test fun `a computer that removed this phone is refused and opens to Pair again only`() {
        for (reason in listOf(DenyReason.REVOKED, DenyReason.KICKED, DenyReason.UNKNOWN_DEVICE, DenyReason.INVALID)) {
            val n = make(facts(state = RelayState.DENIED, denied = reason)).single()
            assertEquals(Tone.DANGER, n.tone)
            assertEquals(R.string.conn_word_refused, word(n))
            assertEquals(listOf(Action.PAIR_AGAIN), n.actions)
            assertTrue(n.tail.isEmpty())
        }
        assertEquals(R.string.conn_removed_line, res(make(facts(state = RelayState.DENIED, denied = DenyReason.REVOKED)).single().line))
        assertEquals(R.string.conn_unknown_line, res(make(facts(state = RelayState.DENIED, denied = DenyReason.INVALID)).single().line))
    }

    @Test fun `a phone too old for the computer says update, not pair again`() {
        val n = make(facts(state = RelayState.DENIED, denied = DenyReason.UPDATE_REQUIRED)).single()
        assertEquals(R.string.conn_word_update, word(n))
        assertFalse(Action.PAIR_AGAIN in n.actions)
        assertTrue(n.actions.isEmpty())
    }

    @Test fun `a changed pairing key says key changed, whether denied or still dialing`() {
        for (c in listOf(facts(state = RelayState.DENIED, denied = DenyReason.BAD_KEY), facts(state = RelayState.OFFLINE, detail = RelayStatus.BAD_KEY), facts(state = RelayState.DENIED, denied = DenyReason.BAD_CODE))) {
            val n = make(c).single()
            assertEquals(Tone.DANGER, n.tone)
            assertEquals(R.string.conn_word_key_changed, word(n))
            assertEquals(listOf(Action.PAIR_AGAIN), n.actions)
        }
    }

    @Test fun `a safety exit is said instead of offline, with the time`() {
        val stopped = make(facts(state = RelayState.OFFLINE, active = true, exit = ExitKind.STOPPED_REMOTE)).single()
        assertEquals(R.string.conn_word_stopped, word(stopped))
        assertEquals(Msg.Res(R.string.conn_stopped_line_at, listOf("9:41")), stopped.line)
        assertEquals(listOf(Action.TRY_AGAIN, Action.DETAILS), stopped.actions)
        val quit = make(facts(state = RelayState.OFFLINE, active = true, exit = ExitKind.QUIT)).single()
        assertEquals(R.string.conn_word_quit, word(quit))
        assertEquals(Msg.Res(R.string.conn_quit_line_at, listOf("Studio", "9:41")), quit.line)
        assertTrue(Action.TRY_AGAIN !in quit.actions)
    }

    @Test fun `a safety exit is forgotten once the computer is online again`() {
        assertEquals(Tone.OK, make(facts(state = RelayState.ONLINE, active = true, exit = ExitKind.STOPPED_REMOTE)).single().tone)
    }

    @Test fun `the version difference is the word update on an online computer`() {
        val older = make(facts(active = true, protocolCheck = ProtocolCheck.UPDATE_COMPUTER)).single()
        assertEquals(Tone.OK, older.tone)
        assertEquals(R.string.conn_word_update, word(older))
        assertEquals(Tone.WARNING, older.wordTone)
        assertEquals(R.string.conn_update_computer_line, res(older.line))
        assertTrue(older.opens)
        val newer = make(facts(active = true, protocolCheck = ProtocolCheck.UPDATE_PHONE)).single()
        assertEquals(R.string.conn_update_phone_line, res(newer.line))
        assertNull(make(facts(active = true, protocolCheck = ProtocolCheck.SAME)).single().word)
    }

    @Test fun `a computer switched off is quiet even when its link is offline`() {
        val n = make(facts(state = RelayState.OFFLINE, disabled = true)).single()
        assertEquals(Tone.OFF, n.tone)
        assertFalse(n.opens)
    }

    @Test fun `the state maps to one facts per computer, in order, with the active one's details`() {
        val computers = listOf(
            Computer("a", "Studio", "wss://relay.example.dev", 0),
            Computer("b", "Gomi", "wss://gomi.tail1234.ts.net", 0, connectionDisabled = true),
            Computer("c", "Laptop", "wss://gomi.tail1234.ts.net", 0),
        )
        val s = ComputersState(
            ready = true, computers = computers, activeId = "a", conn = RelayState.OFFLINE, connDetail = null, remoteStoppedAt = 5L,
            peers = mapOf("c" to Peer(conn = RelayState.CONNECTING)),
        )
        val f = ConnectionNotes.facts(s, waiting = 3, debug = false)
        assertEquals(listOf("a", "b", "c"), f.map { it.id })
        assertTrue(f[0].active); assertEquals(3, f[0].waiting); assertEquals(ExitKind.STOPPED_REMOTE, f[0].exit)
        assertTrue(f[1].disabled)
        assertEquals(RelayRoute.TAILSCALE, f[2].route); assertEquals(RelayState.CONNECTING, f[2].state); assertEquals(0, f[2].waiting)
        // The later exit wins.
        val quit = ConnectionNotes.facts(s.copy(remoteQuitAt = 9L), 0, false)[0]
        assertEquals(ExitKind.QUIT, quit.exit); assertEquals(9L, quit.exitAt)
    }
}
