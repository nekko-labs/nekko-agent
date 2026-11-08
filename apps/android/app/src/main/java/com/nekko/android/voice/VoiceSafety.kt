package com.nekko.android.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner

/** A sheet-scoped safety lease. Returning to the foreground NEVER restarts audio. Main thread only. */
class VoiceSafety(
    context: Context,
    private val owner: LifecycleOwner,
    private val stop: () -> Unit,
) : AutoCloseable {
    private val app = context.applicationContext
    private val audio = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var closed = false
    private var started = false
    private var routes = devices()
    private val lifecycle = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_DESTROY) stop()
    }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_OFF || intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) stop()
        }
    }
    private val route = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = changed()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = changed()
    }
    fun start() {
        if (started || closed) return
        started = true
        routes = devices()
        owner.lifecycle.addObserver(lifecycle)
        ContextCompat.registerReceiver(app, receiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        }, ContextCompat.RECEIVER_NOT_EXPORTED)
        audio.registerAudioDeviceCallback(route, Handler(Looper.getMainLooper()))
    }
    val foreground: Boolean get() = started && !closed && owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    private fun devices() = audio.getDevices(AudioManager.GET_DEVICES_ALL).map { it.id }.toSet()
    private fun changed() {
        if (closed) return
        val current = devices()
        if (current != routes) { routes = current; stop() }
    }
    override fun close() {
        if (closed) return
        closed = true
        if (started) {
            owner.lifecycle.removeObserver(lifecycle)
            app.unregisterReceiver(receiver)
            audio.unregisterAudioDeviceCallback(route)
        }
        stop()
    }
}
