use super::*;
use crate::skill_manager::tests::{temporary_directory, write_skill};
use std::fs;

fn fixture(path: &str, bytes: &[u8]) -> SkillPackageFile {
    SkillPackageFile {
        path: path.into(),
        content_base64: STANDARD.encode(bytes),
        executable: false,
    }
}

#[test]
fn package_copies_scripts_references_private_assets_and_binary_bytes() {
    let root = temporary_directory("skill-package");
    let source = root.join("source");
    let target = root.join("target");
    let directory = source.join(".agents/skills/testing-changes-with-aspire");
    write_skill(&directory, "testing-changes-with-aspire", "Test APIs.");
    let resources: [(&str, &[u8]); 4] = [
        (
            "scripts/run_local.py",
            b"#!/usr/bin/env python3\nprint('test')\n",
        ),
        ("references/nucleus-local-aspire.md", b"Local setup\n"),
        (
            "assets/appsettings.developer.overrides.json",
            b"{\"test\":true}",
        ),
        ("assets/image.bin", &[0, 255, 128, 10]),
    ];
    for (path, bytes) in resources {
        let path = directory.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    set_executable(&directory.join("scripts/run_local.py"), true).unwrap();
    let manager = SkillManager { backend: None };
    let catalog = manager
        .catalog_at(&source, SkillCatalogScope::global())
        .unwrap();
    let package = manager
        .read_package_at(&source, SkillCatalogScope::global(), &catalog.skills[0].id)
        .unwrap();
    assert_eq!(package.files.len(), 5);
    let catalog = manager
        .create_user_package_at(&target, "testing-changes-with-aspire", &package.files)
        .unwrap();
    assert_eq!(catalog.skills.len(), 1);
    let copied = target.join(".agents/skills/testing-changes-with-aspire");
    for (path, bytes) in resources {
        assert_eq!(fs::read(copied.join(path)).unwrap(), bytes);
    }
    assert_eq!(
        fs::read(copied.join("SKILL.md")).unwrap(),
        fs::read(directory.join("SKILL.md")).unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(copied.join("scripts/run_local.py"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(copied.join("assets/appsettings.developer.overrides.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&copied).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    fs::write(copied.join("SKILL.md"), "existing content").unwrap();
    assert!(matches!(
        manager.create_user_package_at(&target, "testing-changes-with-aspire", &package.files),
        Err(SkillManagerError::SkillAlreadyExists)
    ));
    assert_eq!(
        fs::read_to_string(copied.join("SKILL.md")).unwrap(),
        "existing content"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_packages_leave_no_destination() {
    let root = temporary_directory("skill-package-invalid");
    let manager = SkillManager { backend: None };
    for path in [
        "../escape",
        "/absolute",
        "C:/escape",
        "a\\b",
        "a//b",
        "a/./b",
        "NUL.txt",
        "a/COM1",
        "a/b.",
        "a/b ",
        "a:b",
        "a\0b",
    ] {
        let files = vec![fixture("SKILL.md", b"skill"), fixture(path, b"data")];
        assert!(
            matches!(
                manager.create_user_package_at(&root, "example", &files),
                Err(SkillManagerError::InvalidPackage)
            ),
            "{path:?}"
        );
        assert!(!root.join(".agents").exists());
    }
    for files in [
        vec![fixture("scripts/run.py", b"no definition")],
        vec![
            fixture("SKILL.md", b"skill"),
            fixture("skill.md", b"collision"),
        ],
        vec![
            fixture("SKILL.md", b"skill"),
            fixture("Scripts/a.py", b"first"),
            fixture("scripts/b.py", b"aliased folder"),
        ],
        vec![
            fixture("SKILL.md", b"skill"),
            fixture("a", b"file"),
            fixture("a/b", b"child"),
        ],
        vec![
            fixture("SKILL.md", b"skill"),
            fixture("a/b", b"child"),
            fixture("a", b"file"),
        ],
        vec![fixture("SKILL.md", &[255])],
        vec![SkillPackageFile {
            path: "SKILL.md".into(),
            content_base64: "invalid!".into(),
            executable: false,
        }],
    ] {
        assert!(matches!(
            manager.create_user_package_at(&root, "example", &files),
            Err(SkillManagerError::InvalidPackage)
        ));
        assert!(!root.join(".agents").exists());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn package_bounds_apply_to_combined_content_and_file_count() {
    let files = vec![
        fixture("SKILL.md", b"skill"),
        fixture("asset", &vec![0; MAX_BYTES]),
    ];
    assert!(matches!(
        validate_files(&files),
        Err(SkillManagerError::PackageTooLarge)
    ));
    let files = vec![fixture("SKILL.md", b"skill"); MAX_FILES + 1];
    assert!(matches!(
        validate_files(&files),
        Err(SkillManagerError::PackageTooLarge)
    ));
    let files = vec![
        fixture("SKILL.md", b"skill"),
        fixture("asset", &vec![0; MAX_BYTES - 5]),
    ];
    assert!(validate_files(&files).is_ok());
    // The complete base64 payload still fits the existing 8 MiB control limit.
    assert!(serde_json::to_vec(&files).unwrap().len() < 8 * 1024 * 1024);
}

#[test]
fn export_rejects_oversized_resources_instead_of_truncating() {
    let root = temporary_directory("skill-package-large");
    let directory = root.join(".agents/skills/example");
    write_skill(&directory, "example", "Test.");
    fs::File::create(directory.join("large.bin"))
        .unwrap()
        .set_len((MAX_BYTES + 1) as u64)
        .unwrap();
    let manager = SkillManager { backend: None };
    let catalog = manager
        .catalog_at(&root, SkillCatalogScope::global())
        .unwrap();
    assert!(matches!(
        manager.read_package_at(&root, SkillCatalogScope::global(), &catalog.skills[0].id),
        Err(SkillManagerError::PackageTooLarge)
    ));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn export_rejects_symbolic_links_instead_of_leaking_or_omitting_resources() {
    let root = temporary_directory("skill-package-link");
    let directory = root.join(".agents/skills/example");
    write_skill(&directory, "example", "Test.");
    fs::write(root.join("outside"), "private").unwrap();
    std::os::unix::fs::symlink(root.join("outside"), directory.join("linked")).unwrap();
    let manager = SkillManager { backend: None };
    let catalog = manager
        .catalog_at(&root, SkillCatalogScope::global())
        .unwrap();
    assert!(matches!(
        manager.read_package_at(&root, SkillCatalogScope::global(), &catalog.skills[0].id),
        Err(SkillManagerError::InvalidPackage)
    ));
    fs::remove_dir_all(root).unwrap();
}
