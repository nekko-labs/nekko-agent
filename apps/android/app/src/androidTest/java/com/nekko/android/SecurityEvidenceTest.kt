package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.ui.chat.ApprovalCard
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.rememberSimpleView
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.ui.chat.ChatModeDialog
import com.nekko.android.ui.security.LocalPhonePrefs
import com.nekko.android.ui.security.YoloWarning
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Approval
import com.nekko.protocol.PcSettings.ChatMode
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Decision 0054 on Android: **Always allow this tool** on an MCP approval, and the YOLO
 * warning before a chat switches to YOLO. The real composables, no relay. With
 * `-e nekkoModeEvidence true` each is saved as a whole-screen PNG under the app's external
 * files (`evidence/always-allow-tool.png`, `evidence/yolo-warning.png`).
 */
@RunWith(AndroidJUnit4::class)
class SecurityEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val evidence = InstrumentationRegistry.getArguments().getString("nekkoModeEvidence") == "true"

    private val prefs = PhonePrefs(object : PrefStore {
        val map = HashMap<String, String>()
        override fun getString(name: String) = map[name]
        override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
    })

    @Test fun alwaysAllowTool() {
        val decided = CopyOnWriteArrayList<String>()
        val approval = Approval(
            ToolCall("call-1", "mcp__github__create_issue", buildJsonObject { put("title", "Release notes are out of date"); put("repo", "nekko/agent") }),
            "This chat read web content: MCP calls ask first.",
            Severity.HIGH,
        )
        compose.setContent {
            NekkoTheme(dark = false) {
                Surface(color = Nekko.palette.paper) {
                    Box(Modifier.fillMaxSize().padding(16.dp)) {
                        ApprovalCard(
                            approval,
                            onDecide = { ok -> decided += if (ok) "allow" else "deny" },
                            onAlwaysAllow = { decided += "always" },
                        )
                    }
                }
            }
        }
        compose.onNodeWithTag("chat.approval.alwaysAllow").assertIsDisplayed()
        settle()
        shot("always-allow-tool")
        compose.onNodeWithTag("chat.approval.alwaysAllow").performClick()
        compose.waitUntil(5_000) { decided.isNotEmpty() }
        assertEquals(listOf("always"), decided.toList())
    }

    @Test fun builtInToolsOfferNoAlwaysAllow() {
        val approval = Approval(ToolCall("call-2", "bash", buildJsonObject { put("command", "npm test") }), "", Severity.MEDIUM)
        compose.setContent {
            NekkoTheme(dark = false) {
                ApprovalCard(approval, onDecide = {}, onAlwaysAllow = {})
            }
        }
        compose.onNodeWithTag("chat.approval.alwaysAllow").assertDoesNotExist()
    }

    // The same harness runs on base/head. Stable wire tags, no references to renamed resources.
    @Test fun permissionChoicesSimple() = permissionChoices(expert = false)
    @Test fun permissionChoicesDetailed() = permissionChoices(expert = true)

    private fun permissionChoices(expert: Boolean) {
        prefs.set(EXPERT_MODE, expert)
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalPhonePrefs provides prefs, LocalSimple provides rememberSimpleView(prefs)) {
                    Surface(color = Nekko.palette.paper, modifier = Modifier.fillMaxSize()) {
                        ChatModeDialog(ChatMode.GUARDRAILS, ChatMode.GUARDRAILS, "Studio", onDismiss = {}, onPick = {})
                    }
                }
            }
        }
        ChatMode.entries.forEach { compose.onNodeWithTag("chat.toolMode.${it.wire}").assertIsDisplayed() }
        settle()
        shot("permission-choices-${if (expert) "detailed" else "simple"}")
    }

    @Test fun yoloWarning() {
        val picked = CopyOnWriteArrayList<ChatMode>()
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalPhonePrefs provides prefs) {
                    Surface(color = Nekko.palette.paper, modifier = Modifier.fillMaxSize()) {
                        ChatModeDialog(ChatMode.GUARDRAILS, ChatMode.GUARDRAILS, "Studio", onDismiss = {}) { picked += it }
                    }
                }
            }
        }
        // Keep asking changes nothing.
        compose.onNodeWithTag("chat.toolMode.yolo").performClick()
        compose.onNodeWithTag(YoloWarning.Tags.DIALOG).assertIsDisplayed()
        if (!evidence) assertTrue(compose.onAllNodes(hasText("Turn on No restrictions?")).fetchSemanticsNodes().isNotEmpty())
        settle()
        shot("yolo-warning")
        compose.onNodeWithTag(YoloWarning.Tags.KEEP_ASKING).performClick()
        compose.waitForIdle()
        assertTrue(picked.isEmpty())
        assertEquals(false, prefs.get(YoloWarning.SKIP))

        // Don't warn me again, then Turn on YOLO: saved on the phone, and YOLO picked.
        compose.onNodeWithTag("chat.toolMode.yolo").performClick()
        compose.onNodeWithTag(YoloWarning.Tags.SKIP).performClick()
        compose.onNodeWithTag(YoloWarning.Tags.TURN_ON).performClick()
        compose.waitForIdle()
        assertEquals(listOf(ChatMode.YOLO), picked.toList())
        assertEquals(true, prefs.get(YoloWarning.SKIP))

        // Skipped from now on: YOLO is picked straight away.
        compose.onNodeWithTag("chat.toolMode.yolo").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag(YoloWarning.Tags.DIALOG).assertDoesNotExist()
        assertEquals(listOf(ChatMode.YOLO, ChatMode.YOLO), picked.toList())
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(700)
        compose.waitForIdle()
    }

    /** The whole screen, so the dialog shows as on the phone; only for the evidence run. */
    private fun shot(name: String) {
        if (!evidence) return
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
