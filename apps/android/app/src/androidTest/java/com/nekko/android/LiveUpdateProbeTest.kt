package com.nekko.android

import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nekko.android.connection.Notices
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Probe (temporary): which builder settings stop promotion on this system. */
@RunWith(AndroidJUnit4::class)
class LiveUpdateProbeTest {
    @Test
    fun whichVariantsArePromotable() {
        assumeTrue(Build.VERSION.SDK_INT >= 36)
        val context = ApplicationProvider.getApplicationContext<Context>()
        Notices(context)
        fun base() = NotificationCompat.Builder(context, Notices.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Staying connected")
            .setContentText("2 chats running on Mac")
            .setOngoing(true)
            .setRequestPromotedOngoing(true)
            .setShortCriticalText("2 running")
        val variants = linkedMapOf(
            "minimal" to base(),
            "+silent" to base().setSilent(true),
            "+category" to base().setCategory(NotificationCompat.CATEGORY_SERVICE),
            "+fgsImmediate" to base().setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE),
            "+bigText" to base().setStyle(NotificationCompat.BigTextStyle().bigText("2 chats running on Mac")),
            "+silent+bigText" to base().setSilent(true).setStyle(NotificationCompat.BigTextStyle().bigText("x")),
        )
        val report = variants.map { (k, b) -> "$k=${b.build().hasPromotableCharacteristics()}" }.joinToString(", ")
        fail("PROBE $report")
    }
}
