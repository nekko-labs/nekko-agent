package com.nekko.android

import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.connection.EventNotice
import com.nekko.android.connection.Notices
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Run separately after `adb shell pm revoke <package> android.permission.POST_NOTIFICATIONS`.
 * Revocation terminates the app process, so it cannot safely happen inside the ordinary device suite.
 */
@RunWith(AndroidJUnit4::class)
class AttentionPermissionDeniedDeviceTest {
    @Test fun deniedRuntimePermissionCannotPostAttentionOrBadge() {
        // The ordinary suite may have permission. An explicitly requested denied run must really be denied.
        assumeTrue("Run separately with POST_NOTIFICATIONS revoked", androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("nekkoDenied") == "true")
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        val notices = Notices(app)
        assertFalse(notices.allowed())
        val waiting = listOf(EventNotice.of("denied", PhoneEvent.NEEDS_INPUT, "Choose", "Test computer", true))
        notices.post(waiting.single())
        notices.syncAttention("computer", waiting, silent = false)
        Thread.sleep(500)
        assertFalse(notices.allowed())
        assertFalse(app.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == Notices.ID_EVENT })
    }
}
