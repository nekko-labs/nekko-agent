package com.nekko.android.ui.chat

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.provider.MediaStore
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.outlined.Schema
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import com.nekko.android.mermaid.MermaidRenderer
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.MermaidRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.File

private sealed interface Phase {
    data object Waiting : Phase
    class Drawn(val drawing: MermaidRenderer.Drawing) : Phase
    class Failed(val message: String) : Phase
}

/**
 * A ```` ```mermaid ```` fence drawn as its diagram (MM-4, the iPhone's
 * `MermaidBlock`): a picture scaled to the bubble, tap for full screen. While
 * the reply streams the fence shows as source; a diagram that fails falls
 * back to its source with Mermaid's error.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun MermaidBlock(source: String, closed: Boolean, style: MarkdownStyle) {
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val dark = Nekko.palette.paper.luminance() < 0.5f
    val scale = LocalDensity.current.density
    when (MermaidRules.decide(source, closed)) {
        MermaidRules.Decision.WAIT_FOR_FENCE -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            CodeBlock("mermaid", source, style)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Schema, contentDescription = null, tint = style.faint, modifier = Modifier.size(14.dp))
                Text("Drawing when the reply finishes…", style = MaterialTheme.typography.labelSmall, color = style.faint, modifier = Modifier.padding(start = 6.dp))
            }
        }
        MermaidRules.Decision.TOO_LARGE -> Fallback(MermaidRenderer.Failure.TOO_LARGE.message.orEmpty(), source, style)
        MermaidRules.Decision.DRAW -> BoxWithConstraints(Modifier.fillMaxWidth()) {
            val width = MermaidRules.drawWidth(maxWidth.value.toDouble())
            var phase by remember(source, dark, width) { mutableStateOf<Phase>(Phase.Waiting) }
            var full by remember { mutableStateOf(false) }
            var menu by remember { mutableStateOf(false) }
            var showSource by remember { mutableStateOf(false) }
            LaunchedEffect(source, dark, width) {
                phase = try {
                    Phase.Drawn(MermaidRenderer.draw(context, source, dark, width, scale))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Phase.Failed(e.message ?: "The diagram couldn’t be drawn.")
                }
            }
            when (val ph = phase) {
                is Phase.Drawn -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box {
                        val kind = MermaidRules.kind(source)
                        Image(
                            ph.drawing.image.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Fit,
                            modifier = Modifier.widthIn(max = (ph.drawing.image.width / scale).dp)
                                .combinedClickable(onClick = { full = true }, onLongClick = { menu = true }, onClickLabel = "Open full screen")
                                .semantics {
                                    contentDescription = "Diagram, $kind"
                                    customActions = listOf(CustomAccessibilityAction(if (showSource) "Hide source" else "Show source") { showSource = !showSource; true })
                                }
                                .testTag("mermaid.diagram"),
                        )
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Copy source") }, leadingIcon = { Icon(Icons.Filled.ContentCopy, null) }, onClick = {
                                menu = false
                                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Diagram", source))) }
                            })
                            DropdownMenuItem(text = { Text(if (showSource) "Hide source" else "Show source") }, leadingIcon = { Icon(Icons.Filled.Code, null) }, onClick = {
                                menu = false
                                showSource = !showSource
                            })
                        }
                    }
                    if (showSource) CodeBlock("mermaid", source, style)
                    if (full) MermaidScreen(source, ph.drawing, dark) { full = false }
                }
                is Phase.Failed -> Fallback(ph.message, source, style)
                Phase.Waiting -> Row(Modifier.heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(strokeWidth = 2.dp, color = style.soft, modifier = Modifier.size(16.dp))
                    Text("Drawing diagram…", style = MaterialTheme.typography.labelSmall, color = style.faint, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@Composable
private fun Fallback(message: String, source: String, style: MarkdownStyle) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("mermaid.error")) {
        Row {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = style.soft, modifier = Modifier.size(16.dp))
            Text(message, style = MaterialTheme.typography.labelMedium, color = style.soft, modifier = Modifier.padding(start = 6.dp))
        }
        CodeBlock("mermaid", source, style)
    }
}

/**
 * A diagram full screen: pinch to zoom and pan the SVG (in a WebView with
 * JavaScript off and every load refused), Copy source, Share image, Save to
 * Photos and Show source.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MermaidScreen(source: String, drawing: MermaidRenderer.Drawing, dark: Boolean, onDismiss: () -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var showSource by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(note) {
        if (note != null) {
            delay(1500)
            note = null
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
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                    title = { Text("Diagram") },
                    navigationIcon = { IconButton(onClick = onDismiss, modifier = Modifier.testTag("mermaid.done")) { Icon(Icons.Filled.Close, contentDescription = "Done") } },
                    actions = {
                        Box {
                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("mermaid.actions")) { Icon(Icons.Filled.MoreVert, contentDescription = "Diagram actions") }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("Copy source") }, leadingIcon = { Icon(Icons.Filled.ContentCopy, null) }, onClick = {
                                    menu = false
                                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Diagram", source))) }
                                    note = "Copied the source"
                                })
                                DropdownMenuItem(text = { Text("Share image") }, leadingIcon = { Icon(Icons.Filled.Share, null) }, onClick = {
                                    menu = false
                                    scope.launch { shareImage(context, drawing.image) }
                                })
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                    DropdownMenuItem(text = { Text("Save to Photos") }, leadingIcon = { Icon(Icons.Filled.Save, null) }, onClick = {
                                        menu = false
                                        scope.launch { note = if (saveToPhotos(context, drawing.image)) "Saved to Photos" else "Couldn’t save it" }
                                    })
                                }
                                DropdownMenuItem(text = { Text(if (showSource) "Show diagram" else "Show source") }, leadingIcon = { Icon(Icons.Filled.Code, null) }, onClick = {
                                    menu = false
                                    showSource = !showSource
                                })
                            }
                        }
                    },
                )
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                if (showSource) {
                    SelectionContainer(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) {
                        Text(source, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = p.ink, modifier = Modifier.padding(16.dp))
                    }
                } else {
                    LockedSvg(drawing.svg, dark, Modifier.fillMaxSize().semantics { contentDescription = "Diagram, ${MermaidRules.kind(source)}" })
                }
                note?.let {
                    Text(
                        it, style = MaterialTheme.typography.labelMedium, color = p.ink,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp),
                    )
                }
            }
        }
    }
}

private const val SVG_PAGE = "https://diagram.nekko.invalid/"

/** The SVG shown crisp at any zoom: a WebView with JavaScript off, no navigation and every load refused, holding only the SVG text. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun LockedSvg(svg: String, dark: Boolean, modifier: Modifier = Modifier) {
    val html = remember(svg, dark) {
        """<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.25, maximum-scale=8, user-scalable=yes">
<style>html,body{margin:0;background:${if (dark) "#0C0C11" else "#FFFFFF"}}body{display:flex;justify-content:center;padding:16px}svg{max-width:100%;height:auto}</style>
</head><body>$svg</body></html>"""
    }
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                webViewClient = object : WebViewClient() {
                    // The page itself, and nothing else.
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                        if (request.url.toString() == SVG_PAGE) WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray(Charsets.UTF_8)))
                        else WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                }
                loadUrl(SVG_PAGE)
            }
        },
        onRelease = { it.destroy() },
        modifier = modifier,
    )
}

/** Share the picture through the app's FileProvider: one file in the cache, replaced by the next share. */
private suspend fun shareImage(context: android.content.Context, image: Bitmap) {
    val file = withContext(Dispatchers.IO) {
        File(context.cacheDir, "diagram-share").apply { mkdirs() }.let { dir ->
            File(dir, "diagram.png").apply { outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        }
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.photos", file)
    val send = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, null))
}

/** Pictures/Nekko in the phone's gallery (Android 10 and later need no permission for it). */
private suspend fun saveToPhotos(context: android.content.Context, image: Bitmap): Boolean = withContext(Dispatchers.IO) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@withContext false
    runCatching {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "Diagram ${System.currentTimeMillis()}.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Nekko")
        }
        val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return@runCatching false
        context.contentResolver.openOutputStream(uri)?.use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } != null
    }.getOrDefault(false)
}
