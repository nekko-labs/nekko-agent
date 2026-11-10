package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.*
import com.nekko.protocol.*
import com.nekko.android.lock.AppLock
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.screens.NewChatScreen
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.rememberSimpleView
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.voice.AndroidMic
import com.nekko.android.voice.Dictation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * #2448: the composer's bottom row as the desktop's (+, folder, asks-first, mic beside Send) and
 * New chat's icon-only Chat / Image toggle. The real ChatScreen and NewChatScreen over a synthetic,
 * memory-only computer (no relay, credentials or microphone). Runs unchanged on the base revision
 * (`-e nekkoRevision before`) for the before shots; saves `evidence/composer-<name>-<revision>.png`.
 */
class ComposerEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val remote = ComposerEvidenceRemote()
    private val prefs = PhonePrefs(ComposerEvidencePrefs())
    private val appLock = AppLock(true).apply { unlock() }
    private val stores = androidx.lifecycle.ViewModelStore()
    private val before = InstrumentationRegistry.getArguments().getString("nekkoRevision") == "before"

    private fun repo(): ComputersRepository {
        val repo = ComputersRepository(ComposerEvidenceStore(), RemoteFactory { _, _ -> remote }, scope, { "Composer fixture phone" },
            deriveKey = { _, _ -> ByteArray(32) }, changeSigner = SoftwareChangeSigner.generate())
        runBlocking {
            repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123",
                hostKey = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            remote.online()
        }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE && !repo.state.value.summariesLoading }
        return repo
    }

    @After fun close() { stores.clear(); scope.cancel() }

    @Test fun chatComposerBottomRow() {
        prefs.set(Dictation.ENABLED, true)
        val repo = repo()
        val vm = ChatViewModel("composer-session", repo, AndroidMic(compose.activity), prefs)
        stores.put("composer", vm)
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalAppLock provides appLock, LocalSimple provides rememberSimpleView(prefs)) {
                    ChatScreen(vm, onBack = {}, onSettings = {}, onNewChat = {}, dictationOn = true)
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) { repo.state.value.workspaces.isNotEmpty() }
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("Tidy up the settings page")
        if (!before) {
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("composer.folder").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("chat.asksFirst").assertExists()
            compose.onNodeWithTag("composer.voiceConversation").assertExists()
        }
        shot("chat")
        if (!before) {
            compose.onNodeWithTag("composer.folder").performClick()
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("composer.files").fetchSemanticsNodes().isNotEmpty() }
            shot("chat-folder-menu")
        }
        assertFalse(remote.calls.any { it == Channels.CHAT_SEND || it == Channels.CHAT_QUEUE })
    }

    @Test fun newChatKindToggle() {
        val repo = repo()
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalAppLock provides appLock, LocalSimple provides rememberSimpleView(prefs)) {
                    NewChatScreen(repo, onBack = {}, onPair = {}, onCreated = {})
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("newChat.kind").fetchSemanticsNodes().isNotEmpty() }
        shot("new-chat")
        if (!before) {
            compose.onNodeWithTag("newChat.kind.image").performClick()
            compose.waitForIdle()
            Thread.sleep(400)
            shot("new-chat-image")
        }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(500)
        var bitmap: Bitmap? = null
        for (i in 0 until 10) {
            bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (bitmap != null) break
            Thread.sleep(300)
        }
        val revision = if (before) "before" else "after"
        val dir = File(compose.activity.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "composer-$name-$revision.png").outputStream().use { bitmap!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap!!.recycle()
    }
}

private class ComposerEvidencePrefs : PrefStore {
    private val values = HashMap<String, String>()
    override fun getString(name: String) = values[name]
    override fun putString(name: String, value: String?) { if (value == null) values.remove(name) else values[name] = value }
}

private class ComposerEvidenceStore : SecureStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = values[key]
    override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

private class ComposerEvidenceRemote : Remote {
    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 32)
    override val dismissals = MutableSharedFlow<String>()
    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1)
    val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
    fun online() { welcome.tryEmit(WelcomedDevice("test", "Composer fixture phone", "android", PhoneProtocol.VERSION)); status.value = RelayStatus(RelayState.ONLINE) }
    override fun connect() { status.value = RelayStatus(RelayState.CONNECTING) }
    override fun close() { status.value = RelayStatus(RelayState.IDLE) }
    override fun nudge() = Unit
    override fun reconnect() = Unit
    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?) = call(channel, *args.toTypedArray())
    private fun json(s: String) = WireJson.parseToJsonElement(s)
    override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
        calls += channel
        return when (channel) {
            "app:info" -> json("""{"version":"composer-fixture","hostname":"Synthetic computer","capabilities":{"imageGeneration":true}}""")
            "settings:get" -> json("""{"defaultProviderId":"engine","defaultModelId":"text"}""")
            "providers:list" -> json("""[{"id":"engine","kind":"engine","name":"Local","enabled":true}]""")
            "models:list" -> json("""[{"id":"text","name":"Text model"}]""")
            "sessions:summaries" -> json("""[{"id":"composer-session","title":"Settings page","workspaceId":"app"}]""")
            "session:get" -> json("""{"id":"composer-session","title":"Settings page","providerId":"engine","modelId":"text","workspaceId":"app","messages":[{"id":"r1","role":"assistant","content":"The settings page is tidy now."}]}""")
            "workspace:list" -> json("""[{"id":"app","name":"nekko-agent","path":"/code/nekko-agent"}]""")
            "skills:list", "skills:all", "skills:runnable", "prompts:list", "engine:models" -> JsonArray(emptyList())
            "chat:pending" -> JsonObject(emptyMap())
            else -> JsonNull
        }
    }
}
