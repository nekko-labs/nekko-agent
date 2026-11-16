package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assert
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
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
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
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2497: Allow tapped while the computer is away stays in the chat as a message, *Pending ·
 * sends when connected*, with Retry and Cancel; back online it goes once, after `chat:pending`
 * shows the same approval still waiting; once sent it leaves the composer. Run with `-e nekkoRevision before`
 * on main for the comparison (no assertions there). Screenshots under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class PendingResponsesDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision") ?: "after"
    private val after get() = revision == "after"

    @Test fun allowTappedOfflineIsKeptThenSent() {
        val repo = repo()
        val vm = ChatViewModel("s1", repo, null, null)
        compose.setContent { NekkoTheme(dark = false) { ChatScreen(vm, onBack = {}) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Allow")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        shot("1-card")

        // The connection drops with the card on screen; the person taps Allow anyway.
        computer.online = false
        computer.goOffline()
        settle()
        compose.onNode(hasText("Allow")).performClick()
        if (after) {
            compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("chat.response")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("response.status", useUnmergedTree = true).assert(androidx.compose.ui.test.hasText("Pending · sends when connected"))
            compose.onNodeWithTag("response.retry").assertExists()
            compose.onNodeWithTag("response.cancel").assertExists()
            // The card steps aside for the message: no second answer to the same request.
            assertEquals(0, compose.onAllNodes(hasText("Allow")).fetchSemanticsNodes().size)
        }
        settle()
        shot("2-offline")

        computer.online = true
        computer.goOnline()
        if (after) {
            compose.waitUntil(15_000) { computer.approved.isNotEmpty() }
            compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("chat.response")).fetchSemanticsNodes().isEmpty() }
            assertEquals(listOf("call-1"), computer.approved)
        }
        settle()
        shot("3-back-online")
    }

    /** Online, Allow goes at once and leaves no message behind: the card leaving must not cut the send short (LiveRelayTest's Deny). */
    @Test fun allowTappedOnlineIsSentAtOnce() {
        val repo = repo()
        val vm = ChatViewModel("s1", repo, null, null)
        compose.setContent { NekkoTheme(dark = false) { ChatScreen(vm, onBack = {}) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Allow")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Allow")).performClick()
        if (after) {
            compose.waitUntil(10_000) { computer.approved.isNotEmpty() }
            compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("chat.response")).fetchSemanticsNodes().isEmpty() }
            assertEquals(listOf("call-1"), computer.approved)
        }
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
        File(dir, "pending-response-$name-$revision-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** One chat waiting on approval of `npm test`; offline it answers nothing. */
    private class FakeComputer {
        @Volatile var online = true
        @Volatile var waiting = true
        val approved = CopyOnWriteArrayList<String>()
        private var live: MutableStateFlow<RelayStatus>? = null
        fun goOnline() { live?.value = RelayStatus(RelayState.ONLINE) }
        fun goOffline() { live?.value = RelayStatus(RelayState.OFFLINE) }

        private fun meta() = buildJsonObject {
            put("id", "s1"); put("title", "Fix the failing build"); put("providerId", "anthropic"); put("modelId", "claude-opus-4-7"); put("updatedAt", 1)
        }

        private fun pending(): JsonElement = if (!waiting) JsonObject(emptyMap()) else buildJsonObject {
            put("s1", buildJsonObject {
                put("approval", buildJsonObject {
                    put("call", buildJsonObject { put("id", "call-1"); put("name", "bash"); put("input", buildJsonObject { put("command", "npm test") }) })
                    put("reason", "Runs the test suite")
                    put("severity", "medium")
                })
            })
        }

        fun answer(channel: String, args: List<JsonElement>): JsonElement {
            if (!online) throw RelayException("$channel: Studio Mac is offline")
            return when (channel) {
                Channels.SETTINGS_GET -> com.nekko.protocol.WireJson.parseToJsonElement("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7","defaultChatMode":"guardrails"}""")
                Channels.SESSIONS_SUMMARIES -> buildJsonArray { add(meta()) }
                Channels.SESSION_GET -> buildJsonObject {
                    meta().forEach { (k, v) -> put(k, v) }
                    put("queue", JsonArray(emptyList()))
                    put("messages", buildJsonArray {
                        add(buildJsonObject { put("id", "u"); put("role", "user"); put("content", "The build fails on CI. Find out why and fix it.") })
                    })
                    if (waiting) put("activeRun", buildJsonObject { put("id", "run") })
                }
                Channels.CHAT_PENDING -> pending()
                Channels.TOOL_APPROVE -> {
                    approved += (args[1] as kotlinx.serialization.json.JsonPrimitive).content
                    waiting = false
                    JsonNull
                }
                Channels.WORKSPACE_LIST -> JsonArray(emptyList())
                else -> JsonNull
            }
        }

        fun remote(config: RelayConfig): Remote = object : Remote {
            override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
            override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
            override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
            override fun connect() {
                live = status
                status.value = RelayStatus(if (online) RelayState.ONLINE else RelayState.OFFLINE)
            }
            override fun close() { status.value = RelayStatus(RelayState.IDLE) }
            override fun nudge() {}
            override fun reconnect() {}
            // As a relay does, the answer comes a moment later: the card has left by then.
            override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
                if (channel == Channels.CHAT_PENDING || channel == Channels.TOOL_APPROVE) kotlinx.coroutines.delay(300)
                return answer(channel, args.toList())
            }
            override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, args.toList())
        }
    }
}
