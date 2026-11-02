package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
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
 * The chat's ⋮ (Chat mode, Rename, Pin, Complete) and the chat list's long-press (Pin, Rename),
 * over a real [ComputersRepository] whose computer is a fake keeping the chat's title, pin and
 * mode as `session:setOptions` left them. Each step is a whole-screen screenshot under the
 * app's external files (`evidence/`), named by device.
 */
@RunWith(AndroidJUnit4::class)
class ChatActionsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    @Test fun chatMenu() {
        val repo = repo()
        val vm = ChatViewModel("s1", repo, null, null)
        compose.setContent { NekkoTheme(dark = false) { ChatScreen(vm, onBack = {}) } }
        compose.waitUntil(10_000) { computer.calls.contains(Channels.SESSION_GET) }
        settle()

        compose.onNodeWithTag("chat.more").performClick()
        settle()
        shot("1-menu")

        // Chat mode: the chat follows the computer's default until it has its own.
        compose.onNodeWithTag("chat.toolMode").performClick()
        settle()
        shot("2-mode")
        compose.onNodeWithTag("chat.toolMode.ask").performClick()
        compose.waitUntil(5_000) { computer.mode == "ask" }

        compose.onNodeWithTag("chat.more").performClick()
        settle()
        compose.onNodeWithTag("chat.rename").performClick()
        settle()
        compose.onNodeWithTag("chat.rename.field").performTextReplacement("Release notes, grouped")
        settle()
        shot("3-rename")
        compose.onAllNodes(hasText("Rename")).onFirst().performClick()
        compose.waitUntil(5_000) { computer.title == "Release notes, grouped" }

        compose.onNodeWithTag("chat.more").performClick()
        settle()
        compose.onNodeWithTag("chat.pin").performClick()
        compose.waitUntil(5_000) { computer.pinned }
        compose.onNodeWithTag("chat.more").performClick()
        settle()
        shot("4-menu-after")
        assertEquals(1, compose.onAllNodes(hasText("Unpin")).fetchSemanticsNodes().size)
    }

    @Test fun chatListLongPress() {
        computer.pinned = true
        val repo = repo()
        compose.setContent {
            NekkoTheme(dark = false) { ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}) }
        }
        compose.waitUntil(10_000) { repo.state.value.summaries.isNotEmpty() }
        settle()
        shot("5-list-pinned")
        compose.onAllNodes(hasText("Tidy the release notes")).onFirst().performTouchInput { longClick() }
        settle()
        shot("6-long-press")
        compose.onNodeWithTag("chats.pin").performClick()
        compose.waitUntil(5_000) { !computer.pinned }
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
        File(dir, "actions-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
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

        private fun json(s: String): JsonElement = com.nekko.protocol.WireJson.parseToJsonElement(s)

        private fun meta() = buildJsonObject {
            put("id", "s1")
            put("title", title)
            put("providerId", "anthropic")
            put("modelId", "claude-opus-4-7")
            put("updatedAt", 1)
            put("pinned", pinned)
            mode?.let { put("mode", it) }
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
                Channels.WORKSPACE_LIST -> JsonArray(emptyList())
                else -> JsonNull
            }
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
