package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.nekko.android.ui.settings.ConnectionStatusSection
import com.nekko.protocol.ProbeNetwork
import com.nekko.protocol.RelayException
import org.junit.Assert.assertTrue
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.data.ThemePrefs
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.settings.AboutSection
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.PairingLink
import com.nekko.protocol.PhoneProtocol
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Check routes (IO-21) on Settings → Connection status: a computer with two routes, a tailnet
 * one that answers and a hosted relay whose name doesn't resolve, checked with a fake network
 * and a fake computer. The result is a whole-screen screenshot under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class RouteChecksTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    @Test fun checkRoutes() {
        val repo = repo(PhoneProtocol.VERSION)
        val prefs = PhonePrefs(object : PrefStore {
            val map = HashMap<String, String>()
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        })
        val deps = SettingsDeps(repo, ThemePrefs(ApplicationProvider.getApplicationContext()), prefs, open = {})
        compose.setContent { NekkoTheme(dark = false) { Column(Modifier.verticalScroll(rememberScrollState())) { ConnectionStatusSection(deps) } } }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE }
        compose.onNodeWithTag("connection.checkRoutes").performClick()
        compose.waitUntil(15_000) { !repo.checking.value && repo.checks.value.size == 2 && repo.checks.value.all { it.dns != null } }
        compose.onNodeWithTag("connection.checks").performScrollTo()
        settle()
        shot("1-checked")
        assertTrue(repo.checks.value.first().ok)
        assertTrue(!repo.checks.value.last().ok)
    }

    private fun androidx.compose.ui.test.junit4.ComposeTestRule.onNodeWithText(text: String) =
        onNode(hasText(text), useUnmergedTree = true)

    private fun repo(protocol: Int): ComputersRepository {
        val repo = ComputersRepository(
            store = MemoryStore(),
            remotes = { config, _ -> remote(config, protocol) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
            probeNetwork = object : ProbeNetwork {
                override suspend fun resolve(host: String, timeoutMs: Long): List<String> =
                    if (host.endsWith(".ts.net")) listOf("100.101.102.103") else throw RelayException("Unable to resolve host \"$host\"")
                override suspend fun connect(address: String, port: Int, timeoutMs: Long) {}
            },
        )
        runBlocking {
            val id = repo.pair(PairingLink("wss://studio.tail1234.ts.net", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", alts = listOf("wss://relay.example.dev")))
            repo.rename(id, "Studio Mac")
            repo.load()
        }
        return repo
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(700)
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "routes-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** A computer that welcomes the phone with [protocol] and has one chat. */
    private fun remote(config: RelayConfig, protocol: Int): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() {
            welcome.tryEmit(WelcomedDevice(config.deviceId, config.deviceName, "android", protocol))
            status.value = RelayStatus(RelayState.ONLINE)
        }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel)
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel)

        private fun answer(channel: String): JsonElement = when (channel) {
            // Touched just now: the list shows a group's recent chats, older ones behind Show more.
            Channels.SESSIONS_SUMMARIES -> WireJson.parseToJsonElement("""[{"id":"s1","title":"Tidy the release notes","updatedAt":${System.currentTimeMillis()}}]""")
            Channels.WORKSPACE_LIST -> JsonArray(emptyList())
            else -> JsonNull
        }
    }
}
