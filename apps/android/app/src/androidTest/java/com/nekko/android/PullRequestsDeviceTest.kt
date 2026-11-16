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
import com.nekko.android.ui.screens.PullRequestsScreen
import com.nekko.android.data.ConnectorHTTP
import com.nekko.android.data.Connectors
import com.nekko.android.data.PullRequests
import com.nekko.protocol.PhoneRequest
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
 * #2109: Pull requests from this phone's GitHub. Mine lists what involves the person (a fake
 * GitHub answers the GraphQL search); a pull request's sheet offers the prompts and says where
 * the chat will run (the computer's folder named like the repository); a prompt opens New chat
 * with its words. Screenshots under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class PullRequestsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val revision = "after"

    private class FakeGitHub : ConnectorHTTP {
        override suspend fun send(request: PhoneRequest): Pair<Int, String> = when {
            request.url.endsWith("/user") -> 200 to """{"login":"ada"}"""
            request.url.endsWith("/graphql") -> 200 to """{"data":{"authored":{"nodes":[$FIX]},"reviewRequested":{"nodes":[$DOCS]},"assigned":{"nodes":[]}}}"""
            else -> 404 to "{}"
        }
        companion object {
            const val FIX = """{"number":42,"title":"Fix the monthly totals in the CSV import","url":"https://github.com/acme/ledger/pull/42","isDraft":false,"updatedAt":"2026-11-16T09:00:00Z","headRefName":"fix/totals","baseRefName":"main","reviewDecision":"CHANGES_REQUESTED","author":{"login":"ada"},"repository":{"nameWithOwner":"acme/ledger"},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]}}"""
            const val DOCS = """{"number":17,"title":"Document the export endpoints","url":"https://github.com/acme/api/pull/17","isDraft":true,"updatedAt":"2026-11-15T09:00:00Z","headRefName":"docs/export","baseRefName":"main","reviewDecision":"REVIEW_REQUIRED","author":{"login":"bob"},"repository":{"nameWithOwner":"acme/api"},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}"""
        }
    }

    @Test fun mineThenAPromptOpensNewChat() {
        val repo = repo()
        val connectors = Connectors(MemoryStore(), FakeGitHub())
        runBlocking { connectors.load(); connectors.connect("github", "ghp_synthetic", emptyMap()) }
        val model = PullRequests(connectors, MemoryStore())
        var started: String? = null
        compose.setContent { NekkoTheme(dark = false) { PullRequestsScreen(repo, connectors, model, onBack = {}, onConnectors = {}, onStartChat = { started = it }) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Fix the monthly totals in the CSV import")).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) { repo.state.value.workspaces.isNotEmpty() }
        settle()
        shot("1-mine")
        compose.onNode(hasText("Fix the monthly totals in the CSV import")).performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("pullRequest.prompt.fix_checks")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Opens New chat on Studio Mac, in ledger. Nothing is sent until you tap Start.")).assertExists()
        settle()
        shot("2-sheet")
        compose.onNode(hasTestTag("pullRequest.prompt.fix_checks")).performClick()
        compose.waitUntil(5_000) { started != null }
        org.junit.Assert.assertTrue(started!!.startsWith("The checks on pull request https://github.com/acme/ledger/pull/42"))
        org.junit.Assert.assertEquals("w-ledger", repo.drafts.draft(com.nekko.protocol.DraftStore.NEW_CHAT).workspaceId)
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
        File(dir, "pull-requests-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** A computer with a folder named like the repository. */
    private class FakeComputer {
        fun answer(channel: String, args: List<JsonElement>): JsonElement = when (channel) {
            Channels.SETTINGS_GET -> com.nekko.protocol.WireJson.parseToJsonElement("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7","defaultChatMode":"guardrails"}""")
            Channels.SESSIONS_SUMMARIES -> JsonArray(emptyList())
            Channels.WORKSPACE_LIST -> com.nekko.protocol.WireJson.parseToJsonElement("""[{"id":"w-ledger","name":"ledger","path":"/Users/ada/code/ledger"}]""")
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
