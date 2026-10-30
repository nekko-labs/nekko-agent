package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.PairingLink
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
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
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Offline mode's drafts: what the message box holds is kept when the chat is left and opened
 * again with a new view model. The fake computer is ChatActionsTest's.
 *
 * Was: the chat's ⋮ (Chat mode, Rename, Pin, Complete) and the chat list's long-press (Pin, Rename),
 * over a real [ComputersRepository] whose computer is a fake keeping the chat's title, pin and
 * mode as `session:setOptions` left them. Each step is a whole-screen screenshot under the
 * app's external files (`evidence/`), named by device.
 */
@RunWith(AndroidJUnit4::class)
class OutboxJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    @Test fun sentOfflineThenDelivered() {
        computer.online = false
        val repo = repo()
        val vm = ChatViewModel("s1", repo, null, null)
        compose.setContent { NekkoTheme(dark = false) { ChatScreen(vm, onBack = {}) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("composer.sendsLater")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("Run the tests when you're back")
        settle()
        shot("outbox-1-offline")
        compose.onNode(hasContentDescription("Send when online")).performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("outbox.waiting")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        shot("outbox-2-waiting")
        assertEquals(1, repo.outbox.state.value.waiting.size)

        computer.online = true
        computer.goOnline()
        compose.waitUntil(15_000) { repo.outbox.state.value.items.isEmpty() }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("outbox.waiting")).fetchSemanticsNodes().isEmpty() }
        settle()
        shot("outbox-3-delivered")
        assertEquals(1, computer.sends)
    }

    private fun repo(): ComputersRepository {
        val repo = ComputersRepository(
            store = MemoryStore(),
            remotes = { config, _ -> computer.remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        runBlocking {
            val id = repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff"))
            repo.rename(id, "Studio Mac")
            // The list draws once the repository has read its computers.
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
        File(dir, "$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** One chat, whose title, pin and mode follow `session:setOptions`; the computer's default mode is Guardrails. */
    private class FakeComputer {
        val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
        @Volatile var title = "Tidy the release notes"
        @Volatile var pinned = false
        @Volatile var mode: String? = null
        @Volatile var online = true
        @Volatile var sends = 0
        val ids = java.util.concurrent.CopyOnWriteArrayList<String>()
        private var live: MutableStateFlow<RelayStatus>? = null
        fun goOnline() { live?.value = RelayStatus(RelayState.ONLINE) }

        private fun json(s: String): JsonElement = com.nekko.protocol.WireJson.parseToJsonElement(s)

        private fun meta() = buildJsonObject {
            put("id", "s1")
            put("title", title)
            put("providerId", "anthropic")
            put("modelId", "claude-opus-4-7")
            put("updatedAt", 1)
            put("pinned", pinned)
            mode?.let { put("mode", it) }
            put("clientMessageIds", JsonArray(ids.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        }

        private fun session() = buildJsonObject {
            meta().forEach { (k, v) -> put(k, v) }
            put("queue", JsonArray(emptyList()))
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "u"); put("role", "user"); put("content", "Group the release notes by area and drop the duplicates.") })
                add(buildJsonObject { put("id", "a"); put("role", "assistant"); put("content", "Done: 14 notes in 4 areas. I removed 3 duplicates.") })
            })
        }

        fun answer(channel: String, args: List<JsonElement>): JsonElement {
            calls += channel
            return when (channel) {
                Channels.SETTINGS_GET -> json("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7","defaultChatMode":"guardrails","chatPaneAction":"complete"}""")
                Channels.SESSIONS_SUMMARIES -> buildJsonArray { add(meta()) }
                Channels.SESSION_GET -> session()
                Channels.SESSION_SET_OPTIONS -> {
                    val patch = args[1].jsonObject
                    patch["title"]?.let { title = it.jsonPrimitive.content }
                    patch["pinned"]?.let { pinned = it.jsonPrimitive.content == "true" }
                    patch["mode"]?.let { mode = it.jsonPrimitive.content }
                    session()
                }
                Channels.CHAT_SEND -> {
                    sends++
                    args[0].jsonObject["clientMessageId"]?.jsonPrimitive?.content?.let { ids += it }
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
            override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel, args.toList())
            override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, args.toList())
        }
    }
}
