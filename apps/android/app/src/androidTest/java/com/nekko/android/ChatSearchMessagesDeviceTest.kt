package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayException
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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Search chats finds a phrase said in the middle of a chat, with the line it was said in (#3448),
 * against a fake computer; and a computer without `sessions:finderText` (an older Nekko Agent)
 * keeps today's summary search. Screenshots in `evidence/chat-search-*.png`.
 */
class ChatSearchMessagesDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val calls = CopyOnWriteArrayList<String>()
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })

    private val summaries = """[
        {"id":"c1","title":"Speed up the CI cache","updatedAt":1793923200000,"firstUserText":"Why does the build cache miss on every run?","lastReplyText":"Done: the cache hits again."},
        {"id":"c2","title":"Plan the week","updatedAt":1793836800000,"firstUserText":"Three goals for Monday","lastReplyText":"Here is the plan."}
    ]"""

    private val said = """{
        "c1":{"title":"Speed up the CI cache","updatedAt":1793923200000,"messages":[
            {"role":"user","text":"Why does the build cache miss on every run?"},
            {"role":"assistant","text":"The key includes the runner image date, so each nightly image misses it. Key it on the lockfile alone and restore with a prefix fallback.","files":[".github/workflows/ci.yml"]},
            {"role":"assistant","text":"Done: the cache hits again."}]},
        "c2":{"title":"Plan the week","updatedAt":1793836800000,"messages":[{"role":"user","text":"Three goals for Monday"}]}
    }"""

    private fun answer(channel: String, finder: Boolean): JsonElement {
        calls += channel
        return when (channel) {
            Channels.SESSIONS_SUMMARIES -> WireJson.parseToJsonElement(summaries)
            Channels.SESSIONS_FINDER_TEXT ->
                if (finder) WireJson.parseToJsonElement(said)
                else throw RelayException("Not allowed from a paired phone (channel-denied): sessions:finderText")
            Channels.WORKSPACE_LIST -> WireJson.parseToJsonElement("[]")
            Channels.SETTINGS_GET -> WireJson.parseToJsonElement("""{"chatPaneAction":"complete"}""")
            else -> JsonNull
        }
    }

    private fun remote(finder: Boolean): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel, finder)
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, finder)
    }

    private fun searchFor(finder: Boolean, query: String) {
        val repo = ComputersRepository(
            store = object : SecureStore {
                private val map = HashMap<String, String>()
                override suspend fun get(key: String) = map[key]
                override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
            },
            remotes = { _: RelayConfig, _ -> remote(finder) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        runBlocking {
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
            repo.load()
        }
        compose.setContent {
            NekkoTheme(dark = false) {
                ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}, phonePrefs = prefs)
            }
        }
        compose.waitUntil(10_000) { repo.state.value.summaries.isNotEmpty() }
        settle()
        compose.onAllNodesWithTag("chats.menu").onFirst().performClick()
        settle()
        compose.onAllNodesWithTag("chats.menu.search").onFirst().performClick()
        settle()
        compose.onAllNodesWithTag("chats.search").onFirst().performTextInput(query)
        compose.waitUntil(10_000) { Channels.SESSIONS_FINDER_TEXT in calls }
        settle()
    }

    @Test fun findsAPhraseSaidMidChatWithItsLine() {
        searchFor(finder = true, query = "runner image")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("chats.row.snippet", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(compose.onAllNodes(hasText("Speed up the CI cache")).fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, compose.onAllNodes(hasText("Plan the week")).fetchSemanticsNodes().size)
        assertTrue(compose.onAllNodes(hasText("The key includes the runner image date", substring = true)).fetchSemanticsNodes().isNotEmpty())
        shot("found-in-messages")
    }

    @Test fun anOlderComputerKeepsTheSummarySearch() {
        searchFor(finder = false, query = "runner image")
        assertEquals(0, compose.onAllNodes(hasText("Speed up the CI cache")).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithTag("chats.row.snippet", useUnmergedTree = true).fetchSemanticsNodes().size)
        shot("older-computer-summaries-only")
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(500)
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
        File(dir, "chat-search-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
