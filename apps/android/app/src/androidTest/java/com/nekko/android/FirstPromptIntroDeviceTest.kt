package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.*
import com.nekko.android.ui.screens.FirstPromptIntro
import com.nekko.android.ui.screens.NewChatScreen
import com.nekko.android.ui.security.LocalPhonePrefs
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * #2234: "Send your first prompt" over the first ever New chat, on Android's own screen.
 * A synthetic computer in memory, no relay. Walks Next, Back and Get started, checks it is
 * saved and never opens again, and that someone who already chatted never sees it.
 * Screenshots `evidence/first-prompt-<step>-<theme>-<device>.png`.
 */
class FirstPromptIntroDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private var dark by mutableStateOf(false)
    /** Bumped to open New chat again, as leaving it and coming back does. */
    private var visit by mutableIntStateOf(0)

    private fun open(summaries: String): ComputersRepository {
        val host = IntroRemote(summaries)
        val repo = ComputersRepository(IntroStore(), RemoteFactory { _, _ -> host }, scope, { "Test phone" },
            deriveKey = { _, _ -> ByteArray(32) }, changeSigner = SoftwareChangeSigner.generate())
        runBlocking {
            repo.load()
            repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123",
                hostKey = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            repo.rename(repo.state.value.activeId!!, "Mac")
            host.online()
        }
        compose.setContent {
            NekkoTheme(dark = dark) {
                CompositionLocalProvider(LocalPhonePrefs provides prefs) {
                    key(visit) { NewChatScreen(repo, onBack = {}, onPair = {}, onCreated = {}) }
                }
            }
        }
        compose.waitUntil(10_000) { repo.state.value.summariesLoaded }
        return repo
    }

    @After fun close() { scope.cancel() }

    private fun intro() = compose.onAllNodesWithTag("firstPromptIntro.step").fetchSemanticsNodes().isNotEmpty()

    @Test fun opensOnceOverTheFirstNewChatAndWalksItsSteps() {
        open("""[]""")
        compose.waitUntil(10_000) { intro() }
        compose.onNodeWithText("Start with a question").assertExists()
        compose.onNodeWithTag("firstPromptIntro.skip").assertExists()
        shot("start-light")
        compose.onNodeWithTag("firstPromptIntro.next").performClick()
        compose.onNodeWithText("Add photos and a folder").assertExists()
        shot("add-light")
        compose.onNodeWithTag("firstPromptIntro.back").performClick()
        compose.onNodeWithText("Start with a question").assertExists()
        compose.onNodeWithTag("firstPromptIntro.next").performClick()
        compose.onNodeWithTag("firstPromptIntro.next").performClick()
        // Android's own words for step 3: the chat starts with Send.
        compose.onNodeWithText("Tap Send, and Nekko gets to work").assertExists()
        compose.onAllNodesWithTag("firstPromptIntro.skip").assertCountEquals(0)
        shot("send-light")
        compose.onNodeWithTag("firstPromptIntro.done").performClick()
        compose.waitUntil(5_000) { !intro() }
        assertTrue(prefs.get(FirstPromptIntro.SEEN))

        // New chat again: never twice.
        visit++
        compose.waitForIdle()
        Thread.sleep(1_000)
        assertFalse(intro())
    }

    @Test fun skipClosesItForGoodInDarkToo() {
        dark = true
        open("""[]""")
        compose.waitUntil(10_000) { intro() }
        shot("start-dark")
        compose.onNodeWithTag("firstPromptIntro.skip").performClick()
        compose.waitUntil(5_000) { !intro() }
        assertTrue(prefs.get(FirstPromptIntro.SEEN))
    }

    @Test fun someoneWhoAlreadyChattedNeverSeesIt() {
        open("""[{"id":"s1","title":"Plan the week","updatedAt":1,"exchangeCount":3}]""")
        compose.waitForIdle()
        Thread.sleep(1_500)
        assertFalse(intro())
        assertFalse(prefs.get(FirstPromptIntro.SEEN))
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        // Let the demo play a little, so the picture shows it moving rather than its first blank frame.
        Thread.sleep(2_500)
        var bitmap: Bitmap? = null
        for (i in 0 until 10) {
            bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (bitmap != null) break
            Thread.sleep(300)
        }
        val dir = File(compose.activity.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "first-prompt-$name-$device.png").outputStream().use { bitmap!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}

private class IntroStore : SecureStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = values[key]
    override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

private class IntroRemote(private val summaries: String) : Remote {
    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 32)
    override val dismissals = MutableSharedFlow<String>()
    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1)
    fun online() { welcome.tryEmit(WelcomedDevice("test", "Test phone", "android", PhoneProtocol.VERSION)); status.value = RelayStatus(RelayState.ONLINE) }
    override fun connect() { status.value = RelayStatus(RelayState.CONNECTING) }
    override fun close() { status.value = RelayStatus(RelayState.IDLE) }
    override fun nudge() = Unit
    override fun reconnect() = Unit
    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement) = call(channel, *args)
    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?) = call(channel, *args.toTypedArray())
    private fun json(s: String) = WireJson.parseToJsonElement(s)
    override suspend fun call(channel: String, vararg args: JsonElement): JsonElement = when (channel) {
        "app:info" -> json("""{"version":"intro-fixture","hostname":"Mac"}""")
        "settings:get" -> json("""{"defaultProviderId":"engine","defaultModelId":"text"}""")
        "providers:list" -> json("""[{"id":"engine","kind":"engine","name":"Local","enabled":true}]""")
        "models:list" -> json("""[{"id":"text","name":"Text model"}]""")
        "sessions:summaries" -> json(summaries)
        "workspace:list" -> json("""[{"id":"w1","name":"Sales"},{"id":"w2","name":"Website"}]""")
        "skills:list", "skills:all", "skills:runnable", "prompts:list" -> JsonArray(emptyList())
        "chat:pending" -> JsonObject(emptyMap())
        else -> JsonNull
    }
}
