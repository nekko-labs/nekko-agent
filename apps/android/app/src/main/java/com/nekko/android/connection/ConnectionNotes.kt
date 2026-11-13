package com.nekko.android.connection

import androidx.annotation.StringRes
import com.nekko.android.R
import com.nekko.android.data.ComputersState
import com.nekko.protocol.DenyReason
import com.nekko.protocol.ProtocolCheck
import com.nekko.protocol.RelayHint
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus

/** Words for the row, as a string resource and its arguments (resolved on screen, so the mapping is testable without a Context). */
sealed interface Msg {
    data class Res(@StringRes val res: Int, val args: List<Any> = emptyList()) : Msg
    /** Already in words (the relay hint's own sentence). */
    data class Text(val text: String) : Msg
}

/** Computer names to be written as "Studio, Gomi and Laptop" in the phone's language. */
data class Names(val names: List<String>)

private fun msg(@StringRes res: Int, vararg args: Any): Msg = Msg.Res(res, args.toList())

/**
 * What the connection row says about one paired computer, or about Tailscale on this phone:
 * a dot, at most one word, and (behind a tap) one line and its fixes. The iPhone's `ConnectionNote`
 * (spec/phone/iphone-connection-strip.md); replaces the connection, fleet and protocol banners.
 */
data class ConnectionNote(
    /** The computer's id, or [TAILSCALE_ID]. */
    val id: String,
    /** The computer's name, or null for the Tailscale item. */
    val name: String?,
    val tone: Tone,
    /** The one word beside the name when something is wrong. */
    val word: Msg?,
    /** The colour of [word]; the dot's colour is [tone]. */
    val wordTone: Tone,
    /** The one sentence shown when the item is opened; null means there is nothing to open. */
    val line: Msg?,
    /** A quieter second half (how to fix it, what waits to send), joined after [line] by a space. */
    val tail: List<Msg>,
    val actions: List<Action>,
    /** Offer the safety exits (SK-8) beside the actions: the active computer only. */
    val more: Boolean,
) {
    enum class Tone {
        /** Online. */
        OK,
        /** Dialing, or waiting on something else (Tailscale): a hollow ring, no word. */
        WAITING,
        /** Not connected by choice (the computer's connection switch is off). */
        OFF,
        WARNING,
        DANGER,
    }

    enum class Action {
        /** Dial now (the link keeps trying on its own anyway). */
        RETRY,
        /** Remote access was turned back on at the computer after a safety exit: connect again. */
        TRY_AGAIN,
        PAIR_AGAIN,
        OPEN_TAILSCALE,
        /** The Computers screen, with the connection details (the active computer only). */
        DETAILS,
    }

    val opens: Boolean get() = line != null
    val isTailscale: Boolean get() = id == TAILSCALE_ID

    companion object {
        const val TAILSCALE_ID = "tailscale"
    }
}

/** A safety exit this phone used on a computer (SK-8). */
enum class ExitKind { STOPPED_REMOTE, QUIT }

/** One paired computer's connection, as the row needs it. */
data class ConnectionFacts(
    val id: String,
    val name: String,
    val route: RelayRoute,
    val relayHost: String,
    val state: RelayState,
    val detail: String? = null,
    val denied: DenyReason? = null,
    /** The computer the phone's screens act on: it gets Details and the safety exits. */
    val active: Boolean = false,
    /** The connection switch is off (#2059): not a problem, the user chose it. */
    val disabled: Boolean = false,
    /** The active computer's protocol comparison (IO-32); SAME for the others. */
    val protocolCheck: ProtocolCheck = ProtocolCheck.SAME,
    val exit: ExitKind? = null,
    /** When the exit happened (ms since the epoch). */
    val exitAt: Long? = null,
    /** Prompts written here that go when the computer is back. */
    val waiting: Int = 0,
    /** The relay address can never work from a phone (localhost, public ws://). */
    val addressProblem: RelayHint.Problem? = null,
)

object ConnectionNotes {
    /** The row's items: Tailscale first when it is what keeps computers away, then every computer in order. */
    fun make(computers: List<ConnectionFacts>, tailscaleOn: Boolean, time: (Long) -> String = { "" }): List<ConnectionNote> {
        val blocked = computers.filter { !it.disabled && shouldOfferTailscale(it.route, tailscaleOn, it.state) }
        val out = mutableListOf<ConnectionNote>()
        if (blocked.isNotEmpty()) {
            out += ConnectionNote(
                id = ConnectionNote.TAILSCALE_ID, name = null, tone = ConnectionNote.Tone.WARNING,
                word = msg(R.string.conn_word_tailscale_off), wordTone = ConnectionNote.Tone.WARNING,
                line = msg(R.string.conn_tailscale_line, Names(blocked.map { it.name })),
                tail = listOfNotNull(waitingTail(blocked.sumOf { it.waiting })),
                actions = listOf(ConnectionNote.Action.OPEN_TAILSCALE) + if (blocked.any { it.active }) listOf(ConnectionNote.Action.DETAILS) else emptyList(),
                more = false,
            )
        }
        val blockedIds = blocked.map { it.id }.toSet()
        for (c in computers) out += if (c.id in blockedIds) quiet(c, ConnectionNote.Tone.WAITING) else note(c, time)
        return out
    }

    /** Offer *Open Tailscale* when the computer is on the tailnet, Tailscale is off on this phone and the phone is trying to reach it. */
    fun shouldOfferTailscale(route: RelayRoute, tailscaleOn: Boolean, state: RelayState): Boolean =
        route == RelayRoute.TAILSCALE && !tailscaleOn && (state == RelayState.CONNECTING || state == RelayState.OFFLINE)

    /** Only the items that have something to say. */
    fun problems(notes: List<ConnectionNote>): List<ConnectionNote> = notes.filter { it.opens }

    private fun quiet(c: ConnectionFacts, tone: ConnectionNote.Tone) =
        ConnectionNote(c.id, c.name, tone, word = null, wordTone = tone, line = null, tail = emptyList(), actions = emptyList(), more = false)

    private fun waitingTail(n: Int): Msg? = when {
        n == 0 -> null
        n == 1 -> msg(R.string.conn_waits_one)
        else -> msg(R.string.conn_waits_other, n)
    }

    fun note(c: ConnectionFacts, time: (Long) -> String): ConnectionNote {
        val name = c.name
        fun problem(tone: ConnectionNote.Tone, word: Msg, line: Msg, fix: Msg?, actions: List<ConnectionNote.Action>) = ConnectionNote(
            id = c.id, name = name, tone = tone, word = word, wordTone = tone, line = line,
            tail = listOfNotNull(fix, if (c.active) waitingTail(c.waiting) else null),
            actions = actions + if (c.active) listOf(ConnectionNote.Action.DETAILS) else emptyList(),
            more = c.active,
        )
        if (c.disabled) return quiet(c, ConnectionNote.Tone.OFF)
        // This phone ended the connection itself (SK-8): say so, not "offline".
        if (c.exit != null && c.state != RelayState.ONLINE) {
            val at = c.exitAt?.let(time).orEmpty()
            return when (c.exit) {
                ExitKind.STOPPED_REMOTE -> problem(
                    ConnectionNote.Tone.WARNING, msg(R.string.conn_word_stopped),
                    if (at.isEmpty()) msg(R.string.conn_stopped_line) else msg(R.string.conn_stopped_line_at, at),
                    msg(R.string.conn_stopped_fix, name), listOf(ConnectionNote.Action.TRY_AGAIN),
                )
                ExitKind.QUIT -> problem(
                    ConnectionNote.Tone.WARNING, msg(R.string.conn_word_quit),
                    if (at.isEmpty()) msg(R.string.conn_quit_line, name) else msg(R.string.conn_quit_line_at, name, at),
                    msg(R.string.conn_quit_fix), emptyList(),
                )
            }
        }
        if (c.detail == RelayStatus.BAD_KEY || (c.state == RelayState.DENIED && (c.denied == DenyReason.BAD_KEY || c.denied == DenyReason.BAD_CODE))) {
            return problem(ConnectionNote.Tone.DANGER, msg(R.string.conn_word_key_changed), msg(R.string.conn_key_line, name), msg(R.string.conn_key_fix), listOf(ConnectionNote.Action.PAIR_AGAIN))
        }
        if (c.addressProblem != null && c.state != RelayState.ONLINE) {
            // An address the phone can never reach: say why instead of dialing forever.
            return problem(ConnectionNote.Tone.DANGER, msg(R.string.conn_word_not_found), Msg.Text(RelayHint.message(c.addressProblem, name)), null, listOf(ConnectionNote.Action.PAIR_AGAIN))
        }
        return when (c.state) {
            RelayState.ONLINE -> when (c.protocolCheck) {
                ProtocolCheck.SAME -> quiet(c, ConnectionNote.Tone.OK)
                ProtocolCheck.UPDATE_COMPUTER -> ConnectionNote(
                    c.id, name, ConnectionNote.Tone.OK, msg(R.string.conn_word_update), ConnectionNote.Tone.WARNING,
                    msg(R.string.conn_update_computer_line, name), listOf(msg(R.string.conn_update_computer_fix)), emptyList(), false,
                )
                ProtocolCheck.UPDATE_PHONE -> ConnectionNote(
                    c.id, name, ConnectionNote.Tone.OK, msg(R.string.conn_word_update), ConnectionNote.Tone.WARNING,
                    msg(R.string.conn_update_phone_line, name), listOf(msg(R.string.conn_update_phone_fix)), emptyList(), false,
                )
            }
            RelayState.IDLE -> quiet(c, ConnectionNote.Tone.OFF)
            RelayState.CONNECTING -> when {
                c.detail == RelayStatus.HOST_NOT_FOUND -> problem(
                    ConnectionNote.Tone.DANGER, msg(R.string.conn_word_not_found),
                    if (c.relayHost.isEmpty()) msg(R.string.conn_not_found_relay) else msg(R.string.conn_not_found_line, c.relayHost),
                    msg(R.string.conn_not_found_fix, name), emptyList(),
                )
                // Still dialing for the first time: nothing to say until it fails.
                c.detail == null -> quiet(c, ConnectionNote.Tone.WAITING)
                c.route == RelayRoute.TAILSCALE -> problem(
                    ConnectionNote.Tone.WARNING, msg(R.string.conn_word_no_answer), msg(R.string.conn_no_answer_tailnet_line, name),
                    msg(R.string.conn_no_answer_tailnet_fix), listOf(ConnectionNote.Action.RETRY, ConnectionNote.Action.OPEN_TAILSCALE),
                )
                else -> problem(
                    ConnectionNote.Tone.WARNING, msg(R.string.conn_word_no_answer), msg(R.string.conn_no_answer_line, name),
                    msg(R.string.conn_no_answer_fix), listOf(ConnectionNote.Action.RETRY),
                )
            }
            RelayState.OFFLINE -> problem(
                ConnectionNote.Tone.WARNING, msg(R.string.conn_word_offline), msg(R.string.conn_offline_line, name),
                msg(R.string.conn_offline_fix), listOf(ConnectionNote.Action.RETRY),
            )
            RelayState.DENIED -> when (c.denied) {
                DenyReason.UPDATE_REQUIRED -> problem(
                    ConnectionNote.Tone.DANGER, msg(R.string.conn_word_update), msg(R.string.conn_update_required_line, name),
                    msg(R.string.conn_update_required_fix), emptyList(),
                )
                DenyReason.REVOKED, DenyReason.KICKED -> problem(
                    ConnectionNote.Tone.DANGER, msg(R.string.conn_word_refused), msg(R.string.conn_removed_line, name), null, listOf(ConnectionNote.Action.PAIR_AGAIN),
                )
                else -> problem(
                    ConnectionNote.Tone.DANGER, msg(R.string.conn_word_refused), msg(R.string.conn_unknown_line, name), null, listOf(ConnectionNote.Action.PAIR_AGAIN),
                )
            }
        }
    }

    /** Every paired computer's connection, in the app's order, for the row. [waiting] is the active computer's outbox. */
    fun facts(s: ComputersState, waiting: Int, debug: Boolean): List<ConnectionFacts> = s.computers.map { c ->
        val active = c.id == s.activeId
        val peer = s.peers[c.id]
        val url = if (active) s.route ?: c.relayUrl else c.relayUrl
        val stopAt = s.remoteStoppedAt.takeIf { active }
        val quitAt = s.remoteQuitAt.takeIf { active }
        // The later of this phone's two safety exits.
        val exit = when {
            quitAt != null && (stopAt == null || quitAt >= stopAt) -> ExitKind.QUIT to quitAt
            stopAt != null -> ExitKind.STOPPED_REMOTE to stopAt
            else -> null
        }
        ConnectionFacts(
            id = c.id, name = c.name, route = RelayRoute.of(url), relayHost = com.nekko.protocol.Pairing.relayHost(url),
            state = if (active) s.conn else peer?.conn ?: RelayState.IDLE,
            detail = if (active) s.connDetail else peer?.detail,
            denied = if (active) s.denied else peer?.denied,
            active = active, disabled = c.connectionDisabled == true,
            protocolCheck = if (active) s.protocolCheck else ProtocolCheck.SAME,
            exit = exit?.first, exitAt = exit?.second,
            waiting = if (active) waiting else 0,
            addressProblem = RelayHint.problem(url, debug),
        )
    }
}
