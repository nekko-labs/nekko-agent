package com.nekko.android.ui.terminal

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardReturn
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Lan
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.terminal.TerminalSession
import com.nekko.android.terminal.TerminalsController
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PhoneTerminal
import com.nekko.protocol.TermColor
import com.nekko.protocol.TermLine
import com.nekko.protocol.TerminalKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A first guess for a new terminal before its screen is laid out; it follows the real size once the screen appears. */
private const val PHONE_COLS = 48
private const val PHONE_ROWS = 24
private val FONT_SIZE = 12.sp

/**
 * A chat's terminals and the computer's SSH hosts (AN-31, the iPhone's
 * `TerminalsView`), full screen from the chat's ⋮ menu. Opening one attaches
 * this phone (the fingerprint, face or screen lock, once per 5 minutes);
 * typing then needs no more prompts.
 */
@Composable
fun TerminalsDialog(terminals: TerminalsController, online: Boolean, computer: String, onDismiss: () -> Unit) {
    val active by terminals.active.collectAsStateWithLifecycle()
    val back: () -> Unit = { if (active != null) terminals.hide() else onDismiss() }
    LaunchedEffect(terminals) { terminals.load() }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = back)
        // The dialog has its own window: its status bar icons follow the app's theme, as the activity's do.
        val view = LocalView.current
        val light = Nekko.palette.paper.luminance() > 0.5f
        LaunchedEffect(light) {
            (view.parent as? DialogWindowProvider)?.window?.let { w ->
                WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
        }
        // On an open folding phone the dialog spans both panes: keep it a readable width.
        Box(Modifier.fillMaxSize().background(Nekko.palette.paper), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
                val s = active
                if (s == null) ListPage(terminals, online, computer, onClose = onDismiss, open = terminals::show)
                else TerminalPage(s, terminals, online, computer, onBack = terminals::hide)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Page(
    title: String,
    onBack: () -> Unit,
    close: Boolean = false,
    actions: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        if (close) Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.tools_close))
                        else Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.tools_back))
                    }
                },
                actions = { actions() },
            )
        },
        content = content,
    )
}

// ---- the list ----

@Composable
private fun ListPage(terminals: TerminalsController, online: Boolean, computer: String, onClose: () -> Unit, open: (TerminalSession) -> Unit) {
    val p = Nekko.palette
    val s by terminals.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    fun opening(make: suspend () -> TerminalSession) {
        busy = true
        scope.launch {
            try {
                open(make())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed = com.nekko.android.terminal.describe(e, computer)
            } finally {
                busy = false
            }
        }
    }
    Page(
        stringResource(R.string.tools_term_title), onClose, close = true,
        actions = { IconButton(onClick = { scope.launch { terminals.load() } }) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.tools_refresh)) } },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(Modifier.fillMaxSize().testTag("terminals.list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Label(stringResource(R.string.tools_term_this_chat).uppercase()) }
                s.error?.let { item { Notice(it, Tone.DANGER) } }
                if (s.loaded && s.error == null && s.terminals.isEmpty()) item { Text(stringResource(R.string.tools_term_none), color = p.inkSoft) }
                items(s.terminals, key = { it.id }) { t -> TerminalRow(t) { open(terminals.session(t)) } }
                item {
                    Row2(Icons.Filled.Add, stringResource(R.string.tools_term_new), enabled = !busy && online, modifier = Modifier.testTag("terminals.new")) {
                        opening { terminals.newTerminal(PHONE_COLS, PHONE_ROWS) }
                    }
                    Footnote(stringResource(R.string.tools_term_new_note, computer))
                }
                item { Label("SSH") }
                when {
                    s.hostsError != null -> item { Text(s.hostsError!!, color = p.inkSoft) }
                    s.loaded && s.hosts.isEmpty() -> item { Text(stringResource(R.string.tools_term_no_hosts, computer), color = p.inkSoft) }
                }
                items(s.hosts, key = { "ssh:${it.alias}" }) { h ->
                    Row2(Icons.Filled.Lan, h.alias, detail = h.detail, enabled = !busy && online, modifier = Modifier.testTag("terminals.ssh.${h.alias}")) {
                        opening { terminals.openSsh(h, PHONE_COLS, PHONE_ROWS) }
                    }
                }
                item { Footnote(stringResource(R.string.tools_term_ssh_note, computer)) }
            }
            if (busy || (s.loading && !s.loaded)) CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
        }
    }
    failed?.let { m ->
        AlertDialog(
            onDismissRequest = { failed = null },
            title = { Text(stringResource(R.string.tools_cant_open)) },
            text = { Text(m) },
            confirmButton = { TextButton(onClick = { failed = null }) { Text(stringResource(R.string.tools_ok)) } },
        )
    }
}

@Composable
private fun TerminalRow(t: PhoneTerminal, onClick: () -> Unit) {
    val p = Nekko.palette
    val icon = when (t.kind) {
        PhoneTerminal.Kind.SSH -> Icons.Filled.Lan
        PhoneTerminal.Kind.AGENT -> Icons.AutoMirrored.Filled.ListAlt
        PhoneTerminal.Kind.SHELL -> Icons.Filled.Terminal
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick).padding(12.dp).testTag("terminals.row.${t.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = if (t.running) p.accent else p.inkFaint)
        Column(Modifier.weight(1f)) {
            Text(t.title.ifEmpty { t.shell }, style = MaterialTheme.typography.bodyLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(t.detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (t.viewers > 0) Icon(Icons.Filled.PhoneAndroid, contentDescription = stringResource(R.string.tools_term_attached), tint = p.inkSoft, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun Row2(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val p = Nekko.palette
    Row(
        modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = if (enabled) p.accent else p.inkFaint)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (enabled) p.ink else p.inkFaint)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft) }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp).semantics { heading() })
}

@Composable
private fun Footnote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkFaint, modifier = Modifier.padding(top = 6.dp, start = 4.dp, end = 4.dp))
}

// ---- one terminal ----

/** One terminal: live output with ANSI colours, the key row, and a command line for typing or dictating a whole line. */
@Composable
private fun TerminalPage(session: TerminalSession, terminals: TerminalsController, online: Boolean, computer: String, onBack: () -> Unit) {
    val p = Nekko.palette
    val state by session.state.collectAsStateWithLifecycle()
    val terminal by session.terminal.collectAsStateWithLifecycle()
    val error by session.error.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var confirmClose by remember { mutableStateOf(false) }

    LaunchedEffect(session) { if (state == TerminalSession.State.Opening) session.start() }
    // The connection came back: the computer forgot this phone's session, so open it again.
    var wasOnline by remember { mutableStateOf(online) }
    LaunchedEffect(online) {
        if (online && !wasOnline) session.reconnected()
        wasOnline = online
    }

    Page(
        terminal.title.ifEmpty { stringResource(R.string.tools_term_terminal) }, onBack,
        actions = {
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.testTag("terminal.more")) { Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.tools_term_more)) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.tools_term_read_again)) }, leadingIcon = { Icon(Icons.Filled.Refresh, contentDescription = null) },
                        onClick = { menu = false; scope.launch { session.refresh() } })
                    if (!terminal.readOnly) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.tools_term_close), color = p.danger) }, leadingIcon = { Icon(Icons.Filled.Close, contentDescription = null, tint = p.danger) },
                            onClick = { menu = false; confirmClose = true }, modifier = Modifier.testTag("terminal.close"))
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            when (val st = state) {
                TerminalSession.State.Opening -> Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(color = p.accent, modifier = Modifier.size(20.dp))
                    Text(stringResource(R.string.tools_term_opening), color = p.inkSoft)
                }
                is TerminalSession.State.Failed -> Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Notice(st.message, Tone.DANGER)
                    TextButton(onClick = { scope.launch { session.start() } }) { Text(stringResource(R.string.tools_try_again)) }
                }
                is TerminalSession.State.Exited -> Banner(st.code?.let { stringResource(R.string.tools_term_exited_code, it) } ?: stringResource(R.string.tools_term_exited))
                TerminalSession.State.Closed -> Banner(stringResource(R.string.tools_term_closed))
                TerminalSession.State.ReadOnly -> Banner(stringResource(R.string.tools_term_read_only))
                TerminalSession.State.Live -> error?.let { Banner(it, danger = true) }
            }
            Output(session, Modifier.weight(1f))
            if (state == TerminalSession.State.Live) Controls(session)
        }
    }
    if (confirmClose) {
        AlertDialog(
            onDismissRequest = { confirmClose = false },
            title = { Text(stringResource(R.string.tools_term_close_title, computer)) },
            text = { Text(stringResource(R.string.tools_term_close_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmClose = false
                    scope.launch { runCatching { session.close() }; terminals.load() }
                }) { Text(stringResource(R.string.tools_term_close), color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmClose = false }) { Text(stringResource(R.string.tools_cancel)) } },
        )
    }
}

@Composable
private fun Banner(text: String, danger: Boolean = false) {
    val p = Nekko.palette
    Text(text, style = MaterialTheme.typography.bodySmall, color = if (danger) p.danger else p.inkSoft,
        modifier = Modifier.fillMaxWidth().background(p.surface).padding(horizontal = 12.dp, vertical = 6.dp))
}

@Composable
private fun Output(session: TerminalSession, modifier: Modifier) {
    val p = Nekko.palette
    val dark = p.paper.luminance() < 0.5f
    val colors = remember(dark) { TerminalColors(dark) }
    val version by session.version.collectAsStateWithLifecycle()
    val state by session.state.collectAsStateWithLifecycle()
    val lines = remember(version, state) { synchronized(session.screen) { session.screen.rendered(cursor = state == TerminalSession.State.Live) } }
    val list = rememberLazyListState()
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = FONT_SIZE, color = colors.ink)
    // The size of one character cell in the terminal's font.
    val cell = remember(style, density) { measurer.measure("M", style).size }
    var size by remember { mutableStateOf(IntSize.Zero) }

    LaunchedEffect(lines.size, version) { if (lines.isNotEmpty()) list.scrollToItem(lines.lastIndex) }
    // Rotation, the keyboard, a fold: the terminal follows once the size settles.
    LaunchedEffect(size) {
        if (size == IntSize.Zero || cell.width == 0 || cell.height == 0) return@LaunchedEffect
        delay(250)
        val margin = with(density) { 12.dp.roundToPx() }
        session.resize(maxOf((size.width - margin) / cell.width, 10), maxOf(size.height / cell.height, 4))
    }
    val text = remember(lines) { lines.takeLast(8).joinToString("\n") { it.text }.trim() }
    Box(
        modifier.fillMaxWidth().background(colors.background).onSizeChanged { size = it }
            .semantics { contentDescription = text }.testTag("terminal.output"),
    ) {
        LazyColumn(Modifier.fillMaxSize().horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp), state = list) {
            itemsIndexed(lines) { _, l -> Text(annotated(l, colors), style = style, maxLines = 1, softWrap = false) }
        }
    }
}

@Composable
private fun Controls(session: TerminalSession) {
    val p = Nekko.palette
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var line by remember { mutableStateOf("") }
    var ctrl by remember { mutableStateOf(false) }
    val send = {
        session.sendLine(line)
        line = ""
    }
    Column(Modifier.fillMaxWidth().background(p.surface).navigationBarsPadding().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Key("esc") { session.key(TerminalKey.Escape) }
            Key("tab") { session.key(TerminalKey.Tab) }
            Key("ctrl", on = ctrl, description = stringResource(R.string.tools_term_key_control)) { ctrl = !ctrl }
            Key("^C", description = stringResource(R.string.tools_term_key_control_c)) { session.key(TerminalKey.Ctrl('c')) }
            Key("↑", description = stringResource(R.string.tools_term_key_up)) { session.key(TerminalKey.Up) }
            Key("↓", description = stringResource(R.string.tools_term_key_down)) { session.key(TerminalKey.Down) }
            Key("←", description = stringResource(R.string.tools_term_key_left)) { session.key(TerminalKey.Left) }
            Key("→", description = stringResource(R.string.tools_term_key_right)) { session.key(TerminalKey.Right) }
            Key("⌫", description = stringResource(R.string.tools_term_key_backspace)) { session.key(TerminalKey.Backspace) }
            Key("⏎", description = stringResource(R.string.tools_term_key_return)) { session.key(TerminalKey.Enter) }
            IconButton(onClick = {
                scope.launch {
                    val clip = clipboard.getClipEntry()?.clipData ?: return@launch
                    if (clip.itemCount > 0) clip.getItemAt(0).coerceToText(context)?.toString()?.let(session::paste)
                }
            }) { Icon(Icons.Filled.ContentPaste, contentDescription = stringResource(R.string.tools_term_paste)) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = line,
                onValueChange = { v ->
                    // With Ctrl on, the next key goes at once as Ctrl+key.
                    if (ctrl && v.length > line.length) {
                        session.key(TerminalKey.Ctrl(v.last()))
                        line = ""
                        ctrl = false
                    } else {
                        line = v
                    }
                },
                placeholder = { Text(stringResource(if (ctrl) R.string.tools_term_ctrl_key else R.string.tools_term_type)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                modifier = Modifier.weight(1f).testTag("terminal.line"),
            )
            IconButton(onClick = send, modifier = Modifier.testTag("terminal.send")) {
                Icon(Icons.AutoMirrored.Filled.KeyboardReturn, contentDescription = stringResource(R.string.tools_term_send))
            }
        }
    }
}

@Composable
private fun Key(label: String, on: Boolean = false, description: String? = null, onClick: () -> Unit) {
    val p = Nekko.palette
    Text(
        label,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        color = if (on) p.accentInk else p.ink,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(if (on) p.accent else p.surface2)
            .clickable(onClick = onClick).heightIn(min = 36.dp).padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics {
                description?.let { contentDescription = it }
                selected = on
            },
    )
}

// ---- colours ----

/** The terminal's own colours, readable on its background in both themes (the iPhone's). */
private class TerminalColors(dark: Boolean) {
    val background = Color(if (dark) 0xFF0E0E14 else 0xFFFBFBFD)
    val ink = Color(if (dark) 0xFFE6E4EE else 0xFF1C1B22)
    val ansi: List<Color> = (
        if (dark) listOf(0x2E2E38, 0xFF6B6B, 0x5FD68A, 0xE8C05A, 0x6CA7FF, 0xC792EA, 0x56D4DD, 0xD6D4DF,
            0x6E6C7A, 0xFF8A8A, 0x7FE8A4, 0xF5D37A, 0x8DBBFF, 0xD8ACF2, 0x7FE3EA, 0xFFFFFF)
        else listOf(0x1C1B22, 0xC22F2F, 0x1E7F45, 0x8A6400, 0x2457C5, 0x8A3FB3, 0x0F7C86, 0x6B6977,
            0x55535F, 0xD93C3C, 0x23924F, 0x9E7300, 0x2E66DB, 0x9C4CC7, 0x138C97, 0x2A2932)
        ).map { Color(0xFF000000 or it.toLong()) }

    fun of(c: TermColor): Color? = when (c) {
        TermColor.Default -> null
        is TermColor.Rgb -> Color(c.r, c.g, c.b)
        is TermColor.Palette -> when {
            c.index < 16 -> ansi[c.index]
            c.index < 232 -> {
                // The 6×6×6 cube.
                val v = c.index - 16
                val steps = intArrayOf(0, 95, 135, 175, 215, 255)
                Color(steps[v / 36], steps[(v / 6) % 6], steps[v % 6])
            }
            else -> (8 + (c.index - 232) * 10).let { Color(it, it, it) }
        }
    }
}

private fun annotated(l: TermLine, colors: TerminalColors): AnnotatedString = buildAnnotatedString {
    if (l.runs.isEmpty()) {
        append(" ")
        return@buildAnnotatedString
    }
    for (run in l.runs) {
        val s = run.style
        var fg = colors.of(s.fg) ?: colors.ink
        var bg = colors.of(s.bg)
        if (s.inverse) {
            val f = fg
            fg = bg ?: colors.background
            bg = f
        }
        withStyle(
            SpanStyle(
                color = if (s.dim) fg.copy(alpha = 0.6f) else fg,
                background = bg ?: Color.Unspecified,
                fontWeight = if (s.bold) FontWeight.Bold else null,
                fontStyle = if (s.italic) FontStyle.Italic else null,
                textDecoration = when {
                    s.underline && s.strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
                    s.underline -> TextDecoration.Underline
                    s.strike -> TextDecoration.LineThrough
                    else -> null
                },
            ),
        ) { append(run.text) }
    }
}
