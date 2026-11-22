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
 * #2115: the agent's plan as a sheet over the composer. Folded it shows the step being worked,
 * "3 of 4" and its chips (the PR with its CI, the task link); tapped it opens the whole plan, the
 * finished step with a PR open, the others squeezed. Run with `-e nekkoRevision before` on main
 * for the comparison (no assertions there). Screenshots under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class PlanSheetDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision") ?: "after"

    @Test fun foldedThenOpen() {
        val repo = repo()
        val vm = ChatViewModel("s1", repo, null, null)
        compose.setContent { NekkoTheme(dark = false) { ChatScreen(vm, onBack = {}) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Import the CSV files", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        if (revision == "after") {
            compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("chat.planFolded")).fetchSemanticsNodes().isNotEmpty() }
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("#42 · Open · CI passing"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        }
        settle()
        shot("1-folded")
        if (revision != "after") return
        compose.onNode(hasTestTag("chat.planFolded")).performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("chat.planOpen")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasTestTag("chat.planStep.step_2")).assertExists()
        settle()
        shot("2-open")
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
        File(dir, "plan-sheet-$name-$revision-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** One chat with a plan: explored, built (PR 42), verifying now, ship next. */
    private class FakeComputer {
        private fun meta() = buildJsonObject {
            put("id", "s1"); put("title", "CSV import"); put("providerId", "anthropic"); put("modelId", "claude-opus-4-7"); put("updatedAt", 1)
        }
        private val pr = "https://github.com/acme/ledger/pull/42"

        fun answer(channel: String, args: List<JsonElement>): JsonElement = when (channel) {
            Channels.SETTINGS_GET -> com.nekko.protocol.WireJson.parseToJsonElement("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7","defaultChatMode":"guardrails"}""")
            Channels.SESSIONS_SUMMARIES -> buildJsonArray { add(meta()) }
            Channels.SESSION_GET -> com.nekko.protocol.WireJson.parseToJsonElement("""
                {"id":"s1","title":"CSV import","providerId":"anthropic","modelId":"claude-opus-4-7","updatedAt":5,"queue":[],
                 "messages":[
                   {"id":"u","role":"user","content":"Import the CSV files and fix the totals. https://linear.app/acme/issue/LED-12","createdAt":1},
                   {"id":"a1","role":"assistant","content":"","createdAt":2,"toolCalls":[{"id":"p1","name":"update_plan","input":{"steps":[{"title":"Read the importer","status":"done"},{"title":"Fix the totals","status":"active"}]}}]},
                   {"id":"a2","role":"assistant","content":"","createdAt":3,"toolCalls":[{"id":"g","name":"Bash","input":{"command":"gh pr create"}}]},
                   {"id":"r","role":"tool","content":"","createdAt":4,"toolResult":{"toolCallId":"g","output":"$pr","isError":false}},
                   {"id":"a3","role":"assistant","content":"Opened the PR; checking the totals against last month now.","createdAt":5}
                 ],
                 "agentPlan":[
                   {"id":"step_1","title":"Read the importer","status":"done","kind":"explore"},
                   {"id":"step_2","title":"Fix the totals","status":"done","kind":"build"},
                   {"id":"step_3","title":"Check against last month","status":"active","kind":"verify","note":"Comparing 1,204 rows"},
                   {"id":"step_4","title":"Ship it","status":"pending","kind":"ship"}
                 ]}
            """)
            Channels.PR_SESSION_LIST -> com.nekko.protocol.WireJson.parseToJsonElement("""[{"url":"$pr","number":42,"title":"Fix the totals","state":"open","checks":"passing"}]""")
            Channels.CHAT_PENDING -> buildJsonObject { }
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
