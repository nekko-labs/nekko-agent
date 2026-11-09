package com.nekko.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.connection.EventNotice
import com.nekko.android.ui.chat.ApprovalCard
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Approval
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2065: **Always allow this tool** from the approval notification. The action is on an
 * MCP tool's notification only and needs an unlocked phone; it opens the chat, whose
 * approval card presses its own Always allow once. A refused save approves nothing and
 * the reason shows on the card. Screenshots under the app's external files, `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class AlwaysAllowNotificationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val app get() = ApplicationProvider.getApplicationContext<NekkoApp>()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val manager get() = app.getSystemService(NotificationManager::class.java)

    @Before fun allow() {
        if (Build.VERSION.SDK_INT >= 33) {
            InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        manager.cancelAll()
    }

    private fun actions(sessionId: String): List<Notification.Action> =
        manager.activeNotifications.first { it.tag == EventNotice.tag(sessionId) }.notification.actions?.toList().orEmpty()

    @Test fun onlyAnMcpToolsNotificationOffersAlwaysAllow() {
        val notices = app.connection.notices
        notices.post(EventNotice.of("s-mcp", PhoneEvent.APPROVAL, "Release notes", "Studio Mac", hideContent = false, callId = "call-1", toolName = "mcp__github__create_issue"))
        notices.post(EventNotice.of("s-bash", PhoneEvent.APPROVAL, "Fix the build", "Studio Mac", hideContent = false, callId = "call-2", toolName = "bash"))
        Thread.sleep(500)

        val mcp = actions("s-mcp")
        assertEquals(listOf("Always allow this tool", "Deny"), mcp.map { it.title.toString() })
        // Android 12+ asks for the unlocked phone before the app opens (the app lock still holds below that).
        if (Build.VERSION.SDK_INT >= 31) assertTrue(mcp[0].isAuthenticationRequired)
        assertTrue(mcp[0].actionIntent.isActivity)
        assertEquals(listOf("Deny"), actions("s-bash").map { it.title.toString() })

        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cmd statusbar expand-notifications").close()
        Thread.sleep(1_500)
        shot("notification-actions")
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cmd statusbar collapse").close()
        manager.cancelAll()
    }

    @Test fun theCardPressesAlwaysAllowOnceAndShowsARefusal() {
        val calls = CopyOnWriteArrayList<String>()
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
                            onDecide = { ok -> calls += if (ok) "allow" else "deny" },
                            // As a cancelled fingerprint prompt or a phone without a Change key: the save is refused.
                            onAlwaysAllow = { calls += "always"; error("Not confirmed on this phone. Nothing was allowed.") },
                            startAlways = true,
                            onStartedAlways = { calls += "taken" },
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("Not confirmed on this phone. Nothing was allowed.").assertExists()
        compose.onNodeWithTag("chat.approval.alwaysAllow").assertExists()
        // Taken once, the save ran once, and nothing was approved.
        assertEquals(listOf("taken", "always"), calls.toList())
        compose.waitForIdle()
        Thread.sleep(700)
        shot("card-refused")
    }

    @Test fun aBuiltInToolsCardNeverStartsAlwaysAllow() {
        val calls = CopyOnWriteArrayList<String>()
        val approval = Approval(ToolCall("call-2", "bash", buildJsonObject { put("command", "npm test") }), "", Severity.MEDIUM)
        compose.setContent {
            NekkoTheme(dark = false) {
                ApprovalCard(approval, onDecide = { calls += "decide" }, onAlwaysAllow = { calls += "always" }, startAlways = true, onStartedAlways = { calls += "taken" })
            }
        }
        compose.waitForIdle()
        assertTrue(calls.isEmpty())
    }

    private fun shot(name: String) {
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(app.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "always-allow-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
