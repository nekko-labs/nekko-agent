package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.ui.chat.ModeTags
import com.nekko.android.ui.simple.EXPERT_DESCRIPTION
import com.nekko.android.ui.simple.SIMPLE_DESCRIPTION
import com.nekko.android.ui.panes.PaneLabels
import com.nekko.android.ui.panes.PanesHost
import com.nekko.android.ui.panes.rememberWindowPosture
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.PaneContent
import com.nekko.protocol.PaneLayout
import com.nekko.protocol.PaneMode
import com.nekko.protocol.PaneSide
import com.nekko.protocol.PairingLink
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Simple and Expert modes in the real chat screen (spec/phone/iphone-simple-and-expert-modes.md):
 * [ChatScreen] and [ChatViewModel] over a real [ComputersRepository] whose computer is a fake
 * answering like the phone gate does. On an open folding phone (600 dp or wider) it shows two
 * chats side by side in [PanesHost], as the app does; on a phone, one chat. Each step is a
 * whole-screen screenshot (sheets and menus included) under the app's external files
 * (`evidence/`), named by device.
 */
@RunWith(AndroidJUnit4::class)
class ChatModesTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()

    /** Names the screenshots: `-e nekkoDevice fold`, else the model (every emulator calls itself the same). */
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val prefs = PhonePrefs(object : PrefStore {
        val map = HashMap<String, String>()
        override fun getString(name: String) = map[name]
        override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
    })

    @Test fun simpleAndExpert() {
        show()
        // Simple by default: the model only, no effort dial text, context ring or hardware strip.
        assertTrue(compose.onAllNodesWithTag(ModeTags.MODEL_EFFORT).fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.CONTEXT).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
        shot("1-simple")

        // Expert (the code icon): the hardware strip under the title, effort and the context ring.
        compose.onAllNodesWithContentDescription(EXPERT_DESCRIPTION).onFirst().performClick()
        compose.waitUntil(5_000) { computer.calls.any { it == Channels.ENGINE_STATUS } }
        settle()
        assertTrue(prefs.get(EXPERT_MODE))
        shot("2-expert")

        // Model and effort: the sheet, then High.
        compose.onAllNodesWithTag(ModeTags.MODEL_EFFORT).onFirst().performClick()
        settle()
        shot("3-model-effort")
        compose.onAllNodesWithTag(ModeTags.effort(com.nekko.protocol.Effort.HIGH)).onFirst().performClick()
        compose.waitUntil(5_000) { computer.effort == "high" }
        settle()
        shot("4-effort-high")
        Espresso.pressBack()
        settle()

        // The context ring's breakdown.
        compose.onAllNodesWithTag(ModeTags.CONTEXT).onFirst().performClick()
        settle()
        shot("5-context")
        Espresso.pressBack()
        settle()

        // The whole Monitor and Unload.
        compose.onAllNodesWithTag(ModeTags.MONITOR).onFirst().performClick()
        settle()
        shot("6-monitor")
        compose.onAllNodes(hasText("Unload")).onFirst().performClick()
        compose.waitUntil(5_000) { computer.calls.contains(Channels.MODEL_UNLOAD) }
        settle()
        shot("7-unloaded")
        Espresso.pressBack()
        settle()

        // Back to Simple (the chat bubble): no strip, no context ring, and no more hardware reads.
        compose.onAllNodesWithContentDescription(SIMPLE_DESCRIPTION).onFirst().performClick()
        settle()
        val reads = computer.calls.count { it == Channels.SYSTEM_STATS }
        Thread.sleep(4_000)
        assertEquals("Simple stops the hardware reads", reads, computer.calls.count { it == Channels.SYSTEM_STATS })
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.CONTEXT).fetchSemanticsNodes().size)
    }

    /** One chat on a phone; two side by side (Chat + Chat) on an open folding phone. */
    private fun show() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val repo = ComputersRepository(
            store = MemoryStore(),
            remotes = { config, _ -> computer.remote(config) },
            scope = scope,
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        runBlocking {
            val id = repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff"))
            repo.rename(id, "Studio Mac")
        }
        val vms = mapOf("s1" to ChatViewModel("s1", repo, null, prefs), "s2" to ChatViewModel("s2", repo, null, prefs))
        compose.setContent {
            NekkoTheme(dark = false) {
                val window = rememberWindowPosture()
                if (window.mode == PaneMode.ONE) {
                    ChatScreen(vms.getValue("s1"), onBack = {})
                    return@NekkoTheme
                }
                var layout by remember { mutableStateOf(PaneLayout(PaneContent.Chat("s1"), PaneContent.Chat("s2"), focused = PaneSide.FIRST)) }
                LaunchedEffect(window.mode) { layout = layout.forMode(window.mode, null) }
                PanesHost(
                    window = window,
                    layout = layout,
                    onChange = { change -> layout = change(layout).normalized(window.mode) },
                    labels = PaneLabels { c -> (c as? PaneContent.Chat)?.id ?: c.key },
                    chats = emptyList(),
                    waiting = emptySet(),
                    tip = null,
                    onTakeTip = {},
                    onDismissTip = {},
                    noteDismissed = true,
                    onDismissNote = {},
                ) { slot ->
                    val id = (slot.content as PaneContent.Chat).id ?: "s1"
                    ChatScreen(vms.getValue(id), onBack = slot.back, pane = slot)
                }
            }
        }
        compose.waitUntil(10_000) { computer.calls.contains(Channels.CONTEXT_PREVIEW) }
        settle()
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(700)
        compose.waitForIdle()
    }

    /** The whole screen, so sheets, menus and the status bar show as on the phone. */
    private fun shot(name: String) {
        // takeScreenshot is null now and then while the display is busy; a moment later it isn't.
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "modes-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** The computer as the phone gate answers it: a Claude chat, the hardware, one loaded local model. */
    class FakeComputer {
        val calls = CopyOnWriteArrayList<String>()
        /** Each chat's effort, as `session:setOptions` left it. */
        val efforts = java.util.concurrent.ConcurrentHashMap<String, String>()
        val effort: String? get() = efforts["s1"]
        @Volatile var resident = true

        private fun json(s: String): JsonElement = WireJson.parseToJsonElement(s)

        private fun session(id: String) = buildJsonObject {
            put("id", id)
            put("title", if (id == "s1") "Tidy the release notes" else "Profile the image cache")
            put("providerId", "anthropic")
            put("modelId", "claude-opus-4-7")
            efforts[id]?.let { put("effort", it) }
            put("updatedAt", 1)
            put("queue", JsonArray(emptyList()))
            put(
                "messages",
                buildJsonArray {
                    add(buildJsonObject { put("id", "$id-u"); put("role", "user"); put("content", "Group the release notes by area and drop the duplicates.") })
                    add(buildJsonObject { put("id", "$id-a"); put("role", "assistant"); put("content", "Done: 14 notes in 4 areas (Chat, Phone, Models, Settings). I removed 3 duplicates and kept the clearer wording of each.") })
                },
            )
        }

        fun answer(channel: String, args: List<JsonElement>): JsonElement {
            calls += channel
            return when (channel) {
                Channels.SETTINGS_GET -> json("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7"}""")
                Channels.PROVIDERS_LIST -> json("""[{"id":"anthropic","kind":"anthropic","label":"Anthropic","enabled":true},{"id":"nekko-engine","kind":"nekko-engine","label":"Model Server","enabled":true}]""")
                Channels.MODELS_LIST -> when (args.firstOrNull()?.jsonPrimitive?.content) {
                    "anthropic" -> json("""[{"id":"claude-opus-4-7","providerId":"anthropic","name":"Claude Opus 4.7"},{"id":"claude-sonnet-4-5","providerId":"anthropic","name":"Claude Sonnet 4.5"}]""")
                    else -> json("""[{"id":"google/gemma-4-e4b","providerId":"nekko-engine","name":"Gemma 4 E4B","loaded":true}]""")
                }
                Channels.SESSIONS_SUMMARIES -> json("""[{"id":"s1","title":"Tidy the release notes","updatedAt":2},{"id":"s2","title":"Profile the image cache","updatedAt":1}]""")
                Channels.SESSION_GET -> session(args.first().jsonPrimitive.content)
                Channels.SESSION_SET_OPTIONS -> {
                    args.getOrNull(1)?.jsonObject?.get("effort")?.let { efforts[args.first().jsonPrimitive.content] = it.jsonPrimitive.content }
                    session(args.first().jsonPrimitive.content)
                }
                Channels.CONTEXT_PREVIEW -> json("""{"usedTokens":86400,"contextWindow":200000,"sources":{"system":6200,"conversation":61800,"attached-file":12400,"guideline":3800,"memory":2200}}""")
                Channels.SYSTEM_STATS -> json("""{"cpuPct":38,"cpuCores":16,"memUsedMB":21800,"memTotalMB":32768,"temps":{"cpuC":64,"gpuC":71}}""")
                Channels.GPU_STATS -> json("""{"totalMB":24576,"usedMB":9400,"unified":false,"devices":[{"utilizationPct":72}]}""")
                Channels.ENGINE_STATUS -> json(
                    """{"installed":true,"running":true,
                    "resident":${if (resident) """[{"id":"google/gemma-4-e4b","contextLength":32768,"vramBytes":5100000000,"loadedOn":"gpu","gpuLayers":42,"totalLayers":42}]""" else "[]"},
                    "loading":[],"memory":{"budgetBytes":22000000000,"kind":"vram"}}""",
                )
                Channels.MODEL_UNLOAD -> {
                    resident = false
                    json("""{"ok":true,"message":"Unloaded Gemma 4 E4B."}""")
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
