package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.*
import com.nekko.android.ui.screens.UsageScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * The real Usage and limits screen over one synthetic computer, for a before/after pair (#2114).
 * Compiles against both revisions: only `UsageScreen(repo, onBack)`.
 */
class UsageScreenEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @After fun close() { scope.cancel() }

    @Test fun oneComputer() {
        val host = UsageRemote()
        val repo = ComputersRepository(UsageStore(), RemoteFactory { _, _ -> host }, scope, { "Test phone" },
            deriveKey = { _, _ -> ByteArray(32) }, changeSigner = SoftwareChangeSigner.generate())
        runBlocking {
            repo.load()
            repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123",
                hostKey = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            repo.rename(repo.state.value.activeId!!, "Studio Mac")
            host.online()
        }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE && repo.state.value.providers.isNotEmpty() }
        compose.setContent { NekkoTheme(dark = false) { UsageScreen(repo = repo, onBack = {}) } }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("usage.view")).fetchSemanticsNodes().isNotEmpty() && host.calls.contains("limits:get") }
        compose.waitForIdle(); Thread.sleep(1_000)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision", "after")
        val dir = File(compose.activity.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "usage-screen-$revision.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}

private class UsageStore : SecureStore {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = values[key]
    override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

private class UsageRemote : Remote {
    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 32)
    override val dismissals = MutableSharedFlow<String>()
    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1)
    val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
    fun online() { welcome.tryEmit(WelcomedDevice("test", "Test phone", "android", PhoneProtocol.VERSION)); status.value = RelayStatus(RelayState.ONLINE) }
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
            "app:info" -> json("""{"version":"usage-fixture","hostname":"Studio Mac"}""")
            "settings:get" -> json("""{"defaultProviderId":"claude","defaultModelId":"claude-opus-5-5"}""")
            "providers:list" -> json("""[{"id":"claude","kind":"anthropic","label":"Claude","enabled":true},{"id":"openai","kind":"openai","label":"OpenAI","enabled":true}]""")
            "usage:summary" -> json("""{"totalInput":1820000,"totalOutput":240000,"totalCost":18.4,"byModel":[{"model":"claude-opus-5-5","input":1200000,"output":160000,"cost":0,"subscription":true},{"model":"gpt-5","input":420000,"output":60000,"cost":14.1},{"model":"gemini-3-pro","input":120000,"output":15000,"cost":4.3}],"daily":[{"date":"2026-11-09","input":600000,"output":40000,"cost":6.1},{"date":"2026-11-10","input":850000,"output":60000,"cost":8.2}]}""")
            "limits:get" -> if (args.firstOrNull()?.jsonPrimitive?.content == "claude") json("""{"planType":"max","windows":[{"id":"5h","label":"5 hours","usedPercent":62,"status":"allowed"},{"id":"7d","label":"Week","usedPercent":85,"status":"warning"}]}""") else JsonNull
            "sessions:summaries", "workspace:list", "skills:list", "skills:all", "skills:runnable", "prompts:list" -> JsonArray(emptyList())
            "chat:pending" -> JsonObject(emptyMap())
            else -> JsonNull
        }
    }
}
