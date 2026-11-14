package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.data.ThemePrefs
import com.nekko.android.phone.PhoneChats
import com.nekko.android.phone.PhoneHTTP
import com.nekko.android.ui.screens.CustomizeScreen
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.rememberSimpleView
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.PhoneRequest
import com.nekko.protocol.PhoneTone
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
 * #2426: the Customize page, as on the iPhone. Simple or Detailed, the tone of this phone's
 * models (saved, and sent with their next reply), and the connected computer's skills.
 * Screenshots in `evidence/customize-*.png`.
 */
class CustomizeDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })
    private val opened = mutableListOf<String>()
    private var online = true

    private val skills = """[{"name":"review-pr","description":"Read a pull request and list what to fix before it merges.","category":"code","source":"builtin"},
        {"name":"release-notes","description":"Write the release notes from the merged pull requests.","category":"writing","source":"marketplace"},
        {"name":"triage","description":"Sort new issues by area and urgency.","category":"code","source":"claude"}]"""

    private fun remote(@Suppress("UNUSED_PARAMETER") config: RelayConfig): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() { status.value = RelayStatus(if (online) RelayState.ONLINE else RelayState.OFFLINE) }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement): JsonElement =
            if (channel == Channels.SKILLS_RUNNABLE) WireJson.parseToJsonElement(skills) else JsonNull
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
    }

    private fun memory() = object : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    private fun show(): PhoneChats {
        val repo = ComputersRepository(
            store = memory(),
            remotes = { config, _ -> remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        val phone = PhoneChats(memory(), object : PhoneHTTP { override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?) = error("offline") }, CoroutineScope(SupervisorJob()))
        runBlocking {
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
            repo.load()
            phone.load()
        }
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val deps = SettingsDeps(repo, ThemePrefs(context), prefs, open = { opened += it })
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalSimple provides rememberSimpleView(prefs)) {
                    CustomizeScreen(deps, phone, onBack = {})
                }
            }
        }
        compose.waitForIdle()
        return phone
    }

    @Test fun experienceSetsTheViewAndThisPhonesToneAndSkillsListTheComputers() {
        val phone = show()
        shot("1-experience")
        // Agent output: the same Simple / Detailed as the menus, kept on this phone.
        compose.onNodeWithTag("mode.switch.detailed").performClick()
        compose.waitForIdle()
        assertEquals(true, prefs.get(EXPERT_MODE))
        // Tone for models running on this phone.
        compose.onNodeWithTag("customize.tone").performClick()
        compose.waitForIdle()
        shot("2-tone")
        compose.onNodeWithTag("customize.tone.Concise").performClick()
        compose.waitUntil(3_000) { phone.state.value.tone == PhoneTone.CONCISE }
        compose.onNodeWithText("Concise").assertExists()
        // Visible controls and monitors opens the Simple mode page.
        compose.onNodeWithText("Visible controls and monitors").performClick()
        assertEquals("settings/simple", opened.last())
        compose.onNodeWithTag("customize.experience").performScrollToNode(hasText("How agents work", ignoreCase = true))
        compose.waitForIdle()
        shot("3-experience-bottom")

        // Skills: the connected computer's, read-only, with how to run one.
        compose.onNodeWithTag("customize.Skills").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("review-pr"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Use /name in a chat to run a skill.", substring = true).assertExists()
        compose.onNodeWithText("release-notes").assertExists()
        shot("4-skills")
    }

    @Test fun skillsSayWhenTheComputerIsNotConnected() {
        online = false
        show()
        compose.onNodeWithTag("customize.Skills").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Connect your computer to see its skills."), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        shot("5-skills-offline")
    }

    private fun shot(name: String) {
        Thread.sleep(400)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "customize-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
