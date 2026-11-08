package com.nekko.android

import android.Manifest
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.NekkoVoiceSheet
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import org.junit.runners.model.Statement

/**
 * New surface: no before state. Runs only in the disposable API 34 evidence emulator.
 * native-mode-evidence.yml: capture_platform=android, baseline_ref=source_ref=<head SHA>,
 * android_test_file=apps/android/app/src/androidTest/java/com/nekko/android/NekkoVoiceSheetEvidenceTest.kt,
 * android_test_class=com.nekko.android.NekkoVoiceSheetEvidenceTest, android_expect=voice-sheet.
 * Reuses TestPairing and the in-memory Remote/SecureStore pattern from ChatListViewTest.
 * No MainActivity, service, real transport, microphone grant, recognition, or provider call.
 */
@RunWith(AndroidJUnit4::class)
class NekkoVoiceSheetEvidenceTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()
    private val emulatorOnly = TestRule { base, _ ->
        object : Statement() {
            override fun evaluate() {
                // Outside the activity rule: even launching the test activity is gated.
                assumeTrue("Only the disposable evidence emulator may launch this sheet",
                    InstrumentationRegistry.getArguments().getString("nekkoModeEvidence") == "true" &&
                        Build.HARDWARE in listOf("ranchu", "goldfish") && Build.VERSION.SDK_INT == 34)
                base.evaluate()
            }
        }
    }
    @get:Rule val rules: RuleChain = RuleChain.outerRule(emulatorOnly).around(compose)

    @Test fun sheetEvidenceCancelOpenAppAndMicrophoneDenial() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext
        val ui = instrumentation.uiAutomation
        assertEquals(Configuration.UI_MODE_NIGHT_NO,
            app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK)
        assertTrue("Fresh emulator app data must be unpaired",
            (app.applicationContext as NekkoApp).computers.state.value.computers.isEmpty())
        fun assertMicDenied() = assertEquals("Never grant or start the microphone",
            PackageManager.PERMISSION_DENIED, app.checkSelfPermission(Manifest.permission.RECORD_AUDIO))
        assertMicDenied()
        val output = File(requireNotNull(app.getExternalFilesDir(null)), "evidence/voice-sheet.png")
        output.parentFile!!.mkdirs()
        if (output.exists()) assertTrue(output.delete())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val calls = AtomicInteger()
        val opened = AtomicInteger()
        val memory = HashMap<String, String>()
        val repo = ComputersRepository(
            store = object : SecureStore {
                override suspend fun get(key: String) = memory[key]
                override suspend fun set(key: String, value: String?) {
                    if (value == null) memory.remove(key) else memory[key] = value
                }
            },
            remotes = { _, _ -> object : Remote {
                // Intentionally disconnected: displayed totals are honestly marked stale.
                override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
                override val events = MutableSharedFlow<Pair<String, JsonElement>>()
                override val welcome = MutableSharedFlow<WelcomedDevice>()
                override fun connect() {}
                override fun close() {}
                override fun nudge() {}
                override fun reconnect() {}
                override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
                    calls.incrementAndGet()
                    error("No RPC is allowed in voice sheet evidence: $channel")
                }
                override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = call(channel, *args)
            } },
            scope = scope,
            deviceName = { "Evidence Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        val prefs = PhonePrefs(object : PrefStore {
            override fun getString(name: String): String? = null
            override fun putString(name: String, value: String?) { error("Sheet must not persist settings") }
        })
        var screenshot: Bitmap? = null
        try {
            runBlocking {
                val id = repo.pair(testPairing())
                repo.rename(id, "Fixture Mac")
                repo.load()
            }
            val card = MutableStateFlow<LiveCardState?>(LiveCardState(emptyList(), null,
                counts = mapOf("working" to 3, "needsYou" to 2, "done" to 20, "failed" to 1, "watching" to 4)))
            compose.setContent {
                NekkoTheme(dark = false) { NekkoVoiceSheet(repo, prefs, card) { opened.incrementAndGet() } }
            }
            compose.onNodeWithText("Talk to Nekko").assertIsDisplayed()
            compose.onNodeWithText("On Fixture Mac").assertIsDisplayed()
            compose.onNodeWithText("Offline or stale. Last known totals.").assertIsDisplayed()
            compose.onNodeWithText("3 Building · 2 Need input · 20 Done").assertIsDisplayed()
            compose.onNodeWithText("Listen").assertExists()
            compose.onNodeWithText("Listening…").assertDoesNotExist()
            compose.waitForIdle()
            ui.waitForIdle(500, 5_000)
            screenshot = requireNotNull(ui.takeScreenshot())

            compose.onNodeWithText("Cancel / discard").performScrollTo().performClick()
            compose.onNodeWithText("Cancelled. Nothing sent.").performScrollTo().assertIsDisplayed()
            assertEquals(0, opened.get())
            assertMicDenied()
            // This is the only Listen tap. Permission is denied before and after it.
            compose.onNodeWithText("Listen").performScrollTo().performClick()
            var deny: AccessibilityNodeInfo? = null
            compose.waitUntil(10_000) {
                deny = listOf("com.android.permissioncontroller", "com.google.android.permissioncontroller")
                    .firstNotNullOfOrNull { pkg ->
                        ui.rootInActiveWindow?.findAccessibilityNodeInfosByViewId("$pkg:id/permission_deny_button")
                            ?.firstOrNull { it.isVisibleToUser && it.isEnabled }
                    }
                deny != null
            }
            assertTrue("Only click the OS permission controller",
                deny!!.packageName.toString() in listOf("com.android.permissioncontroller", "com.google.android.permissioncontroller"))
            assertTrue("Deny the actual OS microphone permission request",
                deny!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
            val deniedMessage = "Microphone denied. Nothing sent. Enable it in Android app permissions to use voice."
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(deniedMessage).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText(deniedMessage).performScrollTo().assertIsDisplayed()
            assertMicDenied()
            compose.onNodeWithText("Listening…").assertDoesNotExist()
            compose.onNodeWithText("Processing…").assertDoesNotExist()
            compose.onNodeWithText("Open app").performScrollTo().performClick()
            compose.runOnIdle {
                assertEquals(1, opened.get())
                assertEquals(0, calls.get())
                assertTrue("Nothing queued", repo.outbox.state.value.items.isEmpty())
            }
            compose.onNodeWithText("Cancelled. Nothing sent.").assertExists()
            // Publish the initial sheet only after every interaction assertion passes.
            output.outputStream().use { assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            assertTrue(output.length() > 0)
        } finally {
            screenshot?.recycle()
            // The activity rule disposes the sheet; all repository work is fixture-owned.
            scope.cancel()
        }
    }
}
