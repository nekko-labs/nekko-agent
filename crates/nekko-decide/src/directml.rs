//! Choosing the DirectML.dll the DirectML provider runs on.
//!
//! The app does not ship DirectML.dll (18 MB that most users never touch): `nekkod` delay-loads
//! it (crates/nekkod/build.rs), so nothing binds it until ONNX Runtime first calls into it, and
//! by then this module has loaded the right copy. Once a module named `DirectML.dll` is in the
//! process, the delay-load helper's by-name `LoadLibrary` gets that module back rather than
//! searching again. The copies, in order:
//!
//! 1. one already loaded (an earlier session, or a process that links it the usual way),
//! 2. the one the host downloaded, passed in `LoadOptions::directml`,
//! 3. one beside the executable (a development build, where ort-sys copies it into `target/`),
//! 4. Windows' own `System32\DirectML.dll`, when it is at least [`MIN_VERSION`].
//!
//! With none of these the provider is skipped with a reason and the session runs on the CPU.
//! Windows 10's copy predates the API ONNX Runtime's DirectML provider is built against; Windows
//! 11 has carried a new enough one since 2024, so most machines never download anything.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The DirectML ONNX Runtime 1.28's provider was built against (ort-sys's prebuilt binaries
/// ship 1.15.4): anything older than 1.15 lacks entry points it calls.
pub const MIN_VERSION: (u16, u16, u16) = (1, 15, 0);

/// A DirectML.dll found on disk, not yet loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub source: &'static str,
    pub version: Option<(u16, u16, u16, u16)>,
}

impl Candidate {
    fn usable(&self) -> bool {
        self.version.is_some_and(|(a, b, c, _)| (a, b, c) >= MIN_VERSION)
    }

    fn version_string(&self) -> Option<String> {
        self.version.map(|(a, b, c, _)| format!("{a}.{b}.{c}"))
    }
}

/// What `decide:status` reports, so the host knows whether to download a copy before loading.
/// `available` is whether a usable DirectML exists without downloading anything.
pub fn status(explicit: Option<&Path>) -> Value {
    if !cfg!(windows) {
        return json!({ "available": false, "reason": "DirectML is Windows only." });
    }
    let found = candidates(explicit);
    let system = found.iter().find(|c| c.source == "system");
    let pick = found.iter().find(|c| c.usable());
    json!({
        "available": pick.is_some(),
        "source": pick.map(|c| c.source),
        "path": pick.map(|c| &c.path),
        "version": pick.and_then(Candidate::version_string),
        "systemVersion": system.and_then(Candidate::version_string),
        "minVersion": format!("{}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2),
    })
}

/// The copies on disk, in the order they are preferred.
fn candidates(explicit: Option<&Path>) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut push = |path: PathBuf, source: &'static str| {
        if path.is_file() && !out.iter().any(|c: &Candidate| c.path == path) {
            let version = sys::file_version(&path);
            out.push(Candidate { path, source, version });
        }
    };
    if let Some(p) = explicit {
        push(p.to_path_buf(), "downloaded");
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        push(dir.join("DirectML.dll"), "beside the executable");
    }
    if let Some(dir) = sys::system_dir() {
        push(dir.join("DirectML.dll"), "system");
    }
    out
}

/// Make sure the process has a usable DirectML.dll loaded before ONNX Runtime asks for one.
/// Returns a short description of the copy in use, or why there is none.
pub fn prepare(explicit: Option<&Path>) -> Result<String, String> {
    if let Some(path) = sys::loaded() {
        return Ok(format!("DirectML already loaded from {}", path.display()));
    }
    let found = candidates(explicit);
    let Some(pick) = found.iter().find(|c| c.usable()) else {
        let system = found.iter().find(|c| c.source == "system").and_then(Candidate::version_string);
        return Err(match system {
            Some(v) => format!(
                "Windows has DirectML {v}, older than the {}.{} this runtime needs, and no newer copy has been downloaded",
                MIN_VERSION.0, MIN_VERSION.1
            ),
            None => "DirectML.dll is not installed and no copy has been downloaded".into(),
        });
    };
    sys::load(&pick.path)?;
    Ok(format!("DirectML {} ({})", pick.version_string().unwrap_or_default(), pick.source))
}

#[cfg(windows)]
mod sys {
    use std::ffi::{OsStr, OsString, c_void};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleW, LOAD_WITH_ALTERED_SEARCH_PATH, LoadLibraryExW,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }

    pub fn system_dir() -> Option<PathBuf> {
        let mut buf = [0u16; 520];
        // SAFETY: the buffer and its length match; the call writes at most that many units.
        let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        (n > 0 && n < buf.len()).then(|| PathBuf::from(OsString::from_wide(&buf[..n])))
    }

    /// Where the process's DirectML.dll came from, when one is loaded.
    pub fn loaded() -> Option<PathBuf> {
        let name = wide(OsStr::new("DirectML.dll"));
        // SAFETY: a NUL-terminated wide string; a null handle means it is not loaded.
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        if module.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        // SAFETY: the handle came from GetModuleHandleW and the buffer length matches.
        let n = unsafe { GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32) } as usize;
        Some(PathBuf::from(OsString::from_wide(&buf[..n.min(buf.len())])))
    }

    /// Load by full path, so its own dependencies resolve from its folder. The module stays
    /// loaded for the life of the process, which is what the delay-load helper relies on.
    pub fn load(path: &Path) -> Result<(), String> {
        let p = wide(path.as_os_str());
        // SAFETY: a NUL-terminated wide path; no file handle is passed.
        let module = unsafe { LoadLibraryExW(p.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH) };
        if module.is_null() {
            return Err(format!("couldn't load {}: {}", path.display(), std::io::Error::last_os_error()));
        }
        Ok(())
    }

    /// The fixed file version (`major.minor.build.revision`) of a PE file.
    pub fn file_version(path: &Path) -> Option<(u16, u16, u16, u16)> {
        let p = wide(path.as_os_str());
        // SAFETY: a NUL-terminated wide path; the handle out-parameter is optional.
        let size = unsafe { GetFileVersionInfoSizeW(p.as_ptr(), std::ptr::null_mut()) };
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        // SAFETY: the buffer is exactly the size the previous call asked for.
        if unsafe { GetFileVersionInfoW(p.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
            return None;
        }
        let root = wide(OsStr::new("\\"));
        let mut info: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        // SAFETY: `data` holds a version resource; VerQueryValueW points into it.
        if unsafe { VerQueryValueW(data.as_ptr().cast(), root.as_ptr(), &mut info, &mut len) } == 0
            || info.is_null()
            || (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
        {
            return None;
        }
        // SAFETY: checked non-null and large enough above; it points into `data`, still alive.
        let fixed = unsafe { &*(info as *const VS_FIXEDFILEINFO) };
        let hi = fixed.dwFileVersionMS;
        let lo = fixed.dwFileVersionLS;
        Some(((hi >> 16) as u16, hi as u16, (lo >> 16) as u16, lo as u16))
    }
}

#[cfg(not(windows))]
mod sys {
    use std::path::{Path, PathBuf};

    pub fn system_dir() -> Option<PathBuf> {
        None
    }

    pub fn loaded() -> Option<PathBuf> {
        None
    }

    pub fn load(_: &Path) -> Result<(), String> {
        Err("DirectML is Windows only".into())
    }

    pub fn file_version(_: &Path) -> Option<(u16, u16, u16, u16)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_floor_is_inclusive() {
        let c = |v| Candidate { path: PathBuf::from("x"), source: "system", version: Some(v) };
        assert!(c((1, 15, 0, 0)).usable());
        assert!(c((1, 15, 5, 0)).usable());
        assert!(c((2, 0, 0, 0)).usable());
        assert!(!c((1, 14, 9, 0)).usable());
        assert!(!c((1, 8, 2, 0)).usable());
        assert!(!Candidate { path: PathBuf::from("x"), source: "system", version: None }.usable());
    }

    #[test]
    fn a_missing_explicit_copy_is_not_a_candidate() {
        let found = candidates(Some(Path::new("/definitely/not/DirectML.dll")));
        assert!(found.iter().all(|c| c.source != "downloaded"));
    }

    #[cfg(windows)]
    #[test]
    fn reads_a_real_file_version() {
        // kernel32 is on every Windows machine and always carries a version resource.
        let k = sys::system_dir().unwrap().join("kernel32.dll");
        let (major, ..) = sys::file_version(&k).expect("kernel32 has a version");
        assert!(major >= 6);
    }
}
