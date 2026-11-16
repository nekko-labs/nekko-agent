package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performClick
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2856: **Set up Tailscale** after pairing over it. The emulator has no tailnet, so step 1 asks to
 * turn Tailscale on (with Open Tailscale), the fake computer answers (step 2 ticked), and step 3
 * links to Android's VPN settings. Screenshot under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class TailscaleSetupDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    @Test fun theStepsAreCheckedLive() {
        val repo = repo()
        val id = repo.state.value.activeId!!
        var closed = false
        compose.setContent { NekkoTheme(dark = false) { com.nekko.android.ui.screens.TailscaleSetupSheet(repo, id) { closed = true } } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("tailscaleSetup.step2")).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE }
        compose.onNode(hasTestTag("tailscaleSetup.vpnSettings")).assertExists()
        // No tailnet on the emulator: step 1 says so and offers the app; Later, not Done.
        if (!com.nekko.android.connection.TailnetStatus.phoneOnTailnet()) {
            compose.onNode(hasTestTag("tailscaleSetup.open")).assertExists()
            compose.onNode(hasText("Later")).assertExists()
        }
        settle()
        shot("guide")
        compose.onNode(hasTestTag("tailscaleSetup.done")).performClick()
        compose.waitUntil(5_000) { closed }
    }

    private fun repo(): ComputersRepository {
        val repo = ComputersRepository(
            store = MemoryStore(),
            remotes = { config, _ -> computer.remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
            offlineFiles = object : com.nekko.protocol.OfflineFiles {
                val map = java.util.concurrent.ConcurrentHashMap<String, JsonElement>()
                override fun load(computerId: String, name: String) = map["$computerId/$name"]
                override fun save(computerId: String, name: String, value: JsonElement) { map["$computerId/$name"] = value }
                override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
            },
        )
        runBlocking {
            val id = repo.pair(testPairing())
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
        File(dir, "tailscale-setup-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** A computer that answers. */
    private class FakeComputer {
        val pieces = CopyOnWriteArrayList<Long>()
        val release = CountDownLatch(1)

        private fun meta() = buildJsonObject {
            put("id", "s1"); put("title", "Trip clips"); put("providerId", "openrouter"); put("modelId", "google/gemini-2.5-pro"); put("updatedAt", 1)
        }

        fun answer(channel: String, args: List<JsonElement>): JsonElement = when (channel) {
            Channels.SETTINGS_GET -> com.nekko.protocol.WireJson.parseToJsonElement("""{"defaultProviderId":"openrouter","defaultModelId":"google/gemini-2.5-pro","defaultChatMode":"guardrails"}""")
            Channels.SESSIONS_SUMMARIES -> buildJsonArray { add(meta()) }
            Channels.SESSION_GET -> buildJsonObject {
                meta().forEach { (k, v) -> put(k, v) }
                put("queue", JsonArray(emptyList()))
                put("messages", buildJsonArray {
                    add(buildJsonObject { put("id", "u"); put("role", "user"); put("content", "Plan the trip from these clips.") })
                })
            }
            Channels.CHAT_PENDING -> buildJsonObject { }
            Channels.ATTACHMENT_UPLOAD -> {
                val offset = (args[3] as JsonPrimitive).content.toLong()
                pieces += offset
                if (pieces.size == 2) release.await(20, TimeUnit.SECONDS)
                val received = offset + java.util.Base64.getDecoder().decode((args[5] as JsonPrimitive).content).size
                buildJsonObject { put("received", received); put("done", received == (args[4] as JsonPrimitive).content.toLong()) }
            }
            Channels.WORKSPACE_LIST -> JsonArray(emptyList())
            else -> JsonNull
        }

        fun remote(config: RelayConfig): Remote = object : Remote {
            override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
            override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
            override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
            override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
            override fun close() { status.value = RelayStatus(RelayState.IDLE) }
            override fun nudge() {}
            override fun reconnect() {}
            override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel, args.toList())
            override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, args.toList())
        }
    }
}
