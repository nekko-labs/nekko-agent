//! The read-only allowlist behind guardrails mode (decision 0010).
//!
//! Guardrails mode auto-runs a shell command only when every command in it is
//! a known read-only one. The command is split into simple commands on `|`,
//! `&&`, `||`, `;`, `&` and newlines, and each is read as words after quote
//! removal. Anything the split cannot read with certainty (command
//! substitution, variables, redirection to a file, subshells, heredocs, escape
//! tricks, an unterminated quote) is refused here, and the caller asks.
//!
//! This is deliberately a small, strict lexer, not a shell: when it is unsure
//! it says so, and the answer is to ask the user.

/// Which shell grammar a command is read in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    /// `/bin/sh`, bash, zsh.
    Posix,
    /// `cmd.exe`.
    Cmd,
    /// Windows PowerShell and `pwsh`.
    PowerShell,
}

impl Dialect {
    /// The shell the `bash` tool runs commands in on this machine: `cmd.exe`
    /// on Windows (as Node's `exec` did), `/bin/sh` elsewhere.
    pub fn host() -> Self {
        if cfg!(windows) { Dialect::Cmd } else { Dialect::Posix }
    }
}

/// Why a command cannot be checked word by word: a label for the approval
/// prompt, and the text that caused it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Unreadable {
    pub label: &'static str,
    pub evidence: String,
}

pub(crate) const EXPANSION: &str = "Command substitution or shell expansion";
pub(crate) const OUTPUT_REDIRECT: &str = "Output redirection to a file";
pub(crate) const INPUT_REDIRECT: &str = "Input redirection, heredoc or process substitution";
pub(crate) const GROUPING: &str = "Subshell or command group";
pub(crate) const UNTERMINATED: &str = "Unterminated quote";
pub(crate) const ESCAPE: &str = "Shell escape character";
pub(crate) const CONTROL: &str = "Control character in the command";
pub(crate) const CALL_OPERATOR: &str = "PowerShell call operator";

fn unreadable(label: &'static str, evidence: impl Into<String>) -> Unreadable {
    Unreadable { label, evidence: evidence.into() }
}

/// One simple command: its words after quote removal, and the operator that
/// ended it (empty for the last).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Segment {
    pub words: Vec<String>,
    pub sep: &'static str,
}

impl Segment {
    /// The words joined by single spaces: what user allow rules are matched against.
    pub fn text(&self) -> String {
        self.words.join(" ")
    }
}

/// The command as the shell would see it after quote removal, segments
/// joined by their operators. Rules are matched against this as well as the
/// raw text, so `cat .e''nv` is caught by a rule that looks for `.env`.
pub(crate) fn render(segments: &[Segment]) -> String {
    let mut out = String::new();
    for s in segments {
        out.push_str(&s.text());
        if !s.sep.is_empty() {
            out.push(' ');
            out.push_str(s.sep);
            out.push(' ');
        }
    }
    out.trim_end().to_string()
}

struct Lexer {
    chars: Vec<char>,
    i: usize,
    d: Dialect,
    segments: Vec<Segment>,
    words: Vec<String>,
    word: String,
    /// The current word exists (a quoted empty string is still a word).
    in_word: bool,
    /// Part of the current word was quoted or escaped.
    quoted: bool,
}

impl Lexer {
    fn peek(&self, k: usize) -> Option<char> {
        self.chars.get(self.i + k).copied()
    }

    fn end_word(&mut self) {
        if self.in_word {
            self.words.push(std::mem::take(&mut self.word));
        }
        self.in_word = false;
        self.quoted = false;
    }

    fn end_segment(&mut self, sep: &'static str) {
        self.end_word();
        if !self.words.is_empty() {
            self.segments.push(Segment { words: std::mem::take(&mut self.words), sep });
        } else if let Some(last) = self.segments.last_mut() {
            // `a ;; b`, `a |\n b`: keep the first operator.
            if last.sep.is_empty() {
                last.sep = sep;
            }
        }
    }

    fn push(&mut self, c: char) {
        self.word.push(c);
        self.in_word = true;
    }

    /// A `$`, backtick or `%` that would expand to something the lexer cannot see.
    fn check_expansion(&self, c: char) -> Result<(), Unreadable> {
        let expands = match self.d {
            Dialect::Posix | Dialect::PowerShell => c == '$' || c == '`',
            Dialect::Cmd => c == '%' || c == '!',
        };
        if expands { Err(unreadable(EXPANSION, c.to_string())) } else { Ok(()) }
    }

    fn single_quoted(&mut self) -> Result<(), Unreadable> {
        let start = self.i;
        self.i += 1;
        self.in_word = true;
        self.quoted = true;
        loop {
            let Some(c) = self.peek(0) else {
                return Err(unreadable(UNTERMINATED, self.chars[start..].iter().collect::<String>()));
            };
            self.i += 1;
            if c == '\'' {
                // PowerShell writes a quote inside single quotes as two.
                if self.d == Dialect::PowerShell && self.peek(0) == Some('\'') {
                    self.i += 1;
                    self.word.push('\'');
                    continue;
                }
                return Ok(());
            }
            self.word.push(c);
        }
    }

    fn double_quoted(&mut self) -> Result<(), Unreadable> {
        let start = self.i;
        self.i += 1;
        self.in_word = true;
        self.quoted = true;
        loop {
            let Some(c) = self.peek(0) else {
                return Err(unreadable(UNTERMINATED, self.chars[start..].iter().collect::<String>()));
            };
            self.i += 1;
            if c == '"' {
                if self.d == Dialect::PowerShell && self.peek(0) == Some('"') {
                    self.i += 1;
                    self.word.push('"');
                    continue;
                }
                return Ok(());
            }
            self.check_expansion(c)?;
            if c.is_control() && c != '\n' && c != '\t' && c != '\r' {
                return Err(unreadable(CONTROL, format!("{c:?}")));
            }
            if c == '\\' && self.d == Dialect::Posix {
                match self.peek(0) {
                    Some('\n') => {
                        self.i += 1;
                        continue;
                    }
                    Some(n @ ('$' | '`' | '"' | '\\')) => {
                        self.i += 1;
                        self.word.push(n);
                        continue;
                    }
                    _ => {}
                }
            }
            self.word.push(c);
        }
    }

    /// `>` and what follows it. Only redirections that cannot write a file
    /// pass: duplicating a descriptor (`2>&1`) or discarding to the null
    /// device (`>/dev/null`, `2>nul`, `> $null`).
    fn redirect(&mut self, both: bool) -> Result<(), Unreadable> {
        let start = self.i;
        // A word of digits right before `>` is its descriptor, not an argument.
        if self.in_word && !self.quoted && !self.word.is_empty() && self.word.chars().all(|c| c.is_ascii_digit()) {
            self.word.clear();
            self.in_word = false;
        } else {
            self.end_word();
        }
        self.i += 1; // `>`
        if self.peek(0) == Some('>') {
            self.i += 1; // `>>`
        }
        let snippet = |l: &Self| l.chars[start..l.i.min(l.chars.len())].iter().collect::<String>();
        if self.peek(0) == Some('|') {
            self.i += 1;
            return Err(unreadable(OUTPUT_REDIRECT, snippet(self)));
        }
        if !both && self.peek(0) == Some('&') {
            self.i += 1;
            let digits = self.i;
            while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
            if self.i == digits || !self.at_word_end() {
                // `>&file` sends both streams to a file in bash.
                return Err(unreadable(OUTPUT_REDIRECT, snippet(self)));
            }
            return Ok(());
        }
        while matches!(self.peek(0), Some(' ' | '\t')) {
            self.i += 1;
        }
        let target_start = self.i;
        while !self.at_word_end() {
            self.i += 1;
        }
        let target: String = self.chars[target_start..self.i].iter().collect();
        let null = match self.d {
            Dialect::Posix => target == "/dev/null",
            Dialect::Cmd => target.eq_ignore_ascii_case("nul"),
            Dialect::PowerShell => target.eq_ignore_ascii_case("$null"),
        };
        if null { Ok(()) } else { Err(unreadable(OUTPUT_REDIRECT, snippet(self))) }
    }

    /// The next character ends a word: end of input, blank, or an operator.
    fn at_word_end(&self) -> bool {
        match self.peek(0) {
            None => true,
            Some(c) => matches!(c, ' ' | '\t' | '\n' | '\r' | ';' | '|' | '&' | '<' | '>' | '(' | ')'),
        }
    }

    fn run(mut self) -> Result<Vec<Segment>, Unreadable> {
        while let Some(c) = self.peek(0) {
            match c {
                ' ' | '\t' => {
                    self.end_word();
                    self.i += 1;
                }
                '\n' | '\r' => {
                    self.end_segment("\n");
                    self.i += 1;
                }
                ';' => {
                    self.end_segment(";");
                    self.i += 1;
                }
                '|' => {
                    self.i += 1;
                    if self.peek(0) == Some('|') {
                        self.i += 1;
                        self.end_segment("||");
                    } else {
                        if self.d == Dialect::Posix && self.peek(0) == Some('&') {
                            self.i += 1; // `|&`: stderr too
                        }
                        self.end_segment("|");
                    }
                }
                '&' => {
                    if self.peek(1) == Some('&') {
                        self.i += 2;
                        self.end_segment("&&");
                    } else if self.d == Dialect::Posix && self.peek(1) == Some('>') {
                        // `&>file`: both streams.
                        self.end_word();
                        self.i += 1;
                        self.redirect(true)?;
                    } else if self.d == Dialect::PowerShell {
                        return Err(unreadable(CALL_OPERATOR, "&"));
                    } else {
                        // Background (sh) or a plain separator (cmd).
                        self.i += 1;
                        self.end_segment("&");
                    }
                }
                '>' => self.redirect(false)?,
                '<' => return Err(unreadable(INPUT_REDIRECT, "<")),
                '(' | ')' => return Err(unreadable(GROUPING, c.to_string())),
                '{' | '}' | '@' if self.d == Dialect::PowerShell => return Err(unreadable(GROUPING, c.to_string())),
                '^' if self.d == Dialect::Cmd => return Err(unreadable(ESCAPE, "^")),
                '\'' if self.d != Dialect::Cmd => self.single_quoted()?,
                '"' => self.double_quoted()?,
                '\\' if self.d == Dialect::Posix => match self.peek(1) {
                    None => return Err(unreadable(ESCAPE, "\\")),
                    Some('\n') => self.i += 2,
                    Some(n) => {
                        if n.is_control() && n != '\t' {
                            return Err(unreadable(CONTROL, format!("{n:?}")));
                        }
                        self.i += 2;
                        self.quoted = true;
                        self.push(n);
                    }
                },
                c if c.is_control() => return Err(unreadable(CONTROL, format!("{c:?}"))),
                c => {
                    self.check_expansion(c)?;
                    self.i += 1;
                    self.push(c);
                }
            }
        }
        self.end_segment("");
        Ok(self.segments)
    }
}

/// Split a command into simple commands, or say why it cannot be read.
pub(crate) fn split(command: &str, d: Dialect) -> Result<Vec<Segment>, Unreadable> {
    Lexer {
        chars: command.chars().collect(),
        i: 0,
        d,
        segments: Vec::new(),
        words: Vec::new(),
        word: String::new(),
        in_word: false,
        quoted: false,
    }
    .run()
}

/// A short flag cluster (`-abc`, not `--long`) that contains `flag`.
fn has_short(args: &[String], flag: char) -> bool {
    args.iter().any(|a| a.len() > 1 && a.starts_with('-') && !a.starts_with("--") && a[1..].contains(flag))
}

/// A long option, or an abbreviation of it at least `min` characters long
/// (getopt and git both accept unambiguous abbreviations).
fn has_long(args: &[String], full: &str, min: usize) -> bool {
    args.iter().any(|a| {
        let name = a.split('=').next().unwrap_or_default();
        name.starts_with(full) || (name.len() >= min && full.starts_with(name))
    })
}

/// `git` with a read-only subcommand and no option that writes or runs anything.
fn git_read_only(args: &[String]) -> bool {
    let mut i = 0;
    // Global options: only these. `-c`, `--exec-path`, `--git-dir` and the
    // rest can point git at commands or configuration of the caller's choosing.
    while let Some(a) = args.get(i).filter(|a| a.starts_with('-')) {
        match a.as_str() {
            "--no-pager" | "-P" => i += 1,
            "-C" if args.get(i + 1).is_some() => i += 2,
            _ => return false,
        }
    }
    let Some(sub) = args.get(i) else { return false };
    let rest = &args[i + 1..];
    // `--output` writes the patch to a file; `--ext-diff` runs a configured program.
    let writes = has_long(rest, "--output", 5) || has_long(rest, "--ext-diff", 5);
    match sub.as_str() {
        "status" | "diff" | "log" | "show" | "rev-parse" | "ls-files" | "blame" | "describe" => !writes,
        "branch" => {
            const LIST: &[&str] = &[
                "-a",
                "--all",
                "-r",
                "--remotes",
                "-v",
                "-vv",
                "--verbose",
                "--list",
                "-l",
                "--show-current",
                "--no-color",
            ];
            let listing = rest.iter().any(|a| a == "--list" || a == "-l");
            rest.iter().all(|a| LIST.contains(&a.as_str()) || (listing && !a.starts_with('-')))
        }
        "remote" => rest.is_empty() || (rest.len() == 1 && (rest[0] == "-v" || rest[0] == "--verbose")),
        "tag" => {
            rest.is_empty()
                || (matches!(rest[0].as_str(), "-l" | "--list") && rest[1..].iter().all(|a| !a.starts_with('-')))
        }
        _ => false,
    }
}

/// The commands guardrails mode runs without asking, and the arguments that
/// would make each of them write or execute something.
pub(crate) fn read_only(words: &[String], d: Dialect) -> bool {
    let Some((name, args)) = words.split_first() else { return true };
    // cmd and PowerShell match command names case-insensitively.
    let name = if d == Dialect::Posix { name.clone() } else { name.to_ascii_lowercase() };
    match name.as_str() {
        "ls" | "pwd" | "cd" | "cat" | "head" | "tail" | "wc" | "stat" | "du" | "df" | "which" | "echo" | "printf"
        | "grep" | "cut" | "diff" => true,
        // `file -C` compiles a magic file into the current directory.
        "file" => !has_short(args, 'C') && !has_long(args, "--compile", 5),
        // `sort -o` writes a file; `--compress-program` runs one. Windows'
        // sort.exe writes with `/o`.
        "sort" => {
            !has_short(args, 'o')
                && !has_long(args, "--output", 5)
                && !has_long(args, "--compress-program", 4)
                && (d == Dialect::Posix || !args.iter().any(|a| a.to_ascii_lowercase().starts_with("/o")))
        }
        // `uniq in out` writes `out`.
        "uniq" => args.iter().filter(|a| !a.starts_with('-') || a.as_str() == "-").count() <= 1,
        // `tree -o` writes its listing to a file, `-R` writes one per directory.
        "tree" => !has_short(args, 'o') && !has_short(args, 'R') && !has_long(args, "--output", 5),
        // `rg --pre` runs a program on every file it searches.
        "rg" => !args.iter().any(|a| a.starts_with("--pre")),
        "find" => !args.iter().any(|a| {
            matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete" | "-fls")
                || a.starts_with("-fprint")
        }),
        "git" => git_read_only(args),
        // cmd built-ins and Windows tools.
        "dir" | "type" | "where" | "findstr" => true,
        // PowerShell cmdlets and their aliases.
        "get-childitem" | "gci" | "get-content" | "gc" | "select-string" | "sls" | "get-location" => {
            d != Dialect::Posix
        }
        _ => false,
    }
}

/// The command runs git in one of its simple commands (an unreadable command
/// counts, to be safe).
pub(crate) fn runs_git(command: &str, d: Dialect) -> bool {
    split(command, d).map_or(true, |segments| {
        segments.iter().any(|s| s.words.first().is_some_and(|w| w.eq_ignore_ascii_case("git")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(command: &str, d: Dialect) -> Vec<Vec<String>> {
        split(command, d).unwrap().into_iter().map(|s| s.words).collect()
    }

    #[test]
    fn splits_on_every_operator_and_removes_quotes() {
        let p = Dialect::Posix;
        assert_eq!(
            words("ls -la | grep 'a b' && cat \"x y\"; pwd || echo n\nwc", p),
            vec![
                vec!["ls", "-la"],
                vec!["grep", "a b"],
                vec!["cat", "x y"],
                vec!["pwd"],
                vec!["echo", "n"],
                vec!["wc"],
            ]
        );
        assert_eq!(words("cat .e''nv", p), vec![vec!["cat", ".env"]]);
        assert_eq!(words("cat .e\\nv", p), vec![vec!["cat", ".env"]]);
        assert_eq!(words("ls 2>/dev/null", p), vec![vec!["ls"]]);
        assert_eq!(words("ls 2>&1 | head", p), vec![vec!["ls"], vec!["head"]]);
        assert_eq!(render(&split("ca''t  .e\"\"nv|sh", p).unwrap()), "cat .env | sh");
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        let p = Dialect::Posix;
        for (cmd, label) in [
            ("echo $(id)", EXPANSION),
            ("echo `id`", EXPANSION),
            ("echo \"$(id)\"", EXPANSION),
            ("echo $HOME", EXPANSION),
            ("cat <(curl x)", INPUT_REDIRECT),
            ("cat <<EOF", INPUT_REDIRECT),
            ("echo x > f", OUTPUT_REDIRECT),
            ("echo x >> f", OUTPUT_REDIRECT),
            ("echo x 2> f", OUTPUT_REDIRECT),
            ("echo x &> f", OUTPUT_REDIRECT),
            ("echo x >&f", OUTPUT_REDIRECT),
            ("echo x >| f", OUTPUT_REDIRECT),
            ("echo x >/dev/nullx", OUTPUT_REDIRECT),
            ("(ls)", GROUPING),
            ("echo 'x", UNTERMINATED),
            ("echo \"x", UNTERMINATED),
            ("echo x\\", ESCAPE),
            ("rm\u{0b}-rf x", CONTROL),
        ] {
            assert_eq!(split(cmd, p).map_err(|e| e.label), Err(label), "{cmd:?}");
        }
        assert_eq!(split("type x ^& del y", Dialect::Cmd).map_err(|e| e.label), Err(ESCAPE));
        assert_eq!(split("type %USERPROFILE%", Dialect::Cmd).map_err(|e| e.label), Err(EXPANSION));
        assert_eq!(split("& rm x", Dialect::PowerShell).map_err(|e| e.label), Err(CALL_OPERATOR));
        assert_eq!(split("gci | % { rm $_ }", Dialect::PowerShell).map_err(|e| e.label), Err(GROUPING));
        assert_eq!(split("Get-Content $env:X", Dialect::PowerShell).map_err(|e| e.label), Err(EXPANSION));
    }

    #[test]
    fn windows_quoting_differs() {
        // cmd has no single quotes and no backslash escapes.
        assert_eq!(words(r"type C:\x\y.txt & dir", Dialect::Cmd), vec![vec!["type", r"C:\x\y.txt"], vec!["dir"]]);
        assert_eq!(words("echo 'a & dir'", Dialect::Cmd), vec![vec!["echo", "'a"], vec!["dir'"]]);
        assert_eq!(words("dir 2>nul", Dialect::Cmd), vec![vec!["dir"]]);
        assert_eq!(words("Get-ChildItem 2> $null", Dialect::PowerShell), vec![vec!["Get-ChildItem"]]);
    }
}
