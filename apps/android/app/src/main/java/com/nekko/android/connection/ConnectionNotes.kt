package com.nekko.android.connection

import androidx.annotation.StringRes
import com.nekko.android.R
import com.nekko.android.data.ComputersState
import com.nekko.protocol.DenyReason
import com.nekko.protocol.FleetLink
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
 * What the connection row says about one paired computer, 
 * a dot, at most one word, and (behind a tap) one line and its fixes. The iPhone's `ConnectionNote`
 * (spec/phone/iphone-connection-strip.md); replaces the connection, fleet and protocol banners.
 */
data class ConnectionNote(
    /** The computer's id. */
    val id: String,
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
    /**
     * The phone also has a route to this computer that doesn't need Tailscale (Nekko Cloud Relay or
     * another internet relay, decision 0116), so Tailscale being off is not what keeps it away.
     */
    val offTailnet: Boolean = false,
    /** A computer of the account, dialed with no pairing (decision 0126): a refusal reads as the account's. */
    val fromAccount: Boolean = false,
) {
    /** Only Tailscale reaches this computer: when Tailscale is off, it is the thing to fix. */
    val tailnetOnly: Boolean get() = route == RelayRoute.TAILSCALE && !offTailnet
}

object ConnectionNotes {
    /**
     * The row's items, one per computer in order. A computer only Tailscale reaches (by its routes, or because
     * the phone's route choice is Tailscale only) says "Tailscale off" itself when that is what blocks it; there
     * is no page-wide Tailscale item (#3346). A computer with an off-tailnet route is never blamed on Tailscale.
     */
    fun make(computers: List<ConnectionFacts>, tailscaleOn: Boolean, time: (Long) -> String = { "" }): List<ConnectionNote> =
        computers.map { note(it, time, tailscaleOn) }

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

    fun note(c: ConnectionFacts, time: (Long) -> String, tailscaleOn: Boolean = true): ConnectionNote {
        val name = c.name
        fun problem(tone: ConnectionNote.Tone, word: Msg, line: Msg, fix: Msg?, actions: List<ConnectionNote.Action>) = ConnectionNote(
            id = c.id, name = name, tone = tone, word = word, wordTone = tone, line = line,
            tail = listOfNotNull(fix, if (c.active) waitingTail(c.waiting) else null),
            actions = actions + if (c.active) listOf(ConnectionNote.Action.DETAILS) else emptyList(),
            more = c.active,
        )
        if (c.disabled) return quiet(c, ConnectionNote.Tone.OFF)
        // Only Tailscale reaches it and Tailscale is off on this phone: that computer's own problem, with the fix beside it.
        if (!c.offTailnet && shouldOfferTailscale(c.route, tailscaleOn, c.state)) {
            return problem(
                ConnectionNote.Tone.WARNING, msg(R.string.conn_word_tailscale_off), msg(R.string.conn_tailscale_line, name),
                null, listOf(ConnectionNote.Action.OPEN_TAILSCALE),
            )
        }
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
                c.tailnetOnly -> problem(
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
            RelayState.DENIED -> if (c.fromAccount && (c.denied?.isFleet == true || c.denied == DenyReason.INVALID)) problem(
                // The account's own refusals, in words (English for now: the pairing ones are translated).
                ConnectionNote.Tone.WARNING, msg(R.string.conn_word_refused),
                Msg.Text(FleetLink.accountRefusalText(c.denied.wire) ?: "$name refused this phone."), null, emptyList(),
            ) else when (c.denied) {
                DenyReason.UPDATE_REQUIRED -> problem(
                    ConnectionNote.Tone.DANGER, msg(R.string.conn_word_update), msg(R.string.conn_update_required_line, name),
                    msg(R.string.conn_update_required_fix), emptyList(),
                )
                DenyReason.ROUTE -> problem(
                    ConnectionNote.Tone.WARNING, msg(R.string.conn_word_refused), msg(R.string.conn_route_line, name),
                    msg(R.string.conn_route_fix, name), listOf(ConnectionNote.Action.PAIR_AGAIN),
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

    /**
     * One of a computer's routes needs no tailnet: Nekko Cloud Relay or another internet relay (decision 0116).
     * A LAN address doesn't count: it is no use away from home, where Tailscale would be the fix.
     */
    fun reachableOffTailnet(routes: List<String>): Boolean = routes.any { RelayRoute.of(it) == RelayRoute.INTERNET }

    /** Every paired computer's connection, in the app's order, for the row. [waiting] is the active computer's outbox. */
    fun facts(s: ComputersState, waiting: Int, debug: Boolean): List<ConnectionFacts> = s.computers.map { c ->
        val active = c.id == s.activeId
        val peer = s.peers[c.id]
        val url = if (active) s.route ?: c.relayUrl else c.relayUrl
        // What this phone may dial: the route choice's kinds, so `direct` is never off the tailnet and `cloud` always is.
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
            offTailnet = reachableOffTailnet(c.routes),
            fromAccount = c.fromAccount,
        )
    }
}
