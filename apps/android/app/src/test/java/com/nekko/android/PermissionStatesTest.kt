package com.nekko.android

import androidx.biometric.BiometricManager
import com.nekko.android.permissions.PermissionAction
import com.nekko.android.permissions.PermissionActions
import com.nekko.android.permissions.PermissionItem
import com.nekko.android.permissions.PermissionState
import com.nekko.android.permissions.PermissionStates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2251: the checklist says what Android says, and offers only what can still change it. */
class PermissionStatesTest {
    @Test fun `a runtime permission reads as Android answers it`() {
        assertEquals(PermissionState.ALLOWED, PermissionStates.runtime(granted = true, asked = true, rationale = false))
        assertEquals("never asked", PermissionState.NOT_SET, PermissionStates.runtime(granted = false, asked = false, rationale = false))
        assertEquals("refused once: Android still asks", PermissionState.NOT_SET, PermissionStates.runtime(granted = false, asked = true, rationale = true))
        assertEquals("refused for good: only Settings now", PermissionState.DENIED, PermissionStates.runtime(granted = false, asked = true, rationale = false))
    }

    @Test fun `the screen lock is available until a check passes`() {
        assertEquals(PermissionState.AVAILABLE, PermissionStates.screenLock(BiometricManager.BIOMETRIC_SUCCESS, verified = false))
        assertEquals(PermissionState.ALLOWED, PermissionStates.screenLock(BiometricManager.BIOMETRIC_SUCCESS, verified = true))
        assertEquals("nothing enrolled yet", PermissionState.NOT_SET, PermissionStates.screenLock(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED, verified = false))
        assertEquals(PermissionState.UNAVAILABLE, PermissionStates.screenLock(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE, verified = false))
        assertEquals(PermissionState.RESTRICTED, PermissionStates.screenLock(BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED, verified = false))
    }

    @Test fun `each row offers only what can still change it`() {
        assertEquals(PermissionAction.ALLOW, PermissionActions.of(PermissionItem.MICROPHONE, PermissionState.NOT_SET, hasSettings = true))
        assertEquals(PermissionAction.SETTINGS, PermissionActions.of(PermissionItem.MICROPHONE, PermissionState.DENIED, hasSettings = true))
        assertEquals(PermissionAction.SETTINGS, PermissionActions.of(PermissionItem.ALERTS, PermissionState.ALLOWED, hasSettings = true))
        assertEquals("read-only rows link to the system", PermissionAction.SETTINGS, PermissionActions.of(PermissionItem.BACKGROUND, PermissionState.DENIED, hasSettings = true))
        assertEquals(PermissionAction.TRY, PermissionActions.of(PermissionItem.SCREEN_LOCK, PermissionState.AVAILABLE, hasSettings = true))
        assertEquals("enrol a lock first", PermissionAction.SETTINGS, PermissionActions.of(PermissionItem.SCREEN_LOCK, PermissionState.NOT_SET, hasSettings = true))
        assertEquals(PermissionAction.NONE, PermissionActions.of(PermissionItem.LIVE_UPDATES, PermissionState.UNAVAILABLE, hasSettings = false))
        assertEquals("Save on Android 10+: nothing to change", PermissionAction.NONE, PermissionActions.of(PermissionItem.SAVE_PHOTOS, PermissionState.ALLOWED, hasSettings = false))
        assertEquals(PermissionAction.NONE, PermissionActions.of(PermissionItem.SPEECH, PermissionState.AVAILABLE, hasSettings = false))
    }

    @Test fun `only allowed counts as done, and only what can be asked is requestable`() {
        assertTrue(PermissionState.ALLOWED.checked)
        assertFalse(PermissionState.DENIED.checked)
        assertFalse(PermissionState.UNAVAILABLE.requestable)
        assertFalse(PermissionState.RESTRICTED.requestable)
        assertTrue(PermissionState.DENIED.requestable)
        assertEquals("two recommended rows, five optional", listOf(2, 5), listOf(true, false).map { r -> PermissionItem.entries.count { it.recommended == r } })
    }
}
