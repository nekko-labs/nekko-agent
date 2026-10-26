import Foundation

/// What a run of tool calls is for, so the transcript can fold adjacent calls
/// with one purpose into one row that says the goal ("Read the project's
/// guidance", "Edited 3 files", "Ran the tests").
///
/// A port of `packages/shared/src/tool-purpose.ts`; all three classifiers
/// (TS, this, Kotlin `ToolPurpose.kt`) run `packages/shared/fixtures/tool-purpose.json`,
/// so change them together. Pure: no model call, nothing sent anywhere.
/// Spec: spec/chat/tool-calls-grouped-by-purpose.md.
public enum ToolPurpose: String, Sendable, Equatable, CaseIterable {
    case guidance, explore, edit, check, run, git, web, plan, delegate, other
}

/// A call as grouping sees it: its name and input, and whether it failed.
public struct PurposeCall: Sendable, Equatable {
    public var name: String
    public var input: [String: JSONValue]
    public var failed: Bool

    public init(name: String, input: [String: JSONValue] = [:], failed: Bool = false) {
        self.name = name
        self.input = input
        self.failed = failed
    }
}

public struct PurposeHeadline: Sendable, Equatable {
    /// The goal: the calls' own stated one, else the purpose's phrase.
    public var headline: String
    /// What was touched, how a check went, and how many failed.
    public var detail: String
    public var failed: Int
}

public enum Purpose {
    // MARK: Tool names

    /// Tool names compared without case, `_`, `-` or spaces: `read_file`, `Read` and `ReadFile` alike.
    static func key(_ name: String) -> String {
        String(name.lowercased().filter { $0 != "_" && $0 != "-" && !$0.isWhitespace })
    }

    static let read: Set<String> = ["readfile", "read", "view", "openfile", "notebookread", "readmanyfiles", "cat"]
    static let list: Set<String> = ["listdir", "ls", "listdirectory", "listfiles"]
    static let search: Set<String> = ["grep", "glob", "search", "find", "findfiles", "filesearch", "codebasesearch", "grepsearch", "searchfiles"]
    static let editTools: Set<String> = [
        "writefile", "editfile", "write", "edit", "multiedit", "applypatch", "notebookedit", "createfile",
        "strreplace", "strreplaceeditor", "strreplacebasededittool", "deletefile", "patch",
    ]
    static let shell: Set<String> = [
        "bash", "shell", "runcommand", "runterminalcmd", "exec", "execcommand", "powershell", "terminal",
        "localshell", "runshellcommand", "startprocess", "readprocess", "killprocess", "bashoutput", "killshell", "killbash",
    ]
    static let webSearch: Set<String> = ["websearch", "searchweb", "googlesearch"]
    static let web: Set<String> = webSearch.union(["webfetch", "fetchurl", "fetch", "browser", "browse"])
    static let planTools: Set<String> = ["updateplan", "todowrite", "todoread", "writetodos", "exitplanmode", "enterplanmode", "decide"]
    static let delegateTools: Set<String> = ["spawnagent", "task", "agent", "subagent", "dispatchagent", "delegationtargets"]
    static let ask: Set<String> = ["askuser", "askuserquestion", "askfollowupquestion"]

    static func isMcp(_ name: String) -> Bool { name.hasPrefix("mcp__") }

    /// A question for the person: never folded into a group, because it needs them.
    public static func needsUser(_ name: String) -> Bool { ask.contains(key(name)) }

    static func str(_ v: JSONValue?) -> String? {
        guard let s = v?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    static let pathKeys = ["file_path", "path", "file", "filename", "target_file", "notebook_path", "absolute_path", "relative_workspace_path", "dir", "directory"]

    /// The paths a file tool names: its path arguments, else a glob's pattern.
    static func paths(_ call: PurposeCall) -> [String] {
        var out = pathKeys.compactMap { str(call.input[$0]) }
        if let list = call.input["paths"]?.array { out += list.compactMap { str($0) } }
        if out.isEmpty, key(call.name) == "glob", let p = str(call.input["pattern"]) { out.append(p) }
        return out
    }

    /// The last segment of a path, either separator.
    public static func leaf(_ path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }

    static let guideFiles: Set<String> = ["agents.md", "claude.md", "claude.local.md", "gemini.md", "skill.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"]

    /// A file or folder that tells an agent how to work in the project.
    public static func isGuidancePath(_ path: String) -> Bool {
        let segs = path.replacingOccurrences(of: "\\", with: "/").lowercased().split(separator: "/").map(String.init)
        let base = segs.last ?? ""
        if guideFiles.contains(base) { return true }
        for prefix in ["readme", "contributing"] where base.hasPrefix(prefix) {
            let rest = base.dropFirst(prefix.count)
            if rest.isEmpty || rest.hasPrefix(".") { return true }
        }
        let markdownOrFolder = base.hasSuffix(".md") || base.hasSuffix(".mdx") || !base.contains(".")
        for (i, seg) in segs.enumerated() {
            let next = i + 1 < segs.count ? segs[i + 1] : nil
            if seg == "docs", next == "runbooks" || next == "decisions", markdownOrFolder { return true }
            if seg == "spec", markdownOrFolder { return true }
            if seg == ".cursor", next == "rules" { return true }
            // `.claude/worktrees/` holds whole checkouts, not instructions.
            if seg == ".claude", next != "worktrees" { return true }
            if seg == ".github", base.hasSuffix(".md") { return true }
        }
        return false
    }

    /// The command a shell tool ran, as one string. Codex-style `["bash", "-lc", "…"]` arrays keep the script.
    public static func shellCommand(_ input: [String: JSONValue]) -> String {
        let raw = input["command"] ?? input["cmd"] ?? input["script"]
        if let s = raw?.string { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let a = raw?.array {
            let words = a.compactMap(\.string)
            guard words.count == a.count else { return "" }
            if words.count >= 3, words[1].hasPrefix("-"), words[1].hasSuffix("c"), words[1].dropFirst().allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) {
                return words[words.count - 1].trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return words.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ""
    }

    // MARK: Shell commands

    enum ShellKind { case git, check, guidance, explore, run }

    static let wrappers: Set<String> = ["sudo", "time", "env", "nohup", "command", "exec", "&", "call", "npx", "bunx", "pnpx"]
    static let noise: Set<String> = ["cd", "pushd", "popd", "set-location", "sl", "export", "set", "source", ".", "echo", "write-host", "write-output", "true", ":", "sleep", "clear", "cls"]
    static let checkProgs: Set<String> = [
        "vitest", "jest", "pytest", "tsc", "vue-tsc", "eslint", "mypy", "ruff", "mocha", "rspec", "phpunit",
        "swiftlint", "ktlint", "golangci-lint", "biome", "playwright", "tox", "nox", "stylelint", "unittest",
    ]
    static let showProgs: Set<String> = ["cat", "head", "tail", "less", "more", "bat", "type", "get-content", "gc", "ls", "dir", "tree", "get-childitem", "gci"]
    static let lookProgs: Set<String> = showProgs.union(["find", "fd", "rg", "grep", "ag", "ack", "wc", "select-string", "sls", "stat", "file", "realpath", "pwd", "which", "where", "get-item", "test-path", "du"])
    static let searchProgs: Set<String> = ["find", "fd", "rg", "grep", "ag", "ack", "select-string", "sls"]
    static let packageManagers: Set<String> = ["npm", "pnpm", "yarn", "bun"]
    static let install: Set<String> = ["install", "i", "add", "ci", "uninstall", "remove", "rm", "update", "upgrade", "init", "create", "exec", "dlx"]
    static let scripts: Set<String> = ["test", "t", "tests", "lint", "typecheck", "type-check", "build", "check", "verify", "e2e"]

    /// `test`, `test:unit`, `lint:fix`: a package script that checks the code.
    static func isCheckScript(_ arg: String) -> Bool {
        let head = arg.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? arg
        guard scripts.contains(head) else { return false }
        if head.count == arg.count { return true }
        let tail = arg.dropFirst(head.count + 1)
        return !tail.isEmpty && tail.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == ":" || $0 == "." || $0 == "-" }
    }

    static func unquote(_ w: Substring) -> String {
        var s = w
        while let f = s.first, f == "\"" || f == "'" { s = s.dropFirst() }
        while let l = s.last, l == "\"" || l == "'" { s = s.dropLast() }
        return String(s)
    }

    static func isAssignment(_ w: String) -> Bool {
        guard let eq = w.firstIndex(of: "="), eq != w.startIndex else { return false }
        let name = w[..<eq]
        guard let first = name.first, first.isLetter || first == "_" else { return false }
        return name.allSatisfy { ($0.isLetter || $0.isNumber || $0 == "_") && $0.isASCII }
    }

    /// The words of one command, with env assignments and wrappers (`sudo`, `npx`) taken off the front.
    static func words(_ segment: String) -> [String] {
        var w = segment.split(whereSeparator: { $0.isWhitespace }).map(unquote)
        while let first = w.first {
            if isAssignment(first) {
                w.removeFirst()
            } else if wrappers.contains(first.lowercased()) {
                w.removeFirst()
                while let f = w.first, f.hasPrefix("-") { w.removeFirst() }
            } else { break }
        }
        return w
    }

    /// A program's bare name: `./node_modules/.bin/vitest`, `.\gradlew.bat` read as `vitest`, `gradlew`.
    static func progName(_ word: String) -> String {
        var name = leaf(word).lowercased()
        for ext in [".exe", ".cmd", ".bat", ".ps1", ".sh"] where name.hasSuffix(ext) {
            name = String(name.dropLast(ext.count))
            break
        }
        return name
    }

    static func segmentKind(_ segment: String) -> ShellKind? {
        let w = words(segment)
        guard let head = w.first else { return nil }
        let prog = progName(head)
        let args = Array(w.dropFirst())
        let lower = args.map { $0.lowercased() }
        let plain = lower.filter { !$0.hasPrefix("-") && !$0.hasPrefix("+") }
        let first = plain.first ?? ""
        if noise.contains(prog) { return nil }
        if prog == "git" || prog == "gh" { return .git }
        if checkCommand(prog, lower, plain, first) { return .check }
        if lookProgs.contains(prog) {
            // `cat > notes.md <<EOF` writes a file.
            if args.contains(where: { $0.hasPrefix(">") }) { return .run }
            if !showProgs.contains(prog) { return .explore }
            let paths = args.filter { !$0.hasPrefix("-") && !($0.allSatisfy(\.isNumber) && !$0.isEmpty) }
            return !paths.isEmpty && paths.allSatisfy(isGuidancePath) ? .guidance : .explore
        }
        return .run
    }

    static func checkCommand(_ prog: String, _ lower: [String], _ plain: [String], _ first: String) -> Bool {
        if checkProgs.contains(prog) { return true }
        if packageManagers.contains(prog) {
            if install.contains(first) { return false }
            return plain.contains { isCheckScript($0) || checkProgs.contains($0) }
        }
        switch prog {
        case "cargo": return ["test", "build", "check", "clippy", "nextest", "bench"].contains(first)
        case "go": return ["test", "build", "vet"].contains(first)
        case "swift", "dotnet": return ["test", "build"].contains(first)
        case "deno": return ["test", "check", "lint"].contains(first)
        case "mvn", "mvnw": return plain.contains { ["test", "verify", "package", "compile", "install"].contains($0) }
        case "gradle", "gradlew": return plain.contains { a in ["test", "build", "assemble", "lint", "check"].contains { a.contains($0) } }
        case "make", "just": return first.isEmpty || ["test", "check", "build", "lint", "all"].contains(first)
        case "xcodebuild": return plain.contains { ["test", "build", "build-for-testing", "test-without-building", "analyze"].contains($0) }
        case "python", "python3", "py", "uv", "poetry", "pipenv": return plain.contains { checkProgs.contains($0) }
        case "node": return lower.contains("--test")
        default: return false
        }
    }

    /// The commands a shell line runs, split on `&&`, `||`, `;`, `|` and newlines.
    static func segments(_ command: String) -> [String] {
        var out: [String] = []
        var cur = ""
        let chars = Array(command)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            if (c == "&" && next == "&") || (c == "|" && next == "|") {
                out.append(cur); cur = ""; i += 2; continue
            }
            if c == ";" || c == "|" || c == "\n" {
                out.append(cur); cur = ""; i += 1; continue
            }
            cur.append(c)
            i += 1
        }
        out.append(cur)
        return out.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    static func shellPurpose(_ command: String) -> ToolPurpose {
        let kinds = segments(command).compactMap(segmentKind)
        guard let first = kinds.first else { return .run }
        if first == .git { return .git }
        if kinds.contains(.check) { return .check }
        if kinds.contains(.git) { return .git }
        if kinds.allSatisfy({ $0 == .guidance }) { return .guidance }
        if kinds.allSatisfy({ $0 == .guidance || $0 == .explore }) { return .explore }
        return .run
    }

    // MARK: Purpose and goal

    /// What one call is for.
    public static func of(name: String, input: [String: JSONValue]) -> ToolPurpose {
        if isMcp(name) { return .other }
        let k = key(name)
        if delegateTools.contains(k) { return .delegate }
        if planTools.contains(k) { return .plan }
        if web.contains(k) { return .web }
        if editTools.contains(k) { return .edit }
        if read.contains(k) || list.contains(k) || search.contains(k) {
            let p = paths(PurposeCall(name: name, input: input))
            return !p.isEmpty && p.allSatisfy(isGuidancePath) ? .guidance : .explore
        }
        if shell.contains(k) { return shellPurpose(shellCommand(input)) }
        return .other
    }

    /// The goal a call states for itself (Claude Code's Bash and Task send a short `description`).
    public static func goal(name: String, input: [String: JSONValue]) -> String {
        if isMcp(name) || editTools.contains(key(name)) { return "" }
        let raw = input["description"]?.string ?? input["intent"]?.string ?? ""
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.count > 120 || text.contains("\n") { return "" }
        var flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        while flat.hasSuffix(".") { flat.removeLast() }
        return flat
    }

    // MARK: Headlines

    static func cap(_ s: String) -> String { s.isEmpty ? s : s.prefix(1).uppercased() + s.dropFirst() }

    /// Up to three names in full; more than that is the first two and `+N`.
    static func nameList(_ names: [String]) -> String {
        var seen = Set<String>()
        let distinct = names.filter { seen.insert($0).inserted }
        if distinct.count <= 3 { return distinct.joined(separator: ", ") }
        return distinct.prefix(2).joined(separator: ", ") + " +\(distinct.count - 2)"
    }

    static func oneLine(_ text: String, _ max: Int = 60) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if flat.count <= max { return flat }
        var cut = String(flat.prefix(max - 1))
        while cut.last?.isWhitespace == true { cut.removeLast() }
        return cut + "…"
    }

    static func plural(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? one : "\(n) \(many)" }

    enum CheckKind { case test, build, lint }

    /// Whole-word-start match, as JS `\b` + word: `word` begins at a word boundary.
    static func hasWordStart(_ text: String, _ word: String) -> Bool {
        var search = text.startIndex
        while let r = text.range(of: word, range: search..<text.endIndex) {
            if r.lowerBound == text.startIndex { return true }
            let before = text[text.index(before: r.lowerBound)]
            if !(before.isLetter || before.isNumber || before == "_") { return true }
            search = text.index(after: r.lowerBound)
        }
        return false
    }

    static func hasWord(_ text: String, _ word: String) -> Bool {
        var search = text.startIndex
        while let r = text.range(of: word, range: search..<text.endIndex) {
            let okBefore = r.lowerBound == text.startIndex || { let c = text[text.index(before: r.lowerBound)]; return !(c.isLetter || c.isNumber || c == "_") }()
            let okAfter = r.upperBound == text.endIndex || { let c = text[r.upperBound]; return !(c.isLetter || c.isNumber || c == "_") }()
            if okBefore && okAfter { return true }
            search = text.index(after: r.lowerBound)
        }
        return false
    }

    static func checkKind(_ call: PurposeCall) -> CheckKind {
        let k = key(call.name)
        let text = shell.contains(k) ? shellCommand(call.input).lowercased() : k
        if hasWordStart(text, "test") || ["vitest", "jest", "pytest", "mocha", "rspec", "phpunit", "playwright", "unittest"].contains(where: text.contains) || hasWord(text, "e2e") { return .test }
        if hasWordStart(text, "build") || text.contains("assemble") || hasWord(text, "make") || text.contains("compile") || text.contains("package") { return .build }
        return .lint
    }

    static let gitActions: [String: (String, String)] = [
        "commit": ("committed", "committing"),
        "push": ("pushed", "pushing"),
        "pull": ("pulled", "pulling"),
        "switch": ("switched branches", "switching branches"),
        "merge": ("merged", "merging"),
        "rebase": ("rebased", "rebasing"),
        "stash": ("stashed changes", "stashing changes"),
        "worktree": ("set up a worktree", "setting up a worktree"),
        "pr-create": ("opened a PR", "opening a PR"),
        "pr-merge": ("queued the PR", "queuing the PR"),
        "pr-read": ("checked the PR", "checking the PR"),
        "issue-create": ("filed an issue", "filing an issue"),
        "issue-read": ("read the issues", "reading the issues"),
        "add": ("staged changes", "staging changes"),
        "look": ("checked the changes", "checking the changes"),
        "other": ("used git", "using git"),
    ]
    static let minorGit: Set<String> = ["add", "look", "other", "pr-read", "issue-read"]

    static func gitActionList(_ calls: [PurposeCall]) -> [String] {
        var out: [String] = []
        for call in calls {
            for seg in segments(shellCommand(call.input)) {
                let w = words(seg).map { $0.lowercased() }
                let prog = w.first.map(progName) ?? ""
                guard prog == "git" || prog == "gh" else { continue }
                var i = 1
                while i < w.count, w[i].hasPrefix("-") { i += (w[i] == "-c" || w[i] == "-C" ? 2 : 1) }
                let sub = i < w.count ? w[i] : ""
                let obj = i + 1 < w.count ? w[i + 1] : ""
                let action: String
                if prog == "gh" {
                    if sub == "pr" { action = obj == "create" ? "pr-create" : obj == "merge" ? "pr-merge" : "pr-read" }
                    else if sub == "issue" { action = obj == "create" ? "issue-create" : "issue-read" }
                    else if sub == "run" || sub == "api" { action = "pr-read" }
                    else { action = "other" }
                } else if ["commit", "push", "merge", "rebase", "stash", "worktree"].contains(sub) { action = sub }
                else if sub == "pull" || sub == "fetch" { action = "pull" }
                else if ["checkout", "switch", "branch"].contains(sub) { action = "switch" }
                else if sub == "add" { action = "add" }
                else if ["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "remote"].contains(sub) { action = "look" }
                else { action = "other" }
                if !out.contains(action) { out.append(action) }
            }
        }
        let major = out.filter { !minorGit.contains($0) }
        if !major.isEmpty { return major }
        for a in ["pr-read", "issue-read", "add", "look"] where out.contains(a) { return [a] }
        return ["other"]
    }

    static func joinPhrases(_ parts: [String]) -> String {
        if parts.count <= 1 { return parts.first ?? "" }
        return parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1]
    }

    static func distinctPaths(_ calls: [PurposeCall]) -> [String] {
        var seen = Set<String>()
        return calls.flatMap(paths).filter { seen.insert($0).inserted }
    }

    /// The purpose's own headline for these calls, ignoring any stated goal.
    public static func phrase(_ purpose: ToolPurpose, _ calls: [PurposeCall], running: Bool = false) -> String {
        func t(_ past: String, _ present: String) -> String { running ? present : past }
        let n = calls.count
        switch purpose {
        case .guidance: return t("Read the project's guidance", "Reading the project's guidance")
        case .explore: return t("Looked through the code", "Looking through the code")
        case .edit:
            let files = distinctPaths(calls).count
            return "\(t("Edited", "Editing")) \(plural(files == 0 ? n : files, "1 file", "files"))"
        case .check:
            let kinds = Set(calls.map { "\(checkKind($0))" })
            if kinds == ["test"] { return t("Ran the tests", "Running the tests") }
            if kinds == ["build"] { return t("Built the app", "Building the app") }
            return t("Ran the checks", "Running the checks")
        case .run: return "\(t("Ran", "Running")) \(plural(n, "a command", "commands"))"
        case .git: return cap(joinPhrases(gitActionList(calls).map { running ? gitActions[$0]!.1 : gitActions[$0]!.0 }))
        case .web:
            if calls.contains(where: { webSearch.contains(key($0.name)) }) { return t("Searched the web", "Searching the web") }
            return "\(t("Read", "Reading")) \(plural(n, "a page", "pages"))"
        case .plan: return t("Updated the plan", "Updating the plan")
        case .delegate: return "\(t("Delegated", "Delegating")) \(plural(n, "a task", "tasks"))"
        case .other: return n == 1 ? "\(t("Used", "Using")) \(calls[0].name)" : "\(t("Used", "Using")) \(n) tools"
        }
    }

    static func host(_ url: String) -> String {
        guard let r = url.range(of: "://") else { return url }
        let scheme = url[..<r.lowerBound]
        guard let f = scheme.first, f.isLetter, scheme.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "+" || $0 == "." || $0 == "-" }) else { return url }
        let rest = url[r.upperBound...]
        let h = rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" && !$0.isWhitespace }
        if h.isEmpty { return url }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : String(h)
    }

    static func detail(_ purpose: ToolPurpose, _ calls: [PurposeCall], running: Bool) -> String {
        switch purpose {
        case .guidance, .edit:
            return nameList(distinctPaths(calls).map(leaf))
        case .explore:
            var files = 0, folders = 0, searches = 0, commands = 0
            for c in calls {
                let k = key(c.name)
                if read.contains(k) { files += 1 }
                else if list.contains(k) { folders += 1 }
                else if search.contains(k) { searches += 1 }
                else if segments(shellCommand(c.input)).contains(where: { searchProgs.contains(progName(words($0).first ?? "")) }) { searches += 1 }
                else { commands += 1 }
            }
            var parts: [String] = []
            if files > 0 { parts.append(plural(files, "1 file", "files")) }
            if folders > 0 { parts.append(plural(folders, "1 folder", "folders")) }
            if searches > 0 { parts.append(plural(searches, "1 search", "searches")) }
            if commands > 0 { parts.append(plural(commands, "1 command", "commands")) }
            return parts.joined(separator: ", ")
        case .check:
            let failed = calls.filter(\.failed).count
            if !running { return failed > 0 ? "\(failed) failed" : "passed" }
            let cmd = shellCommand(calls[0].input)
            return oneLine(cmd.isEmpty ? calls[0].name : cmd)
        case .run, .git:
            return oneLine(shellCommand(calls[0].input))
        case .web:
            if let q = calls.lazy.compactMap({ str($0.input["query"]) }).first { return oneLine(q) }
            return nameList(calls.compactMap { str($0.input["url"]) }.map(host))
        case .other:
            return nameList(calls.map(\.name))
        case .plan, .delegate:
            return ""
        }
    }

    /// The headline and detail line for a run of same-purpose calls; present tense while running.
    public static func headline(_ purpose: ToolPurpose, _ calls: [PurposeCall], running: Bool = false) -> PurposeHeadline {
        var seen = Set<String>()
        let goals = calls.map { goal(name: $0.name, input: $0.input) }.filter { !$0.isEmpty && seen.insert($0).inserted }
        let head = goals.isEmpty ? phrase(purpose, calls, running: running)
            : goals.count > 1 ? "\(goals[0]) and \(goals.count - 1) more" : goals[0]
        let failed = calls.filter(\.failed).count
        var d = detail(purpose, calls, running: running)
        if failed > 0, !(purpose == .check && !running) { d = [d, "\(failed) failed"].filter { !$0.isEmpty }.joined(separator: " · ") }
        return PurposeHeadline(headline: head, detail: d, failed: failed)
    }
}

/// How an item takes part in purpose grouping.
public enum PurposeRole {
    /// A call; `standalone` keeps it out of every group (it waits for approval).
    case call(PurposeCall, standalone: Bool)
    /// Something between calls (a thought) that folds in with same-purpose calls on both sides.
    case between
    /// Something that ends a group (a reply, a prompt).
    case breaker
}

/// One row of a grouped transcript: two or more adjacent same-purpose calls, or an item on its own.
public enum PurposeRun<T> {
    case group(ToolPurpose, [T], [PurposeCall])
    case single(T)
}

extension Purpose {
    /// Fold adjacent same-purpose calls into groups, as `groupByPurpose` does
    /// in TS. Questions and standalone calls stay single, and so does a group
    /// of one call. Nothing is reordered or dropped.
    public static func group<T>(_ items: [T], role: (T) -> PurposeRole) -> [PurposeRun<T>] {
        var out: [PurposeRun<T>] = []
        var current: (purpose: ToolPurpose, items: [T], calls: [PurposeCall])?
        var held: [T] = []
        func flush() {
            if let g = current {
                if g.calls.count > 1 { out.append(.group(g.purpose, g.items, g.calls)) } else { out += g.items.map { .single($0) } }
                current = nil
            }
            out += held.map { .single($0) }
            held = []
        }
        for item in items {
            switch role(item) {
            case .between:
                if current != nil { held.append(item) } else { out.append(.single(item)) }
            case .breaker:
                flush()
                out.append(.single(item))
            case .call(let call, let standalone):
                if standalone || needsUser(call.name) {
                    flush()
                    out.append(.single(item))
                    continue
                }
                let purpose = of(name: call.name, input: call.input)
                if var g = current, g.purpose == purpose {
                    g.items += held + [item]
                    g.calls.append(call)
                    current = g
                    held = []
                } else {
                    flush()
                    current = (purpose, [item], [call])
                }
            }
        }
        flush()
        return out
    }

    /// A transcript block's part in grouping: a call waiting for approval stays
    /// on its own, a thought with no reply text sits between calls, and a reply
    /// or a prompt ends a group.
    public static func role(of block: Block) -> PurposeRole {
        switch block {
        case .tool(_, let name, _, let status, _, let input):
            return .call(PurposeCall(name: name, input: input, failed: status == .error), standalone: status == .waiting)
        case .assistant(_, let text, _, _, _):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .between : .breaker
        case .user:
            return .breaker
        }
    }
}
