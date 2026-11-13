package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
import androidx.test.espresso.Espresso
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
class ChatListViewTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private val day = 24L * 60 * 60 * 1000
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })
    /** The prefs the list reads; a new instance over the same [store] is a cold launch. */
    private var screenPrefs by mutableStateOf(prefs)

    private fun summaries(): String {
        val app = (0 until 10).joinToString(",") { i ->
            """{"id":"a$i","title":"App task ${i + 1}","updatedAt":${now - i * day / 2},"workspaceId":"w1","lastReplyText":"Reply ${i + 1} in App."}"""
        }
        // exchangeCount, activeWatchCount and activeRun feed the status groups (#2107).
        return """[{"id":"g1","title":"Plan the week","updatedAt":${now - 2 * day},"lastReplyText":"Three goals for Monday.","exchangeCount":2},
            {"id":"w9","title":"Ship the release","updatedAt":${now - day / 2},"workspaceId":"w2","exchangeCount":6,"activeWatchCount":1,"lastReplyText":"Watching PR #555."},
            {"id":"n0","title":"Notes for later","updatedAt":${now - day / 3},"exchangeCount":0},
            {"id":"t1","title":"Release checklist\n- Fix the flaky sign-in test on the release branch before Friday's build","updatedAt":${now - day / 5},"exchangeCount":2,"modelId":"claude-sonnet-5-5","lastReplyText":"The sign-in test is stable now."},
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
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
            repo.load()
        }
        compose.setContent {
            NekkoTheme(dark = false) {
                key(screenPrefs) {
                    ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}, phonePrefs = screenPrefs)
                }
            }
        }
        compose.waitUntil(10_000) { repo.state.value.summaries.isNotEmpty() && repo.state.value.workspaces.isNotEmpty() }
        settle()
        return repo
    }

    @Test fun projectGroupsShowTheRecentFewAndReorderOnThePhone() {
        show()
        shot("1-default")
        // Groups start folded (#2107): open App first.
        compose.onNodeWithText("APP", useUnmergedTree = true).performClick()
        settle()
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
        // One level (#2449): Group by shows its value and opens its choices in place; no Reset at the defaults.
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithTag("chats.view.reset").assertDoesNotExist()
        compose.onNodeWithTag("chats.view.groupBy").performClick()
        settle()
        shot("2b-group-by")
        compose.onNodeWithText("Date").performClick()
        settle()
        // A pick closes the menu; Show opens its toggles in place and keeps the menu open.
        compose.onNodeWithTag("chats.view.groupBy").assertDoesNotExist()
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithText("Date", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("chats.view.show").performClick()
        settle()
        compose.onNodeWithText("Previews").performClick()
        settle()
        compose.onNodeWithText("Completed chats").assertExists()
        shot("2c-show")
        compose.onNodeWithTag("chats.view.back").performClick()
        settle()
        compose.onNodeWithTag("chats.view.reset").assertExists()
        shot("2d-menu-changed")
        Espresso.pressBack()
        settle()
        assertEquals(ChatListView.GroupBy.DATE, prefs.get(ChatListPrefs.VIEW).groupBy)
        assertEquals(false, prefs.get(ChatListPrefs.VIEW).showPreviews)
        compose.onNodeWithText("TODAY", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("The page is drafted.", useUnmergedTree = true).assertDoesNotExist()
        shot("5-by-date")
        // Reset to defaults brings the list back as it was.
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithTag("chats.view.reset").performClick()
        settle()
        assertEquals(ChatListView.STANDARD, prefs.get(ChatListPrefs.VIEW))
    }

    /** #2133: a closed group stays closed after the list is rebuilt from the saved preferences, as on a cold launch. */
    @Test fun groupsStartFoldedAndOpenedOnesSurviveARelaunch() {
        show()
        // #2107: groups start folded, as on the iPhone; General has no fold.
        compose.onNodeWithText("App task 1", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Plan the week", useUnmergedTree = true).assertExists()
        shot("6-folded")
        compose.onNodeWithText("APP", useUnmergedTree = true).performClick()
        settle()
        compose.onNodeWithText("App task 1", useUnmergedTree = true).assertExists()
        assertEquals(setOf("w1"), prefs.get(ChatListPrefs.OPENED_GROUPS))

        // Cold launch: a fresh read of the same preferences file and a new list.
        screenPrefs = PhonePrefs(object : PrefStore {
            override fun getString(name: String) = store[name]
            override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
        })
        settle()
        compose.onNodeWithText("App task 1", useUnmergedTree = true).assertExists()
        shot("7-app-open-after-relaunch")

        // Folding it again is saved too.
        compose.onNodeWithText("APP", useUnmergedTree = true).performClick()
        settle()
        compose.onNodeWithText("App task 1", useUnmergedTree = true).assertDoesNotExist()
        assertEquals(emptySet<String>(), screenPrefs.get(ChatListPrefs.OPENED_GROUPS))
    }

    /** #2107: by status, the iPhone's groups; Watching is live while a watch is armed. */
    @Test fun statusGroupsLikeTheIphone() {
        show()
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithText("Group by").performClick()
        settle()
        compose.onNodeWithText("Status").performClick()
        settle()
        compose.onNodeWithText("WATCHING", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("DRAFT", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("DONE", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("chats.group.live.status:watching", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("WATCHING", useUnmergedTree = true).performClick()
        settle()
        compose.onNodeWithText("Ship the release", useUnmergedTree = true).assertExists()
        shot("8-by-status")
    }

    /**
     * #2108: two paired computers and a chat on this phone, in one list. Studio Mac answers with
     * the chats above; Office PC (its own room and key) with one of its own.
     */
    private fun showFleet(): Pair<ComputersRepository, String> {
        val officeRoom = "b2c3d4e5f6071829"
        val officeKey = "BE4Fn5F4K5mkw+MBYHvdQT/kC5NZN9rHpVgZBu5TJjT8ZDQi5gfJoAAZUNSiXhFQAHF+CVRUTY3F9l4HofyGWbA="
        val office = """[{"id":"o1","title":"Back up the photos","updatedAt":${now - day / 6},"exchangeCount":3,"lastReplyText":"Copied 2,140 photos to the NAS."}]"""
        val repo = ComputersRepository(
            store = object : SecureStore {
                private val map = HashMap<String, String>()
                override suspend fun get(key: String) = map[key]
                override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
            },
            remotes = { config, _ ->
                if (config.room != officeRoom) remote(config)
                else object : Remote by remote(config) {
                    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
                    override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
                    override fun close() { status.value = RelayStatus(RelayState.IDLE) }
                    override suspend fun call(channel: String, vararg args: JsonElement) =
                        if (channel == Channels.SESSIONS_SUMMARIES) WireJson.parseToJsonElement(office) else JsonNull
                    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
                }
            },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
            stayConnected = true,
        )
        // A chat on this phone, with its own provider: no computer involved.
        val phoneStore = HashMap<String, String>()
        phoneStore["phone.chats.v1"] = """[{"id":"phone:q1","title":"Quick question","providerId":"p1","modelId":"claude-haiku-5-5","createdAt":$now,"updatedAt":${now - day / 8},
            "messages":[{"id":"u","role":"user","text":"What rhymes with orange?","at":$now},{"id":"a","role":"assistant","text":"Nothing quite does: door hinge is close.","at":$now}]}]"""
        val phone = com.nekko.android.phone.PhoneChats(
            object : SecureStore {
                override suspend fun get(key: String) = phoneStore[key]
                override suspend fun set(key: String, value: String?) { if (value == null) phoneStore.remove(key) else phoneStore[key] = value }
            },
            object : com.nekko.android.phone.PhoneHTTP { override suspend fun send(request: com.nekko.protocol.PhoneRequest, line: ((String) -> Boolean)?) = error("offline") },
            CoroutineScope(SupervisorJob()),
        )
        val officeId = runBlocking {
            val mac = repo.pair(testPairing())
            repo.rename(mac, "Studio Mac")
            val pc = repo.pair(com.nekko.protocol.PairingLink("wss://relay.example.dev", officeRoom, "00112233445566778899aabbccddeeff", hostKey = officeKey))
            repo.rename(pc, "Office PC")
            // The Mac is the one used last.
            repo.connect(mac)
            repo.load(mac)
            phone.load()
            pc
        }
        compose.setContent {
            NekkoTheme(dark = false) {
                ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}, phonePrefs = prefs, phone = phone)
            }
        }
        compose.waitUntil(10_000) { repo.state.value.summaries.isNotEmpty() && repo.state.value.peers[officeId]?.summaries?.isNotEmpty() == true }
        settle()
        return repo to officeId
    }

    /** #2108: every computer's chats and this phone's in one list; each row says where it runs. */
    @Test fun oneListAcrossComputersAndThisPhone() {
        val (repo, officeId) = showFleet()
        compose.onNodeWithText("Computers", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("2 of 2 online", useUnmergedTree = true).assertExists()
        // General holds chats from both computers and the phone, each row naming its place.
        compose.onNodeWithText("Back up the photos", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Quick question", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Office PC", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("This phone", useUnmergedTree = true).assertExists()
        shot("9-all-computers")

        // Group by computer: one group per place, the phone last.
        compose.onNodeWithTag("chats.view").performClick()
        settle()
        compose.onNodeWithTag("chats.view.groupBy").performClick()
        settle()
        compose.onNodeWithText("Computer").performClick()
        settle()
        compose.onNodeWithText("STUDIO MAC", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("OFFICE PC", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("THIS PHONE", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("OFFICE PC", useUnmergedTree = true).performClick()
        compose.onNodeWithText("THIS PHONE", useUnmergedTree = true).performClick()
        settle()
        compose.onNodeWithText("Back up the photos", useUnmergedTree = true).assertExists()
        shot("10-by-computer")
        assertEquals(ChatListView.GroupBy.COMPUTER, prefs.get(ChatListPrefs.VIEW).groupBy)

        // Show chats from one computer: only its chats, and it becomes the active one.
        compose.onNodeWithTag("chats.menu").performClick()
        settle()
        shot("11-show-chats-from")
        compose.onNodeWithTag("chats.from.$officeId").performClick()
        settle()
        compose.waitUntil(5_000) { repo.state.value.activeId == officeId }
        compose.onNodeWithText("Plan the week", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Back up the photos", useUnmergedTree = true).assertExists()
        assertEquals(officeId, prefs.get(ChatListPrefs.FILTER))
        shot("12-office-only")
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
