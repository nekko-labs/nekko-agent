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
import kotlinx.coroutines.flow.StateFlow

object Routes {
    const val CHATS = "chats"
    const val CHAT = "chat/{id}"
    const val NEW = "new"
    const val PAIR = "pair?link={link}"
    const val COMPUTERS = "computers"
    const val SETTINGS = "settings"
    const val LICENSES = "settings/licenses"

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
    val link by incomingLink.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        when (val l = link) {
            is DeepLink.Pair -> nav.navigate(Routes.pair(l.raw)) { launchSingleTop = true }
            is DeepLink.Chat -> nav.navigate(Routes.chat(l.id)) { launchSingleTop = true }
            // Over whatever is open; Back from New chat returns there.
            DeepLink.Share -> nav.navigate(Routes.NEW) { launchSingleTop = true }
            null -> return@LaunchedEffect
        }
        onLinkHandled()
    }

    NavHost(navController = nav, startDestination = Routes.CHATS) {
        composable(Routes.CHATS) {
            ChatsScreen(
                repo = repo,
                onOpenChat = { nav.navigate(Routes.chat(it)) },
                onNewChat = { nav.navigate(Routes.NEW) },
                onPair = { nav.navigate(Routes.pair()) },
                onComputers = { nav.navigate(Routes.COMPUTERS) },
                onSettings = { nav.navigate(Routes.SETTINGS) },
            )
        }
        composable(Routes.CHAT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
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
