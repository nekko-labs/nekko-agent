//! The filesystem calls the TS tools make, with Node's results and errors.
//!
//! A failed tool call shows the model `e.message`, so the errors have to read
//! as Node's do (`ENOENT: no such file or directory, open '<path>'`), and a
//! few calls behave differently from their obvious Rust counterparts:
//! `readFileSync` on a directory fails at `read` with no path in the message,
//! `mkdirSync(..., { recursive: true })` reports the whole requested path, and
//! `readdirSync` lists in libuv's order (sorted by bytes on Unix, the
//! filesystem's own order on Windows).

use std::io;
use std::path::Path;

/// Node's error code and libuv's description for an OS error.
fn code_of(e: &io::Error) -> (&'static str, &'static str) {
    #[cfg(windows)]
    if let Some(raw) = e.raw_os_error() {
        // libuv's uv_translate_sys_error for the codes file calls produce.
        match raw {
            2 | 3 | 123 | 161 => return ("ENOENT", "no such file or directory"),
            5 => return ("EPERM", "operation not permitted"),
            32 | 33 => return ("EBUSY", "resource busy or locked"),
            80 | 183 => return ("EEXIST", "file already exists"),
            112 => return ("ENOSPC", "no space left on device"),
            206 => return ("ENAMETOOLONG", "name too long"),
            267 => return ("ENOTDIR", "not a directory"),
            _ => {}
        }
    }
    #[cfg(unix)]
    if let Some(raw) = e.raw_os_error() {
        match raw {
            libc::ENOENT => return ("ENOENT", "no such file or directory"),
            libc::EACCES => return ("EACCES", "permission denied"),
            libc::EPERM => return ("EPERM", "operation not permitted"),
            libc::EISDIR => return ("EISDIR", "illegal operation on a directory"),
            libc::ENOTDIR => return ("ENOTDIR", "not a directory"),
            libc::EEXIST => return ("EEXIST", "file already exists"),
            libc::ENAMETOOLONG => return ("ENAMETOOLONG", "name too long"),
            libc::ELOOP => return ("ELOOP", "too many symbolic links encountered"),
            libc::EBUSY => return ("EBUSY", "resource busy or locked"),
            libc::ENOSPC => return ("ENOSPC", "no space left on device"),
            libc::EROFS => return ("EROFS", "read-only file system"),
            libc::EMFILE => return ("EMFILE", "too many open files"),
            libc::EINVAL => return ("EINVAL", "invalid argument"),
            _ => {}
        }
    }
    match e.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::InvalidInput => ("EINVAL", "invalid argument"),
        _ => ("EIO", "i/o error"),
    }
}

/// Node's error code for an OS error (`ENOENT`, ...).
pub fn code_name(e: &io::Error) -> &'static str {
    code_of(e).0
}

/// `${code}: ${description}, ${syscall} '${path}'`, Node's message shape.
fn message(code: (&str, &str), syscall: &str, path: Option<&str>) -> String {
    match path {
        Some(p) => format!("{}: {}, {syscall} '{p}'", code.0, code.1),
        None => format!("{}: {}, {syscall}", code.0, code.1),
    }
}

fn os_error(e: &io::Error, syscall: &str, path: &str) -> String {
    message(code_of(e), syscall, Some(path))
}

const EISDIR: (&str, &str) = ("EISDIR", "illegal operation on a directory");
const ENOTDIR: (&str, &str) = ("ENOTDIR", "not a directory");
const EEXIST: (&str, &str) = ("EEXIST", "file already exists");

/// `existsSync`: follows links, and any error reads as "no".
pub fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

/// `readFileSync(p, 'utf8')`: invalid bytes become U+FFFD (Node and Rust
/// both replace maximal invalid subsequences), and a BOM is kept.
pub fn read_utf8(p: &str) -> Result<String, String> {
    if std::fs::metadata(p).is_ok_and(|m| m.is_dir()) {
        return Err(message(EISDIR, "read", None));
    }
    let bytes = std::fs::read(p).map_err(|e| os_error(&e, "open", p))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `writeFileSync(p, s, 'utf8')`.
pub fn write_utf8(p: &str, s: &str) -> Result<(), String> {
    if std::fs::metadata(p).is_ok_and(|m| m.is_dir()) {
        return Err(message(EISDIR, "open", Some(p)));
    }
    std::fs::write(p, s).map_err(|e| {
        // A parent that is a file: Node opens and gets ENOENT on Windows,
        // ENOTDIR on Unix, which is what the OS error already says.
        os_error(&e, "open", p)
    })
}

/// `mkdirSync(dir, { recursive: true })`.
pub fn mkdir_p(dir: &str) -> Result<(), String> {
    match std::fs::metadata(dir) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(_) => return Err(message(EEXIST, "mkdir", Some(dir))),
        Err(_) => {}
    }
    // An ancestor that exists as a file makes the whole request ENOTDIR.
    let mut ancestor = Path::new(dir).parent();
    while let Some(a) = ancestor {
        if let Ok(m) = std::fs::metadata(a) {
            if !m.is_dir() {
                return Err(message(ENOTDIR, "mkdir", Some(dir)));
            }
            break;
        }
        ancestor = a.parent();
    }
    std::fs::create_dir_all(dir).map_err(|e| os_error(&e, "mkdir", dir))
}

/// One `readdirSync(dir, { withFileTypes: true })` entry.
pub struct DirEntry {
    pub name: String,
    /// `Dirent.isDirectory()`: the entry itself, so a link to a directory is not one.
    pub is_dir: bool,
    /// `Dirent.isFile()`: a regular file, not a link to one.
    pub is_file: bool,
}

/// `readdirSync(dir, { withFileTypes: true })`, in libuv's order.
pub fn read_dir(dir: &str) -> Result<Vec<DirEntry>, String> {
    if std::fs::metadata(dir).is_ok_and(|m| !m.is_dir()) {
        return Err(message(ENOTDIR, "scandir", Some(dir)));
    }
    let rd = std::fs::read_dir(dir).map_err(|e| os_error(&e, "scandir", dir))?;
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| os_error(&e, "scandir", dir))?;
        // libuv on Windows calls any reparse point a link, cloud placeholders
        // included, where Rust would call some of them directories.
        #[cfg(windows)]
        let (is_dir, is_file) = entry.metadata().map_or((false, false), |m| {
            use std::os::windows::fs::MetadataExt;
            const DIRECTORY: u32 = 0x10;
            const REPARSE_POINT: u32 = 0x400;
            let a = m.file_attributes();
            (a & DIRECTORY != 0 && a & REPARSE_POINT == 0, a & (DIRECTORY | REPARSE_POINT) == 0)
        });
        #[cfg(not(windows))]
        let (is_dir, is_file) = entry.file_type().map_or((false, false), |t| (t.is_dir(), t.is_file()));
        out.push(DirEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir, is_file });
    }
    // libuv's scandir sorts with strcmp on Unix; on Windows it returns the
    // directory's own order, which is also what read_dir yields there.
    #[cfg(not(windows))]
    out.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    Ok(out)
}
