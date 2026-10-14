package com.nekko.android

import android.app.Application
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.nekko.android.connection.ConnectionKeeper
import com.nekko.android.data.AndroidSecureStore
import com.nekko.android.data.NewChatDefaults
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.RelayRemoteFactory
import com.nekko.android.data.ThemePrefs
import com.nekko.android.lock.AppLock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** App-scoped singletons (manual DI). */
class NekkoApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var computers: ComputersRepository
        private set
    lateinit var themePrefs: ThemePrefs
        private set
    lateinit var phonePrefs: PhonePrefs
        private set
    lateinit var appLock: AppLock
        private set
    lateinit var newChatDefaults: NewChatDefaults
        private set

    override fun onCreate() {
        super.onCreate()
        themePrefs = ThemePrefs(this)
        phonePrefs = PhonePrefs(this)
        newChatDefaults = NewChatDefaults(phonePrefs)
        computers = ComputersRepository(
            store = AndroidSecureStore(this),
            remotes = RelayRemoteFactory(),
            scope = appScope,
            deviceName = ::deviceName,
            onForget = newChatDefaults::forget,
        )
        appLock = AppLock(enabled = phonePrefs.get(AppLock.ENABLED), persist = { phonePrefs.set(AppLock.ENABLED, it) })
        connection = ConnectionKeeper(this, computers, phonePrefs, appLock, appScope)
        connection.start()
        // Nothing reaches the computer until the user has unlocked once: no
        // relay connection, no chat list, no approvals behind the lock screen.
        appScope.launch {
            appLock.status.first { !it.locked }
            // The phone's default computer (Settings → New chats), else the one used last.
            computers.load(preferredId = newChatDefaults.computerId())
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                appLock.onForeground()
                connection.onForeground(true)
                // App came to the foreground: reconnect now rather than after the backoff.
                computers.nudge()
            }

            // Fires ~700 ms after the last activity stops, so rotations do not lock.
            override fun onStop(owner: LifecycleOwner) {
                appLock.onBackground()
                connection.onForeground(false)
            }
        })
    }

    /** The name the computer shows for this phone (Settings → Remote access). */
    private fun deviceName(): String {
        val name = runCatching { Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            ?.trim()?.ifEmpty { null }
            ?: Build.MODEL?.trim()?.ifEmpty { null }
            ?: "Android phone"
        return name.take(60)
    }
}
