package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.data.StarAsk
import com.nekko.android.data.StarAskState
import com.nekko.android.ui.chat.StarAskTags
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.Events
import com.nekko.protocol.RelayConfig
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The GitHub star ask (spec/platform/github-star-ask.md) in the real chat screen, over a fake
 * computer that answers each prompt and ends it with `done`. Opts in with its own [StarAsk]
 * (the app's is off under instrumentation). Screenshots go under the app's external files
 * (`evidence/`), named by device.
 */
@RunWith(AndroidJUnit4::class)
class StarAskEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })
    private val opened = CopyOnWriteArrayList<String>()

    private fun open(dark: Boolean = false, startAt: Int = 9): StarAsk {
        val ask = StarAsk(prefs)
        prefs.set(StarAsk.KEY, StarAskState(prompts = startAt).encode())
        val vm = ChatViewModel("s1", repo(), null, null, starAsk = ask)
        val uri = object : UriHandler { override fun openUri(uri: String) { opened += uri } }
        compose.setContent { NekkoTheme(dark = dark) { CompositionLocalProvider(LocalUriHandler provides uri) { ChatScreen(vm, onBack = {}) } } }
        compose.waitUntil(10_000) { computer.calls.contains(Channels.SESSION_GET) }
        settle()
        return ask
    }

    private fun send(text: String) {
        compose.onNode(hasContentDescription("Message")).performTextInput(text)
        compose.onNode(hasContentDescription("Send")).performClick()
        compose.waitForIdle()
        androidx.test.espresso.Espresso.closeSoftKeyboard()
    }

    /** The card is the transcript's last item: bring it fully into view before a shot or a tap. */
    private fun showCard() {
        compose.waitUntil(10_000) { cardShown() }
        settle()
        compose.onNodeWithTag(StarAskTags.CARD).performScrollTo()
        settle()
    }

    private fun cardShown() = compose.onAllNodes(hasTestTag(StarAskTags.CARD)).fetchSemanticsNodes().isNotEmpty()

    @Test fun askUnderTheTenthReplyThenStar() {
        val ask = open()
        assertTrue(!cardShown())
        send("Summarise what changed in the release branch")
        showCard()
        compose.onNodeWithText("Nekko Agent is open source").assertExists()
        compose.onNodeWithText("If it helps you, a star on GitHub helps more people find it.").assertExists()
        compose.onNodeWithText("Not now").assertExists()
        compose.onNodeWithText("Don’t ask again").assertExists()
        // Used up as it shows.
        assertEquals(StarAskState(prompts = 10, asked = 1), ask.read())
        shot("1-ask")

        compose.onNodeWithTag(StarAskTags.STAR).performClick()
        showCard()
        assertEquals(listOf("https://github.com/nekko-labs/nekko-agent"), opened)
        compose.onNodeWithText("Thank you! Nekko is happy you’re here.").assertExists()
        assertTrue(ask.read().stopped)
        shot("2-thanks")

        compose.onNodeWithTag(StarAskTags.CLOSE).performClick()
        compose.waitUntil(5_000) { !cardShown() }
    }

    @Test fun ignoringItIsNotNowAndTheNextSendRemovesIt() {
        val ask = open(dark = true)
        send("Run the tests")
        showCard()
        shot("3-ask-dusk")
        // Sending without choosing removes it; no second ask until 50.
        send("Now fix the failing one")
        compose.waitUntil(5_000) { !cardShown() }
        compose.waitUntil(10_000) { computer.sends == 2 && ask.read().prompts == 11 }
        settle()
        assertTrue(!cardShown())
        assertEquals(StarAskState(prompts = 11, asked = 1), ask.read())
    }

    @Test fun dontAskAgainStopsAtFifty() {
        // The first ask never got its chance before 50: it shows once and uses up both.
        val ask = open(startAt = 49)
        send("One more thing")
        showCard()
        assertEquals(StarAskState(prompts = 50, asked = 2), ask.read())
        compose.onNodeWithTag(StarAskTags.NEVER).performClick()
        compose.waitUntil(5_000) { !cardShown() }
        assertEquals(StarAskState(prompts = 50, asked = 2, stopped = true), ask.read())
        assertTrue(opened.isEmpty())
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
        File(dir, "star-ask-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** One chat; each `chat:send` gets a short reply, streamed as `text` and ended with `done`. */
    private class FakeComputer {
        val calls = CopyOnWriteArrayList<String>()
        @Volatile var sends = 0
        private val ids = CopyOnWriteArrayList<String>()
        private val messages = CopyOnWriteArrayList<JsonObject>(
            listOf(
                msg("u0", "user", "Group the release notes by area and drop the duplicates."),
                msg("a0", "assistant", "Done: 14 notes in 4 areas. I removed 3 duplicates."),
            ),
        )
        private var events: MutableSharedFlow<Pair<String, JsonElement>>? = null

        private fun json(s: String): JsonElement = com.nekko.protocol.WireJson.parseToJsonElement(s)

        private fun meta() = buildJsonObject {
            put("id", "s1")
            put("title", "Release notes")
            put("providerId", "anthropic")
            put("modelId", "claude-opus-4-7")
            put("updatedAt", 1)
            // The prompts it took: the outbox lets go of each once the chat lists it.
            put("clientMessageIds", JsonArray(ids.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        }

        private fun session() = buildJsonObject {
            meta().forEach { (k, v) -> put(k, v) }
            put("queue", JsonArray(emptyList()))
            put("messages", JsonArray(messages.toList()))
        }

        private fun event(type: String, extra: Map<String, String> = emptyMap()) = buildJsonObject {
            put("type", type)
            put("sessionId", "s1")
            extra.forEach { (k, v) -> put(k, v) }
        }

        fun answer(channel: String, args: List<JsonElement>): JsonElement {
            calls += channel
            return when (channel) {
                Channels.SETTINGS_GET -> json("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7","defaultChatMode":"guardrails","chatPaneAction":"complete","orchestrationStrategy":"solo"}""")
                Channels.SESSIONS_SUMMARIES -> buildJsonArray { add(meta()) }
                Channels.SESSION_GET -> session()
                Channels.CHAT_SEND -> {
                    val n = ++sends
                    args[0].jsonObject["clientMessageId"]?.jsonPrimitive?.content?.let { ids += it }
                    val text = args[0].jsonObject["text"]!!.jsonPrimitive.content
                    val reply = if (n == 1) "Three areas changed: the chat screen, the outbox and the settings sync." else "Done. The test passes now."
                    messages += msg("u$n", "user", text)
                    messages += msg("a$n", "assistant", reply)
                    events?.tryEmit(Events.AGENT_EVENT to event("text", mapOf("delta" to reply)))
                    events?.tryEmit(Events.AGENT_EVENT to event("done", mapOf("messageId" to "a$n")))
                    JsonNull
                }
                Channels.WORKSPACE_LIST -> JsonArray(emptyList())
                else -> JsonNull
            }
        }

        fun remote(config: RelayConfig): Remote = object : Remote {
            override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
            override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64).also { this@FakeComputer.events = it }
            override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
            override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
            override fun close() { status.value = RelayStatus(RelayState.IDLE) }
            override fun nudge() {}
            override fun reconnect() {}
            override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel, args.toList())
            override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, args.toList())
        }

        companion object {
            fun msg(id: String, role: String, content: String) = buildJsonObject { put("id", id); put("role", role); put("content", content) }
        }
    }
}
