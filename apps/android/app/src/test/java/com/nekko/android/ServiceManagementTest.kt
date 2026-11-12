package com.nekko.android

import com.nekko.android.computer.ServiceLink
import com.nekko.android.computer.ServiceManagementModel
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.ServiceAction
import com.nekko.protocol.ServiceChannels
import com.nekko.protocol.ServiceNote.Kind
import com.nekko.protocol.ServiceStatus
import com.nekko.protocol.ServiceUpdate
import com.nekko.protocol.StepUpProof
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2059: the service section's rules, as on the iPhone. The computer decides (opt-in, signature,
 * step-up); the phone never sends anything to another computer, never repeats a change that may
 * have landed, and asks before a restart or an install.
 */
class ServiceManagementTest {
    private fun status(enabled: Boolean = true, restart: Boolean = true, install: String? = null) = Json.parseToJsonElement(
        """{"protocolVersion":1,"agentRunning":true,"manageServiceFromPhone":$enabled,"capabilities":{
            "restart":{"supported":$restart${if (!restart) ""","reason":"supervisor-unavailable"""" else ""}},
            "updateState":{"supported":true},"updateCheck":{"supported":true},"updateDownload":{"supported":true},
            "updateInstall":{"supported":${install == null}${install?.let { ""","reason":"$it"""" } ?: ""}}}}""",
    )

    private fun update(state: String, version: String? = null) = Json.parseToJsonElement(
        """{"state":"$state","currentVersion":"0.9.0","notesUrl":"https://x","edition":"desktop"${version?.let { ""","version":"$it"""" } ?: ""}}""",
    )

    /** A fake computer: answers by channel, records every call, and can switch connection. */
    private class Fake : ServiceLink {
        var conn: Any? = Any()
        val reads = mutableMapOf<String, () -> JsonElement>()
        val changes = mutableMapOf<String, (StepUpProof?) -> JsonElement>()
        val sent = mutableListOf<Pair<String, StepUpProof?>>()
        var during: () -> Unit = {}
        override fun connection() = conn
        override suspend fun read(channel: String) = reads.getValue(channel)()
        override suspend fun change(channel: String, stepUp: StepUpProof?): JsonElement {
            sent += channel to stepUp
            during()
            return changes.getValue(channel)(stepUp)
        }
    }

    private fun ready(enabled: Boolean = true, updateState: String = "none", restart: Boolean = true, install: String? = null) = Fake().apply {
        reads[ServiceChannels.STATUS] = { status(enabled, restart, install) }
        reads[ServiceChannels.UPDATE_STATE] = { update(updateState, "1.0.0") }
    }

    @Test fun `only version 1 with every capability is read, and unknown updater states are refused`() {
        assertEquals(true, ServiceStatus.from(status())?.manageServiceFromPhone)
        assertNull(ServiceStatus.from(Json.parseToJsonElement("""{"protocolVersion":2,"agentRunning":true,"manageServiceFromPhone":true,"capabilities":{}}""")))
        assertNull("a missing capability", ServiceStatus.from(Json.parseToJsonElement("""{"protocolVersion":1,"agentRunning":true,"manageServiceFromPhone":true,"capabilities":{"restart":{"supported":true}}}""")))
        assertEquals(ServiceUpdate.State.DOWNLOADED, ServiceUpdate.from(update("downloaded"))?.state)
        assertNull(ServiceUpdate.from(update("installing")))
        assertEquals(Kind.SERVICE_BUSY, com.nekko.protocol.ServiceNote.error("Error: service-busy: another action")?.kind)
        assertEquals("another action", com.nekko.protocol.ServiceNote.error("service-busy: another action")?.detail)
        assertEquals(Kind.OPT_IN, com.nekko.protocol.ServiceNote.error("service-disabled: off")?.kind)
        assertEquals(Kind.CAP_LOCAL_APPROVAL, com.nekko.protocol.ServiceNote.capability("interactive-admin-install").kind)
    }

    @Test fun `with the computer's opt-in off nothing can run, and the phone says where to turn it on`() = runTest {
        val m = ServiceManagementModel(ready(enabled = false))
        m.connectionChanged()
        assertEquals(false, m.ui.value.status?.manageServiceFromPhone)
        for (a in ServiceAction.entries) assertEquals(Kind.OPT_IN, m.disabledReason(a)?.kind)
    }

    @Test fun `restart is asked first, then signed, and accepted is not proof until a reconnect`() = runTest {
        val f = ready().apply { changes[ServiceChannels.RESTART] = { Json.parseToJsonElement("""{"restarting":true}""") } }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        m.request(ServiceAction.RESTART)
        assertEquals("asked, not sent", ServiceAction.RESTART, m.ui.value.confirming)
        assertTrue(f.sent.isEmpty())
        m.confirm()
        assertEquals(listOf(ServiceChannels.RESTART to null), f.sent)
        assertTrue(m.ui.value.awaitingReconnect)
        assertEquals(Kind.RESTART_ACCEPTED, m.ui.value.notice?.kind)
        assertEquals(Kind.RECONNECT_FIRST, m.disabledReason(ServiceAction.UPDATE_CHECK)?.kind)
        // The same connection refreshing is not a reconnect.
        m.connectionChanged()
        assertTrue(m.ui.value.awaitingReconnect)
        // Dropped, then back: actions return.
        f.conn = null; m.connectionChanged()
        f.conn = Any(); m.connectionChanged()
        assertFalse(m.ui.value.awaitingReconnect)
        assertNull(m.disabledReason(ServiceAction.RESTART))
    }

    @Test fun `cancelling the question sends nothing`() = runTest {
        val f = ready()
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        m.request(ServiceAction.RESTART)
        m.cancelConfirmation()
        m.confirm()
        assertTrue(f.sent.isEmpty())
    }

    @Test fun `a step-up goes through the sheet on the same connection, and Cancel changes nothing`() = runTest {
        val f = ready(updateState = "downloaded").apply {
            changes[ServiceChannels.UPDATE_INSTALL] = { proof ->
                if (proof == null) throw RelayException("Confirm with your security key or a code.", PhoneRefusal("step-up-required", "service:updateInstall"))
                Json.parseToJsonElement("""{"installing":true}""")
            }
        }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        m.request(ServiceAction.UPDATE_INSTALL)
        m.confirm()
        assertEquals("the sheet opens", ServiceAction.UPDATE_INSTALL, m.ui.value.stepUp)
        m.stepUpCancelled()
        assertEquals(Kind.NOT_CONFIRMED, m.ui.value.problem?.kind)
        assertEquals(1, f.sent.size)

        m.request(ServiceAction.UPDATE_INSTALL)
        m.confirm()
        m.stepUpRetry(StepUpProof.Totp("123456"))
        assertEquals(StepUpProof.Totp("123456"), f.sent.last().second)
        assertTrue(m.ui.value.awaitingReconnect)
        assertEquals(Kind.INSTALL_ACCEPTED, m.ui.value.notice?.kind)
    }

    @Test fun `a step-up answer after the connection changed is never sent`() = runTest {
        val f = ready().apply {
            changes[ServiceChannels.RESTART] = { proof ->
                if (proof == null) throw RelayException("step up", PhoneRefusal("step-up-required", "service:restart"))
                Json.parseToJsonElement("""{"restarting":true}""")
            }
        }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        m.request(ServiceAction.RESTART)
        m.confirm()
        f.conn = Any() // another computer became active, or the link was replaced
        val thrown = runCatching { m.stepUpRetry(StepUpProof.Totp("123456")) }.exceptionOrNull()
        assertTrue(thrown is IllegalStateException)
        assertEquals("only the first, unproven try reached the computer", 1, f.sent.size)
    }

    @Test fun `a timeout is never retried and says the outcome is unknown`() = runTest {
        val f = ready().apply { changes[ServiceChannels.RESTART] = { throw RelayException("Timed out waiting for the computer.") } }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        m.request(ServiceAction.RESTART)
        m.confirm()
        assertEquals(1, f.sent.size)
        assertTrue(m.ui.value.outcomeUnknown)
        assertFalse(m.ui.value.awaitingReconnect)
        // A computer's refusal is certain, not unknown.
        f.changes[ServiceChannels.RESTART] = { throw RelayException("service-busy: another action") }
        m.request(ServiceAction.RESTART)
        m.confirm()
        assertEquals(Kind.SERVICE_BUSY, m.ui.value.problem?.kind)
        assertFalse(m.ui.value.outcomeUnknown)
    }

    @Test fun `a reply that arrives after the computer changed is dropped`() = runTest {
        val f = ready().apply { changes[ServiceChannels.UPDATE_CHECK] = { update("available", "1.0.0") } }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        f.during = { f.conn = Any() }
        m.request(ServiceAction.UPDATE_CHECK)
        assertEquals("the old computer's answer isn't shown", "none", m.ui.value.update?.state?.wire)
        assertNull(m.ui.value.problem)
    }

    @Test fun `an unsupported action says why, from the computer's reason`() = runTest {
        val m = ServiceManagementModel(ready(restart = false, install = "interactive-admin-install"))
        m.connectionChanged()
        assertEquals(Kind.CAP_SUPERVISOR, m.disabledReason(ServiceAction.RESTART)?.kind)
        assertEquals(Kind.CAP_LOCAL_APPROVAL, m.disabledReason(ServiceAction.UPDATE_INSTALL)?.kind)
        assertEquals("download needs an available update", Kind.CHECK_FIRST, m.disabledReason(ServiceAction.UPDATE_DOWNLOAD)?.kind)
    }

    @Test fun `an older computer without service channels is told to update`() = runTest {
        val f = Fake().apply { reads[ServiceChannels.STATUS] = { throw RelayException("Not allowed from a paired phone (channel-denied): service:status", PhoneRefusal("channel-denied", "service:status")) } }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        assertTrue(m.ui.value.unsupported)
        assertEquals(Kind.HOST_TOO_OLD, m.ui.value.problem?.kind)
        assertEquals(Kind.UPDATE_HOST, m.disabledReason(ServiceAction.RESTART)?.kind)
    }

    @Test fun `offline nothing runs`() = runTest {
        val f = ready().apply { conn = null }
        val m = ServiceManagementModel(f)
        m.connectionChanged()
        assertEquals(Kind.OFFLINE, m.disabledReason(ServiceAction.RESTART)?.kind)
        m.request(ServiceAction.RESTART)
        assertNull(m.ui.value.confirming)
    }
}
