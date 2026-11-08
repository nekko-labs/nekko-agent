package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.*
import com.nekko.android.lock.AppLock
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.mode.LocalSimple
import com.nekko.android.ui.mode.rememberSimpleView
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.voice.AndroidMic
import com.nekko.android.voice.Dictation
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

/** Synthetic, memory-only native UI fixture. No live relay, credentials, microphone or speech service.
 * Captures a NEW surface: there is no before voice sheet. Device/posture comes from the test runner.
 * This fixture does not prove real audio, permission dialogs, background timing or physical folds.
 */
class VoiceIntegrationEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val remote = VoiceEvidenceRemote()
    private val prefs = PhonePrefs(VoiceEvidencePrefs())
    private val appLock = AppLock(true).apply { unlock() }
    private val stores = androidx.lifecycle.ViewModelStore()
    private lateinit var repo: ComputersRepository
    private lateinit var vm: ChatViewModel

    @Before fun setup() {
        prefs.set(Dictation.ENABLED, true)
        repo = ComputersRepository(VoiceEvidenceStore(), RemoteFactory { _, _ -> remote }, scope, { "Voice fixture phone" },
            deriveKey = { _, _ -> ByteArray(32) }, changeSigner = SoftwareChangeSigner.generate())
        runBlocking {
            repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123",
                hostKey = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            remote.online()
        }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE && !repo.state.value.summariesLoading }
        vm = ChatViewModel("voice-session", repo, AndroidMic(compose.activity), prefs)
        stores.put("voice", vm)
        compose.setContent {
            val enabled by prefs.flow(Dictation.ENABLED).collectAsState()
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalAppLock provides appLock, LocalSimple provides rememberSimpleView(prefs)) {
                    ChatScreen(vm, onBack = {}, dictationOn = enabled, onSettings = {}, onNewChat = {})
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("voice.hold").fetchSemanticsNodes().isNotEmpty() }
    }
    @After fun close() { stores.clear(); scope.cancel() }

    @Test fun realComposerEntryDraftPreservationAndLockDismissal() {
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("Keep this typed draft")
        shot("voice-composer")
        compose.onNodeWithContentDescription("Add").performClick()
        compose.onNodeWithTag("composer.voiceConversation").performClick()
        compose.onNodeWithText("Ready", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Start").assertExists()
        shot("voice-conversation-ready")
        compose.onNodeWithText("Close").performClick()
        compose.onAllNodes(hasSetTextAction()).onFirst().assertTextContains("Keep this typed draft")
        compose.onNodeWithContentDescription("Add").performClick()
        compose.onNodeWithTag("composer.voiceConversation").performClick()
        compose.runOnIdle { appLock.onBackground() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Start").fetchSemanticsNodes().isEmpty() }
        assertTrue(repo.outbox.state.value.items.isEmpty())
        assertFalse(remote.calls.any { it == Channels.CHAT_SEND || it == Channels.CHAT_QUEUE })
    }
    @Test fun voiceOffRemovesNativeControlsAndOpenConversation() {
        compose.onNodeWithContentDescription("Add").performClick()
        compose.onNodeWithTag("composer.voiceConversation").performClick()
        compose.runOnIdle { prefs.set(Dictation.ENABLED, false) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("voice.hold").fetchSemanticsNodes().isEmpty() && compose.onAllNodesWithText("Start").fetchSemanticsNodes().isEmpty() }
        assertFalse(remote.calls.any { it == Channels.CHAT_SEND || it == Channels.CHAT_QUEUE })
    }
    private fun shot(name: String) {
        if (InstrumentationRegistry.getArguments().getString("nekkoVoiceEvidence") != "true") return
        compose.waitForIdle()
        val inst = InstrumentationRegistry.getInstrumentation()
        val device = InstrumentationRegistry.getArguments().getString("nekkoDevice", "phone")
        val dir = File(inst.targetContext.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        val screenshot = inst.uiAutomation.takeScreenshot() ?: error("No native-window screenshot")
        File(dir, "after-$device-$name.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        screenshot.recycle()
    }
}
private class VoiceEvidencePrefs : PrefStore {
    private val values = HashMap<String, String>()
    override fun getString(name: String) = values[name]
    override fun putString(name: String, value: String?) { if (value == null) values.remove(name) else values[name] = value }
}
private class VoiceEvidenceStore : SecureStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = values[key]
    override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}
private class VoiceEvidenceRemote : Remote {
    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 32)
    override val dismissals = MutableSharedFlow<String>()
    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1)
    val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
    fun online() { welcome.tryEmit(WelcomedDevice("test", "Voice fixture phone", "android", PhoneProtocol.VERSION)); status.value = RelayStatus(RelayState.ONLINE) }
    override fun connect() { status.value = RelayStatus(RelayState.CONNECTING) }
    override fun close() { status.value = RelayStatus(RelayState.IDLE) }
    override fun nudge() = Unit
    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?) = call(channel, *args.toTypedArray())
    private fun json(s: String) = WireJson.parseToJsonElement(s)
    override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
        calls += channel
        return when (channel) {
            "app:info" -> json("""{"version":"voice-fixture","hostname":"Synthetic computer"}""")
            "settings:get" -> json("""{"defaultProviderId":"engine","defaultModelId":"text"}""")
            "providers:list" -> json("""[{"id":"engine","kind":"engine","name":"Local","enabled":true}]""")
            "models:list" -> json("""[{"id":"text","name":"Text model"}]""")
            "sessions:summaries" -> json("""[{"id":"voice-session","title":"Voice fixture"}]""")
            "session:get" -> json("""{"id":"voice-session","title":"Voice fixture","providerId":"engine","modelId":"text","messages":[{"id":"old","role":"assistant","content":"A previous reply. Never read this as the next voice answer."}]}""")
            "workspace:list", "skills:list", "skills:all", "skills:runnable", "prompts:list" -> JsonArray(emptyList())
            "chat:pending" -> JsonObject(emptyMap())
            else -> JsonNull
        }
    }
}
