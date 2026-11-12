package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ComputerScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.ServiceChannels
import com.nekko.protocol.SoftwareChangeSigner
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * #2059: the computer page's *Nekko Agent service* against a fake computer that behaves like the
 * real gate: everything but status refused while *Manage service from phone* is off; changes need
 * a signed proof; restart needs a step-up (a code here); restart drops and restores the link.
 * Screenshots in `evidence/service-*.png`.
 */
class ServiceManagementDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Volatile private var optIn = false
    private val sent = mutableListOf<Triple<String, Boolean, StepUpProof?>>()
    private var link: MutableStateFlow<RelayStatus>? = null

    private fun status() = WireJson.parseToJsonElement(
        """{"protocolVersion":1,"agentRunning":true,"manageServiceFromPhone":$optIn,"capabilities":{
            "restart":{"supported":true},"updateState":{"supported":true},"updateCheck":{"supported":true},
            "updateDownload":{"supported":true},"updateInstall":{"supported":false,"reason":"interactive-admin-install"}}}""",
    )

    private val update = WireJson.parseToJsonElement("""{"state":"available","currentVersion":"0.9.4","version":"0.9.5","notesUrl":"https://nekkoagent.com/changelog","edition":"desktop"}""")

    private fun answer(channel: String): JsonElement = when (channel) {
        ServiceChannels.STATUS -> status()
        ServiceChannels.UPDATE_STATE -> if (optIn) update else throw RelayException("service-disabled: Manage service from phone is off")
        Channels.SECURITY_CHALLENGE -> WireJson.parseToJsonElement("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":${System.currentTimeMillis() + 120_000},"required":true,"methods":["totp"]}""")
        Channels.MACHINE_SUMMARY -> WireJson.parseToJsonElement("""{"platform":"darwin","version":"0.9.4","edition":"desktop"}""")
        else -> JsonNull
    }

    private fun remote(@Suppress("UNUSED_PARAMETER") config: RelayConfig): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE)).also { link = it }
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel)
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel)
        override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?): JsonElement {
            if (channel != com.nekko.protocol.ChangeProof.KEY_CHANNEL) sent += Triple(channel, proof.isNotEmpty(), stepUp)
            return when (channel) {
                com.nekko.protocol.ChangeProof.KEY_CHANNEL -> JsonNull
                ServiceChannels.UPDATE_CHECK -> update
                // The gate: restart needs a step-up first.
                ServiceChannels.RESTART -> if (stepUp == null) throw RelayException("Not allowed from a paired phone (step-up-required): service:restart")
                    else WireJson.parseToJsonElement("""{"restarting":true}""")
                else -> throw RelayException("service-invalid: unexpected $channel")
            }
        }
    }

    private fun show(): Pair<ComputersRepository, String> {
        val repo = ComputersRepository(
            store = object : SecureStore {
                private val map = HashMap<String, String>()
                override suspend fun get(key: String) = map[key]
                override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
            },
            remotes = { config, _ -> remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
            changeSigner = SoftwareChangeSigner.generate(),
        )
        val id = runBlocking {
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
            repo.load()
            id
        }
        compose.setContent { NekkoTheme(dark = false) { ComputerScreen(repo, id, onBack = {}, onProviders = {}) } }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE }
        return repo to id
    }

    private fun scrollTo(tag: String) {
        compose.onNode(hasTestTag("computer.scroll")).performScrollToNode(hasTestTag(tag))
        compose.waitForIdle()
    }

    private fun waitFor(tag: String) = compose.waitUntil(8_000) { compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    @Test fun optInThenConfirmedStepUpRestartAndReconnect() {
        show()
        // Opt-in off on the computer: the phone says where to turn it on, and offers nothing.
        waitFor("service.optIn")
        scrollTo("service.section")
        shot("1-opt-in-off")
        compose.onNodeWithTag("service.restart").assertDoesNotExist()

        // Turned on there; Refresh reads it again.
        optIn = true
        compose.onNodeWithTag("service.refresh").performClick()
        waitFor("service.updateState")
        scrollTo("service.restart")
        shot("2-on")

        // Restart: asked first, then a step-up, then accepted (not yet proof).
        compose.onNodeWithTag("service.restart").performClick()
        compose.waitForIdle()
        shot("3-confirm")
        compose.onNodeWithTag("service.confirm").performClick()
        compose.waitUntil(8_000) { compose.onAllNodes(hasText("Code from your authenticator app")).fetchSemanticsNodes().isNotEmpty() }
        shot("4-step-up")
        assertEquals("the first try was signed, with no step-up", listOf(Triple(ServiceChannels.RESTART, true, null as StepUpProof?)), sent.toList())
        compose.onNode(hasText("Code from your authenticator app")).performTextInput("123456")
        compose.onNodeWithText("Confirm with code").performClick()
        waitFor("service.notice")
        assertEquals(StepUpProof.Totp("123456"), sent.last().third)
        scrollTo("service.notice")
        shot("5-accepted")
        compose.onNodeWithTag("service.updateCheck").assertDoesNotExist()

        // The service restarts: the link drops and comes back; actions return after the reconnect.
        link!!.value = RelayStatus(RelayState.OFFLINE)
        compose.waitForIdle()
        Thread.sleep(500)
        link!!.value = RelayStatus(RelayState.ONLINE)
        waitFor("service.restart")
        scrollTo("service.restart")
        shot("6-reconnected")
        assertTrue("restart was sent once with the code, never again", sent.count { it.first == ServiceChannels.RESTART } == 2)
    }

    private fun shot(name: String) {
        Thread.sleep(400)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "service-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
