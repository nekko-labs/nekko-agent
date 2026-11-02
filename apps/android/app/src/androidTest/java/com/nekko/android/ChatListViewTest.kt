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
import com.nekko.protocol.PairingLink
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
class ChatListViewTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private val day = 24L * 60 * 60 * 1000
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })

    private fun summaries(): String {
        val app = (0 until 10).joinToString(",") { i ->
            """{"id":"a$i","title":"App task ${i + 1}","updatedAt":${now - i * day / 2},"workspaceId":"w1","lastReplyText":"Reply ${i + 1} in App."}"""
        }
        return """[{"id":"g1","title":"Plan the week","updatedAt":${now - 2 * day},"lastReplyText":"Three goals for Monday."},
            {"id":"d1","title":"Write the docs page","updatedAt":${now - day / 4},"workspaceId":"w2","lastReplyText":"The page is drafted."},
            {"id":"d2","title":"Old notes","updatedAt":${now - 3 * day},"workspaceId":"w2","archivedAt":${now - day}},
            $app]"""
    }

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
            val id = repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff"))
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

    @Test fun projectGroupsShowTheRecentFewAndReorderOnThePhone() {
        show()
        shot("1-default")
        // App has 10 chats from the last five days: 8 shown, then Show 2 more.
        compose.onNodeWithTag("chats.list").performScrollToNode(hasTestTag("chats.showMore"))
        compose.onNode(hasTestTag("chats.showMore"), useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Show 2 more", useUnmergedTree = true).assertExists()
        shot("1b-show-more")
        compose.onNodeWithTag("chats.list").performScrollToNode(hasTestTag("chats.group"))
        // Reorder groups from the view menu: Docs above App, kept for this computer on the phone.
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        shot("2-menu")
        compose.onNodeWithTag("chats.reorder").performClick()
        settle()
        compose.onNodeWithContentDescription("Move Docs up").performClick()
        settle()
        shot("3-reorder")
        compose.onNodeWithTag("groups.done").performClick()
        settle()
        val saved = prefs.get(ChatListPrefs.GROUP_ORDER).values.single()
        assertEquals(listOf("__none", "w2", "w1"), saved)
        compose.onNodeWithTag("chats.list").performScrollToIndex(0)
        settle()
        shot("4-reordered")
    }

    @Test fun groupByDateAndHidePreviews() {
        show()
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithText("Date").performClick()
        settle()
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithText("Previews").performClick()
        settle()
        assertEquals(ChatListView.GroupBy.DATE, prefs.get(ChatListPrefs.VIEW).groupBy)
        assertEquals(false, prefs.get(ChatListPrefs.VIEW).showPreviews)
        compose.onNodeWithText("TODAY", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("The page is drafted.", useUnmergedTree = true).assertDoesNotExist()
        shot("5-by-date")
        // Reset to defaults brings the list back as it was.
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithText("Reset to defaults").performClick()
        settle()
        assertEquals(ChatListView.STANDARD, prefs.get(ChatListPrefs.VIEW))
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
        File(dir, "chatlist-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
