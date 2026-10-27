package com.nekko.android.ui.previews

import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.text.format.Formatter
import android.util.LruCache
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.invisibleToUser
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.graphics.createBitmap
import androidx.core.view.WindowCompat
import com.nekko.android.previews.LocalChatPreviews
import com.nekko.android.previews.PreviewLoader
import com.nekko.android.previews.PreviewSource
import com.nekko.android.previews.PreviewWeb
import com.nekko.android.previews.PreviewWebState
import com.nekko.android.ui.chat.MarkdownText
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ArtifactKind
import com.nekko.protocol.ChatLinks
import com.nekko.protocol.ChatPreviewLink
import com.nekko.protocol.PreviewUrls
import com.nekko.protocol.RelayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

// ---- the window ----

private sealed interface Content {
    class Web(val source: PreviewSource) : Content
    class Picture(val image: ImageBitmap) : Content
    class Markdown(val text: String, val cut: Long?) : Content
    class Text(val text: String, val cut: Long?) : Content
    class Pdf(val data: ByteArray) : Content
}

/**
 * A file the agent made, or a dev server on the computer, opened full screen
 * (AN-35, the iPhone's `PreviewWindow`): an HTML prototype or SVG runs in the
 * isolated web view, interactive; pictures pinch to zoom; Markdown is
 * formatted; text, JSON and CSV are monospaced; a PDF shows its pages.
 * Everything is read from the computer through the relay: the phone never
 * reaches the computer's files or ports itself.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PreviewWindow(link: ChatPreviewLink, sessionId: String, loader: PreviewLoader, onDismiss: () -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var attempt by rememberSaveable { mutableIntStateOf(0) }
    var content by remember { mutableStateOf<Content?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var webLoading by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val loopback = link.isLoopback

    LaunchedEffect(attempt) {
        val reload = attempt > 0
        error = null
        content = null
        webLoading = false
        // Reload reads the page and everything it uses again.
        if (reload) loader.forget(sessionId)
        try {
            content = when (val t = link.target) {
                is ChatPreviewLink.Target.Artifact -> {
                    val body = loader.artifact(sessionId, t.path, reload)
                    val cut = if (body.truncated) body.size else null
                    when (link.kind ?: ArtifactKind.ofPath(t.path) ?: ArtifactKind.TEXT) {
                        ArtifactKind.HTML, ArtifactKind.SVG -> {
                            // Half a page would run half a prototype.
                            if (body.truncated) throw RelayException("Too large to open on a phone.")
                            Content.Web(PreviewSource(sessionId, loader, PreviewUrls.artifactUrl(t.path), null))
                        }
                        ArtifactKind.IMAGE -> Content.Picture(
                            withContext(Dispatchers.Default) { decode(body.data, 4096) } ?: throw RelayException("This image can’t be shown on a phone."),
                        )
                        ArtifactKind.MARKDOWN -> Content.Markdown(body.data.toString(Charsets.UTF_8), cut)
                        ArtifactKind.TEXT -> Content.Text(shown(body.data.toString(Charsets.UTF_8)), cut)
                        ArtifactKind.PDF -> Content.Pdf(body.data)
                    }
                }
                is ChatPreviewLink.Target.Loopback -> {
                    val local = PreviewUrls.previewUrl(t.url) ?: throw RelayException("This address can’t be opened.")
                    val first = PreviewUrls.upstream(local.substringBefore('#'), t.url) ?: throw RelayException("This address can’t be opened.")
                    // Read the page first, so a stopped server says so here rather than as a blank page.
                    loader.fetch(sessionId, first, reload)
                    Content.Web(PreviewSource(sessionId, loader, local, t.url))
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = PreviewLoader.message(e, loopback)
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = onDismiss)
        // The dialog has its own window: its status bar icons follow the app's theme, as the activity's do.
        val view = LocalView.current
        val light = p.paper.luminance() > 0.5f
        LaunchedEffect(light) {
            (view.parent as? DialogWindowProvider)?.window?.let { w ->
                WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
        }
        Scaffold(
            containerColor = p.paper,
            modifier = Modifier.testTag("preview.window"),
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                    navigationIcon = {
                        IconButton(onClick = onDismiss, modifier = Modifier.testTag("preview.done")) { Icon(Icons.Filled.Close, contentDescription = "Done") }
                    },
                    title = {
                        Column(Modifier.semantics(mergeDescendants = true) { heading() }) {
                            Text(link.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(link.detail, style = MaterialTheme.typography.labelSmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        }
                    },
                    actions = {
                        IconButton(onClick = { attempt++ }, modifier = Modifier.testTag("preview.reload")) { Icon(Icons.Filled.Refresh, contentDescription = "Reload") }
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(if (loopback) "Copy address" else "Copy path") },
                                leadingIcon = { Icon(Icons.Filled.ContentCopy, contentDescription = null) },
                                onClick = {
                                    menu = false
                                    scope.launch { clipboard.setClipEntry(ClipEntry(android.content.ClipData.newPlainText(link.title, link.original))) }
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Share") },
                                leadingIcon = { Icon(Icons.Filled.Share, contentDescription = null) },
                                onClick = {
                                    menu = false
                                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link.original)
                                    context.startActivity(Intent.createChooser(send, null))
                                },
                            )
                        }
                    },
                )
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
                val c = content
                when {
                    error != null -> Failure(error!!) { attempt++ }
                    c == null -> Column(
                        Modifier.fillMaxSize().semantics { contentDescription = "Opening on your computer" },
                        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator(color = p.accent)
                        Text("Opening on your computer…", color = p.inkSoft, modifier = Modifier.padding(top = 12.dp))
                    }
                    else -> Shown(c, link, attempt) { state ->
                        when (state) {
                            PreviewWebState.Loading -> webLoading = true
                            is PreviewWebState.Loaded -> webLoading = false
                            is PreviewWebState.Failed -> {
                                webLoading = false
                                error = state.message
                            }
                        }
                    }
                }
                if (webLoading && error == null) {
                    CircularProgressIndicator(
                        color = p.accent,
                        modifier = Modifier.padding(top = 12.dp).size(28.dp).semantics { contentDescription = "Loading" },
                    )
                }
            }
        }
    }
}

@Composable
private fun Shown(c: Content, link: ChatPreviewLink, attempt: Int, onWeb: (PreviewWebState) -> Unit) {
    val p = Nekko.palette
    when (c) {
        is Content.Web -> androidx.compose.runtime.key(attempt) { PreviewWebView(c.source, interactive = true, onState = onWeb, modifier = Modifier.fillMaxSize()) }
        is Content.Picture -> ZoomableImage(c.image, link.title)
        is Content.Markdown -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).widthIn(max = 720.dp).padding(16.dp)) {
            CutNote(c.cut)
            MarkdownText(c.text, p.ink)
        }
        is Content.Text -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(16.dp)) {
            CutNote(c.cut)
            SelectionContainer {
                Text(c.text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = p.ink, softWrap = false)
            }
        }
        is Content.Pdf -> PdfPages(c.data)
    }
}

@Composable
private fun CutNote(size: Long?) {
    if (size == null) return
    val context = LocalContext.current
    Text(
        "Only the start is shown: the whole file is ${Formatter.formatShortFileSize(context, size)} on your computer.",
        style = MaterialTheme.typography.bodySmall, color = Nekko.palette.warning, modifier = Modifier.padding(bottom = 12.dp),
    )
}

@Composable
private fun Failure(message: String, retry: () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxSize().padding(24.dp).testTag("preview.error"),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Couldn’t open the preview", style = MaterialTheme.typography.titleMedium, color = p.ink)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.padding(top = 8.dp))
        TextButton(onClick = retry, modifier = Modifier.padding(top = 8.dp).testTag("preview.retry")) { Text("Try again") }
    }
}

/** The isolated web view; destroyed (and what the page stored forgotten) when it leaves the screen. */
@Composable
private fun PreviewWebView(source: PreviewSource, interactive: Boolean, onState: (PreviewWebState) -> Unit, modifier: Modifier = Modifier) {
    var web by remember { mutableStateOf<WebView?>(null) }
    AndroidView(
        factory = { ctx -> PreviewWeb.create(ctx, source, interactive, onState).also { web = it } },
        modifier = modifier,
    )
    DisposableEffect(source) { onDispose { web?.let(PreviewWeb::dispose) } }
}

/** A picture that pinches and double-taps to zoom. */
@Composable
private fun ZoomableImage(image: ImageBitmap, label: String) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(
        Modifier.fillMaxSize().clipToBounds()
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 8f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = {
                    if (scale > 1f) {
                        scale = 1f
                        offset = Offset.Zero
                    } else {
                        scale = 3f
                    }
                })
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            image, contentDescription = label, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            },
        )
    }
}

/** A PDF's pages, drawn by the platform's renderer from a private temporary copy. */
@Composable
private fun PdfPages(data: ByteArray) {
    val p = Nekko.palette
    val context = LocalContext.current
    var pages by remember { mutableStateOf<List<ImageBitmap>?>(null) }
    var failed by remember { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = with(LocalDensity.current) { maxWidth.toPx() }.toInt().coerceIn(320, 2000)
        LaunchedEffect(data, widthPx) {
            pages = try {
                withContext(Dispatchers.IO) { renderPdf(context.cacheDir, data, widthPx) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                failed = true
                null
            }
        }
        val list = pages
        when {
            failed -> Failure("This PDF can’t be shown on a phone.") {}
            list == null -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
            else -> LazyColumn(Modifier.fillMaxSize().background(p.code), contentPadding = PaddingValues(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(list.size) { i ->
                    val page = list[i]
                    Image(
                        page, contentDescription = "Page ${i + 1} of ${list.size}", contentScale = ContentScale.FillWidth,
                        modifier = Modifier.fillMaxWidth().aspectRatio(page.width.toFloat() / page.height.coerceAtLeast(1)).background(androidx.compose.ui.graphics.Color.White),
                    )
                }
            }
        }
    }
}

/** At most 50 pages, each [widthPx] wide; the copy is deleted straight after. */
private fun renderPdf(dir: File, data: ByteArray, widthPx: Int): List<ImageBitmap> {
    val file = File.createTempFile("preview", ".pdf", dir)
    try {
        file.writeBytes(data)
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
            PdfRenderer(fd).use { r ->
                return (0 until minOf(r.pageCount, 50)).map { i ->
                    r.openPage(i).use { page ->
                        val h = (widthPx.toFloat() * page.height / page.width.coerceAtLeast(1)).toInt().coerceAtLeast(1)
                        val b = createBitmap(widthPx, h)
                        b.eraseColor(android.graphics.Color.WHITE)
                        page.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        b.asImageBitmap()
                    }
                }
            }
        }
    } finally {
        file.delete()
    }
}

/** An image scaled down to at most [maxPx] on its long side; null when it isn't one. */
private fun decode(data: ByteArray, maxPx: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxPx) sample *= 2
    return BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}

/** A very long text file is cut for display: one Text can't lay out megabytes. */
private fun shown(text: String): String = if (text.length > 200_000) text.take(200_000) + "\n…" else text

// ---- the cards under a reply ----

/**
 * A reply's preview cards (the iPhone's `AssistantReply` cards): one per file
 * or loopback page it links, a thumbnail for pages and pictures, an
 * extension chip for the rest. Nothing outside a chat (no [LocalChatPreviews]).
 */
@Composable
fun PreviewCards(text: String) {
    val previews = LocalChatPreviews.current ?: return
    val links = remember(text) { ChatLinks.previews(text) }
    if (links.isEmpty()) return
    Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (link in links) PreviewCard(link, previews.sessionId, previews.loader) { previews.open(link) }
    }
}

@Composable
private fun PreviewCard(link: ChatPreviewLink, sessionId: String, loader: PreviewLoader, open: () -> Unit) {
    val p = Nekko.palette
    val shape = RoundedCornerShape(12.dp)
    val thumbnail = link.isWeb || link.kind == ArtifactKind.IMAGE
    Column(
        Modifier.fillMaxWidth().clip(shape).background(p.surface).border(1.dp, p.line, shape)
            .clickable(onClick = open)
            .semantics(mergeDescendants = true) {
                contentDescription = "${link.title}, ${link.detail}. Opens a preview from your computer"
                role = Role.Button
            }
            .testTag("preview.card"),
    ) {
        if (thumbnail) {
            Thumbnail(link, sessionId, loader)
            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
        }
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (!thumbnail) {
                Text(
                    link.detail.substringAfterLast('.', "file").uppercase(),
                    style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = p.inkSoft,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(p.code).padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
            Column(Modifier.weight(1f)) {
                Text(link.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(link.detail, style = MaterialTheme.typography.labelSmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            }
            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, tint = p.accent, modifier = Modifier.size(18.dp))
        }
    }
}

/** Pictures of pages and images already drawn, so scrolling back doesn't load them again. */
private object Thumbnails {
    val images = LruCache<String, ImageBitmap>(60)
}

private val VIEWPORT = 390.dp
private val THUMB_HEIGHT = 160.dp

/**
 * A card's picture. A page renders in the isolated web view at a phone's
 * width (390 dp), scaled down, without touches, and is then kept as a
 * picture so a long chat holds no live web views. Only a few load at a time.
 */
@Composable
private fun Thumbnail(link: ChatPreviewLink, sessionId: String, loader: PreviewLoader) {
    val p = Nekko.palette
    val key = "$sessionId|${link.id}"
    var image by remember(key) { mutableStateOf(Thumbnails.images.get(key)) }
    var source by remember(key) { mutableStateOf<PreviewSource?>(null) }
    var failed by remember(key) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(key) {
        if (image != null) return@LaunchedEffect
        try {
            loader.withThumbnailSlot {
                when (val t = link.target) {
                    is ChatPreviewLink.Target.Artifact -> {
                        val body = loader.artifact(sessionId, t.path)
                        if (link.kind == ArtifactKind.IMAGE) {
                            val thumb = withContext(Dispatchers.Default) { decode(body.data, 900) } ?: throw RelayException("not an image")
                            Thumbnails.images.put(key, thumb)
                            image = thumb
                        } else if (!body.truncated) {
                            source = PreviewSource(sessionId, loader, PreviewUrls.artifactUrl(t.path), null)
                        } else {
                            failed = true
                        }
                    }
                    is ChatPreviewLink.Target.Loopback -> {
                        val local = PreviewUrls.previewUrl(t.url)
                        val first = local?.let { PreviewUrls.upstream(it.substringBefore('#'), t.url) }
                        if (local == null || first == null) {
                            failed = true
                        } else {
                            loader.fetch(sessionId, first)
                            source = PreviewSource(sessionId, loader, local, t.url)
                        }
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        }
    }
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(THUMB_HEIGHT).background(p.code).clipToBounds().semantics { invisibleToUser() },
    ) {
        val img = image
        val src = source
        when {
            img != null -> Image(img, contentDescription = null, contentScale = ContentScale.FillWidth, alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize())
            src != null -> {
                val scale = maxWidth / VIEWPORT
                Box(
                    Modifier.wrapContentSize(Alignment.TopStart, unbounded = true)
                        .requiredSize(VIEWPORT, THUMB_HEIGHT / scale)
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            transformOrigin = TransformOrigin(0f, 0f)
                        },
                ) {
                    PreviewWebView(src, interactive = false, modifier = Modifier.fillMaxSize(), onState = { state ->
                        when (state) {
                            // Let the page's scripts draw for a moment, then keep a picture of it.
                            is PreviewWebState.Loaded -> scope.launch {
                                delay(700)
                                if (source == null) return@launch
                                PreviewWeb.snapshot(state.web)?.asImageBitmap()?.let {
                                    Thumbnails.images.put(key, it)
                                    image = it
                                }
                                source = null
                            }
                            is PreviewWebState.Failed -> {
                                failed = true
                                source = null
                            }
                            PreviewWebState.Loading -> {}
                        }
                    })
                }
            }
            failed -> Icon(
                if (link.isWeb) Icons.Filled.Language else Icons.Filled.BrokenImage, contentDescription = null, tint = p.inkFaint,
                modifier = Modifier.align(Alignment.Center).size(32.dp),
            )
            else -> CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.align(Alignment.Center).size(24.dp))
        }
    }
}
