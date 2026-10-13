fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // DirectML.dll is delay-loaded: ONNX Runtime's DirectML provider links it, but the app does
    // not ship the 18 MB file. Nothing binds it until a decision model first runs on DirectML,
    // and before that nekko-decide loads a new enough copy (Windows' own, or one the host
    // downloaded); see crates/nekko-decide/src/directml.rs. Without this the loader binds it at
    // startup, and on Windows 10 that is a copy too old for the provider.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.ends_with("-windows-msvc") {
        println!("cargo:rustc-link-arg=/DELAYLOAD:DirectML.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
    }
}
