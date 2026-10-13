package com.nekko.android

import android.app.Application
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.nekko.android.data.AndroidSecureStore
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.RelayRemoteFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** App-scoped singletons (manual DI). */
class NekkoApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var computers: ComputersRepository
        private set

    override fun onCreate() {
        super.onCreate()
        computers = ComputersRepository(
            store = AndroidSecureStore(this),
            remotes = RelayRemoteFactory(),
            scope = appScope,
            deviceName = ::deviceName,
        )
        appScope.launch { computers.load() }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            // App came to the foreground: reconnect now rather than after the backoff.
            override fun onStart(owner: LifecycleOwner) = computers.nudge()
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
