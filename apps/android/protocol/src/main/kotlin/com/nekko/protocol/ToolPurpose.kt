package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * What a run of tool calls is for, so the transcript can fold adjacent calls
 * with one purpose into one card that says the goal ("Read the project's
 * guidance", "Edited 3 files", "Ran the tests").
 *
 * A port of `packages/shared/src/tool-purpose.ts`; all three classifiers (TS,
 * Swift `ToolPurpose.swift`, this) run `packages/shared/fixtures/tool-purpose.json`,
 * so change them together. Pure: no model call, nothing sent anywhere.
 * Spec: spec/chat/tool-calls-grouped-by-purpose.md.
 */
enum class ToolPurpose(val id: String) {
    GUIDANCE("guidance"), EXPLORE("explore"), EDIT("edit"), CHECK("check"), RUN("run"),
    GIT("git"), WEB("web"), PLAN("plan"), DELEGATE("delegate"), OTHER("other");

    companion object {
        fun of(id: String): ToolPurpose? = entries.firstOrNull { it.id == id }
    }
}

/** A call as grouping sees it: its name and input, and whether it failed. */
data class PurposeCall(val name: String, val input: JsonObject = JsonObject(emptyMap()), val failed: Boolean = false)

data class PurposeHeadline(val headline: String, val detail: String, val failed: Int)

/** How an item takes part in purpose grouping. */
sealed interface PurposeRole {
    /** A call; [standalone] keeps it out of every group (it waits for approval). */
    data class Call(val call: PurposeCall, val standalone: Boolean = false) : PurposeRole
    /** Something between calls (a thought) that folds in with same-purpose calls on both sides. */
    data object Between : PurposeRole
    /** Something that ends a group (a reply, a prompt). */
    data object Breaker : PurposeRole
}

/** One row of a grouped transcript: two or more adjacent same-purpose calls, or an item on its own. */
sealed interface PurposeRun<T> {
    data class Group<T>(val purpose: ToolPurpose, val items: List<T>, val calls: List<PurposeCall>) : PurposeRun<T>
    data class Single<T>(val item: T) : PurposeRun<T>
}

object Purpose {
    /** Tool names compared without case, `_`, `-` or spaces: `read_file`, `Read` and `ReadFile` alike. */
    private fun key(name: String) = name.lowercase().filter { it != '_' && it != '-' && !it.isWhitespace() }

    private val READ = setOf("readfile", "read", "view", "openfile", "notebookread", "readmanyfiles", "cat")
    private val LIST = setOf("listdir", "ls", "listdirectory", "listfiles")
    private val SEARCH = setOf("grep", "glob", "search", "find", "findfiles", "filesearch", "codebasesearch", "grepsearch", "searchfiles")
    private val EDIT = setOf(
        "writefile", "editfile", "write", "edit", "multiedit", "applypatch", "notebookedit", "createfile",
        "strreplace", "strreplaceeditor", "strreplacebasededittool", "deletefile", "patch",
    )
    private val SHELL = setOf(
        "bash", "shell", "runcommand", "runterminalcmd", "exec", "execcommand", "powershell", "terminal",
        "localshell", "runshellcommand", "startprocess", "readprocess", "killprocess", "bashoutput", "killshell", "killbash",
    )
    private val WEB_SEARCH = setOf("websearch", "searchweb", "googlesearch")
    private val WEB = WEB_SEARCH + setOf("webfetch", "fetchurl", "fetch", "browser", "browse")
    private val PLAN = setOf("updateplan", "todowrite", "todoread", "writetodos", "exitplanmode", "enterplanmode", "decide")
    private val DELEGATE = setOf("spawnagent", "task", "agent", "subagent", "dispatchagent", "delegationtargets")
    private val ASK = setOf("askuser", "askuserquestion", "askfollowupquestion")

    private fun isMcp(name: String) = name.startsWith("mcp__")

    /** A question for the person: never folded into a group, because it needs them. */
    fun needsUser(name: String) = key(name) in ASK

    private fun str(v: Any?): String? = ((v as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull)?.trim()?.ifEmpty { null }

    private val PATH_KEYS = listOf("file_path", "path", "file", "filename", "target_file", "notebook_path", "absolute_path", "relative_workspace_path", "dir", "directory")

    /** The paths a file tool names: its path arguments, else a glob's pattern. */
    private fun paths(call: PurposeCall): List<String> {
        val out = PATH_KEYS.mapNotNull { str(call.input[it]) }.toMutableList()
        (call.input["paths"] as? JsonArray)?.let { a -> out += a.mapNotNull { str(it) } }
        if (out.isEmpty() && key(call.name) == "glob") str(call.input["pattern"])?.let { out += it }
        return out
    }

    /** The last segment of a path, either separator. */
    fun leaf(path: String): String = path.split('/', '\\').lastOrNull { it.isNotEmpty() } ?: path

    private val GUIDE_FILES = setOf("agents.md", "claude.md", "claude.local.md", "gemini.md", "skill.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md")

    /** A file or folder that tells an agent how to work in the project. */
    fun isGuidancePath(path: String): Boolean {
        val segs = path.replace('\\', '/').lowercase().split('/').filter { it.isNotEmpty() }
        val base = segs.lastOrNull() ?: ""
        if (base in GUIDE_FILES) return true
        for (prefix in listOf("readme", "contributing")) {
            if (base.startsWith(prefix)) {
                val rest = base.substring(prefix.length)
                if (rest.isEmpty() || rest.startsWith(".")) return true
            }
        }
        val markdownOrFolder = base.endsWith(".md") || base.endsWith(".mdx") || '.' !in base
        for ((i, seg) in segs.withIndex()) {
            val next = segs.getOrNull(i + 1)
            if (seg == "docs" && (next == "runbooks" || next == "decisions") && markdownOrFolder) return true
            if (seg == "spec" && markdownOrFolder) return true
            if (seg == ".cursor" && next == "rules") return true
            // `.claude/worktrees/` holds whole checkouts, not instructions.
            if (seg == ".claude" && next != "worktrees") return true
            if (seg == ".github" && base.endsWith(".md")) return true
        }
        return false
    }

    /** The command a shell tool ran, as one string. Codex-style `["bash", "-lc", "…"]` arrays keep the script. */
    fun shellCommand(input: JsonObject): String {
        val raw = input["command"] ?: input["cmd"] ?: input["script"]
        (raw as? JsonPrimitive)?.takeIf { it.isString }?.let { return it.content.trim() }
        val array = raw as? JsonArray ?: return ""
        val words = array.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        if (words.size != array.size) return ""
        val flag = words.getOrNull(1)
        if (words.size >= 3 && flag != null && flag.startsWith("-") && flag.endsWith("c") && flag.drop(1).all { it.isLetterOrDigit() || it == '_' }) {
            return words.last().trim()
        }
        return words.joinToString(" ").trim()
    }

    private enum class ShellKind { GIT, CHECK, GUIDANCE, EXPLORE, RUN }

    private val WRAPPERS = setOf("sudo", "time", "env", "nohup", "command", "exec", "&", "call", "npx", "bunx", "pnpx")
    private val NOISE = setOf("cd", "pushd", "popd", "set-location", "sl", "export", "set", "source", ".", "echo", "write-host", "write-output", "true", ":", "sleep", "clear", "cls")
    private val CHECK_PROGS = setOf(
        "vitest", "jest", "pytest", "tsc", "vue-tsc", "eslint", "mypy", "ruff", "mocha", "rspec", "phpunit",
        "swiftlint", "ktlint", "golangci-lint", "biome", "playwright", "tox", "nox", "stylelint", "unittest",
    )
    private val SHOW_PROGS = setOf("cat", "head", "tail", "less", "more", "bat", "type", "get-content", "gc", "ls", "dir", "tree", "get-childitem", "gci")
    private val LOOK_PROGS = SHOW_PROGS + setOf("find", "fd", "rg", "grep", "ag", "ack", "wc", "select-string", "sls", "stat", "file", "realpath", "pwd", "which", "where", "get-item", "test-path", "du")
    private val SEARCH_PROGS = setOf("find", "fd", "rg", "grep", "ag", "ack", "select-string", "sls")
    private val PM = setOf("npm", "pnpm", "yarn", "bun")
    private val INSTALL = setOf("install", "i", "add", "ci", "uninstall", "remove", "rm", "update", "upgrade", "init", "create", "exec", "dlx")
    private val SCRIPTS = setOf("test", "t", "tests", "lint", "typecheck", "type-check", "build", "check", "verify", "e2e")

    /** `test`, `test:unit`, `lint:fix`: a package script that checks the code. */
    private fun isCheckScript(arg: String): Boolean {
        val head = arg.substringBefore(':')
        if (head !in SCRIPTS) return false
        if (head.length == arg.length) return true
        val tail = arg.substring(head.length + 1)
        return tail.isNotEmpty() && tail.all { it.isLetterOrDigit() || it == '_' || it == ':' || it == '.' || it == '-' }
    }

    private fun unquote(w: String) = w.trim('"', '\'')

    private fun isAssignment(w: String): Boolean {
        val eq = w.indexOf('=')
        if (eq <= 0) return false
        val name = w.substring(0, eq)
        return (name[0].isLetter() || name[0] == '_') && name.all { it.code < 128 && (it.isLetterOrDigit() || it == '_') }
    }

    /** The words of one command, with env assignments and wrappers (`sudo`, `npx`) taken off the front. */
    private fun words(segment: String): List<String> {
        val w = segment.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.map(::unquote).toMutableList()
        while (w.isNotEmpty()) {
            if (isAssignment(w[0])) {
                w.removeAt(0)
            } else if (w[0].lowercase() in WRAPPERS) {
                w.removeAt(0)
                while (w.isNotEmpty() && w[0].startsWith("-")) w.removeAt(0)
            } else break
        }
        return w
    }

    /** A program's bare name: `./node_modules/.bin/vitest`, `.\gradlew.bat` read as `vitest`, `gradlew`. */
    private fun progName(word: String): String {
        val name = leaf(word).lowercase()
        for (ext in listOf(".exe", ".cmd", ".bat", ".ps1", ".sh")) if (name.endsWith(ext)) return name.dropLast(ext.length)
        return name
    }

    private fun segmentKind(segment: String): ShellKind? {
        val w = words(segment)
        if (w.isEmpty()) return null
        val prog = progName(w[0])
        val args = w.drop(1)
        val lower = args.map { it.lowercase() }
        val plain = lower.filter { !it.startsWith("-") && !it.startsWith("+") }
        val first = plain.firstOrNull() ?: ""
        if (prog in NOISE) return null
        if (prog == "git" || prog == "gh") return ShellKind.GIT
        if (checkCommand(prog, lower, plain, first)) return ShellKind.CHECK
        if (prog in LOOK_PROGS) {
            // `cat > notes.md <<EOF` writes a file.
            if (args.any { it.startsWith(">") }) return ShellKind.RUN
            if (prog !in SHOW_PROGS) return ShellKind.EXPLORE
            val paths = args.filter { !it.startsWith("-") && !(it.isNotEmpty() && it.all(Char::isDigit)) }
            return if (paths.isNotEmpty() && paths.all(::isGuidancePath)) ShellKind.GUIDANCE else ShellKind.EXPLORE
        }
        return ShellKind.RUN
    }

    private fun checkCommand(prog: String, lower: List<String>, plain: List<String>, first: String): Boolean {
        if (prog in CHECK_PROGS) return true
        if (prog in PM) {
            if (first in INSTALL) return false
            return plain.any { isCheckScript(it) || it in CHECK_PROGS }
        }
        return when (prog) {
            "cargo" -> first in setOf("test", "build", "check", "clippy", "nextest", "bench")
            "go" -> first in setOf("test", "build", "vet")
            "swift", "dotnet" -> first in setOf("test", "build")
            "deno" -> first in setOf("test", "check", "lint")
            "mvn", "mvnw" -> plain.any { it in setOf("test", "verify", "package", "compile", "install") }
            "gradle", "gradlew" -> plain.any { a -> listOf("test", "build", "assemble", "lint", "check").any { a.contains(it) } }
            "make", "just" -> first.isEmpty() || first in setOf("test", "check", "build", "lint", "all")
            "xcodebuild" -> plain.any { it in setOf("test", "build", "build-for-testing", "test-without-building", "analyze") }
            "python", "python3", "py", "uv", "poetry", "pipenv" -> plain.any { it in CHECK_PROGS }
            "node" -> "--test" in lower
            else -> false
        }
    }

    /** The commands a shell line runs, split on `&&`, `||`, `;`, `|` and newlines. */
    private fun segments(command: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < command.length) {
            val c = command[i]
            val next = command.getOrNull(i + 1)
            if ((c == '&' && next == '&') || (c == '|' && next == '|')) {
                out += cur.toString(); cur.clear(); i += 2; continue
            }
            if (c == ';' || c == '|' || c == '\n') {
                out += cur.toString(); cur.clear(); i += 1; continue
            }
            cur.append(c)
            i++
        }
        out += cur.toString()
        return out.map { it.trim() }.filter { it.isNotEmpty() }
    }

    private fun shellPurpose(command: String): ToolPurpose {
        val kinds = segments(command).mapNotNull(::segmentKind)
        if (kinds.isEmpty()) return ToolPurpose.RUN
        if (kinds[0] == ShellKind.GIT) return ToolPurpose.GIT
        if (ShellKind.CHECK in kinds) return ToolPurpose.CHECK
        if (ShellKind.GIT in kinds) return ToolPurpose.GIT
        if (kinds.all { it == ShellKind.GUIDANCE }) return ToolPurpose.GUIDANCE
        if (kinds.all { it == ShellKind.GUIDANCE || it == ShellKind.EXPLORE }) return ToolPurpose.EXPLORE
        return ToolPurpose.RUN
    }

    /** What one call is for. */
    fun of(name: String, input: JsonObject): ToolPurpose {
        if (isMcp(name)) return ToolPurpose.OTHER
        val k = key(name)
        return when {
            k in DELEGATE -> ToolPurpose.DELEGATE
            k in PLAN -> ToolPurpose.PLAN
            k in WEB -> ToolPurpose.WEB
            k in EDIT -> ToolPurpose.EDIT
            k in READ || k in LIST || k in SEARCH -> {
                val p = paths(PurposeCall(name, input))
                if (p.isNotEmpty() && p.all(::isGuidancePath)) ToolPurpose.GUIDANCE else ToolPurpose.EXPLORE
            }
            k in SHELL -> shellPurpose(shellCommand(input))
            else -> ToolPurpose.OTHER
        }
    }

    /** The goal a call states for itself (Claude Code's Bash and Task send a short `description`). */
    fun goal(name: String, input: JsonObject): String {
        if (isMcp(name) || key(name) in EDIT) return ""
        val raw = (input["description"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: (input["intent"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        val text = raw.trim()
        if (text.isEmpty() || text.length > 120 || '\n' in text) return ""
        return text.split(Regex("\\s+")).joinToString(" ").trimEnd('.')
    }

    private fun cap(s: String) = s.replaceFirstChar { it.uppercase() }

    /** Up to three names in full; more than that is the first two and `+N`. */
    private fun nameList(names: List<String>): String {
        val distinct = names.distinct()
        if (distinct.size <= 3) return distinct.joinToString(", ")
        return distinct.take(2).joinToString(", ") + " +${distinct.size - 2}"
    }

    private fun oneLine(text: String, max: Int = 60): String {
        val flat = text.trim().split(Regex("\\s+")).joinToString(" ")
        return if (flat.length <= max) flat else flat.take(max - 1).trimEnd() + "…"
    }

    private fun plural(n: Int, one: String, many: String) = if (n == 1) one else "$n $many"

    private fun wordChar(c: Char) = c.isLetterOrDigit() || c == '_'

    /** `word` starts at a word boundary somewhere in [text] (JS `\bword`). */
    private fun hasWordStart(text: String, word: String): Boolean {
        var from = 0
        while (true) {
            val i = text.indexOf(word, from)
            if (i < 0) return false
            if (i == 0 || !wordChar(text[i - 1])) return true
            from = i + 1
        }
    }

    /** `word` stands alone somewhere in [text] (JS `\bword\b`). */
    private fun hasWord(text: String, word: String): Boolean {
        var from = 0
        while (true) {
            val i = text.indexOf(word, from)
            if (i < 0) return false
            val end = i + word.length
            if ((i == 0 || !wordChar(text[i - 1])) && (end == text.length || !wordChar(text[end]))) return true
            from = i + 1
        }
    }

    private fun checkKind(call: PurposeCall): String {
        val k = key(call.name)
        val text = if (k in SHELL) shellCommand(call.input).lowercase() else k
        if (hasWordStart(text, "test") || listOf("vitest", "jest", "pytest", "mocha", "rspec", "phpunit", "playwright", "unittest").any { it in text } || hasWord(text, "e2e")) return "test"
        if (hasWordStart(text, "build") || "assemble" in text || hasWord(text, "make") || "compile" in text || "package" in text) return "build"
        return "lint"
    }

    private val GIT_ACTIONS = mapOf(
        "commit" to ("committed" to "committing"),
        "push" to ("pushed" to "pushing"),
        "pull" to ("pulled" to "pulling"),
        "switch" to ("switched branches" to "switching branches"),
        "merge" to ("merged" to "merging"),
        "rebase" to ("rebased" to "rebasing"),
        "stash" to ("stashed changes" to "stashing changes"),
        "worktree" to ("set up a worktree" to "setting up a worktree"),
        "pr-create" to ("opened a PR" to "opening a PR"),
        "pr-merge" to ("queued the PR" to "queuing the PR"),
        "pr-read" to ("checked the PR" to "checking the PR"),
        "issue-create" to ("filed an issue" to "filing an issue"),
        "issue-read" to ("read the issues" to "reading the issues"),
        "add" to ("staged changes" to "staging changes"),
        "look" to ("checked the changes" to "checking the changes"),
        "other" to ("used git" to "using git"),
    )
    private val MINOR_GIT = setOf("add", "look", "other", "pr-read", "issue-read")

    private fun gitActions(calls: List<PurposeCall>): List<String> {
        val out = ArrayList<String>()
        for (call in calls) {
            for (seg in segments(shellCommand(call.input))) {
                val w = words(seg).map { it.lowercase() }
                val prog = w.firstOrNull()?.let(::progName) ?: ""
                if (prog != "git" && prog != "gh") continue
                var i = 1
                while (i < w.size && w[i].startsWith("-")) i += if (w[i] == "-c" || w[i] == "-C") 2 else 1
                val sub = w.getOrNull(i) ?: ""
                val obj = w.getOrNull(i + 1) ?: ""
                val action = if (prog == "gh") {
                    when (sub) {
                        "pr" -> when (obj) { "create" -> "pr-create"; "merge" -> "pr-merge"; else -> "pr-read" }
                        "issue" -> if (obj == "create") "issue-create" else "issue-read"
                        "run", "api" -> "pr-read"
                        else -> "other"
                    }
                } else when (sub) {
                    "commit", "push", "merge", "rebase", "stash", "worktree" -> sub
                    "pull", "fetch" -> "pull"
                    "checkout", "switch", "branch" -> "switch"
                    "add" -> "add"
                    "status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "remote" -> "look"
                    else -> "other"
                }
                if (action !in out) out += action
            }
        }
        val major = out.filter { it !in MINOR_GIT }
        if (major.isNotEmpty()) return major
        for (a in listOf("pr-read", "issue-read", "add", "look")) if (a in out) return listOf(a)
        return listOf("other")
    }

    private fun joinPhrases(parts: List<String>): String =
        if (parts.size <= 1) parts.firstOrNull() ?: "" else parts.dropLast(1).joinToString(", ") + " and " + parts.last()

    private fun distinctPaths(calls: List<PurposeCall>) = calls.flatMap(::paths).distinct()

    /** The purpose's own headline for these calls, ignoring any stated goal. */
    fun phrase(purpose: ToolPurpose, calls: List<PurposeCall>, running: Boolean = false): String {
        fun t(past: String, present: String) = if (running) present else past
        val n = calls.size
        return when (purpose) {
            ToolPurpose.GUIDANCE -> t("Read the project's guidance", "Reading the project's guidance")
            ToolPurpose.EXPLORE -> t("Looked through the code", "Looking through the code")
            ToolPurpose.EDIT -> {
                val files = distinctPaths(calls).size.takeIf { it > 0 } ?: n
                "${t("Edited", "Editing")} ${plural(files, "1 file", "files")}"
            }
            ToolPurpose.CHECK -> {
                val kinds = calls.map(::checkKind).toSet()
                when (kinds) {
                    setOf("test") -> t("Ran the tests", "Running the tests")
                    setOf("build") -> t("Built the app", "Building the app")
                    else -> t("Ran the checks", "Running the checks")
                }
            }
            ToolPurpose.RUN -> "${t("Ran", "Running")} ${plural(n, "a command", "commands")}"
            ToolPurpose.GIT -> cap(joinPhrases(gitActions(calls).map { GIT_ACTIONS.getValue(it).let { (past, present) -> if (running) present else past } }))
            ToolPurpose.WEB ->
                if (calls.any { key(it.name) in WEB_SEARCH }) t("Searched the web", "Searching the web")
                else "${t("Read", "Reading")} ${plural(n, "a page", "pages")}"
            ToolPurpose.PLAN -> t("Updated the plan", "Updating the plan")
            ToolPurpose.DELEGATE -> "${t("Delegated", "Delegating")} ${plural(n, "a task", "tasks")}"
            ToolPurpose.OTHER -> if (n == 1) "${t("Used", "Using")} ${calls[0].name}" else "${t("Used", "Using")} $n tools"
        }
    }

    private fun host(url: String): String {
        val sep = url.indexOf("://")
        if (sep <= 0) return url
        val scheme = url.substring(0, sep)
        if (!scheme[0].isLetter() || !scheme.all { it.isLetterOrDigit() || it == '+' || it == '.' || it == '-' }) return url
        val h = url.substring(sep + 3).takeWhile { it != '/' && it != '?' && it != '#' && !it.isWhitespace() }
        if (h.isEmpty()) return url
        return h.removePrefix("www.")
    }

    private fun detail(purpose: ToolPurpose, calls: List<PurposeCall>, running: Boolean): String = when (purpose) {
        ToolPurpose.GUIDANCE, ToolPurpose.EDIT -> nameList(distinctPaths(calls).map(::leaf))
        ToolPurpose.EXPLORE -> {
            var files = 0; var folders = 0; var searches = 0; var commands = 0
            for (c in calls) {
                val k = key(c.name)
                when {
                    k in READ -> files++
                    k in LIST -> folders++
                    k in SEARCH -> searches++
                    segments(shellCommand(c.input)).any { progName(words(it).firstOrNull() ?: "") in SEARCH_PROGS } -> searches++
                    else -> commands++
                }
            }
            listOfNotNull(
                files.takeIf { it > 0 }?.let { plural(it, "1 file", "files") },
                folders.takeIf { it > 0 }?.let { plural(it, "1 folder", "folders") },
                searches.takeIf { it > 0 }?.let { plural(it, "1 search", "searches") },
                commands.takeIf { it > 0 }?.let { plural(it, "1 command", "commands") },
            ).joinToString(", ")
        }
        ToolPurpose.CHECK -> {
            val failed = calls.count { it.failed }
            if (!running) { if (failed > 0) "$failed failed" else "passed" }
            else oneLine(shellCommand(calls[0].input).ifEmpty { calls[0].name })
        }
        ToolPurpose.RUN, ToolPurpose.GIT -> oneLine(shellCommand(calls[0].input))
        ToolPurpose.WEB -> calls.firstNotNullOfOrNull { str(it.input["query"]) }?.let { oneLine(it) }
            ?: nameList(calls.mapNotNull { str(it.input["url"]) }.map(::host))
        ToolPurpose.OTHER -> nameList(calls.map { it.name })
        ToolPurpose.PLAN, ToolPurpose.DELEGATE -> ""
    }

    /** The headline and detail line for a run of same-purpose calls; present tense while running. */
    fun headline(purpose: ToolPurpose, calls: List<PurposeCall>, running: Boolean = false): PurposeHeadline {
        val goals = calls.map { goal(it.name, it.input) }.filter { it.isNotEmpty() }.distinct()
        val head = when {
            goals.isEmpty() -> phrase(purpose, calls, running)
            goals.size > 1 -> "${goals[0]} and ${goals.size - 1} more"
            else -> goals[0]
        }
        val failed = calls.count { it.failed }
        var d = detail(purpose, calls, running)
        if (failed > 0 && !(purpose == ToolPurpose.CHECK && !running)) d = listOf(d, "$failed failed").filter { it.isNotEmpty() }.joinToString(" · ")
        return PurposeHeadline(head, d, failed)
    }

    /**
     * Fold adjacent same-purpose calls into groups, as `groupByPurpose` does in
     * TS. Questions and standalone calls stay single, and so does a group of one
     * call. Nothing is reordered or dropped.
     */
    fun <T> group(items: List<T>, role: (T) -> PurposeRole): List<PurposeRun<T>> {
        val out = ArrayList<PurposeRun<T>>()
        var purpose: ToolPurpose? = null
        val groupItems = ArrayList<T>()
        val groupCalls = ArrayList<PurposeCall>()
        val held = ArrayList<T>()
        fun flush() {
            if (purpose != null) {
                if (groupCalls.size > 1) out += PurposeRun.Group(purpose!!, groupItems.toList(), groupCalls.toList())
                else groupItems.forEach { out += PurposeRun.Single(it) }
                purpose = null; groupItems.clear(); groupCalls.clear()
            }
            held.forEach { out += PurposeRun.Single(it) }
            held.clear()
        }
        for (item in items) {
            when (val r = role(item)) {
                PurposeRole.Between -> if (purpose != null) held += item else out += PurposeRun.Single(item)
                PurposeRole.Breaker -> { flush(); out += PurposeRun.Single(item) }
                is PurposeRole.Call -> {
                    if (r.standalone || needsUser(r.call.name)) {
                        flush(); out += PurposeRun.Single(item); continue
                    }
                    val p = of(r.call.name, r.call.input)
                    if (purpose == p) {
                        groupItems += held; groupItems += item; groupCalls += r.call; held.clear()
                    } else {
                        flush()
                        purpose = p; groupItems += item; groupCalls += r.call
                    }
                }
            }
        }
        flush()
        return out
    }

    /**
     * A transcript block's part in grouping: a call waiting for approval stays
     * on its own, a thought with no reply text sits between calls, and a reply
     * or a prompt ends a group.
     */
    fun role(block: Block): PurposeRole = when (block) {
        is Block.Tool -> PurposeRole.Call(PurposeCall(block.name, block.input, block.status == ToolStatus.ERROR), standalone = block.status == ToolStatus.WAITING)
        is Block.Assistant -> if (block.text.isBlank()) PurposeRole.Between else PurposeRole.Breaker
        is Block.User -> PurposeRole.Breaker
    }
}
