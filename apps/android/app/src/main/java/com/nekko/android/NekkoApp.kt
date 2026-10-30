package com.nekko.android

import android.app.Application
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.nekko.android.connection.ConnectionKeeper
import com.nekko.android.connection.RoutePolicy
import com.nekko.android.data.AndroidSecureStore
import com.nekko.android.data.ChatListFiles
import com.nekko.android.data.NewChatDefaults
import com.nekko.android.data.PaneLayouts
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.RelayRemoteFactory
import com.nekko.android.data.ThemePrefs
import com.nekko.android.haptics.AndroidHaptics
import com.nekko.android.haptics.EventHaptics
import com.nekko.android.lock.AppLock
import com.nekko.android.security.ActivityOwnerCheck
import com.nekko.android.security.KeystoreChangeSigner
import com.nekko.android.share.ShareInbox
import com.nekko.android.widget.StatusSnapshot
import com.nekko.android.widget.StatusStore
import com.nekko.android.widget.StatusTile
import com.nekko.android.widget.StatusWidget
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
    /** The folding-phone pane arrangement per computer (phone only). */
    lateinit var paneLayouts: PaneLayouts
        private set
    /** Text shared from other apps on its way to a chat's composer; memory only. */
    val shareInbox = ShareInbox()
    lateinit var connection: ConnectionKeeper
        private set
    lateinit var haptics: AndroidHaptics
        private set
    private lateinit var chatLists: ChatListFiles
    /** The fingerprint or screen lock for Change actions, through whichever activity is on screen. */
    val ownerCheck = ActivityOwnerCheck()

    /** Settings → Connection → Keep the chat list when offline. Off deletes every saved list. */
    fun setKeepChatList(on: Boolean) {
        phonePrefs.set(ChatListFiles.ENABLED, on)
        computers.chatListCache = if (on) chatLists else null
        if (!on) chatLists.removeAll()
    }

    override fun onCreate() {
        super.onCreate()
        themePrefs = ThemePrefs(this)
        phonePrefs = PhonePrefs(this)
        newChatDefaults = NewChatDefaults(phonePrefs)
        paneLayouts = PaneLayouts(phonePrefs)
        computers = ComputersRepository(
            store = AndroidSecureStore(this),
            remotes = RelayRemoteFactory(),
            scope = appScope,
            deviceName = ::deviceName,
            changeSigner = KeystoreChangeSigner(ownerCheck),
            routeAllowed = RoutePolicy::allowed,
            onForget = { id ->
                newChatDefaults.forget(id)
                paneLayouts.forget(id)
            },
        )
        chatLists = ChatListFiles(this)
        if (phonePrefs.get(ChatListFiles.ENABLED)) computers.chatListCache = chatLists
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
        haptics = AndroidHaptics(this, EventHaptics(phonePrefs), computers)
        // Vibrate for the active computer's agent events, per Settings → Vibration.
        appScope.launch { computers.events.collect(haptics::onEvent) }
        // The Home Screen widget: counts only, saved and redrawn when they change.
        val widgetStore = StatusStore(this)
        appScope.launch {
            computers.state.collect { s ->
                // Not before the computers are loaded (after unlock): keep the last real numbers.
                if (!s.ready) return@collect
                val next = StatusSnapshot.of(s, System.currentTimeMillis())
                if (!next.sameAs(widgetStore.load())) {
                    widgetStore.save(next)
                    StatusWidget.refresh(this@NekkoApp)
                    StatusTile.refresh(this@NekkoApp)
                }
            }
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
