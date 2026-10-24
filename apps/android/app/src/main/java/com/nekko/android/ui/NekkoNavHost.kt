package com.nekko.android.ui

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.nekko.android.DeepLink
import com.nekko.android.share.ShareInbox
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.NewChatDefaults
import com.nekko.android.voice.AndroidMic
import com.nekko.android.voice.Dictation
import com.nekko.android.data.PhonePrefs
import com.nekko.android.haptics.AndroidHaptics
import com.nekko.android.data.ThemePrefs
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.screens.ComputersScreen
import com.nekko.android.ui.screens.NewChatScreen
import com.nekko.android.ui.screens.PairScreen
import com.nekko.android.ui.screens.SettingsScreen
import com.nekko.android.ui.settings.LicensesScreen
import com.nekko.android.ui.settings.SettingsDeps
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.nekko.android.data.PaneLayouts
import com.nekko.android.monitors.MonitorsViewModel
import com.nekko.android.ui.panes.PaneChatChoice
import com.nekko.android.ui.panes.PaneLabels
import com.nekko.android.ui.panes.PaneSlot
import com.nekko.android.ui.panes.PanesHost
import com.nekko.android.ui.panes.PanesViewModel
import com.nekko.android.ui.panes.WindowPosture
import com.nekko.android.ui.panes.rememberWindowPosture
import com.nekko.android.ui.screens.MonitorsScreen
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.util.plainText
import com.nekko.protocol.Activity
import com.nekko.protocol.PaneContent
import com.nekko.protocol.PaneMode
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.StateFlow

object Routes {
    const val CHATS = "chats"
    const val CHAT = "chat/{id}"
    const val NEW = "new"
    const val PAIR = "pair?link={link}"
    const val COMPUTERS = "computers"
    const val SETTINGS = "settings"
    const val LICENSES = "settings/licenses"
    const val MONITORS = "monitors"

    fun chat(id: String) = "chat/${Uri.encode(id)}"
    fun pair(link: String? = null) = if (link == null) "pair" else "pair?link=${Uri.encode(link)}"
}

@Composable
fun NekkoNavHost(
    repo: ComputersRepository,
    themePrefs: ThemePrefs,
    phonePrefs: PhonePrefs,
    shareInbox: ShareInbox,
    haptics: AndroidHaptics? = null,
    incomingLink: StateFlow<DeepLink?>,
    onLinkHandled: () -> Unit,
    nav: NavHostController = rememberNavController(),
) {
    // Folding phones: closed is today's one-column app; open shows two panes (PanesHost).
    val window = rememberWindowPosture()
    val mode = window.mode
    val panes: PanesViewModel = viewModel(key = "panes") { PanesViewModel(PaneLayouts(phonePrefs)) }
    val activeId by remember(repo) { repo.state.map { it.activeId }.distinctUntilChanged() }.collectAsStateWithLifecycle(repo.state.value.activeId)
    LaunchedEffect(activeId) { panes.attach(activeId) }
    LaunchedEffect(mode) {
        val was = panes.onMode(mode)
        // Closing the phone returns to the one-column app on the pane that had the keyboard.
        if (was != null && was != PaneMode.ONE && mode == PaneMode.ONE && nav.currentDestination?.route == Routes.CHATS) {
            val l = panes.layout.value
            when (val c = l[l.zoomed ?: l.focused]) {
                is PaneContent.Chat -> c.id?.let { nav.navigate(Routes.chat(it)) }
                PaneContent.Monitors -> nav.navigate(Routes.MONITORS)
                PaneContent.Chats -> Unit
            }
        }
    }
    val paneLayout by panes.layout.collectAsStateWithLifecycle()
    // A chat or Monitors that left both panes stops listening; one that only moved keeps its state.
    LaunchedEffect(paneLayout.first.key, paneLayout.second.key) {
        panes.stores.keepOnly(setOf(paneLayout.first.key, paneLayout.second.key))
    }

    val link by incomingLink.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        when (val l = link) {
            is DeepLink.Pair -> nav.navigate(Routes.pair(l.raw)) { launchSingleTop = true }
            is DeepLink.Chat -> nav.navigate(Routes.chat(l.id)) { launchSingleTop = true }
            // Over whatever is open; Back from New chat returns there.
            DeepLink.Share, DeepLink.NewChat -> nav.navigate(Routes.NEW) { launchSingleTop = true }
            null -> return@LaunchedEffect
        }
        onLinkHandled()
    }

    NavHost(navController = nav, startDestination = Routes.CHATS) {
        composable(Routes.CHATS) {
            if (mode != PaneMode.ONE) {
                Panes(window, panes, repo, phonePrefs, shareInbox, nav)
                return@composable
            }
            ChatsScreen(
                repo = repo,
                onOpenChat = { nav.navigate(Routes.chat(it)) },
                onNewChat = { nav.navigate(Routes.NEW) },
                onPair = { nav.navigate(Routes.pair()) },
                onComputers = { nav.navigate(Routes.COMPUTERS) },
                onSettings = { nav.navigate(Routes.SETTINGS) },
                onMonitors = { nav.navigate(Routes.MONITORS) },
            )
        }
        composable(Routes.MONITORS) {
            if (mode != PaneMode.ONE) {
                // Opened (or the phone unfolded) on Monitors: it joins the panes beside the chat.
                LaunchedEffect(Unit) {
                    panes.update { l ->
                        if (l.first == PaneContent.Monitors || l.second == PaneContent.Monitors) l
                        else l.replace(if (l[l.focused] is PaneContent.Chat) l.focused.other else l.focused, PaneContent.Monitors)
                    }
                    nav.onMain { backToChats() }
                }
                return@composable
            }
            val vm = viewModel(key = "monitors") { MonitorsViewModel(repo) }
            MonitorsScreen(vm = vm, repo = repo, onOpenChat = { nav.navigate(Routes.chat(it)) }, onBack = { nav.popBackStack() })
        }
        composable(Routes.CHAT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            if (mode != PaneMode.ONE) {
                // A chat opened from a link, New chat, or the closed phone as it unfolds: into a chat pane.
                LaunchedEffect(id) {
                    val running = repo.state.value.activity.keys
                    panes.update(running) { it.open(id) }
                    nav.onMain { backToChats() }
                }
                return@composable
            }
            val context = LocalContext.current
            val vm = viewModel(key = "chat:$id") { ChatViewModel(id, repo, AndroidMic(context), phonePrefs) }
            // Text shared into a chat that was just created; taken once, never sent by itself.
            val draft = remember(id) { shareInbox.takeDraft(id) }
            val dictationOn by phonePrefs.flow(Dictation.ENABLED).collectAsStateWithLifecycle()
            ChatScreen(vm = vm, initialDraft = draft, dictationOn = dictationOn, onBack = { nav.popBackStack() })
        }
        composable(Routes.NEW) {
            // The phone's default model for the active computer (Settings → New chats).
            val defaults = remember(phonePrefs) { NewChatDefaults(phonePrefs) }
            val c by repo.state.collectAsStateWithLifecycle()
            val models by defaults.modelsFlow.collectAsStateWithLifecycle()
            val phonePick = remember(models, c.activeId) { c.activeId?.let(defaults::model) }
            // Text shared from another app (Share to Nekko), editable here, never sent by itself.
            val shared by shareInbox.shared.collectAsStateWithLifecycle()
            NewChatScreen(
                repo = repo,
                phonePick = phonePick,
                shared = shared,
                onEditShared = shareInbox::edit,
                onBack = {
                    shareInbox.clear()
                    nav.popBackStack()
                },
                onPair = { nav.navigate(Routes.pair()) },
                onCreated = { id ->
                    shareInbox.handOff(id)
                    nav.onMain { navigate(Routes.chat(id)) { popUpTo(Routes.NEW) { inclusive = true } } }
                },
            )
        }
        composable(
            Routes.PAIR,
            arguments = listOf(navArgument("link") { type = NavType.StringType; nullable = true; defaultValue = null }),
        ) { entry ->
            PairScreen(
                repo = repo,
                initialLink = entry.arguments?.getString("link"),
                onBack = { nav.popBackStack() },
                onPaired = { nav.onMain { backToChats() } },
            )
        }
        composable(Routes.SETTINGS) {
            val deps = remember(nav) {
                SettingsDeps(repo, themePrefs, phonePrefs, haptics, open = { route -> nav.navigate(route) { launchSingleTop = true } })
            }
            SettingsScreen(deps = deps, onBack = { nav.popBackStack() })
        }
        composable(Routes.LICENSES) {
            LicensesScreen(onBack = { nav.popBackStack() })
        }
        composable(Routes.COMPUTERS) {
            ComputersScreen(
                repo = repo,
                onBack = { nav.popBackStack() },
                onPair = { nav.navigate(Routes.pair()) },
            )
        }
    }
}

/**
 * The open folding phone's two panes (spec/phone/folding-phones-two-chats-and-monitors.md):
 * each pane holds the chat list, Monitors or a chat, the same screens as the closed
 * phone with the pane's header actions added. Two chat panes are two ChatViewModels,
 * each with its own ChatController, on the one connection the repository holds.
 */
@Composable
private fun Panes(
    window: WindowPosture,
    panes: PanesViewModel,
    repo: ComputersRepository,
    phonePrefs: PhonePrefs,
    shareInbox: ShareInbox,
    nav: NavHostController,
) {
    val layout by panes.layout.collectAsStateWithLifecycle()
    val tip by panes.tip.collectAsStateWithLifecycle()
    val s by repo.state.collectAsStateWithLifecycle()
    val noteDismissed by phonePrefs.flow(PaneLayouts.FOLDABLE_NOTE_DISMISSED).collectAsStateWithLifecycle()
    val dictationOn by phonePrefs.flow(Dictation.ENABLED).collectAsStateWithLifecycle()
    val context = LocalContext.current
    val running = s.activity.keys
    val waiting = remember(s.activity) { s.activity.filterValues { it == Activity.NEEDS_YOU }.keys }
    val titles = remember(s.summaries) { s.summaries.associate { it.id to plainText(it.title).ifEmpty { "New chat" } } }
    val chats = remember(s.summaries) {
        s.summaries.filter { it.archivedAt == null }.sortedByDescending { it.updatedAt }.map { PaneChatChoice(it.id, titles.getValue(it.id)) }
    }
    val labels = remember(titles) {
        PaneLabels { c ->
            when (c) {
                PaneContent.Chats -> "Chats"
                PaneContent.Monitors -> "Monitors"
                is PaneContent.Chat -> c.id?.let(titles::get) ?: "Chat"
            }
        }
    }
    PanesHost(
        window = window,
        layout = layout,
        onChange = { change -> panes.update(running, change) },
        labels = labels,
        chats = chats,
        waiting = waiting,
        tip = tip,
        onTakeTip = panes::takeTip,
        onDismissTip = panes::dismissTip,
        noteDismissed = noteDismissed,
        onDismissNote = { phonePrefs.set(PaneLayouts.FOLDABLE_NOTE_DISMISSED, true) },
    ) { slot ->
        when (val c = slot.content) {
            PaneContent.Chats -> ChatsScreen(
                repo = repo,
                onOpenChat = slot.open,
                onNewChat = { nav.navigate(Routes.NEW) },
                onPair = { nav.navigate(Routes.pair()) },
                onComputers = { nav.navigate(Routes.COMPUTERS) },
                onSettings = { nav.navigate(Routes.SETTINGS) },
                onMonitors = { panes.update(running) { l -> if (l[slot.side.other] == PaneContent.Monitors) l else l.replace(slot.side.other, PaneContent.Monitors) } },
                pane = slot,
            )
            PaneContent.Monitors -> {
                val vm = viewModel(viewModelStoreOwner = panes.stores.owner(c.key), key = c.key) { MonitorsViewModel(repo) }
                MonitorsScreen(vm = vm, repo = repo, onOpenChat = slot.open, pane = slot)
            }
            is PaneContent.Chat -> {
                val id = c.id
                if (id == null) {
                    EmptyChatPane(slot, onNewChat = { nav.navigate(Routes.NEW) })
                } else {
                    val vm = viewModel(viewModelStoreOwner = panes.stores.owner(c.key), key = c.key) {
                        ChatViewModel(id, repo, AndroidMic(context), phonePrefs)
                    }
                    // Text shared into a chat that was just created; taken once, never sent by itself.
                    val draft = remember(id) { shareInbox.takeDraft(id) }
                    ChatScreen(vm = vm, initialDraft = draft, dictationOn = dictationOn, onBack = slot.back, pane = slot)
                }
            }
        }
    }
}

/** A chat pane with nothing picked yet: say how to fill it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmptyChatPane(slot: PaneSlot, onNewChat: () -> Unit) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text("Chat", style = MaterialTheme.typography.titleMedium) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                actions = slot.actions,
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Open a chat from the list, or pick one with Replace with… above.",
                style = MaterialTheme.typography.bodyLarge,
                color = p.inkSoft,
                textAlign = TextAlign.Center,
            )
            OutlinedButton(onClick = onNewChat) { Text("New chat") }
        }
    }
}

/**
 * Navigation must run on the main thread. These callbacks come at the end of
 * suspend work (pairing, creating a chat), and a coroutine is not guaranteed to
 * resume on the main thread: under Compose UI tests the effect dispatcher
 * resumes wherever the last suspension finished, and navigating from there
 * threw "Method setCurrentState must be called on the main thread"
 * (the emulator journey, apps/android/scripts/emulator-journey.sh).
 */
private fun NavHostController.onMain(block: NavHostController.() -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else Handler(Looper.getMainLooper()).post { block() }
}

/** Back to the chat list, dropping whatever was stacked on top (pairing, settings). */
private fun NavHostController.backToChats() {
    if (!popBackStack(Routes.CHATS, inclusive = false)) {
        navigate(Routes.CHATS) { popUpTo(graph.id) { inclusive = true }; launchSingleTop = true }
    }
}
