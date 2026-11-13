package com.nekko.android

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.connection.Notices
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.FirstRun
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.data.ThemePrefs
import com.nekko.android.share.ShareInbox
import com.nekko.android.ui.NekkoNavHost
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The first run (IO-31) through the app's real navigation, against a fake computer: step 1,
 * Continue, step 2 (the welcome), pairing by a pasted link, step 3, and its two answers. Each
 * step is a whole-screen screenshot under the app's external files (`evidence/`).
 */
@RunWith(AndroidJUnit4::class)
class FirstRunJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val link = testPairingLink()

    @Test fun allowNotifications() {
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        if (Build.VERSION.SDK_INT >= 33) {
            InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        val prefs = journey(shots = true)
        // Step 3 is the permissions checklist (#2251): alerts already allowed here, Continue ends the first run.
        compose.onNodeWithTag("permissions.continue").performClick()
        compose.waitUntil(5_000) { prefs.get(FirstRun.DONE) }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Tidy the release notes")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        shot("5-chats")
        assertTrue(prefs.get(Notices.NEEDS_YOU))
    }

    @Test fun notNow() {
        // Alerts left off: only meaningful while Android hasn't granted them (13+ asks; revoking would end this process).
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        org.junit.Assume.assumeTrue(Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
        val prefs = journey(shots = false)
        compose.onNodeWithTag("permissions.continue").performClick()
        compose.waitUntil(5_000) { prefs.get(FirstRun.DONE) }
        assertFalse("Continue with alerts off turns Notify me off", prefs.get(Notices.NEEDS_YOU) || prefs.get(Notices.FINISHED))
    }

    /** Steps 1 to 3, leaving step 3 on screen. */
    private fun journey(shots: Boolean): PhonePrefs {
        val prefs = PhonePrefs(object : PrefStore {
            val map = HashMap<String, String>()
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        })
        val repo = ComputersRepository(
            store = MemoryStore(),
            remotes = { config, _ -> remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        runBlocking { repo.load() }
        val themePrefs = ThemePrefs(ApplicationProvider.getApplicationContext())
        compose.setContent {
            NekkoTheme(dark = false) {
                NekkoNavHost(repo, themePrefs, prefs, ShareInbox(), incomingLink = MutableStateFlow(null), onLinkHandled = {})
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Step 1 of 3")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        if (shots) shot("1-intro")
        compose.onNodeWithTag("firstRun.continue").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Step 2 of 3")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        if (shots) shot("2-pair")
        compose.onAllNodes(hasText("Pair a computer")).onFirst().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Pairing link")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasText("Pairing link")).onFirst().performTextInput(link)
        settle()
        compose.onAllNodes(hasText("Pair")).onFirst().performClick()
        // The celebration covers everything until it goes; Let's go closes it early.
        val celebrating = { compose.onAllNodesWithTag("pairSuccess.done").fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) { celebrating() || compose.onAllNodes(hasText("Step 3 of 3")).fetchSemanticsNodes().isNotEmpty() }
        if (shots && celebrating()) shot("3-paired")
        if (celebrating()) compose.onNodeWithTag("pairSuccess.done").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("pairSuccess").fetchSemanticsNodes().isEmpty() }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Step 3 of 3")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        if (shots) shot("4-notifications")
        assertFalse(prefs.get(FirstRun.DONE))
        return prefs
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
        File(dir, "firstrun-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** A computer that welcomes the phone and has one chat. */
    private fun remote(config: RelayConfig): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() {
            welcome.tryEmit(WelcomedDevice(config.deviceId, config.deviceName, "android"))
            status.value = RelayStatus(RelayState.ONLINE)
        }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel)
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel)

        private fun answer(channel: String): JsonElement = when (channel) {
            // Touched just now: the list shows a group's recent chats, older ones behind Show more.
            Channels.SESSIONS_SUMMARIES -> WireJson.parseToJsonElement("""[{"id":"s1","title":"Tidy the release notes","updatedAt":${System.currentTimeMillis()}}]""")
            Channels.WORKSPACE_LIST -> JsonArray(emptyList())
            else -> JsonNull
        }
    }
}
