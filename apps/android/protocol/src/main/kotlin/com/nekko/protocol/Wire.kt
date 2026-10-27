package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The slice of the host's IPC surface the phone uses. Channel names mirror
 * `packages/shared/src/ipc.ts` and are pinned by `WireTest` against that file.
 *
 * Decoding is deliberately hand-written over [JsonElement] narrow projections:
 * the host sends far more than the phone reads, adds fields over time, and
 * `providers:list` / `settings:get` carry secrets that must never be decoded
 * into app state.
 */
object Channels {
    const val SETTINGS_GET = "settings:get"
    /** Only the phone-settable keys (the computer's PHONE_SETTINGS_KEYS); anything else is refused. */
    const val SETTINGS_UPDATE = "settings:update"
    const val PROVIDERS_LIST = "providers:list"
    const val MODELS_LIST = "models:list"
    const val SESSIONS_SUMMARIES = "sessions:summaries"
    const val SESSION_CREATE = "session:create"
    const val SESSION_GET = "session:get"
    const val SESSION_SET_OPTIONS = "session:setOptions"
    const val SESSION_DELETE = "session:delete"
    /** The computer's Nekko Voice: installed? (A phone may read it, never install or remove it.) */
    const val VOICE_STATUS = "voice:status"
    /** A mono 16 kHz 16-bit PCM WAV as a JSON array of byte values → the text. */
    const val VOICE_TRANSCRIBE = "voice:transcribe"
    const val CHAT_SEND = "chat:send"
    const val CHAT_ABORT = "chat:abort"
    const val CHAT_QUEUE = "chat:queue"
    const val CHAT_PENDING = "chat:pending"
    const val CHAT_ANSWER = "chat:answer"
    /** Change or remove a queued prompt, only while it still reads what the phone showed ([QueuedPrompt.edit]). */
    const val CHAT_EDIT_QUEUED = "chat:editQueued"
    /** A new chat from this one, before a prompt or after a reply: answers its id and title. */
    const val SESSION_FORK = "session:fork"
    /** A chat's or saved folder's files ([FilesRequest]): list, search and read; a save is a signed Change. */
    const val FILES_LIST = "files:list"
    const val FILES_SEARCH = "files:search"
    const val FILES_READ = "files:read"
    const val FILES_WRITE = "files:write"
    /** Save or forget a folder on the computer (signed Changes); forgetting never deletes files. */
    const val WORKSPACE_ADD_BY_PATH = "workspace:addByPath"
    const val WORKSPACE_REMOVE = "workspace:remove"
    const val LOGS_LIST = "logs:list"
    const val LOGS_READ = "logs:read"
    const val ARTIFACT_READ = "artifact:read"
    const val PREVIEW_FETCH = "preview:fetch"
    const val PROVIDERS_SEAL_KEY = "providers:sealKey"
    const val PROVIDERS_SAVE_SEALED = "providers:saveSealed"
    const val PROVIDERS_SET_ENABLED = "providers:setEnabled"

    /** The computer's automations ([AutomationTask], [AutomationWorkflow]): read, and Run now only. */
    const val TASKS_LIST = "tasks:list"
    const val TASK_RUN_NOW = "task:runNow"
    const val WORKFLOWS_LIST = "workflows:list"
    const val WORKFLOW_RUN = "workflow:run"
    /** Provider usage ([UsageSummary]) and one provider's plan limits by id ([ProviderLimits]); read only. */
    const val USAGE_SUMMARY = "usage:summary"
    const val LIMITS_GET = "limits:get"
    const val TOOL_APPROVE = "tool:approve"
    const val WORKSPACE_LIST = "workspace:list"
    const val APP_INFO = "app:info"
    /** The skills a chat on the computer can run: names and descriptions only, never templates. */
    const val SKILLS_RUNNABLE = "skills:runnable"
    /** What the agent changed in a chat, as a capped read-only diff ([PhoneChanges]); refused unless the computer allows it. */
    const val CHANGES_LIST = "changes:list"
    /** The Monitors pane: hardware, running chats, what needs the owner, next automations ([MonitorSummary]); read class. */
    const val MONITOR_SUMMARY = "monitor:summary"
    /** The Expert monitor ([SystemStats], [GpuStats], [EngineStatus]) and a chat's context totals ([ContextUsage]); read class. */
    const val SYSTEM_STATS = "system:stats"
    const val GPU_STATS = "gpu:stats"
    const val ENGINE_STATUS = "engine:status"
    const val CONTEXT_PREVIEW = "context:preview"
    /** Agent class without a proof: unloading frees memory, and the next reply loads the model again. */
    const val MODEL_UNLOAD = "model:unload"
    /** SK-7: a single-use step-up challenge and the kinds of method registered ([StepUpChallenge]). Read class. */
    const val SECURITY_CHALLENGE = StepUp.CHALLENGE_CHANNEL
    /**
     * SK-3 safety exits: agent class, but no switch, proof or step-up gates
     * them (decision 0018). Sign this phone out (the computer revokes and
     * kicks it), turn remote access off on the computer, quit Nekko Agent
     * there (refused `quit-disabled` unless `app:info` says `quitFromPhone`).
     */
    const val DEVICE_SIGN_OUT = "device:signOut"
    const val REMOTE_STOP = "remote:stop"
    const val APP_QUIT = "app:quit"

    /** AN-30 git on a chat's folder ([GitRequest]): reads, then Change actions (signed). */
    const val WORKSPACE_GIT_STATUS = "workspace:gitStatus"
    const val GIT_DIFF = "git:diff"
    const val GIT_LOG = "git:log"
    const val GIT_SHOW = "git:show"
    const val GIT_BRANCHES = "git:branches"
    const val GIT_COMPARE = "git:compare"
    const val GIT_STAGE = "git:stage"
    const val GIT_UNSTAGE = "git:unstage"
    const val GIT_COMMIT = "git:commit"
    /** A message for what is staged, written by the computer's model: a Change, it spends its tokens. */
    const val GIT_COMMIT_MESSAGE = "git:commitMessage"
    const val GIT_PUSH = "git:push"
    const val GIT_SWITCH = "git:switch"
    const val GIT_MERGE_ABORT = "git:mergeAbort"
    /** A chat's pull requests with their state and checks ([PullRequest]); read class. */
    const val PR_SESSION_LIST = "pr:sessionList"
    const val PR_CHECKS = "pr:checks"
    const val PR_DIFF = "pr:diff"
    /** Open a pull request from the chat's branch (pushed first when it has no upstream). */
    const val PR_CREATE = "pr:create"
    /** Approve, merge, close or reopen a pull request ([PrAction]). */
    const val PR_ACTION = "pr:action"

    /** The git channels the computer treats as Change (`PHONE_CHANGE_CHANNELS`): each one is signed. */
    val GIT_CHANGE = setOf(GIT_STAGE, GIT_UNSTAGE, GIT_COMMIT, GIT_COMMIT_MESSAGE, GIT_PUSH, GIT_SWITCH, GIT_MERGE_ABORT, PR_CREATE, PR_ACTION)

    /** Every Change channel this phone calls ([ChangeProof]). */
    val CHANGE = GIT_CHANGE + TerminalChannels.CHANGE + setOf(FILES_WRITE, WORKSPACE_ADD_BY_PATH, WORKSPACE_REMOVE, PROVIDERS_SAVE_SEALED, PROVIDERS_SET_ENABLED)

    val ALL = listOf(
        SETTINGS_GET, SETTINGS_UPDATE, SESSION_DELETE, VOICE_STATUS, VOICE_TRANSCRIBE, PROVIDERS_LIST, MODELS_LIST, SESSIONS_SUMMARIES, SESSION_CREATE, SESSION_GET,
        SESSION_SET_OPTIONS, CHAT_SEND, CHAT_ABORT, CHAT_QUEUE, CHAT_PENDING, CHAT_ANSWER, TOOL_APPROVE,
        WORKSPACE_LIST, APP_INFO, SKILLS_RUNNABLE, CHANGES_LIST, MONITOR_SUMMARY,
        SYSTEM_STATS, GPU_STATS, ENGINE_STATUS, CONTEXT_PREVIEW, MODEL_UNLOAD,
        SECURITY_CHALLENGE, DEVICE_SIGN_OUT, REMOTE_STOP, APP_QUIT,
        FILES_LIST, FILES_SEARCH, FILES_READ, FILES_WRITE, WORKSPACE_ADD_BY_PATH, WORKSPACE_REMOVE, LOGS_LIST, LOGS_READ, ARTIFACT_READ, PREVIEW_FETCH,
        PROVIDERS_SEAL_KEY, PROVIDERS_SAVE_SEALED, PROVIDERS_SET_ENABLED,
        CHAT_EDIT_QUEUED, SESSION_FORK, TASKS_LIST, TASK_RUN_NOW, WORKFLOWS_LIST, WORKFLOW_RUN, USAGE_SUMMARY, LIMITS_GET,
        WORKSPACE_GIT_STATUS, GIT_DIFF, GIT_LOG, GIT_SHOW, GIT_BRANCHES, GIT_COMPARE,
        GIT_STAGE, GIT_UNSTAGE, GIT_COMMIT, GIT_COMMIT_MESSAGE, GIT_PUSH, GIT_SWITCH, GIT_MERGE_ABORT,
        PR_SESSION_LIST, PR_CHECKS, PR_DIFF, PR_CREATE, PR_ACTION,
    ) + TerminalChannels.ALL
}

object Events {
    const val AGENT_EVENT = "agent:event"
    /** The desktop's theme changed (`IpcEvents.appearanceUpdated`); payload is an [Appearance]. */
    const val APPEARANCE_UPDATED = "appearance:updated"
}

/** `sendChat` errors unless the session names a concrete, enabled model. */
const val AUTO_MODEL_ID = "__auto__"

val WireJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject
internal fun JsonElement?.arr(): JsonArray? = this as? JsonArray
internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
internal fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
internal fun JsonObject.dbl(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
internal fun JsonObject.bool(k: String): Boolean = (this[k] as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.isSet(k: String): Boolean = this[k] != null && this[k] !is JsonNull

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

data class ToolCall(val id: String, val name: String, val input: JsonObject) {
    companion object {
        fun from(e: JsonElement?): ToolCall? {
            val o = e.obj() ?: return null
            return ToolCall(o.str("id") ?: return null, o.str("name") ?: return null, o["input"].obj() ?: JsonObject(emptyMap()))
        }
    }
}

/**
 * A tool's result. [outputChars] is the original length when the computer cut
 * the output for the phone (`truncated`), [omittedImages] the screenshots it
 * left out (see PHONE_SESSION_VIEW in packages/shared/src/phone-access.ts).
 */
data class ToolResult(
    val toolCallId: String,
    val output: String,
    val isError: Boolean,
    val outputChars: Int? = null,
    val omittedImages: Int = 0,
) {
    companion object {
        fun from(e: JsonElement?): ToolResult? {
            val o = e.obj() ?: return null
            val output = when (val v = o["output"]) {
                is JsonPrimitive -> v.contentOrNull ?: ""
                null, JsonNull -> ""
                else -> v.toString()
            }
            return ToolResult(
                o.str("toolCallId") ?: return null,
                output,
                o.bool("isError"),
                outputChars = o.long("outputChars")?.toInt()?.takeIf { o.bool("truncated") && it > output.length },
                omittedImages = o.long("omittedImages")?.toInt()?.coerceAtLeast(0) ?: 0,
            )
        }
    }
}

data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val reasoning: String? = null,
    val createdAt: Long? = null,
    /** The message's photos as the computer sent them to the phone: small JPEG data URLs, `""` for one not sent. */
    val images: List<String> = emptyList(),
    val skill: Pair<String, String>? = null,
    val toolCalls: List<ToolCall> = emptyList(),
    val toolResult: ToolResult? = null,
    val interrupted: Boolean = false,
) {
    val imageCount: Int get() = images.size

    companion object {
        fun from(e: JsonElement?): ChatMessage? {
            val o = e.obj() ?: return null
            val skill = o["skill"].obj()?.let { s -> (s.str("name") ?: return@let null) to (s.str("input") ?: "") }
            return ChatMessage(
                id = o.str("id") ?: return null,
                role = o.str("role") ?: return null,
                content = o.str("content") ?: "",
                reasoning = o.str("reasoning"),
                createdAt = o.long("createdAt"),
                images = o["images"].arr()?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: "" } ?: emptyList(),
                skill = skill,
                toolCalls = o["toolCalls"].arr()?.mapNotNull { ToolCall.from(it) } ?: emptyList(),
                toolResult = ToolResult.from(o["toolResult"]),
                interrupted = o.bool("interrupted"),
            )
        }
    }
}

data class Session(
    val id: String,
    val title: String,
    val providerId: String?,
    val modelId: String?,
    val workspaceId: String?,
    val messages: List<ChatMessage>,
    /** Older messages the computer kept back from the phone (only the newest are sent). */
    val omittedMessages: Int = 0,
    val queue: List<String>,
    val updatedAt: Long,
    /** The chat's effort (`EffortLevel`); null follows the computer's setting. */
    val effort: String? = null,
    /** The queue as the computer holds it: what `chat:editQueued` checks against. */
    val queued: List<QueuedPrompt> = emptyList(),
) {
    companion object {
        fun from(e: JsonElement?): Session? {
            val o = e.obj() ?: return null
            return Session(
                id = o.str("id") ?: return null,
                title = o.str("title") ?: "",
                providerId = o.str("providerId"),
                modelId = o.str("modelId"),
                workspaceId = o.str("workspaceId"),
                messages = o["messages"].arr()?.mapNotNull { ChatMessage.from(it) } ?: emptyList(),
                omittedMessages = o.long("omittedMessages")?.toInt()?.coerceAtLeast(0) ?: 0,
                // Queue entries may be plain strings or {text, images, skill}; a skill's shows as `/name input`.
                queue = QueuedPrompt.list(o["queue"]).map { it.shown },
                updatedAt = o.long("updatedAt") ?: 0,
                effort = o.str("effort"),
                queued = QueuedPrompt.list(o["queue"]),
            )
        }
    }
}

data class SessionSummary(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val modelId: String?,
    val lastReplyText: String?,
    val firstUserText: String?,
    val archived: Boolean,
    val parentSessionId: String?,
    val taskId: String?,
    val trainingRunId: String?,
    val providerId: String? = null,
    /** The project folder the chat belongs to (`workspace:list` id); null for General. */
    val workspaceId: String? = null,
    /** When the chat was completed (the desktop's archive); null while it is active. */
    val archivedAt: Long? = null,
    /** Manual position from the desktop sidebar's drag order; null when never dragged. */
    val order: Double? = null,
    val activeWatchCount: Long = 0,
) {
    /** Real, top-level chats, active or completed: what the phone's list shows. */
    val isVisible: Boolean get() = parentSessionId == null && taskId == null && trainingRunId == null

    companion object {
        fun from(e: JsonElement?): SessionSummary? {
            val o = e.obj() ?: return null
            val archivedAt = o.long("archivedAt")?.takeIf { it != 0L }
            return SessionSummary(
                id = o.str("id") ?: return null,
                title = o.str("title") ?: "",
                updatedAt = o.long("updatedAt") ?: 0,
                modelId = o.str("modelId"),
                lastReplyText = o.str("lastReplyText"),
                firstUserText = o.str("firstUserText"),
                archived = archivedAt != null,
                parentSessionId = o.str("parentSessionId"),
                taskId = o.str("taskId"),
                trainingRunId = o.str("trainingRunId"),
                providerId = o.str("providerId"),
                workspaceId = o.str("workspaceId"),
                archivedAt = archivedAt,
                order = o.dbl("order"),
                activeWatchCount = o.long("activeWatchCount") ?: 0,
            )
        }

        /** Every top-level chat, completed ones included, newest first. */
        fun visible(list: JsonElement?): List<SessionSummary> =
            list.arr()?.mapNotNull { from(it) }?.filter { it.isVisible }?.sortedByDescending { it.updatedAt } ?: emptyList()
    }
}

/**
 * One group of the chat list, as the desktop's agent sidebar draws it
 * (apps/desktop/src/renderer/views/WorkspacesView.tsx): General for chats in
 * no known folder, then one per project folder in the computer's order.
 */
data class ChatGroup(
    /** [GENERAL] or the folder's id. */
    val key: String,
    val name: String,
    /** Active chats: dragged ones in their manual order first, then most recent. */
    val active: List<SessionSummary>,
    /** Completed chats, most recently completed first. */
    val completed: List<SessionSummary>,
) {
    companion object {
        const val GENERAL = "__none"

        /**
         * Split [chats] into the desktop's groups. General comes first and is
         * left out when it has nothing in it; a folder is listed even when empty,
         * as the desktop lists it ("No active agents").
         */
        fun of(chats: List<SessionSummary>, folders: List<WorkspaceFolder>): List<ChatGroup> {
            val known = folders.map { it.id }.toSet()
            val byGroup = chats.groupBy { s -> s.workspaceId?.takeIf { it in known } ?: GENERAL }
            fun group(key: String, name: String): ChatGroup {
                val all = byGroup[key].orEmpty()
                val active = all.filter { !it.archived }.sortedWith(
                    compareBy<SessionSummary> { it.order == null }
                        .thenBy { it.order ?: 0.0 }
                        .thenByDescending { it.updatedAt },
                )
                val completed = all.filter { it.archived }.sortedByDescending { it.archivedAt ?: 0L }
                return ChatGroup(key, name, active, completed)
            }
            val general = group(GENERAL, "General")
            return buildList {
                if (general.active.isNotEmpty() || general.completed.isNotEmpty()) add(general)
                folders.forEach { add(group(it.id, it.name)) }
            }
        }
    }
}

/** A provider as the phone keeps it: never the API key, base URL or token reference. */
data class PublicProvider(val id: String, val kind: String, val label: String, val enabled: Boolean) {
    companion object {
        fun list(e: JsonElement?): List<PublicProvider> = e.arr()?.mapNotNull { p ->
            val o = p.obj() ?: return@mapNotNull null
            PublicProvider(o.str("id") ?: return@mapNotNull null, o.str("kind") ?: "", o.str("label") ?: o.str("id")!!, o.bool("enabled"))
        } ?: emptyList()
    }
}

/** The settings fields the phone reads (`settings:get` returns far more, including secrets). */
data class RemoteDefaults(
    val defaultProviderId: String? = null,
    val defaultModelId: String? = null,
    /** The computer's starred models, as `providerId::modelId` (shared/settings.ts). */
    val favoriteModels: List<String> = emptyList(),
) {
    companion object {
        fun from(e: JsonElement?): RemoteDefaults {
            val o = e.obj() ?: return RemoteDefaults()
            val favorites = o["favoriteModels"].arr()?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
            return RemoteDefaults(o.str("defaultProviderId"), o.str("defaultModelId"), favorites)
        }
    }
}

/**
 * The computer's settings a phone may see and change (`settings:update` takes
 * exactly these keys from a phone; see packages/shared/src/phone-access.ts).
 * Each is null until the computer has answered.
 */
data class PcSettings(
    /** Tool policy for new chats: `ask`, `guardrails` or `yolo` (shared/chat.ts ChatMode). */
    val defaultChatMode: ChatMode? = null,
    /** The chat's main action: complete (archive) or delete. Unset on the computer means complete. */
    val chatPaneAction: ChatAction? = null,
    /** True when the computer deletes chats without asking first. Unset means it asks. */
    val skipDeleteConfirmation: Boolean? = null,
    /** False until the computer has answered `settings:get` (or `settings:update`) on this connection. */
    val known: Boolean = false,
    /** Nekko Voice switched on in the computer's Settings (`voice.enabled`). Read only here. */
    val voiceEnabled: Boolean = false,
    /** The computer lets phones read a chat's changes (`phoneChanges`). Set on the computer only. */
    val phoneChanges: Boolean = false,
    /** The prompts the user saved on the computer (`/` and the + menu offer them beside skills). */
    val prompts: List<SavedPrompt> = emptyList(),
    /** The computer's automations are paused (Settings → Automations there). */
    val automationsPaused: Boolean = false,
) {
    enum class ChatMode(val wire: String) {
        ASK("ask"), GUARDRAILS("guardrails"), YOLO("yolo");

        companion object {
            fun of(s: String?) = entries.firstOrNull { it.wire == s }
        }
    }

    enum class ChatAction(val wire: String) {
        COMPLETE("complete"), DELETE("delete");

        companion object {
            fun of(s: String?) = entries.firstOrNull { it.wire == s }
        }
    }

    /** What the computer actually does when a key is unset (shared/settings.ts defaults). */
    val effectiveMode: ChatMode get() = defaultChatMode ?: ChatMode.GUARDRAILS
    val effectiveAction: ChatAction get() = chatPaneAction ?: ChatAction.COMPLETE
    val confirmDelete: Boolean get() = skipDeleteConfirmation != true

    companion object {
        fun from(e: JsonElement?): PcSettings {
            val o = e.obj() ?: return PcSettings()
            return PcSettings(
                known = true,
                defaultChatMode = ChatMode.of(o.str("defaultChatMode")),
                chatPaneAction = ChatAction.of(o.str("chatPaneAction")),
                skipDeleteConfirmation = (o["skipDeleteConfirmation"] as? JsonPrimitive)?.booleanOrNull,
                voiceEnabled = o["voice"].obj()?.bool("enabled") == true,
                phoneChanges = o.bool("phoneChanges"),
                prompts = SavedPrompt.list(o["prompts"]),
                automationsPaused = o.bool("automationsPaused"),
            )
        }

        /** The `settings:update` patch for one change: never more than the phone-settable keys. */
        fun patch(mode: ChatMode? = null, action: ChatAction? = null, skipConfirm: Boolean? = null) = buildJsonObject {
            mode?.let { put("defaultChatMode", it.wire) }
            action?.let { put("chatPaneAction", it.wire) }
            skipConfirm?.let { put("skipDeleteConfirmation", it) }
        }
    }
}

/**
 * One chat's changes as the computer shows them to a phone (`phoneChangesView`,
 * packages/shared/src/phone-changes.ts): paths cut to their last two parts,
 * secret files counted but never shown, big files summarised.
 */
data class PhoneChanges(val files: List<File>, val omittedFiles: Int = 0) {
    enum class Kind { SAME, REMOVED, ADDED }

    /** [number] is the line in the new file, or in the old one for a removed line. */
    data class Line(val kind: Kind, val text: String, val number: Int)

    data class Hunk(val oldStart: Int, val newStart: Int, val lines: List<Line>) {
        companion object {
            /** Lines as the computer sent them (`' '`, `'-'` or `'+'` first), numbered from the starts. */
            fun of(oldStart: Int, newStart: Int, raw: List<String>): Hunk {
                var o = oldStart
                var n = newStart
                val lines = raw.map { r ->
                    val text = r.drop(1)
                    when (r.firstOrNull()) {
                        '-' -> Line(Kind.REMOVED, text, o++)
                        '+' -> Line(Kind.ADDED, text, n++)
                        else -> Line(Kind.SAME, text, n).also { o++; n++ }
                    }
                }
                return Hunk(oldStart, newStart, lines)
            }
        }
    }

    sealed interface Shown {
        data object Diff : Shown
        data object Hidden : Shown
        data object Binary : Shown
        data class TooLarge(val lines: Int) : Shown
    }

    data class File(
        val path: String,
        val added: Boolean,
        val linesAdded: Int,
        val linesRemoved: Int,
        val hunks: List<Hunk>,
        val shown: Shown,
    )

    val linesAdded: Int get() = files.sumOf { it.linesAdded }
    val linesRemoved: Int get() = files.sumOf { it.linesRemoved }

    companion object {
        /** Changed lines quoted at most, so a big hunk stays a short message. */
        const val QUOTE_LINES = 12

        /** What "Ask about this change" puts in the message box: the hunk's changed lines as a diff. Never sent on its own. */
        fun quote(file: File, hunk: Hunk): String {
            val changed = hunk.lines.filter { it.kind != Kind.SAME }
            val lo = changed.minOfOrNull { it.number }
            val hi = changed.maxOfOrNull { it.number }
            val range = when { lo == null -> ""; lo == hi -> " line $lo"; else -> " lines $lo–$hi" }
            val body = changed.take(QUOTE_LINES).map { (if (it.kind == Kind.ADDED) "+" else "-") + it.text } +
                (if (changed.size > QUOTE_LINES) listOf("… ${changed.size - QUOTE_LINES} more") else emptyList())
            return "About `${file.path}`$range:\n```diff\n${body.joinToString("\n")}\n```\n\n"
        }

        /** The same for a whole file. */
        fun quote(file: File): String =
            "About `${file.path}` (${if (file.added) "new, " else ""}+${file.linesAdded} −${file.linesRemoved}):\n\n"

        fun from(e: JsonElement?): PhoneChanges {
            val o = e.obj() ?: return PhoneChanges(emptyList())
            val files = o["files"].arr()?.mapNotNull { el ->
                val f = el.obj() ?: return@mapNotNull null
                val path = f.str("path") ?: return@mapNotNull null
                val shown = when {
                    f.bool("hidden") -> Shown.Hidden
                    f.bool("binary") -> Shown.Binary
                    f.bool("tooLarge") -> Shown.TooLarge((f.long("lines") ?: 0).toInt())
                    else -> Shown.Diff
                }
                val hunks = if (shown != Shown.Diff) emptyList() else f["hunks"].arr()?.mapNotNull { h ->
                    val ho = h.obj() ?: return@mapNotNull null
                    val os = ho.long("oldStart") ?: return@mapNotNull null
                    val ns = ho.long("newStart") ?: return@mapNotNull null
                    val raw = ho["lines"].arr()?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
                    Hunk.of(os.toInt(), ns.toInt(), raw)
                } ?: emptyList()
                File(
                    path = path,
                    added = f.str("status") == "added",
                    linesAdded = (f.long("added") ?: 0).toInt(),
                    linesRemoved = (f.long("removed") ?: 0).toInt(),
                    hunks = hunks,
                    shown = shown,
                )
            } ?: emptyList()
            return PhoneChanges(files, (o.long("omittedFiles") ?: 0).toInt())
        }
    }
}

/** The part of `voice:status` the phone needs: is Whisper on the computer installed. */
data class VoiceInstall(val installed: Boolean, val installing: Boolean) {
    companion object {
        fun from(e: JsonElement?): VoiceInstall {
            val o = e.obj() ?: return VoiceInstall(installed = false, installing = false)
            return VoiceInstall(o.bool("installed"), o.bool("installing"))
        }
    }
}

/** `voice:transcribe`'s one argument: the WAV bytes as numbers 0..255, as the desktop sends them. */
fun wavArg(wav: ByteArray): JsonArray = JsonArray(wav.map { JsonPrimitive(it.toInt() and 0xFF) })

/**
 * The desktop's look, as `appearanceOf` (packages/shared/src/themes.ts) builds
 * it for the `appearance:updated` event, or read from `settings:get`. Same
 * rules on both paths: the mode (anything unknown is system), a preset id, and
 * accents as `#rrggbb`.
 */
data class Appearance(
    val theme: ThemeMode = ThemeMode.SYSTEM,
    val preset: String? = null,
    val accent: Long? = null,
    val accent2: Long? = null,
) {
    enum class ThemeMode { SYSTEM, LIGHT, DARK }

    companion object {
        fun from(e: JsonElement?): Appearance {
            val o = e.obj() ?: return Appearance()
            val theme = when (o.str("theme")) {
                "light" -> ThemeMode.LIGHT
                "dark" -> ThemeMode.DARK
                else -> ThemeMode.SYSTEM
            }
            val preset = o.str("themePreset")?.takeIf { it.length in 1..32 && it.all { c -> c in 'a'..'z' || c in '0'..'9' || c == '-' } }
            return Appearance(theme, preset, hex(o.str("accent")), hex(o.str("accent2")))
        }

        /** `#rrggbb` as an opaque ARGB value, else null. */
        fun hex(v: String?): Long? {
            if (v == null || v.length != 7 || v[0] != '#') return null
            val rgb = v.substring(1).toLongOrNull(16) ?: return null
            return 0xFF000000L or rgb
        }
    }
}

data class ModelInfo(val id: String, val providerId: String, val name: String, val loaded: Boolean) {
    companion object {
        fun list(e: JsonElement?): List<ModelInfo> = e.arr()?.mapNotNull { m ->
            val o = m.obj() ?: return@mapNotNull null
            val id = o.str("id") ?: return@mapNotNull null
            ModelInfo(id, o.str("providerId") ?: "", o.str("name")?.ifBlank { null } ?: id, o.bool("loaded"))
        } ?: emptyList()
    }
}

data class WorkspaceFolder(
    val id: String,
    val name: String,
    /** Where it is on the computer, shown under Files; never sent back by the phone. */
    val path: String? = null,
) {
    companion object {
        fun list(e: JsonElement?): List<WorkspaceFolder> = e.arr()?.mapNotNull { w ->
            val o = w.obj() ?: return@mapNotNull null
            WorkspaceFolder(o.str("id") ?: return@mapNotNull null, o.str("name") ?: "Folder", o.str("path"))
        } ?: emptyList()
    }
}

/**
 * `app:info`. [quitFromPhone] is the computer's *Quit from a phone* switch
 * (SK-3): only then does the phone offer *Quit Nekko Agent on the computer*.
 * Absent (an older computer) reads as off.
 */
data class AppInfo(val version: String?, val platform: String?, val quitFromPhone: Boolean = false) {
    companion object {
        fun from(e: JsonElement?): AppInfo = e.obj().let { AppInfo(it?.str("version"), it?.str("platform"), it?.bool("quitFromPhone") == true) }
    }
}

// ---------------------------------------------------------------------------
// Ask / approvals
// ---------------------------------------------------------------------------

data class AskOption(val label: String, val description: String?)
data class AskQuestion(val id: String, val header: String, val question: String, val options: List<AskOption>, val multiSelect: Boolean)
data class AskRequest(val callId: String, val questions: List<AskQuestion>, val askedAt: Long) {
    companion object {
        fun from(e: JsonElement?): AskRequest? {
            val o = e.obj() ?: return null
            val qs = o["questions"].arr()?.mapNotNull { q ->
                val qo = q.obj() ?: return@mapNotNull null
                AskQuestion(
                    id = qo.str("id") ?: return@mapNotNull null,
                    header = qo.str("header") ?: "",
                    question = qo.str("question") ?: "",
                    options = qo["options"].arr()?.mapNotNull { op ->
                        op.obj()?.let { oo -> oo.str("label")?.let { AskOption(it, oo.str("description")) } }
                    } ?: emptyList(),
                    multiSelect = qo.bool("multiSelect"),
                )
            } ?: emptyList()
            return AskRequest(o.str("callId") ?: return null, qs, o.long("askedAt") ?: 0)
        }
    }
}

/** The label every question carries for an answer that isn't on the list (shared/ask.ts). */
const val ASK_OTHER_LABEL = "Something else"

data class AskAnswer(val questionId: String, val labels: List<String>, val note: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("questionId", questionId)
        put("labels", buildJsonArray { labels.forEach { add(JsonPrimitive(it)) } })
        note?.takeIf { it.isNotBlank() }?.let { put("note", it) }
    }
}

enum class Severity { LOW, MEDIUM, HIGH;
    companion object { fun parse(s: String?) = when (s) { "high" -> HIGH; "medium" -> MEDIUM; else -> LOW } }
}

data class Approval(val call: ToolCall, val reason: String, val severity: Severity)

data class PendingInput(val sessionId: String, val approval: Approval?, val question: AskRequest?) {
    companion object {
        /** `chat:pending` → `Record<sessionId, PendingInput>`. */
        fun map(e: JsonElement?): Map<String, PendingInput> = e.obj()?.mapNotNull { (sid, v) ->
            val o = v.obj() ?: return@mapNotNull null
            val a = o["approval"].obj()?.let { ao ->
                ToolCall.from(ao["call"])?.let { Approval(it, ao.str("reason") ?: "", Severity.parse(ao.str("severity"))) }
            }
            sid to PendingInput(sid, a, AskRequest.from(o["question"]))
        }?.toMap() ?: emptyMap()
    }
}

// ---------------------------------------------------------------------------
// Agent events (shared/chat.ts AgentEvent); unknown types decode to Other.
// ---------------------------------------------------------------------------

sealed interface AgentEvent {
    val sessionId: String

    data class Text(override val sessionId: String, val delta: String) : AgentEvent
    data class Reasoning(override val sessionId: String, val delta: String) : AgentEvent
    data class ToolCallStarted(override val sessionId: String, val call: ToolCall) : AgentEvent
    data class ApprovalRequired(override val sessionId: String, val approval: Approval) : AgentEvent
    data class ToolResultReady(override val sessionId: String, val result: ToolResult) : AgentEvent
    data class Question(override val sessionId: String, val request: AskRequest) : AgentEvent
    data class QuestionResolved(override val sessionId: String, val callId: String) : AgentEvent
    data class Usage(override val sessionId: String, val outputTokens: Long, val outputMs: Long?) : AgentEvent
    data class Retry(override val sessionId: String) : AgentEvent
    data class Done(override val sessionId: String, val messageId: String?) : AgentEvent
    data class Error(override val sessionId: String, val message: String) : AgentEvent
    data class SessionMeta(override val sessionId: String) : AgentEvent
    data class Other(override val sessionId: String, val type: String) : AgentEvent

    companion object {
        fun from(e: JsonElement?): AgentEvent? {
            val o = e.obj() ?: return null
            val sid = o.str("sessionId") ?: return null
            return when (val t = o.str("type")) {
                "text" -> Text(sid, o.str("delta") ?: "")
                "reasoning" -> Reasoning(sid, o.str("delta") ?: "")
                "tool_call" -> ToolCallStarted(sid, ToolCall.from(o["call"]) ?: return null)
                "tool_approval_required" -> ApprovalRequired(
                    sid, Approval(ToolCall.from(o["call"]) ?: return null, o.str("reason") ?: "", Severity.parse(o.str("severity"))),
                )
                "tool_result" -> ToolResultReady(sid, ToolResult.from(o["result"]) ?: return null)
                "question" -> Question(sid, AskRequest.from(o["request"]) ?: return null)
                "question_resolved" -> QuestionResolved(sid, o.str("callId") ?: return null)
                "usage" -> Usage(sid, o.long("outputTokens") ?: 0, o.long("outputMs"))
                "retry" -> Retry(sid)
                "done" -> Done(sid, o.str("messageId"))
                "error" -> Error(sid, o.str("message") ?: "Something went wrong.")
                "session_meta" -> SessionMeta(sid)
                null -> null
                else -> Other(sid, t)
            }
        }
    }
}

/**
 * A skill the computer can run, as `skills:runnable` gives it to a phone. The
 * computer keeps the instructions: a skill turn sends just the name and the
 * user's input, and the computer expands it the way the desktop does.
 */
data class SkillSummary(
    val name: String,
    val description: String,
    val category: String,
    /** `builtin`, `marketplace`, or the tool it was imported from (`claude`, `codex`, `gemini`, `agents`). */
    val source: String,
) {
    companion object {
        fun from(e: JsonElement?): SkillSummary? {
            val o = e.obj() ?: return null
            val name = o.str("name")?.takeIf { it.isNotBlank() } ?: return null
            return SkillSummary(name, o.str("description") ?: "", o.str("category") ?: "", o.str("source") ?: "")
        }

        fun list(e: JsonElement?): List<SkillSummary> = e.arr()?.mapNotNull { from(it) } ?: emptyList()
    }
}

/** `{ name, input }`: which skill a turn runs and the user's own text after `/name`. */
fun skillCall(name: String, input: String): JsonObject = buildJsonObject {
    put("name", name)
    put("input", input)
}

/**
 * `chat:send` argument (SendOptions). Only the fields the phone uses.
 * [images] are `data:image/jpeg;base64,…` URLs, as the iPhone app sends them.
 */
fun sendOptions(
    sessionId: String,
    providerId: String,
    modelId: String,
    text: String,
    skill: SkillSummary? = null,
    images: List<String> = emptyList(),
): JsonObject = buildJsonObject {
    put("sessionId", sessionId)
    put("providerId", providerId)
    put("modelId", modelId)
    put("text", text)
    if (skill != null) put("skill", skillCall(skill.name, text))
    if (images.isNotEmpty()) put("images", JsonArray(images.map(::JsonPrimitive)))
}

/** `chat:queue` prompt: plain text, or `{ text, skill, images }` (the computer expands a skill). */
fun queuePrompt(text: String, skill: SkillSummary? = null, images: List<String> = emptyList()): JsonElement =
    if (skill == null && images.isEmpty()) JsonPrimitive(text) else buildJsonObject {
        put("text", text)
        if (skill != null) put("skill", skillCall(skill.name, text))
        if (images.isNotEmpty()) put("images", JsonArray(images.map(::JsonPrimitive)))
    }
