package com.nekko.android.permissions

import android.Manifest
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.speech.SpeechRecognizer
import androidx.biometric.BiometricManager
import androidx.core.content.ContextCompat
import com.nekko.android.data.PhonePrefs
import com.nekko.android.lock.Authenticator
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * What the phone can do for Nekko, row by row (the iPhone's PermissionChecklist, #2249; Android's
 * #2251). Each row reads the system's own answer, never a guess: a runtime permission, a system
 * switch, or whether the hardware is there. Nothing here is required.
 */
enum class PermissionItem(val recommended: Boolean, val permission: String? = null) {
    /** Approvals, questions and finished replies (POST_NOTIFICATIONS on Android 13+, else the app's notification switch). */
    ALERTS(true, Manifest.permission.POST_NOTIFICATIONS),
    /** The keep-alive service: stopped entirely when the app's battery use is Restricted. */
    BACKGROUND(true),
    /** Android 16 Live Updates: the running chat in the status bar and on the lock screen. */
    LIVE_UPDATES(false),
    MICROPHONE(false, Manifest.permission.RECORD_AUDIO),
    /** On-device speech recognition: there or not, no permission of its own. */
    SPEECH(false),
    /** Fingerprint, face or the screen lock, for the app lock and approvals. */
    SCREEN_LOCK(false),
    /** Pictures/Nekko: Android 9 only needs the storage permission. */
    SAVE_PHOTOS(false, Manifest.permission.WRITE_EXTERNAL_STORAGE),
}

/** A row's state, as the system reports it. */
enum class PermissionState {
    /** Not asked yet, or Android would still ask. */
    NOT_SET,
    ALLOWED,
    /** Refused, and only the system's settings can change it now. */
    DENIED,
    /** Blocked by the device (a policy, or a needed security update). */
    RESTRICTED,
    /** This phone has no such thing (no microphone, no on-device speech, no Live Updates before Android 16). */
    UNAVAILABLE,
    /** It is there and set up, but not tried yet (the screen lock). */
    AVAILABLE,
    ;

    /** Done, as the progress counts it. */
    val checked: Boolean get() = this == ALLOWED

    /** Something can still be asked for or tried. */
    val requestable: Boolean get() = this != RESTRICTED && this != UNAVAILABLE
}

object PermissionStates {
    /** Runtime permissions the checklist has asked for, so a refusal after the last ask reads as Off in Settings. */
    val ASKED: PhonePrefs.Key<Set<String>> = PhonePrefs.key(
        "permissions.asked",
        emptySet(),
        { JsonArray(it.sorted().map(::JsonPrimitive)).toString() },
        { raw -> (runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }?.toSet() },
    )

    /**
     * A runtime permission's state from what Android says. Granted is Allowed. Never asked is Not set.
     * After an ask, Android shows its dialog again only while it still offers a rationale; once it
     * doesn't, only the app's system settings can change it: Off in Settings.
     */
    fun runtime(granted: Boolean, asked: Boolean, rationale: Boolean): PermissionState = when {
        granted -> PermissionState.ALLOWED
        !asked || rationale -> PermissionState.NOT_SET
        else -> PermissionState.DENIED
    }

    /** The screen lock from BiometricManager's answer; Allowed only after a check passed on this visit. */
    fun screenLock(canAuthenticate: Int, verified: Boolean): PermissionState = when (canAuthenticate) {
        BiometricManager.BIOMETRIC_SUCCESS -> if (verified) PermissionState.ALLOWED else PermissionState.AVAILABLE
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> PermissionState.NOT_SET
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> PermissionState.RESTRICTED
        else -> PermissionState.UNAVAILABLE
    }

    /** What the phone says about [item] now. [rationale] is the activity's shouldShowRequestPermissionRationale. */
    fun read(context: Context, item: PermissionItem, asked: Set<String>, rationale: (String) -> Boolean, verified: Boolean): PermissionState {
        fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
        fun runtimeOf(p: String) = runtime(granted(p), p in asked, rationale(p))
        val notifications = context.getSystemService(NotificationManager::class.java)
        return when (item) {
            PermissionItem.ALERTS -> when {
                Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS) -> runtimeOf(Manifest.permission.POST_NOTIFICATIONS)
                // Allowed, but the app's notifications are switched off in the system.
                notifications?.areNotificationsEnabled() == false -> PermissionState.DENIED
                else -> PermissionState.ALLOWED
            }
            PermissionItem.BACKGROUND ->
                if (context.getSystemService(ActivityManager::class.java)?.isBackgroundRestricted == true) PermissionState.DENIED else PermissionState.ALLOWED
            PermissionItem.LIVE_UPDATES -> when {
                Build.VERSION.SDK_INT < 36 -> PermissionState.UNAVAILABLE
                notifications?.canPostPromotedNotifications() == true && notifications.areNotificationsEnabled() -> PermissionState.ALLOWED
                else -> PermissionState.DENIED
            }
            PermissionItem.MICROPHONE ->
                if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)) PermissionState.UNAVAILABLE
                else runtimeOf(Manifest.permission.RECORD_AUDIO)
            PermissionItem.SPEECH ->
                if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) PermissionState.AVAILABLE else PermissionState.UNAVAILABLE
            PermissionItem.SCREEN_LOCK -> screenLock(BiometricManager.from(context).canAuthenticate(Authenticator.ALLOWED), verified)
            PermissionItem.SAVE_PHOTOS ->
                // Android 10 and later save to the gallery with no permission at all.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) PermissionState.ALLOWED else runtimeOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }

    /** The system page that changes [item], or null when there is nothing to change there. */
    fun settings(context: Context, item: PermissionItem): Intent? {
        val pkg = context.packageName
        val app = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null))
        return when (item) {
            PermissionItem.ALERTS -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
            PermissionItem.LIVE_UPDATES ->
                if (Build.VERSION.SDK_INT >= 36) Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg) else null
            PermissionItem.SCREEN_LOCK -> Intent(Settings.ACTION_SECURITY_SETTINGS)
            PermissionItem.SPEECH -> null
            PermissionItem.SAVE_PHOTOS -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) null else app
            PermissionItem.BACKGROUND, PermissionItem.MICROPHONE -> app
        }
    }

    /** The app's own page in the system settings. */
    fun appSettings(context: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
}

/** What a row's main button does, and says. */
enum class PermissionAction { ALLOW, TRY, SETTINGS, NONE }

object PermissionActions {
    /**
     * The iPhone's rule: Settings once it is allowed or off there; Allow while Android still asks;
     * Try it for the screen lock; nothing for what can't be asked or changed.
     */
    fun of(item: PermissionItem, state: PermissionState, hasSettings: Boolean): PermissionAction = when {
        !state.requestable -> PermissionAction.NONE
        item == PermissionItem.SCREEN_LOCK && state == PermissionState.AVAILABLE -> PermissionAction.TRY
        item == PermissionItem.SCREEN_LOCK && state == PermissionState.NOT_SET -> PermissionAction.SETTINGS
        state == PermissionState.NOT_SET && item.permission != null -> PermissionAction.ALLOW
        // Read-only rows (background, Live Updates, speech) only ever link to the system.
        hasSettings -> PermissionAction.SETTINGS
        else -> PermissionAction.NONE
    }
}
