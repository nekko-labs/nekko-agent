package com.nekko.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.connection.EventNotice
import com.nekko.android.connection.Notices
import com.nekko.protocol.E2E
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Local, synthetic notifications only. Run on a disposable emulator, never a paired phone. */
@RunWith(AndroidJUnit4::class)
class AttentionBadgesDeviceTest {
    private val app get() = ApplicationProvider.getApplicationContext<NekkoApp>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val manager get() = app.getSystemService(NotificationManager::class.java)

    @Test fun distinctWaitingChatsAndResolution() {
        val baseline = InstrumentationRegistry.getArguments().getString("nekkoBaseline") == "true"
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        manager.cancelAll()
        val notices = Notices(app)
        try {
            notices.post(EventNotice.of("approval", PhoneEvent.APPROVAL, "Deploy", "Test computer", false, "call-1"))
            notices.post(EventNotice.of("approval", PhoneEvent.APPROVAL, "Deploy", "Test computer", false, "call-1"))
            notices.post(EventNotice.of("question", PhoneEvent.NEEDS_INPUT, "Choose a target", "Test computer", false))
            notices.post(EventNotice.of("finished", PhoneEvent.FINISHED, "Notes", "Test computer", false))
            Thread.sleep(1_000)
            val waiting = manager.activeNotifications.filter { it.tag in setOf(EventNotice.tag("approval"), EventNotice.tag("question")) }
            assertEquals(2, waiting.size)
            if (!baseline) {
                assertEquals("one badge unit per distinct waiting chat", 2, waiting.sumOf { it.notification.number })
                waiting.forEach { assertEquals(0, it.notification.flags and Notification.FLAG_AUTO_CANCEL) }
                assertTrue(manager.getNotificationChannel(Notices.CHANNEL_NEEDS_YOU).canShowBadge())
                assertFalse(manager.getNotificationChannel(Notices.CHANNEL_REPLIES).canShowBadge())
                assertFalse(manager.getNotificationChannel(Notices.CHANNEL_CONNECTION).canShowBadge())
            }
            shell("cmd statusbar expand-notifications")
            Thread.sleep(1_000)
            val name = if (baseline) "before" else "after"
            val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("No screenshot")
            val dir = File(app.getExternalFilesDir(null), "evidence").apply { mkdirs() }
            File(dir, "attention-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            shell("cmd statusbar collapse")
            notices.dismissNeedsYou(E2E.activityTag("approval"))
            Thread.sleep(500)
            assertFalse(manager.activeNotifications.any { it.tag == EventNotice.tag("approval") })
            assertTrue(manager.activeNotifications.any { it.tag == EventNotice.tag("question") })
            assertTrue(manager.activeNotifications.any { it.tag == EventNotice.tag("finished") })
            val snapshot = manager.activeNotifications.joinToString("\n") { "${it.tag}: number=${it.notification.number}, flags=${it.notification.flags}, channel=${it.notification.channelId}" }
            File(dir, "attention-$name.txt").writeText(snapshot)
        } finally {
            shell("cmd statusbar collapse")
            manager.cancelAll()
        }
    }

    @Suppress("DEPRECATION") // Inspect the platform notification payload, including legacy sound/vibration fields.
    @Test fun reconciliationKeepsOpenedChatUntilResolvedAndDoesNotCancelReplies() {
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        manager.cancelAll()
        val notices = Notices(app)
        val approval = EventNotice.of("approval", PhoneEvent.APPROVAL, "Deploy", "Test computer", true, "call-1")
        val question = EventNotice.of("question", PhoneEvent.NEEDS_INPUT, "Choose", "Test computer", true)
        try {
            notices.syncAttention("computer-a", listOf(approval, question), silent = true)
            notices.syncAttention("computer-a", listOf(approval, question), silent = true)
            Thread.sleep(500)
            assertEquals(2, manager.activeNotifications.filter { it.id == Notices.ID_EVENT }.sumOf { it.notification.number })
            val open = manager.activeNotifications.single { it.tag == EventNotice.tag("approval") }.notification
            assertNull(open.sound)
            assertNull(open.vibrate)
            open.contentIntent.send()
            Thread.sleep(500)
            assertTrue("opening the chat is not answering", manager.activeNotifications.any { it.tag == EventNotice.tag("approval") })
            notices.post(EventNotice.of("approval", PhoneEvent.FINISHED, "Deploy", "Test computer", true))
            notices.syncAttention("computer-a", listOf(question), silent = true)
            Thread.sleep(500)
            assertFalse(manager.activeNotifications.any { it.tag == EventNotice.tag("approval") && it.id == Notices.ID_EVENT })
            assertTrue(manager.activeNotifications.any { it.tag == EventNotice.tag("approval") && it.id == Notices.ID_REPLY })
            assertEquals(1, manager.activeNotifications.filter { it.id == Notices.ID_EVENT }.sumOf { it.notification.number })
            notices.syncAttention("computer-b", emptyList(), silent = true)
            Thread.sleep(500)
            assertFalse(manager.activeNotifications.any { it.id == Notices.ID_EVENT })
        } finally {
            manager.cancelAll()
        }
    }

    @Test fun processRestartUnknownStateIsNotAnAnswer() {
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        manager.cancelAll()
        try {
            val waiting = listOf(EventNotice.of("retained", PhoneEvent.NEEDS_INPUT, "Choose", "Test computer", true))
            Notices(app).syncAttention("computer", waiting, silent = true)
            Thread.sleep(500)
            val restarted = Notices(app)
            restarted.syncAttention("computer", emptyList(), silent = true, authoritative = false)
            Thread.sleep(500)
            assertTrue("opening offline must retain Android's waiting notification", manager.activeNotifications.any { it.tag == EventNotice.tag("retained") })
            restarted.dismissNeedsYou(E2E.activityTag("retained"))
            Thread.sleep(500)
            assertFalse(manager.activeNotifications.any { it.tag == EventNotice.tag("retained") })
            restarted.syncAttention("computer", waiting, silent = true)
            Thread.sleep(500)
            Notices(app).syncAttention("computer", emptyList(), silent = true, authoritative = true)
            Thread.sleep(500)
            assertFalse(manager.activeNotifications.any { it.tag == EventNotice.tag("retained") })
        } finally {
            manager.cancelAll()
        }
    }

    @Test fun oldRepliesKeepTheirContentWithoutAddingBadgeUnits() {
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        manager.cancelAll()
        try {
            manager.createNotificationChannel(android.app.NotificationChannel("replies", "Legacy replies", NotificationManager.IMPORTANCE_DEFAULT))
            val legacy = manager.getNotificationChannel("replies")
            val old = androidx.core.app.NotificationCompat.Builder(app, "replies")
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("An unread reply")
                .setNumber(4)
                .build()
            manager.notify(EventNotice.tag("legacy"), Notices.ID_EVENT, old)
            Thread.sleep(500)
            Notices(app)
            Thread.sleep(500)
            val migrated = manager.activeNotifications.single { it.tag == EventNotice.tag("legacy") }
            assertEquals(Notices.ID_REPLY, migrated.id)
            assertEquals(Notices.CHANNEL_REPLIES, migrated.notification.channelId)
            assertEquals(0, migrated.notification.number)
            assertEquals("An unread reply", migrated.notification.extras.getCharSequence(Notification.EXTRA_TITLE))
            val channel = manager.getNotificationChannel(Notices.CHANNEL_REPLIES)
            assertFalse(channel.canShowBadge())
            assertEquals(legacy.importance, channel.importance)
            assertEquals(legacy.sound, channel.sound)
        } finally {
            manager.cancelAll()
        }
    }

    private fun shell(command: String) {
        instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).readBytes()
        }
    }
}
