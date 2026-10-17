package com.nekko.android

import android.app.Notification
import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nekko.android.connection.KeepAlive
import com.nekko.android.connection.Notices
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * AN-27 on a real Android 16+ system: the running-chat notification asks for
 * promotion and meets the system's own Live Update rules (ongoing, a title,
 * not colourised, a standard style), so it can show as a status-bar chip.
 * Whether the user has Live Updates on for the app is theirs to choose.
 */
@RunWith(AndroidJUnit4::class)
class LiveUpdateTest {
    @Test
    fun theRunningChatNotificationQualifiesAsALiveUpdate() {
        assumeTrue("Live Updates are Android 16+", Build.VERSION.SDK_INT >= 36)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val n = Notices(context).keepAlive(KeepAlive.status(2, "Mac"))
        assertTrue("asks for promotion", n.extras.getBoolean(Notification.EXTRA_REQUEST_PROMOTED_ONGOING))
        assertEquals("2 running", n.shortCriticalText?.toString())
        assertTrue("meets the system's Live Update rules", n.hasPromotableCharacteristics())
    }
}
