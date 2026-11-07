package com.nekko.android

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.NotificationManager
import android.content.res.Configuration
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.connection.KeepAlive
import com.nekko.android.connection.Notices
import com.nekko.protocol.LiveCard
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.LiveChat
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveLevel
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Overlay unchanged on 774700943bea02dab365e1c510870c31f29d84d2 and the implementation.
 * Manual native-mode-evidence.yml inputs:
 * capture_platform=android
 * android_test_file=apps/android/app/src/androidTest/java/com/nekko/android/LiveDashboardNotificationEvidenceTest.kt
 * android_test_class=com.nekko.android.LiveDashboardNotificationEvidenceTest
 * android_expect=live-dashboard-notification
 *
 * The workflow supplies API 34 / google_apis / x86_64 / pixel_2, light system theme,
 * disabled animations and demo clock/battery. Both matrix legs must use those settings.
 * Platform UiAutomation (the accessibility backend used by UIAutomator) avoids adding
 * an AndroidX UIAutomator dependency that neither app revision declares.
 * This posts the real ongoing-notification builder, not a mock or a running service.
 * It proves shade presentation only, not FGS lifecycle, Android 16 promotion or actions.
 */
@RunWith(AndroidJUnit4::class)
class LiveDashboardNotificationEvidenceTest {
    @Test fun notificationShadeEvidence() {
        // Gate before granting permissions, posting, or touching System UI. Never use a user device.
        assumeTrue("Only the disposable evidence emulator may run this test",
            InstrumentationRegistry.getArguments().getString("nekkoModeEvidence") == "true" &&
                Build.HARDWARE in listOf("ranchu", "goldfish"))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext
        val ui = instrumentation.uiAutomation
        val manager = app.getSystemService(NotificationManager::class.java)
        assertEquals("Use the harness's matched API 34 emulator", 34, Build.VERSION.SDK_INT)
        assertEquals("Use the harness's light system theme", Configuration.UI_MODE_NIGHT_NO,
            app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK)
        // The fresh APK has no paired computers. Do not open MainActivity, start the
        // connection service, invoke pending intents, pair, or create a relay transport.
        assertTrue("Evidence requires fresh, unpaired app data",
            (app.applicationContext as NekkoApp).computers.state.value.computers.isEmpty())
        for (permission in listOf(Manifest.permission.FOREGROUND_SERVICE,
            Manifest.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING)) {
            assertEquals("Manifest must declare $permission", PackageManager.PERMISSION_GRANTED,
                app.checkSelfPermission(permission))
        }
        val hadPermission = app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!hadPermission) ui.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        val tag = "live-dashboard-evidence"
        val id = 2047
        val dir = File(requireNotNull(app.getExternalFilesDir(null)), "evidence").apply { mkdirs() }
        val output = File(dir, "live-dashboard-notification.png")
        // A stale PNG must never satisfy the capture script after a failed assertion.
        if (output.exists()) assertTrue(output.delete())
        val originalServiceInfo = ui.serviceInfo
        try {
            ui.serviceInfo = ui.serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS }
            assertTrue("Fresh emulator must not have other app notifications", manager.activeNotifications.isEmpty())
            val notices = Notices(app)
            assertTrue("POST_NOTIFICATIONS and the connection channel must be enabled", notices.allowed())
            val card = fixture()
            assertEquals(8, card.chats.size)
            assertEquals(22, card.more)
            val notification = notices.keepAlive(KeepAlive.status(5, "Fixture Mac"), card, LiveLevel.STANDARD)
            // There is no startedAt in the fixture, so the base cannot show an elapsed timer.
            // Suppress wall-clock posting time on both revisions as well.
            val stable = Notification.Builder.recoverBuilder(app, notification)
                .setWhen(0).setShowWhen(false).build()
            manager.notify(tag, id, stable)
            waitFor("The OS accepted the fixture notification") {
                manager.activeNotifications.any { it.tag == tag && it.id == id }
            }
            assertTrue("Open the real notification shade", ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS))
            val title = stable.extras.getCharSequence(Notification.EXTRA_TITLE).toString()
            val text = stable.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
            // Select the builder's words, not new-only labels, so this assertion runs on base too.
            waitFor("System UI renders the notification's title and text") {
                val root = ui.rootInActiveWindow
                root?.packageName?.toString() == "com.android.systemui" &&
                    root.findAccessibilityNodeInfosByText(title).isNotEmpty() &&
                    root.findAccessibilityNodeInfosByText(text).isNotEmpty()
            }
            // Expand only the fixture's row, never press an action or a different notification.
            val titleNode = ui.rootInActiveWindow.findAccessibilityNodeInfosByText(title).first()
            var row: android.view.accessibility.AccessibilityNodeInfo? = titleNode
            while (row != null) {
                val expand = row.findAccessibilityNodeInfosByViewId("com.android.systemui:id/expand_button").firstOrNull()
                if (expand != null) {
                    if (expand.contentDescription?.toString()?.contains("Expand", ignoreCase = true) == true) {
                        assertTrue("Expand the fixture notification", expand.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK))
                    }
                    break
                }
                row = row.parent
            }
            ui.waitForIdle(500, 5_000)
            // The base and implementation deliberately have different expanded words/actions.
            // Wait for the actual builder's expanded body when it supplies one.
            stable.extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.let { body ->
                waitFor("System UI renders the expanded fixture body") {
                    ui.rootInActiveWindow?.findAccessibilityNodeInfosByText(body)?.isNotEmpty() == true
                }
            }
            val bitmap = requireNotNull(ui.takeScreenshot()) { "System UI screenshot was unavailable" }
            try {
                output.outputStream().use { assertTrue("Write PNG evidence", bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            } finally {
                bitmap.recycle()
            }
            assertTrue("Nonempty PNG for mode-evidence.sh", output.length() > 0)
        } finally {
            manager.cancel(tag, id)
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            ui.serviceInfo = originalServiceInfo
            // Keep POST_NOTIFICATIONS until CI deletes the disposable emulator.
            // Revoking it here can kill the instrumented UID before JUnit reports OK.
        }
    }

    private fun fixture(): LiveCardState {
        val chats = listOf(
            LiveChat("input-1", "Release", LiveChatState.NEEDS_YOU, step = "Review the release notes", callId = "approval-1", severity = "low"),
            LiveChat("input-2", "Design", LiveChatState.NEEDS_YOU, step = "Choose the layout"),
        ) + List(3) { LiveChat("working-$it", "Build $it", LiveChatState.WORKING, step = "Running tests") } +
            List(20) { LiveChat("done-$it", "Done $it", LiveChatState.DONE, finishedAt = 990.0) } +
            LiveChat("failed-1", "Checks", LiveChatState.FAILED, finishedAt = 990.0) +
            List(4) { LiveChat("watch-$it", "Watch $it", LiveChatState.WATCHING, step = "Watching PR…") }
        // Only base-compatible initializer arguments. The current builder derives full-set
        // counts itself; the base clips detail to eight and has no counts constructor field.
        val previous = LiveCardState(chats = emptyList(), focusId = null)
        return requireNotNull(LiveCard.build(chats, previous, null, LiveLevel.STANDARD, now = 1_000.0))
    }

    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!condition()) {
            assertTrue(message, SystemClock.uptimeMillis() < deadline)
            SystemClock.sleep(100)
        }
    }
}
