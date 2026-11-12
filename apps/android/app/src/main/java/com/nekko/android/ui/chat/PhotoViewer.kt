package com.nekko.android.ui.chat

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.MediaStore
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.nekko.android.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.abs

/**
 * One photo the viewer can show: the small copy already on the phone, and how to ask the
 * computer for the full one (`session:photo`). Null [full] means the small copy is the photo
 * (one in the composer, still on the phone).
 */
class ViewerPhoto(val small: String, val full: (suspend () -> String?)? = null)

/**
 * A chat's photos full screen (the iPhone's ImageViewer, #1780): each opens on its small copy with
 * a spinner and turns sharp when the full photo arrives. Pinch or double-tap to zoom, drag to pan
 * a zoomed photo, swipe sideways between photos, and drag a photo at its normal size up or down to
 * close it (past a quarter of the screen, or a flick). The ⋮ menu saves it to the gallery, copies
 * it or shares it, using the full photo once it has arrived.
 */
@Composable
fun PhotoViewer(photos: List<ViewerPhoto>, start: Int, label: (Int) -> String, onDismiss: () -> Unit) {
    if (photos.isEmpty()) return
    val pager = rememberPagerState(initialPage = start.coerceIn(0, photos.lastIndex)) { photos.size }
    // What each page shows: the full photo once it is here, else the small copy; and whether it is still asked.
    val urls = remember { mutableStateMapOf<Int, String>() }
    val loading = remember { mutableStateMapOf<Int, Boolean>() }
    // How far the photo is carried up or down to close: the backdrop fades with it.
    val drag = remember { Animatable(0f) }
    var height by remember { mutableFloatStateOf(1f) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val res = LocalResources.current
    val clipboard = LocalClipboard.current
    var menu by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(note) { if (note != null) { delay(2_000); note = null } }
    val page = pager.currentPage
    val current = urls[page] ?: photos[page].small
    val ready = loading[page] != true && current.isNotEmpty()

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val fade = (1f - abs(drag.value) / (height * 0.6f)).coerceIn(0f, 1f)
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = fade))
                .onSizeChanged { height = it.height.toFloat().coerceAtLeast(1f) }
                .testTag("photo.viewer"),
        ) {
            HorizontalPager(pager, Modifier.fillMaxSize(), key = { it }) { i ->
                val photo = photos[i]
                LaunchedEffect(i) {
                    val full = photo.full ?: return@LaunchedEffect
                    if (urls.containsKey(i)) return@LaunchedEffect
                    loading[i] = true
                    try {
                        full()?.takeIf { it.startsWith("data:image/") }?.let { urls[i] = it }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // An older computer without session:photo, or offline: the small copy stays.
                    } finally {
                        loading[i] = false
                    }
                }
                PhotoPage(
                    url = urls[i] ?: photo.small,
                    small = photo.small,
                    label = label(i),
                    loading = loading[i] == true,
                    drag = if (i == page) drag.value else 0f,
                    onDrag = { dy -> scope.launch { drag.snapTo(drag.value + dy) } },
                    onRelease = { velocity ->
                        if (abs(drag.value) > height / 4 || abs(velocity) > 2_000f) onDismiss()
                        else scope.launch { drag.animateTo(0f) }
                    },
                    onDismiss = onDismiss,
                )
            }
            // The bar: close, which photo, and what can be done with it.
            Row(
                Modifier.fillMaxWidth().safeDrawingPadding().padding(horizontal = 4.dp).graphicsLayer { alpha = fade },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss, modifier = Modifier.testTag("photo.close")) {
                    Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.image_close), tint = Color.White)
                }
                Text(
                    if (photos.size > 1) stringResource(R.string.photo_n_of_m, page + 1, photos.size) else label(page),
                    color = Color.White,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Box {
                    IconButton(onClick = { menu = true }, enabled = ready, modifier = Modifier.testTag("photo.actions")) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.photo_actions), tint = if (ready) Color.White else Color.White.copy(alpha = 0.4f))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.chat_save_to_photos)) },
                                leadingIcon = { Icon(Icons.Outlined.Save, null) },
                                onClick = {
                                    menu = false
                                    scope.launch { note = res.getString(if (PhotoFiles.save(context, current)) R.string.chat_saved_to_photos else R.string.chat_save_failed) }
                                },
                                modifier = Modifier.testTag("photo.save"),
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_copy)) },
                            leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) },
                            onClick = {
                                menu = false
                                scope.launch {
                                    val uri = PhotoFiles.shared(context, current)
                                    if (uri != null) {
                                        clipboard.setClipEntry(ClipEntry(ClipData.newUri(context.contentResolver, label(page), uri)))
                                        note = res.getString(R.string.chat_copied)
                                    }
                                }
                            },
                            modifier = Modifier.testTag("photo.copy"),
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_share)) },
                            leadingIcon = { Icon(Icons.Outlined.Share, null) },
                            onClick = {
                                menu = false
                                scope.launch {
                                    val uri = PhotoFiles.shared(context, current) ?: return@launch
                                    val send = Intent(Intent.ACTION_SEND).setType(PhotoFiles.mime(current))
                                        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    context.startActivity(Intent.createChooser(send, null))
                                }
                            },
                            modifier = Modifier.testTag("photo.share"),
                        )
                    }
                }
            }
            note?.let {
                Text(
                    it,
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .safeDrawingPadding()
                        .padding(bottom = 24.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(999.dp))
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("photo.note"),
                )
            }
        }
    }
}

/** One photo: zoom and pan, double-tap to zoom, and at its normal size a vertical drag that closes the viewer. */
@Composable
private fun PhotoPage(
    url: String,
    small: String,
    label: String,
    loading: Boolean,
    drag: Float,
    onDrag: (Float) -> Unit,
    onRelease: (velocity: Float) -> Unit,
    onDismiss: () -> Unit,
) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val slop = LocalViewConfiguration.current.touchSlop
    // The small copy at once; the full photo replaces it, at the same zoom, once decoded.
    val smallBitmap by produceState<ImageBitmap?>(null, small) { value = PhotoDecoder.decode(small) }
    val fullBitmap by produceState<ImageBitmap?>(null, url) { value = if (url == small) null else PhotoDecoder.decode(url, targetPx = 2048) }
    val bitmap = fullBitmap ?: smallBitmap
    fun clamp(o: Offset, s: Float): Offset {
        val maxX = size.width * (s - 1) / 2
        val maxY = size.height * (s - 1) / 2
        return Offset(o.x.coerceIn(-maxX, maxX), o.y.coerceIn(-maxY, maxY))
    }
    val closeLabel = stringResource(R.string.image_close)
    Box(
        Modifier
            .fillMaxSize()
            .onSizeChanged { size = it }
            .semantics {
                contentDescription = label
                customActions = listOf(CustomAccessibilityAction(closeLabel) { onDismiss(); true })
            }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { at ->
                    if (scale > 1f) { scale = 1f; offset = Offset.Zero }
                    else { scale = 2.5f; offset = clamp((Offset(size.width / 2f, size.height / 2f) - at) * 1.5f, 2.5f) }
                })
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    var moved = Offset.Zero
                    var decided = false
                    var closing = false
                    val tracker = VelocityTracker()
                    do {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.count { it.pressed }
                        val zoom = event.calculateZoom()
                        val pan = event.calculatePan()
                        if (!closing && (pressed > 1 || scale > 1f)) {
                            // Pinching, or moving a zoomed photo: the pager doesn't page meanwhile.
                            scale = (scale * zoom).coerceIn(1f, 5f)
                            offset = if (scale == 1f) Offset.Zero else clamp(offset + pan, scale)
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        } else if (!decided) {
                            moved += pan
                            if (moved.getDistance() > slop) {
                                decided = true
                                // Mostly up or down at the normal size: carry the photo to close; sideways is the pager's.
                                closing = abs(moved.y) > abs(moved.x)
                            }
                        }
                        if (closing) {
                            event.changes.firstOrNull()?.let { tracker.addPosition(it.uptimeMillis, it.position) }
                            onDrag(pan.y)
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                    if (closing) onRelease(tracker.calculateVelocity().y)
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val b = bitmap
        if (b != null) {
            // Carried to close: it moves with the finger and shrinks a little.
            val shrink = 1f - (abs(drag) / (size.height.coerceAtLeast(1) * 4f)).coerceIn(0f, 0.15f)
            Image(
                b,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = scale * shrink
                        scaleY = scale * shrink
                        translationX = offset.x
                        translationY = offset.y + drag
                    }
                    .testTag(if (fullBitmap != null) "photo.full" else "photo.small"),
            )
        }
        if (loading || b == null) CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(28.dp).testTag("photo.loading"))
    }
}

/** A photo's bytes on their way out of the app: the gallery, the clipboard, the share sheet. */
internal object PhotoFiles {
    /** The photo's type from its data URL (`data:image/png;base64,…`); JPEG when it doesn't say. */
    fun mime(url: String): String = url.removePrefix("data:").substringBefore(';').takeIf { it.startsWith("image/") } ?: "image/jpeg"

    fun extension(mime: String): String = when (mime) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        "image/heic" -> "heic"
        else -> "jpg"
    }

    /** Pictures/Nekko in the phone's gallery, the photo's own bytes (Android 10 and later need no permission). */
    suspend fun save(context: Context, url: String): Boolean = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@withContext false
        val bytes = PhotoDecoder.bytesOf(url) ?: return@withContext false
        val mime = mime(url)
        runCatching {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "Photo ${System.currentTimeMillis()}.${extension(mime)}")
                put(MediaStore.Images.Media.MIME_TYPE, mime)
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Nekko")
            }
            val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return@runCatching false
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null
        }.getOrDefault(false)
    }

    /** One file in the cache, shared through the app's FileProvider and replaced by the next one. */
    suspend fun shared(context: Context, url: String): android.net.Uri? = withContext(Dispatchers.IO) {
        val bytes = PhotoDecoder.bytesOf(url) ?: return@withContext null
        val dir = File(context.cacheDir, "photo-share").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "photo.${extension(mime(url))}").apply { writeBytes(bytes) }
        FileProvider.getUriForFile(context, "${context.packageName}.photos", file)
    }
}
