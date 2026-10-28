//! Discover shell feature modules at build time; runtime never scans source files.
use std::{env, fs, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let directory = root.join("src/shell_features");
    println!("cargo:rerun-if-changed=src/shell_features");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut modules = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
        .collect::<Vec<_>>();
    modules.sort();
    let mut output = String::new();
    for path in &modules {
        let name = path.file_stem().unwrap().to_str().unwrap();
        assert!(
            name.as_bytes()[0].is_ascii_lowercase()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        );
        if name.ends_with("_test") {
            output.push_str("#[cfg(test)]\n");
        }
        output.push_str(&format!("mod {name} {{ include!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/src/shell_features/{name}.rs\")); }}\n"));
    }
    output.push_str("fn modules() -> &'static [(&'static str, &'static dyn ShellFeature)] { &[\n");
    for path in modules {
        let name = path.file_stem().unwrap().to_str().unwrap();
        if name.ends_with("_test") {
            output.push_str("#[cfg(test)]\n");
        }
        output.push_str(&format!("({name:?}, {name}::FEATURE),\n"));
    }
    output.push_str("] }\n");
    let file = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("shell_features.rs");
    if fs::read_to_string(&file).ok().as_ref() != Some(&output) {
        fs::write(file, output).unwrap();
    }
}
