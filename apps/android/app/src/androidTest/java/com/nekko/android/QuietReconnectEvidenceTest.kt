package com.nekko.android

import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real screens with an in-memory computer. Overlay this same file on both app revisions. */
@RunWith(AndroidJUnit4::class)
class QuietReconnectEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    /** Record only a settled real reconnect banner, never HOME or fixture transitions. */
    @Test fun steadyReconnectMotion() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
            automation.executeShellCommand(command),
        ).bufferedReader().use { it.readText().trim() }
        assertTrue("Motion evidence requires system animations", ValueAnimator.areAnimatorsEnabled())
        assertEquals("1", shell("settings get global animator_duration_scale"))
        val repo = repo()
        var motionFrame by mutableStateOf(0)
        // Disable auto-advance before composition: its InfiniteAnimationPolicy otherwise
        // cancels infinite transitions before a later manual-clock hold can drive them.
        compose.mainClock.autoAdvance = false
        compose.setContent {
            NekkoTheme(dark = false) {
                Box(Modifier.fillMaxSize()) {
                    ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {})
                    // A static base emits just one screenrecord frame without this test-only
                    // counter. It keeps both native recordings continuous, below the banner.
                    Text("Motion sample $motionFrame", modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp), fontSize = 9.sp)
                }
            }
        }
        compose.runOnIdle { computer.online = false; computer.goConnecting() }
        compose.mainClock.advanceTimeBy(200)
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.CONNECTING }
        settle()
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Studio Mac", substring = true)).fetchSemanticsNodes().isNotEmpty()
        }
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision") ?: error("Missing nekkoRevision")
        require(revision == "before" || revision == "after")
        val recording = File(dir, "android-$revision-pulse-v3.mp4")
        recording.delete()
        // Block only the instrumentation thread. The main thread keeps native animation
        // frames running, with an extra steady second before and half-second after capture.
        Thread.sleep(1_000)
        assertEquals(RelayState.CONNECTING, repo.state.value.conn)
        var output = ""
        val recorder = Thread {
            output = shell("screenrecord --time-limit 6 --bit-rate 8000000 ${recording.absolutePath}")
        }
        recorder.start()
        try {
            // Compose tests own the animation clock. Drive it at wall-clock speed rather
            // than freezing it during a sleep or fast-forwarding six seconds in one frame.
            val start = android.os.SystemClock.elapsedRealtime()
            val clockStart = compose.mainClock.currentTime
            while (recorder.isAlive && android.os.SystemClock.elapsedRealtime() - start < 15_000) {
                compose.runOnUiThread { motionFrame++ }
                val elapsed = android.os.SystemClock.elapsedRealtime() - start
                val advance = elapsed - (compose.mainClock.currentTime - clockStart)
                if (advance > 0) compose.mainClock.advanceTimeBy(advance, ignoreFrameDuration = true)
                Thread.sleep(16)
            }
            recorder.join(1_000)
            assertTrue("screenrecord did not finish", !recorder.isAlive)
            assertTrue("screenrecord failed: $output", recording.length() > 0)
        } finally {
            compose.mainClock.autoAdvance = true
        }
        assertEquals(RelayState.CONNECTING, repo.state.value.conn)
        Thread.sleep(500)
        assertEquals(0, computer.sends)
    }

    @Test fun quietReconnectSurfaces() {
        val repo = repo()
        var screen by mutableStateOf("chat")
        var open by mutableStateOf(1)
        compose.setContent {
            NekkoTheme(dark = false) {
                if (screen == "chat") key(open) {
                    ChatScreen(remember { ChatViewModel("s1", repo, null, null) }, onBack = {})
                } else {
                    ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {})
                }
            }
        }
        compose.waitUntil(10_000) { "s1" in repo.transcripts.chatIds }
        compose.runOnIdle { computer.online = false; computer.goConnecting(); open++ }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("chat.savedCopy")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("Keep my release notes draft")
        settle()
        shot("quiet-reconnect-composer")
        compose.runOnIdle { screen = "list" }
        settle()
        shot("quiet-reconnect-empty")
        compose.runOnIdle { repo.outbox.add("s1", "Run the focused tests") }
        settle()
        shot("quiet-reconnect-one")
        compose.runOnIdle { repo.outbox.add("s1", "Check the release notes") }
        settle()
        shot("quiet-reconnect-many")
        compose.runOnIdle { computer.goOffline(); screen = "chat"; open++ }
        settle()
        shot("quiet-offline-composer")
        assertEquals(0, computer.sends)
    }

    private fun repo(): ComputersRepository {
        val repo = ComputersRepository(
            store = MemoryStore(),
            now = { 1_800_000_000_000L },
            remotes = { config, _ -> computer.remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
            offlineFiles = object : com.nekko.protocol.OfflineFiles {
                val map = java.util.concurrent.ConcurrentHashMap<String, kotlinx.serialization.json.JsonElement>()
                override fun load(computerId: String, name: String) = map["$computerId/$name"]
                override fun save(computerId: String, name: String, value: kotlinx.serialization.json.JsonElement) { map["$computerId/$name"] = value }
                override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
                override fun removeFile(computerId: String, name: String) { map.remove("$computerId/$name") }
            },
        )
        // Keep recent chats to read offline (on by default in the app).
        repo.setKeepTranscripts(true)
        runBlocking {
            val id = repo.pair(testPairing())
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
        @Volatile var creates = 0
        val ids = java.util.concurrent.CopyOnWriteArrayList<String>()
        private var live: MutableStateFlow<RelayStatus>? = null
        fun goOnline() { live?.value = RelayStatus(RelayState.ONLINE) }
        fun goConnecting() { live?.value = RelayStatus(RelayState.CONNECTING) }
        fun goOffline() { live?.value = RelayStatus(RelayState.OFFLINE) }

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
                Channels.SESSION_CREATE -> {
                    creates++
                    buildJsonObject { put("id", "s1"); put("messages", JsonArray(emptyList())) }
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
