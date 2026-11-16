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
 * #2777: **+ → Photos and videos**, and a 7 MB clip going to the computer in three pieces, its
 * progress in the message box, then *Attached to the chat*. Run with `-e nekkoRevision before` on
 * main for the menu only. Screenshots under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class VideoClipDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision") ?: "after"

    @Test fun aClipGoesThenSendIsReady() {
        val repo = repo()
        val vm = ChatViewModel("s1", repo, null, null)
        compose.setContent { NekkoTheme(dark = false) { ChatScreen(vm, onBack = {}) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Plan the trip from these clips.")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasContentDescription("Add")).performClick()
        settle()
        shot("1-menu")
        if (revision != "after") return
        compose.onNode(hasText("Photos and videos")).assertExists()
        // Back closes the menu, as a person would.
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Photos and videos")).fetchSemanticsNodes().isEmpty() }
        settle()

        // A clip as the photo picker hands it over: a content URI with a name, a size and a video type.
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        val file = File(File(app.cacheDir, "camera").apply { mkdirs() }, "harbour-sunset.mp4")
        file.writeBytes(ByteArray(7_000_000) { (it % 251).toByte() })
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.photos", file)
        runBlocking { withContext(Dispatchers.Main) { vm.addMedia(app.contentResolver, listOf(uri)) } }
        // The first piece has gone; the computer holds the second, so the progress shows.
        compose.waitUntil(10_000) { computer.pieces.size >= 2 }
        settle()
        shot("2-sending")
        computer.release.countDown()
        compose.waitUntil(15_000) { compose.onAllNodes(hasText("Attached to the chat"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        settle()
        shot("3-attached")
        assertEquals(listOf(0L, 3_145_728L, 6_291_456L), computer.pieces.toList())
        compose.onNode(hasTestTag("composer.clip.0")).assertExists()
        file.delete()
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
        File(dir, "video-clip-$name-$revision-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** One idle chat; `attachment:upload` takes the first piece at once and holds the second. */
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
