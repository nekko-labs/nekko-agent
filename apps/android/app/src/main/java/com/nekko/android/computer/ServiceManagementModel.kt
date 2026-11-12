package com.nekko.android.computer

import com.nekko.protocol.RelayException
import com.nekko.protocol.ServiceAction
import com.nekko.protocol.ServiceChannels
import com.nekko.protocol.ServiceNote
import com.nekko.protocol.ServiceNote.Kind
import com.nekko.protocol.ServiceStatus
import com.nekko.protocol.ServiceUpdate
import com.nekko.protocol.StepUpProof
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One computer's live connection, as the service section may use it. */
interface ServiceLink {
    /** The live connection to this computer while it is the active one and online; null otherwise. Compared by identity. */
    fun connection(): Any?

    /** A Read call to this computer. */
    suspend fun read(channel: String): JsonElement

    /** A Change call, signed with this phone's key; [stepUp] when the computer asked for one. */
    suspend fun change(channel: String, stepUp: StepUpProof?): JsonElement
}

/** What the section shows. */
data class ServiceUi(
    val online: Boolean = false,
    val status: ServiceStatus? = null,
    val update: ServiceUpdate? = null,
    val loading: Boolean = false,
    val inFlight: ServiceAction? = null,
    /** Restart or install waiting for the person's yes. */
    val confirming: ServiceAction? = null,
    /** Restart or install waiting for a step-up (the sheet is open). */
    val stepUp: ServiceAction? = null,
    val problem: ServiceNote? = null,
    /** A failure whose outcome on the computer can't be known: never retried by the phone. */
    val outcomeUnknown: Boolean = false,
    val notice: ServiceNote? = null,
    /** An older computer that doesn't know `service:*`. */
    val unsupported: Boolean = false,
    /** A restart or install was accepted: nothing else until the phone has reconnected and refreshed. */
    val awaitingReconnect: Boolean = false,
)

/**
 * The service section's rules, the iPhone's ServiceManagementModel on Android (#2059):
 *
 * - Every step is pinned to the connection and the moment it started. If the computer stops being
 *   the active one, the connection changes or drops, a late reply is dropped and nothing is sent.
 * - Restart and install are asked first ([request] → [confirm]); a step-up, when the computer
 *   asks for one, goes through the app's step-up sheet ([stepUpRetry], [stepUpCancelled]).
 * - Nothing that may have reached the computer is ever sent again on its own: a timeout or a
 *   dropped connection says the outcome is unknown and asks for a refresh.
 * - An accepted restart or install is not proof it finished: the phone must reconnect and refresh.
 */
class ServiceManagementModel(private val link: ServiceLink) {
    private val _ui = MutableStateFlow(ServiceUi())
    val ui: StateFlow<ServiceUi> = _ui.asStateFlow()

    private var generation = 0
    /** The connection [ServiceUi.status] was read on; actions need it to still be the live one. */
    private var discovered: Any? = null
    /** Set by a drop seen while a restart or install was awaited: the next live connection is a reconnect. */
    private var droppedSinceAccepted = false
    /** Where a step-up was asked: the retry must land on the same connection, at the same moment. */
    private var stepUpAt: Pair<Any, Int>? = null

    private fun online() = link.connection() != null

    private fun matches(connection: Any, epoch: Int) = generation == epoch && link.connection() === connection

    private class Stale : Exception()

    private fun require(connection: Any, epoch: Int) {
        if (!matches(connection, epoch)) throw Stale()
    }

    /** Why [action] can't run now; null when it can. */
    fun disabledReason(a: ServiceAction, s: ServiceUi = _ui.value): ServiceNote? {
        val conn = link.connection() ?: return ServiceNote(Kind.OFFLINE)
        if (s.loading || s.inFlight != null) return ServiceNote(Kind.WAIT)
        if (s.awaitingReconnect) return ServiceNote(Kind.RECONNECT_FIRST)
        val status = s.status
        if (status == null || discovered !== conn) return ServiceNote(if (s.unsupported) Kind.UPDATE_HOST else Kind.REFRESH_FIRST)
        if (!status.manageServiceFromPhone) return ServiceNote(Kind.OPT_IN)
        if (!status.supports(a)) return ServiceNote.capability(status.capabilities[a]?.reason)
        if (a == ServiceAction.UPDATE_INSTALL && s.update?.state != ServiceUpdate.State.DOWNLOADED) return ServiceNote(Kind.DOWNLOAD_FIRST)
        if (a == ServiceAction.UPDATE_DOWNLOAD && s.update?.state != ServiceUpdate.State.AVAILABLE) return ServiceNote(Kind.CHECK_FIRST)
        if (a in setOf(ServiceAction.UPDATE_CHECK, ServiceAction.UPDATE_DOWNLOAD, ServiceAction.UPDATE_INSTALL) && s.update?.busy == true) return ServiceNote(Kind.UPDATER_BUSY)
        return null
    }

    /** Only while the updater is checking or downloading, and nothing else is going on. */
    val shouldPoll: Boolean
        get() = _ui.value.let { s ->
            online() && discovered != null && s.status?.manageServiceFromPhone == true && s.status.supports(ServiceAction.UPDATE_STATE) &&
                s.update?.busy == true && !s.awaitingReconnect && s.inFlight == null && !s.loading && s.problem == null && s.stepUp == null
        }

    /**
     * The active computer or its connection changed (or the section appeared): forget what was read,
     * drop pending questions, and read again when online. A drop after an accepted restart or
     * install, then a live connection, is the reconnect that lets actions back.
     */
    suspend fun connectionChanged() {
        generation++
        discovered = null
        stepUpAt = null
        val live = online()
        if (_ui.value.awaitingReconnect && !live) droppedSinceAccepted = true
        val reconnected = _ui.value.awaitingReconnect && live && droppedSinceAccepted
        if (reconnected) droppedSinceAccepted = false
        _ui.update {
            it.copy(
                online = live, status = null, update = null, confirming = null, stepUp = null, unsupported = false,
                awaitingReconnect = it.awaitingReconnect && !reconnected,
                loading = false, inFlight = null,
            )
        }
        refresh()
    }

    /** Read-only, so always safe, even after an uncertain change. */
    suspend fun refresh() {
        val connection = link.connection() ?: return
        if (_ui.value.loading || _ui.value.inFlight != null) return
        val epoch = generation
        _ui.update { it.copy(loading = true, problem = null, outcomeUnknown = false) }
        try {
            discover(connection, epoch)
            val s = _ui.value
            if (s.status?.manageServiceFromPhone == true && s.status.supports(ServiceAction.UPDATE_STATE) && !s.awaitingReconnect) readUpdate(connection, epoch)
            else _ui.update { it.copy(update = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (matches(connection, epoch)) {
                discovered = null
                _ui.update { it.copy(status = null, problem = describe(e, discovery = true), unsupported = it.unsupported || isOldHost(e)) }
            }
        } finally {
            if (generation == epoch) _ui.update { it.copy(loading = false) }
        }
    }

    /** One read of the updater while it works; when it settles, support is read again. */
    suspend fun poll() {
        if (!shouldPoll) return
        val connection = link.connection() ?: return
        val epoch = generation
        _ui.update { it.copy(loading = true) }
        try {
            readUpdate(connection, epoch)
            if (_ui.value.update?.busy == false) discover(connection, epoch)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (matches(connection, epoch)) _ui.update { it.copy(problem = describe(e)) }
        } finally {
            if (generation == epoch) _ui.update { it.copy(loading = false) }
        }
    }

    /** A button: restart and install ask first; refreshing reads; the rest run. */
    suspend fun request(a: ServiceAction) {
        if (disabledReason(a) != null) return
        when {
            a.needsConfirmation -> _ui.update { it.copy(confirming = a) }
            a == ServiceAction.UPDATE_STATE -> refresh()
            else -> perform(a)
        }
    }

    fun cancelConfirmation() = _ui.update { it.copy(confirming = null) }

    /** The person said yes: the question is used up at once, and the action runs if it still can. */
    suspend fun confirm() {
        val a = _ui.value.confirming ?: return
        _ui.update { it.copy(confirming = null) }
        if (disabledReason(a) != null) return
        perform(a)
    }

    private suspend fun perform(a: ServiceAction) {
        val connection = link.connection() ?: return
        val epoch = generation
        _ui.update { it.copy(inFlight = a, problem = null, notice = null, outcomeUnknown = false) }
        try {
            require(connection, epoch)
            val reply = try {
                link.change(a.channel, null)
            } catch (e: RelayException) {
                // The computer wants a step-up first: nothing ran. The sheet asks for it, on this same connection.
                if (a.needsConfirmation && e.refusal?.asksForStepUp == true && matches(connection, epoch)) {
                    stepUpAt = connection to epoch
                    _ui.update { it.copy(stepUp = a) }
                    return
                }
                throw e
            }
            require(connection, epoch)
            accepted(a, reply, connection, epoch)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed(a, e, connection, epoch)
        } finally {
            if (generation == epoch && _ui.value.stepUp == null) _ui.update { it.copy(inFlight = null) }
        }
    }

    /**
     * The step-up sheet's answer, sent with the same action on the same connection. A refusal is
     * thrown back to the sheet, which fetches a fresh challenge; a changed connection ends it.
     */
    suspend fun stepUpRetry(proof: StepUpProof) {
        val a = _ui.value.stepUp ?: throw IllegalStateException("Nothing is waiting for a confirmation.")
        val (connection, epoch) = stepUpAt ?: throw IllegalStateException("The connection changed. Refresh this computer’s service status before trying again.")
        if (!matches(connection, epoch)) throw IllegalStateException("The connection changed. Refresh this computer’s service status before trying again.")
        val reply = try {
            link.change(a.channel, proof)
        } catch (e: RelayException) {
            // Refused (a wrong code, a spent challenge): the sheet says so and offers another try.
            if (e.refusal != null) throw e
            // Anything else may have reached the computer: never sent again on its own.
            stepUpAt = null
            failed(a, e, connection, epoch)
            _ui.update { it.copy(stepUp = null, inFlight = null) }
            return
        }
        stepUpAt = null
        _ui.update { it.copy(stepUp = null, inFlight = null) }
        if (!matches(connection, epoch)) return
        try {
            accepted(a, reply, connection, epoch)
        } catch (e: Exception) {
            failed(a, e, connection, epoch)
        }
    }

    /** Cancel on the step-up sheet: nothing changed on the computer. */
    fun stepUpCancelled() {
        if (_ui.value.stepUp == null) return
        stepUpAt = null
        _ui.update { it.copy(stepUp = null, inFlight = null, problem = ServiceNote(Kind.NOT_CONFIRMED)) }
    }

    private suspend fun accepted(a: ServiceAction, reply: JsonElement, connection: Any, epoch: Int) {
        if (a.needsConfirmation) {
            val key = if (a == ServiceAction.RESTART) "restarting" else "installing"
            val ok = (reply as? JsonObject)?.let { it.size == 1 && (it[key] as? JsonPrimitive)?.content == "true" } == true
            if (!ok) throw RelayException("not-accepted")
            discovered = null
            droppedSinceAccepted = false
            _ui.update {
                it.copy(
                    awaitingReconnect = true, status = null, update = null,
                    notice = ServiceNote(if (a == ServiceAction.RESTART) Kind.RESTART_ACCEPTED else Kind.INSTALL_ACCEPTED),
                )
            }
        } else {
            acceptUpdate(reply)
            // Support can change after a check or a download.
            if (matches(connection, epoch)) runCatching { discover(connection, epoch) }
        }
    }

    private fun failed(a: ServiceAction, e: Exception, connection: Any, epoch: Int) {
        if (e is Stale || !matches(connection, epoch)) return
        val refused = (e as? RelayException)?.refusal != null || ServiceNote.error(e.message.orEmpty()) != null
        _ui.update {
            it.copy(
                problem = if (e.message == "not-accepted") ServiceNote(Kind.NOT_ACCEPTED) else describe(e),
                // A refusal is certain; a timeout or a dropped connection is not.
                outcomeUnknown = !refused && e.message != "not-accepted",
            )
        }
    }

    private suspend fun discover(connection: Any, epoch: Int) {
        require(connection, epoch)
        val raw = link.read(ServiceChannels.STATUS)
        require(connection, epoch)
        val status = ServiceStatus.from(raw) ?: throw RelayException("unsupported-response")
        discovered = connection
        _ui.update { it.copy(status = status, unsupported = false) }
    }

    private suspend fun readUpdate(connection: Any, epoch: Int) {
        require(connection, epoch)
        val raw = link.read(ServiceChannels.UPDATE_STATE)
        require(connection, epoch)
        acceptUpdate(raw)
    }

    private fun acceptUpdate(raw: JsonElement) {
        val u = ServiceUpdate.from(raw) ?: throw RelayException("unreadable-update")
        _ui.update { it.copy(update = u, problem = if (u.state == ServiceUpdate.State.ERROR) ServiceNote(Kind.UPDATER_FAILED, u.message) else it.problem) }
    }

    private fun isOldHost(e: Exception) = ServiceNote.error(e.message.orEmpty(), discovery = true)?.kind == Kind.HOST_TOO_OLD ||
        (e as? RelayException)?.refusal?.code == "channel-denied"

    private fun describe(e: Exception, discovery: Boolean = false): ServiceNote {
        val raw = e.message.orEmpty()
        if (discovery && isOldHost(e)) return ServiceNote(Kind.HOST_TOO_OLD)
        return when (raw) {
            "unsupported-response" -> ServiceNote(Kind.UNSUPPORTED_RESPONSE)
            "unreadable-update" -> ServiceNote(Kind.UNREADABLE_UPDATE)
            else -> ServiceNote.error(raw) ?: ServiceNote(Kind.OTHER, raw.ifBlank { null })
        }
    }
}
