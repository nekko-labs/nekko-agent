package com.nekko.android.lock

import com.nekko.android.data.PhonePrefs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Whether the app is locked. [epoch] counts lock events, so the lock screen can
 * offer the system prompt once per lock instead of again after every cancel.
 */
data class LockStatus(val locked: Boolean, val epoch: Int = 0)

/**
 * The app lock: locked on every cold start and every time the app leaves the
 * foreground, unlocked only by the phone's own authentication (fingerprint,
 * face, PIN, pattern or password; see [Authenticator]).
 *
 * No Android types, so the rules are tested on the JVM. [NekkoApp] feeds it the
 * process lifecycle: [onBackground] on ON_STOP, [onForeground] on ON_START.
 * ProcessLifecycleOwner already waits ~700 ms before ON_STOP, so a rotation or
 * a recreated activity does not count as leaving.
 *
 * Trips out of the app that the app starts itself (the QR scanner, the system
 * security settings, the credential screen on Android 9–10) are announced
 * with [expectReturn] and do not lock if the user is back within the window.
 * Only an unlocked app can announce one.
 */
class AppLock(
    enabled: Boolean,
    private val now: () -> Long = System::currentTimeMillis,
    /** Called when the setting changes, to persist it. */
    private val persist: (Boolean) -> Unit = {},
) {
    private val _enabled = MutableStateFlow(enabled)
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private val _status = MutableStateFlow(LockStatus(locked = enabled, epoch = if (enabled) 1 else 0))
    val status: StateFlow<LockStatus> = _status.asStateFlow()

    /** Deadline of an announced trip out of the app, if one is pending. */
    private var returnBy: Long? = null

    val locked: Boolean get() = _status.value.locked

    /** The app left the foreground. */
    fun onBackground() {
        if (!_enabled.value) return
        if (returnBy == null) lock()
    }

    /** The app came back to the foreground. */
    fun onForeground() {
        val deadline = returnBy ?: return
        returnBy = null
        if (_enabled.value && now() > deadline) lock()
    }

    /** The app is about to open something outside itself and expects to come back. */
    fun expectReturn(withinMs: Long = EXCURSION_MS) {
        if (_enabled.value && !locked) returnBy = now() + withinMs
    }

    /** The announced trip is over (or never happened): the next background locks as usual. */
    fun returned() {
        returnBy = null
    }

    /** The user authenticated. */
    fun unlock() {
        returnBy = null
        _status.update { it.copy(locked = false) }
    }

    /**
     * Turn the lock on or off. Callers must authenticate the user before
     * turning it off; turning it on never locks the current session.
     */
    fun setEnabled(on: Boolean) {
        if (_enabled.value == on) return
        _enabled.value = on
        returnBy = null
        if (!on) _status.update { it.copy(locked = false) }
        persist(on)
    }

    private fun lock() {
        _status.update { if (it.locked) it else LockStatus(locked = true, epoch = it.epoch + 1) }
    }

    companion object {
        /** Settings → Security → App lock. On by default, stored on the phone only. */
        val ENABLED = PhonePrefs.boolean("app_lock", default = true)

        /** Long enough to scan a QR code or set up a screen lock, short enough to matter. */
        const val EXCURSION_MS = 2 * 60_000L
    }
}
