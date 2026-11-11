package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasTestTag
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ChatListPrefs
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.ChatListView
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * The chat list's view menu (the iPhone's ChatListLayout): group by, sort,
 * what is shown, Show more, and the project groups' order kept on the phone.
 * Against a fake computer; screenshots in `evidence/chatlist-*.png`.
 */
class CardDetailsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private val day = 24L * 60 * 60 * 1000
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })

    // Watching (a watch armed), so still in progress: the card shows its context gauge only then.
    private fun summaries(): String = """[{"id":"g1","title":"Plan the week","updatedAt":1793923200000,"lastReplyText":"Three goals for Monday.","activeWatchCount":1,"modelId":"opus","transcriptTokens":42000,"claudeCodeContext":{"modelId":"opus","used":42000,"window":200000},"prUrls":["https://github.com/example/project/pull/42"]}]"""

    private fun answer(channel: String): JsonElement = when (channel) {
        Channels.SESSIONS_SUMMARIES -> WireJson.parseToJsonElement(summaries())
        Channels.WORKSPACE_LIST -> WireJson.parseToJsonElement("""[{"id":"w1","name":"App"},{"id":"w2","name":"Docs"}]""")
        Channels.SETTINGS_GET -> WireJson.parseToJsonElement("""{"chatPaneAction":"complete"}""")
        else -> JsonNull
    }

    private fun remote(@Suppress("UNUSED_PARAMETER") config: RelayConfig): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel)
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel)
    }

    private fun show(): ComputersRepository {
        val repo = ComputersRepository(
            store = object : SecureStore {
                private val map = HashMap<String, String>()
                override suspend fun get(key: String) = map[key]
                override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
            },
            remotes = { config, _ -> remote(config) },
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
        compose.waitUntil(10_000) { repo.state.value.summaries.isNotEmpty() && repo.state.value.workspaces.isNotEmpty() }
        settle()
        return repo
    }

    @Test fun cardDetailsPersistIndependently() {
        show()
        val before = InstrumentationRegistry.getArguments().getString("baseline") == "true"
        shot("default")
        if (!before) {
            compose.onNodeWithTag("chats.row.model", useUnmergedTree = true).assertExists()
            compose.onNodeWithTag("chats.row.context", useUnmergedTree = true).assertExists()
            compose.onNodeWithTag("chats.row.prs", useUnmergedTree = true).assertExists()
        }
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        if (before) { shot("menu"); return }
        // Card details opens its toggles in place of the menu (#2449).
        compose.onNodeWithTag("chats.view.cardDetails").performClick()
        settle()
        compose.onNodeWithText("Model").performScrollTo()
        shot("menu")
        compose.onNodeWithText("Model").performClick()
        assertEquals(false, WireJson.parseToJsonElement(prefs.get(ChatListPrefs.VIEW).encoded()).toString().contains("\"showModel\":true"))
        // Dropdown stays open while choosing details. Each remaining control is independent.
        for (label in listOf("Context window", "Pull requests", "Updated time")) {
            compose.onNodeWithText(label).performScrollTo().performClick()
            settle()
        }
        androidx.test.espresso.Espresso.pressBack()
        settle()
        compose.onNodeWithTag("chats.row.model", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("chats.row.context", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("chats.row.prs", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Plan the week").assertExists()
        shot("hidden")
        val restored = ChatListView.parse(prefs.get(ChatListPrefs.VIEW).encoded())
        assertEquals(prefs.get(ChatListPrefs.VIEW), restored)
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
        File(dir, "card-details-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
