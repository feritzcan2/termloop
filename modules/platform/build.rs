#[path = "src/dev_profile_identity.rs"]
mod dev_profile_identity;

fn main() {
    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"),
    );
    let checkout = manifest
        .join("../..")
        .canonicalize()
        .expect("platform crate must live beneath the repository root");
    let git_marker = checkout.join(".git");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/dev_profile_identity.rs");
    if git_marker.is_file() {
        let profile = dev_profile_identity::development_profile_id(&checkout);
        println!("cargo:rustc-env=TERMLOOP_COMPILED_DEV_PROFILE={profile}");
    }
}
