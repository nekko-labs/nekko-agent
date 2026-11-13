package com.nekko.android.ui.chat

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Save to Photos: a picture into the phone's gallery, in Pictures/Nekko.
 *
 * Android 10 and later take it through MediaStore with no permission. Android 9 (the oldest the
 * app runs on) has no such path: an app may write to the shared Pictures folder only with the
 * storage permission, which the manifest declares for Android 9 alone (`maxSdkVersion="28"`), so
 * no later phone ever sees it. It is asked the first time Save is tapped there (#2111 follow-up).
 */
object Gallery {
    /** Whether saving needs the storage permission on this phone: Android 9 only. */
    val needsPermission: Boolean get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q

    fun allowed(context: Context): Boolean =
        !needsPermission || ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    /** [bytes] as `Pictures/Nekko/<name>`; false when it couldn't be written (or the permission is missing on Android 9). */
    suspend fun save(context: Context, bytes: ByteArray, mime: String, name: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, name)
                    put(MediaStore.Images.Media.MIME_TYPE, mime)
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Nekko")
                }
                val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return@runCatching false
                context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null
            } else {
                if (!allowed(context)) return@runCatching false
                @Suppress("DEPRECATION") // The only way to the shared Pictures folder before Android 10.
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Nekko").apply { mkdirs() }
                val file = File(dir, name).apply { writeBytes(bytes) }
                // So the gallery shows it now, not after the next media scan.
                MediaScannerConnection.scanFile(context, arrayOf(file.path), arrayOf(mime), null)
                true
            }
        }.getOrDefault(false)
    }
}

/**
 * Save as a button runs it: [save] at once where no permission is needed (or it was given),
 * else after Android 9 asks for storage access; [onDenied] when the person says no.
 */
@Composable
fun rememberGallerySave(onDenied: () -> Unit): (save: suspend () -> Unit) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val denied by rememberUpdatedState(onDenied)
    val pending = remember { arrayOfNulls<suspend () -> Unit>(1) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val run = pending[0]
        pending[0] = null
        if (granted && run != null) scope.launch { run() } else if (!granted) denied()
    }
    return { save ->
        if (Gallery.allowed(context)) scope.launch { save() }
        else {
            pending[0] = save
            ask.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }
}
