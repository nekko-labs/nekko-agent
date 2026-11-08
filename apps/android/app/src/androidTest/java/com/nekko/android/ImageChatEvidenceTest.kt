package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.*
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.rememberSimpleView
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.screens.NewChatScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * One-source overlay for native-mode-evidence.yml, compatible with defd6001 (before) and head.
 * All host data is synthetic, all storage is in memory, no relay, hardware model or user data.
 * Baseline intentionally has no image creation/editor/reply implementation; capture the same routes.
 */
class ImageChatEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val host = ImageEvidenceRemote()
    private val prefs = PhonePrefs(ImageEvidencePrefs())
    private var vm: ChatViewModel? = null
    private val viewModels = androidx.lifecycle.ViewModelStore()
    private lateinit var repo: ComputersRepository
    private val before get() = InstrumentationRegistry.getArguments().getString("nekkoRevision") == "before"

    @Before fun setup() {
        repo = ComputersRepository(ImageEvidenceStore(), RemoteFactory { _, _ -> host }, scope, { "Test phone" },
            deriveKey = { _, _ -> ByteArray(32) }, changeSigner = SoftwareChangeSigner.generate())
        runBlocking {
            repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123",
                hostKey = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            host.online()
        }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE && !repo.state.value.summariesLoading }
    }

    @After fun close() { viewModels.clear(); scope.cancel() }

    @Test fun createImageChat() {
        var created: String? = null
        compose.setContent { NekkoTheme(dark = false) { NewChatScreen(repo, onBack = {}, onPair = {}, onCreated = { created = it }) } }
        settle()
        if (!before) {
            compose.onNodeWithText("Image", useUnmergedTree = true).performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("image.model.flux").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("image.model.flux").performClick()
            shot("image-new-chat")
            compose.onNodeWithTag("image.save").performScrollTo().performClick()
            compose.waitUntil(10_000) { created == "image-session" }
            val opts = host.calls.single { it.first == "session:setOptions" }.second
            assertEquals(JsonPrimitive("image-session"), opts[0])
            assertEquals("image", opts[1].jsonObject["chatType"]!!.jsonPrimitive.content)
            assertEquals(4L, opts[1].jsonObject["imageParams"]!!.jsonObject["cfgScale"]!!.jsonPrimitive.long)
        } else {
            assertTrue(compose.onAllNodesWithTag("image.editor").fetchSemanticsNodes().isEmpty())
            shot("image-new-chat")
        }
    }

    @Test fun imageReplyAndSignedSend() {
        showChat()
        shot("image-reply")
        if (!before) {
            compose.onAllNodesWithTag("image.reply.0").onFirst().assertExists()
            compose.onNodeWithText("Generated image 1").performClick()
            compose.waitUntil(10_000) { host.calls.any { it.first == "session:photo" } }
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("image.full").fetchSemanticsNodes().isNotEmpty() }
            shot("image-full")
            assertEquals(listOf(JsonPrimitive("image-session"), JsonPrimitive("reply"), JsonPrimitive(0)), host.calls.single { it.first == "session:photo" }.second)
            compose.onNodeWithText("Close").performClick()
            compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("A cat in a paper boat")
            compose.onNodeWithContentDescription("Send").performClick()
            compose.waitUntil(10_000) { host.signed.any { it.first == "chat:generateImage" } }
            assertFalse(host.calls.any { it.first == "chat:send" || it.first == "chat:queue" })
            val request = host.signed.single { it.first == "chat:generateImage" }.second.single().jsonObject
            assertEquals(setOf("sessionId", "prompt", "params"), request.keys)
            assertEquals("A cat in a paper boat", request["prompt"]!!.jsonPrimitive.content)
        } else assertTrue(compose.onAllNodesWithTag("image.reply.0").fetchSemanticsNodes().isEmpty())
    }

    @Test fun imageSummaryBadge() {
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalSimple provides rememberSimpleView(prefs)) {
                    com.nekko.android.ui.screens.ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}, onMonitors = {})
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Paper boat").fetchSemanticsNodes().isNotEmpty() }
        if (!before) compose.onAllNodesWithTag("chats.row.image").onFirst().assertExists()
        shot("image-summary")
    }

    @Test fun offlineImageIntentDoesNotBecomeTextOutbox() {
        showChat()
        host.status.value = RelayStatus(RelayState.OFFLINE)
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.OFFLINE }
        settle()
        shot("image-offline")
        if (!before) {
            compose.onAllNodes(hasText("Reconnect to generate an image. Image prompts are never queued as text.")).onFirst().assertExists()
            assertTrue(runBlocking { runCatching { vm!!.send("Keep this image intent") }.isFailure })
            assertTrue(repo.outbox.state.value.items.isEmpty())
        }
    }

    private fun showChat() {
        vm = ChatViewModel("image-session", repo)
        viewModels.put("image", vm!!)
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalSimple provides rememberSimpleView(prefs)) {
                    ChatScreen(vm!!, onBack = {})
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Paper boat").fetchSemanticsNodes().isNotEmpty() }
        settle()
    }

    private fun settle() { compose.waitForIdle(); Thread.sleep(400); compose.waitForIdle() }
    private fun shot(name: String) {
        if (InstrumentationRegistry.getArguments().getString("nekkoModeEvidence") != "true") return
        settle()
        val inst = InstrumentationRegistry.getInstrumentation()
        val device = InstrumentationRegistry.getArguments().getString("nekkoDevice", "phone")
        val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision", "unspecified")
        val dir = File(inst.targetContext.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        val bitmap = inst.uiAutomation.takeScreenshot() ?: error("No native window screenshot")
        File(dir, "$revision-$device-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}

private class ImageEvidenceStore : SecureStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = values[key]
    override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}
private class ImageEvidencePrefs : PrefStore {
    private val values = HashMap<String, String>()
    override fun getString(name: String) = values[name]
    override fun putString(name: String, value: String?) { if (value == null) values.remove(name) else values[name] = value }
}
private class ImageEvidenceRemote : Remote {
    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 32)
    override val dismissals = MutableSharedFlow<String>()
    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1)
    val calls = CopyOnWriteArrayList<Pair<String, List<JsonElement>>>()
    val signed = CopyOnWriteArrayList<Pair<String, List<JsonElement>>>()
    private fun json(s: String) = WireJson.parseToJsonElement(s)
    private val image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR4nO3PMQ2AUBTFUPQhC1V4wQEGWDHw38BUmjS5Y4d7tv04l7vuZ7m/9dvfDgWgDwWgDwWgD30GWI5OfQC6D0D3AejeD7AcnfoAdB+A7gPQvR9gOTr1Aeg+AN0HoHs/wHJ06gPQfQC6D0D3foDl6NQHoPsAdB+A7v0Ay9GpD0D3Aeg+AN37AZajUx+A7gPQfQC61wNe8oUB/4lexNYAAAAASUVORK5CYII="
    fun online() { welcome.tryEmit(WelcomedDevice("test", "Test phone", "android", PhoneProtocol.VERSION)); status.value = RelayStatus(RelayState.ONLINE) }
    override fun connect() { status.value = RelayStatus(RelayState.CONNECTING) }
    override fun close() { status.value = RelayStatus(RelayState.IDLE) }
    override fun nudge() = Unit
    override fun reconnect() = Unit
    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?): JsonElement {
        assertTrue(proof.isNotEmpty()); signed += channel to args.toList()
        return call(channel, *args.toTypedArray())
    }
    override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
        calls += channel to args.toList()
        return when (channel) {
            "app:info" -> json("""{"version":"test","hostname":"Test computer","capabilities":{"imageGeneration":true}}""")
            "settings:get" -> json("""{"defaultProviderId":"engine","defaultModelId":"text"}""")
            "providers:list" -> json("""[{"id":"engine","kind":"engine","name":"Local","enabled":true}]""")
            "models:list" -> json("""[{"id":"text","name":"Text model"}]""")
            "engine:models" -> json("""[{"id":"flux","kind":"image","name":"Flux","format":"gguf","state":"ready"}]""")
            "sessions:summaries" -> json("""[{"id":"image-session","title":"Paper boat","chatType":"image"}]""")
            "session:create" -> json("""{"id":"image-session"}""")
            "session:get" -> json("""{"id":"image-session","title":"Paper boat","chatType":"image","imageParams":{"modelId":"flux","cfgScale":4},"messages":[{"id":"reply","role":"assistant","content":"","reasoning":"Rendering","images":["$image"]}]}""")
            "session:photo" -> JsonPrimitive(image)
            "workspace:list", "skills:list", "skills:all", "skills:runnable", "prompts:list" -> JsonArray(emptyList())
            "chat:pending" -> JsonObject(emptyMap())
            else -> JsonNull
        }
    }
}
