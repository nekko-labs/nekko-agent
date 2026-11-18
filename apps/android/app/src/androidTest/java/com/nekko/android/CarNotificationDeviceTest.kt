package com.nekko.android

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.connection.CarReplyReceiver
import com.nekko.android.connection.EventNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2782: a finished reply on Android Auto is a conversation the car reads aloud, with Reply
 * (dictated, through RemoteInput) and Mark as read, the actions Android Auto takes. A reply for a
 * chat that isn't on the active computer is not sent, and the conversation says so.
 */
@RunWith(AndroidJUnit4::class)
class CarNotificationDeviceTest {
    private val app get() = ApplicationProvider.getApplicationContext<NekkoApp>()
    private val manager get() = app.getSystemService(NotificationManager::class.java)
    private fun shown(id: String) = manager.activeNotifications.firstOrNull { it.tag == EventNotice.tag(id) }

    @Before fun allow() {
        if (Build.VERSION.SDK_INT >= 33) InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        manager.cancelAll()
    }

    @Test fun aReplyReadAloudWithReplyAndMarkAsRead() {
        app.connection.notices.postCar("car-chat", "Billing retries", "not-this-computer", "Done. The retries now back off.")
        Thread.sleep(500)
        val n = shown("car-chat")!!.notification
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)!!
        assertEquals("Billing retries", style.conversationTitle)
        assertEquals("Done. The retries now back off.", style.messages.single().text)
        val reply = NotificationCompat.getAction(n, 0)!!
        assertEquals(NotificationCompat.Action.SEMANTIC_ACTION_REPLY, reply.semanticAction)
        assertEquals(CarReplyReceiver.KEY, reply.remoteInputs!!.single().resultKey)
        assertTrue(!reply.showsUserInterface)
        val read = NotificationCompat.getInvisibleActions(n).single()
        assertEquals(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ, read.semanticAction)

        // The car dictates a reply; this chat isn't on the computer the phone is on, so nothing goes.
        val intent = Intent(app, CarReplyReceiver::class.java).setAction(CarReplyReceiver.ACTION_REPLY)
            .putExtra(CarReplyReceiver.SESSION, "car-chat").putExtra(CarReplyReceiver.COMPUTER, "not-this-computer")
        RemoteInput.addResultsToIntent(reply.remoteInputs!!, intent,
            Bundle().apply { putCharSequence(CarReplyReceiver.KEY, "Ship it") })
        app.sendBroadcast(intent.setPackage(app.packageName))
        val deadline = System.currentTimeMillis() + 5_000
        var messages = style.messages
        while (System.currentTimeMillis() < deadline) {
            messages = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(shown("car-chat")!!.notification)!!.messages
            if (messages.size == 2) break
            Thread.sleep(200)
        }
        assertEquals(2, messages.size)
        assertTrue(messages.last().text.toString().startsWith("Not sent"))
        assertEquals(0, app.computers.outbox.state.value.items.size)

        // Mark as read takes it away.
        app.sendBroadcast(Intent(app, CarReplyReceiver::class.java).setAction(CarReplyReceiver.ACTION_READ).putExtra(CarReplyReceiver.SESSION, "car-chat").setPackage(app.packageName))
        Thread.sleep(800)
        assertEquals(null, shown("car-chat"))
    }
}
