package com.nekko.android.lock

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/** How one authentication attempt ended. */
sealed interface AuthResult {
    data object Success : AuthResult
    /** The user backed out, or the system dismissed the prompt (app left the screen). Nothing to show. */
    data object Cancelled : AuthResult
    /** Too many attempts, no hardware, and the like: show [message]. */
    data class Failed(val message: String) : AuthResult
}

/**
 * The phone's own authentication: fingerprint, face, or the screen lock PIN,
 * pattern or password. Nekko never sees or stores any of it; the system says
 * yes or no.
 *
 * One [BiometricPrompt] per activity, created in onCreate as the library
 * requires; each [authenticate] call routes its result to its own callback.
 */
class Authenticator(private val activity: FragmentActivity) {
    private var pending: ((AuthResult) -> Unit)? = null

    private val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = finish(AuthResult.Success)

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = finish(
                when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_CANCELED -> AuthResult.Cancelled
                    else -> AuthResult.Failed(errString.toString().ifBlank { "Couldn’t check your identity." })
                },
            )
            // A rejected finger keeps the prompt open for another try: nothing to do.
        },
    )

    /** True when the phone has a screen lock, so there is something to authenticate against. */
    fun deviceSecure(): Boolean =
        activity.getSystemService(Context.KEYGUARD_SERVICE).let { it is KeyguardManager && it.isDeviceSecure }

    fun authenticate(title: String, subtitle: String? = null, onResult: (AuthResult) -> Unit) {
        if (!deviceSecure()) {
            onResult(AuthResult.Failed("This phone has no screen lock."))
            return
        }
        pending = onResult
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .apply { subtitle?.let(::setSubtitle) }
            .setAllowedAuthenticators(ALLOWED)
            .build()
        prompt.authenticate(info)
    }

    private fun finish(result: AuthResult) {
        val cb = pending ?: return
        pending = null
        cb(result)
    }

    companion object {
        /**
         * Strong biometrics or the screen lock. Android 9 and 10 do not support
         * STRONG combined with the screen lock, so they accept any enrolled
         * biometric there; nothing is bound to a key, the prompt only gates the UI.
         */
        val ALLOWED: Int =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL
            else BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    }
}
