package com.nekko.android.ui

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.nekko.android.DeepLink
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.screens.ComputersScreen
import com.nekko.android.ui.screens.NewChatScreen
import com.nekko.android.ui.screens.PairScreen
import kotlinx.coroutines.flow.StateFlow

object Routes {
    const val CHATS = "chats"
    const val CHAT = "chat/{id}"
    const val NEW = "new"
    const val PAIR = "pair?link={link}"
    const val COMPUTERS = "computers"

    fun chat(id: String) = "chat/${Uri.encode(id)}"
    fun pair(link: String? = null) = if (link == null) "pair" else "pair?link=${Uri.encode(link)}"
}

@Composable
fun NekkoNavHost(
    repo: ComputersRepository,
    incomingLink: StateFlow<DeepLink?>,
    onLinkHandled: () -> Unit,
    nav: NavHostController = rememberNavController(),
) {
    val link by incomingLink.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        when (val l = link) {
            is DeepLink.Pair -> nav.navigate(Routes.pair(l.raw)) { launchSingleTop = true }
            is DeepLink.Chat -> nav.navigate(Routes.chat(l.id)) { launchSingleTop = true }
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
            )
        }
        composable(Routes.CHAT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val vm = viewModel(key = "chat:$id") { ChatViewModel(id, repo) }
            ChatScreen(vm = vm, onBack = { nav.popBackStack() })
        }
        composable(Routes.NEW) {
            NewChatScreen(
                repo = repo,
                onBack = { nav.popBackStack() },
                onPair = { nav.navigate(Routes.pair()) },
                onCreated = { id ->
                    nav.navigate(Routes.chat(id)) { popUpTo(Routes.NEW) { inclusive = true } }
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
                onPaired = { nav.backToChats() },
            )
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

/** Back to the chat list, dropping whatever was stacked on top (pairing, settings). */
private fun NavHostController.backToChats() {
    if (!popBackStack(Routes.CHATS, inclusive = false)) {
        navigate(Routes.CHATS) { popUpTo(graph.id) { inclusive = true }; launchSingleTop = true }
    }
}
