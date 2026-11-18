//! Explicit, copy-only portable-library import. Never merge existing libraries.
use crate::util::Dirs;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const OWNER: &str = ".prt-migration-owner";
type Result<T> = std::result::Result<T, String>;

fn io_error(action: &str, error: std::io::Error) -> String {
    format!("{action}: {error}")
}

fn plain_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

/// Resolve existing ancestors without creating a directory. This also catches aliases.
fn identity(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() { path.to_path_buf() } else {
        std::env::current_dir().map_err(|e| io_error("Cannot resolve current directory", e))?.join(path)
    };
    let mut clean = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {},
            Component::ParentDir => { if !clean.pop() { return Err("Invalid parent path".into()); } },
            other => clean.push(other.as_os_str()),
        }
    }
    let mut existing = clean.as_path();
    let mut missing = Vec::new();
    while !existing.exists() {
        missing.push(existing.file_name().ok_or("Cannot resolve path")?.to_os_string());
        existing = existing.parent().ok_or("Cannot resolve path parent")?;
    }
    let mut resolved = plain_path(fs::canonicalize(existing).map_err(|e| io_error("Cannot resolve path", e))?);
    for part in missing.into_iter().rev() { resolved.push(part); }
    Ok(resolved)
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    { text.to_lowercase() }
    #[cfg(not(windows))]
    { text }
}

fn within(child: &Path, parent: &Path) -> bool {
    let child = path_key(child);
    let parent = path_key(parent).trim_end_matches('/').to_string();
    child == parent || child.starts_with(&(parent + "/"))
}

fn overlap(a: &Path, b: &Path) -> bool { within(a, b) || within(b, a) }

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}

fn reject_links(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_link(&metadata) => return Err("Symbolic links, junctions and cloud placeholders cannot be imported. Copy them to a local folder first.".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(io_error("Cannot inspect storage path", error)),
        }
    }
    Ok(())
}

fn empty_or_missing(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("Cannot inspect destination", error)),
        Ok(metadata) if !metadata.is_dir() || is_link(&metadata) => Err("A destination is not a normal directory.".into()),
        Ok(_) => {
            if fs::read_dir(path).map_err(|e| io_error("Cannot inspect destination", e))?.next().is_some() {
                Err("The installed library already contains files. Import will not merge or overwrite it. Use a fresh destination or keep the existing library.".into())
            } else { Ok(()) }
        }
    }
}

/// The raw key remains compatible with all older portable prt executables.
pub struct DataLock {
    #[cfg(windows)]
    handles: Vec<*mut std::ffi::c_void>,
}

impl DataLock {
    pub fn unlocked() -> Self {
        Self {
            #[cfg(windows)]
            handles: Vec::new(),
        }
    }
}

#[cfg(windows)]
impl Drop for DataLock {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        unsafe extern "system" { fn CloseHandle(handle: *mut std::ffi::c_void) -> i32; }
        for handle in self.handles.drain(..) { unsafe { CloseHandle(handle); } }
    }
}

pub fn acquire_data_lock(path: &Path) -> Result<DataLock> {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateMutexW(attributes: *mut c_void, owner: i32, name: *const u16) -> *mut c_void;
            fn GetLastError() -> u32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        let mut guard = DataLock::unlocked();
        let mut seen = HashSet::new();
        for alias in [path.to_path_buf(), identity(path)?] {
            let key = alias.to_string_lossy().to_lowercase();
            if !seen.insert(key.clone()) { continue; }
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            key.hash(&mut hasher);
            let name: Vec<u16> = format!("Local\\prt-{:016x}", hasher.finish()).encode_utf16().chain(Some(0)).collect();
            let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
            if handle.is_null() { return Err("Cannot lock the library. Close other prt windows and retry.".into()); }
            if unsafe { GetLastError() } == 183 {
                unsafe { CloseHandle(handle); }
                return Err("This library is in use. Close the old and installed prt readers, then retry the import.".into());
            }
            guard.handles.push(handle);
        }
        Ok(guard)
    }
    #[cfg(not(windows))]
    { let _ = path; Ok(DataLock::unlocked()) }
}

#[derive(Clone)]
struct Plan { target: PathBuf, stage: PathBuf, present: bool }

struct Transaction { journal: PathBuf, id: String, source: PathBuf, plans: Vec<Plan> }

fn journal_path(dirs: &Dirs) -> Result<PathBuf> {
    let data = identity(&dirs.data)?;
    let papers = identity(&dirs.papers)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path_key(&data).hash(&mut hasher);
    path_key(&papers).hash(&mut hasher);
    Ok(data.parent().ok_or("Data directory has no parent")?.join(format!(".prt-migration-{:016x}.json", hasher.finish())))
}

pub fn pending(dirs: &Dirs) -> Result<bool> { Ok(journal_path(dirs)?.exists()) }

fn stage_path(target: &Path, id: &str, index: usize) -> Result<PathBuf> {
    Ok(target.parent().ok_or("Destination has no parent")?.join(format!(".prt-import-{id}-{index}")))
}

fn owned(path: &Path, id: &str) -> bool {
    fs::read(path.join(OWNER)).map(|value| value == id.as_bytes()).unwrap_or(false)
}

fn remove_owned(path: &Path, id: &str) -> Result<()> {
    if !path.exists() { return Ok(()); }
    reject_links(path)?;
    if !owned(path, id) {
        // A crash between mkdir and writing the marker can only leave an empty stage.
        if fs::read_dir(path).map_err(|e| io_error("Cannot inspect temporary import", e))?.next().is_none() {
            return fs::remove_dir(path).map_err(|e| io_error("Cannot remove empty import stage", e));
        }
        return Err("Import recovery found an unrecognized temporary directory; it was left unchanged.".into());
    }
    // Keep the ownership proof until all content is gone. A failed/terminated cleanup
    // must remain recognizable when the user retries the same import.
    for entry in fs::read_dir(path).map_err(|e| io_error("Cannot inspect temporary import", e))? {
        let entry = entry.map_err(|e| io_error("Cannot inspect temporary import entry", e))?;
        if entry.file_name() == OWNER { continue; }
        let child = entry.path();
        let metadata = fs::symlink_metadata(&child).map_err(|e| io_error("Cannot inspect temporary import entry", e))?;
        if is_link(&metadata) { return Err("A temporary import contains an unexpected link; it was preserved for inspection.".into()); }
        // Each path is a direct child of the derived, ownership-checked stage.
        if metadata.is_dir() {
            fs::remove_dir_all(&child).map_err(|e| io_error("Cannot clean temporary import folder", e))?;
        } else {
            fs::remove_file(&child).map_err(|e| io_error("Cannot clean temporary import file", e))?;
        }
    }
    fs::remove_file(path.join(OWNER)).map_err(|e| io_error("Cannot remove temporary import marker", e))?;
    fs::remove_dir(path).map_err(|e| io_error("Cannot remove empty import stage", e))
}

fn save_journal(transaction: &Transaction, phase: &str, files: u64, bytes: u64) -> Result<()> {
    let body = json!({"version":1,"id":transaction.id,"source":transaction.source,"phase":phase,
        "targets":transaction.plans.iter().map(|p| json!({"path":p.target,"present":p.present})).collect::<Vec<_>>(),
        "filesCopied":files,"bytesCopied":bytes});
    let temp = transaction.journal.with_extension(format!("{}.{}.tmp", transaction.id, phase));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| io_error("Cannot prepare import recovery record", e))?;
    file.write_all(serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| io_error("Cannot write import recovery record", e))?;
    file.sync_all().map_err(|e| io_error("Cannot flush import recovery record", e))?;
    drop(file);
    fs::rename(&temp, &transaction.journal).map_err(|e| io_error("Cannot save import recovery record", e))
}

fn rollback(transaction: &Transaction) -> Result<()> {
    for plan in &transaction.plans {
        if !plan.present { continue; }
        if owned(&plan.target, &transaction.id) {
            if plan.stage.exists() { return Err("Import recovery found conflicting directories; all files were preserved.".into()); }
            fs::rename(&plan.target, &plan.stage).map_err(|e| io_error("Cannot roll back incomplete import", e))?;
        }
        remove_owned(&plan.stage, &transaction.id)?;
    }
    fs::remove_file(&transaction.journal).map_err(|e| io_error("Cannot finish import recovery", e))
}

fn finish(transaction: &Transaction) -> Result<()> {
    for plan in &transaction.plans {
        if plan.present && owned(&plan.target, &transaction.id) {
            fs::remove_file(plan.target.join(OWNER)).map_err(|e| io_error("Cannot finish imported library", e))?;
        }
    }
    fs::remove_file(&transaction.journal).map_err(|e| io_error("Cannot clear completed import record", e))
}

/// A committed import can finish its bookkeeping after a crash; incomplete imports roll back before retrying.
fn recover(source: &Path, dirs: &Dirs) -> Result<Option<(u64, u64)>> {
    let journal = journal_path(dirs)?;
    if !journal.exists() { return Ok(None); }
    reject_links(&journal)?;
    let saved: Value = serde_json::from_slice(&fs::read(&journal).map_err(|e| io_error("Cannot read import recovery record", e))?)
        .map_err(|_| "The import recovery record is damaged. Existing files were preserved.".to_string())?;
    let id = saved["id"].as_str().filter(|id| !id.is_empty() && id.len() < 80 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        .ok_or("Invalid import recovery identifier; files were preserved")?.to_string();
    if saved["version"] != 1 || saved["source"].as_str().map(Path::new) != Some(source) {
        return Err("An unfinished import belongs to another source folder. Retry with that original source before importing anything else.".into());
    }
    let mut plans = Vec::new();
    for (index, target) in [&dirs.data, &dirs.papers].iter().enumerate() {
        let target = identity(target)?;
        if saved["targets"][index]["path"].as_str().map(Path::new) != Some(target.as_path()) {
            return Err("Import recovery destinations do not match. Existing files were preserved.".into());
        }
        plans.push(Plan { stage:stage_path(&target, &id, index)?, target, present:saved["targets"][index]["present"].as_bool().ok_or("Invalid import recovery record")? });
    }
    let transaction = Transaction { journal, id, source:source.to_path_buf(), plans };
    match saved["phase"].as_str() {
        Some("complete") => {
            for plan in &transaction.plans {
                if plan.present && !plan.target.is_dir() { return Err("A completed import destination is missing. Files were preserved for inspection.".into()); }
            }
            finish(&transaction)?;
            Ok(Some((saved["filesCopied"].as_u64().unwrap_or(0), saved["bytesCopied"].as_u64().unwrap_or(0))))
        },
        Some("copying") | Some("committing") => { rollback(&transaction)?; Ok(None) },
        _ => Err("Unknown import recovery phase. Existing files were preserved.".into()),
    }
}

fn copy_tree(source: &Path, destination: &Path, counts: &mut (u64, u64), fail_after: Option<u64>) -> Result<()> {
    for entry in fs::read_dir(source).map_err(|e| io_error("Cannot read old library", e))? {
        let entry = entry.map_err(|e| io_error("Cannot read old library entry", e))?;
        let source = entry.path();
        let metadata = fs::symlink_metadata(&source).map_err(|e| io_error("Cannot inspect old library entry", e))?;
        if is_link(&metadata) { return Err("The old library contains a symbolic link, junction or cloud placeholder. Make a local copy before importing.".into()); }
        if entry.file_name() == OWNER { return Err("The old library contains an unfinished import marker. Resolve it before importing.".into()); }
        let destination = destination.join(entry.file_name());
        if metadata.is_dir() {
            fs::create_dir(&destination).map_err(|e| io_error("Cannot create imported folder", e))?;
            copy_tree(&source, &destination, counts, fail_after)?;
        } else if metadata.is_file() {
            if fail_after.map(|limit| counts.0 >= limit).unwrap_or(false) { return Err("Synthetic interrupted copy".into()); }
            let mut input = File::open(&source).map_err(|e| io_error("Cannot read old library file. Close the old reader before importing", e))?;
            let mut output = OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|e| io_error("Cannot create imported file", e))?;
            let copied = std::io::copy(&mut input, &mut output).map_err(|e| io_error("Cannot copy library file", e))?;
            output.sync_all().map_err(|e| io_error("Cannot flush imported file", e))?;
            if copied != metadata.len() || input.metadata().map_err(|e| io_error("Cannot verify source file", e))?.len() != metadata.len() {
                return Err("The old library changed during copying. Close the old reader and retry.".into());
            }
            counts.0 += 1; counts.1 += copied;
        } else { return Err("The old library contains an unsupported file type.".into()); }
    }
    Ok(())
}

fn migrate_inner(source: &Path, dirs: &Dirs, fail_after: Option<u64>, fail_commit: bool) -> Result<(u64, u64)> {
    if !source.is_absolute() { return Err("Choose an absolute old-version folder containing data and/or papers.".into()); }
    reject_links(source)?;
    if !source.is_dir() { return Err("The selected old-version folder is not a directory.".into()); }
    let source = identity(source)?;
    for target in [&dirs.data, &dirs.papers] { reject_links(target)?; }
    let targets = [identity(&dirs.data)?, identity(&dirs.papers)?];
    if overlap(&targets[0], &targets[1]) || targets.iter().any(|target| overlap(target, &source)) {
        return Err("Source and destination folders must be separate, without shared or nested paths.".into());
    }
    let _source_lock = acquire_data_lock(&source.join("data"))?;
    let _destination_lock = acquire_data_lock(&dirs.data)?;
    if let Some(counts) = recover(&source, dirs)? { return Ok(counts); }
    for target in &targets { empty_or_missing(target)?; }
    let sources = [source.join("data"), source.join("papers")];
    let present = sources.iter().map(|path| {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_error("Cannot inspect old library", error)),
            Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => Ok(true),
            Ok(_) => Err("The old data or papers path is not a normal directory.".into()),
        }
    }).collect::<Result<Vec<bool>>>()?;
    if !present.iter().any(|value| *value) { return Err("The selected folder contains neither data nor papers.".into()); }
    let id = format!("{:x}-{:x}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos());
    let plans = targets.iter().enumerate().map(|(index, target)| Ok(Plan { target:target.clone(), stage:stage_path(target, &id, index)?, present:present[index] })).collect::<Result<Vec<_>>>()?;
    let transaction = Transaction { journal:journal_path(dirs)?, id, source, plans };
    for plan in &transaction.plans {
        fs::create_dir_all(plan.target.parent().ok_or("Destination parent is unavailable")?).map_err(|e| io_error("Cannot create destination parent", e))?;
    }
    save_journal(&transaction, "copying", 0, 0)?;
    let mut counts = (0, 0);
    let result = (|| {
        for (index, plan) in transaction.plans.iter().enumerate() {
            if !plan.present { continue; }
            fs::create_dir(&plan.stage).map_err(|e| io_error("Cannot prepare temporary import directory", e))?;
            fs::write(plan.stage.join(OWNER), transaction.id.as_bytes()).map_err(|e| io_error("Cannot mark temporary import directory", e))?;
            copy_tree(&sources[index], &plan.stage, &mut counts, fail_after)?;
        }
        save_journal(&transaction, "committing", counts.0, counts.1)?;
        for (index, plan) in transaction.plans.iter().enumerate() {
            if !plan.present { continue; }
            empty_or_missing(&plan.target)?;
            if plan.target.exists() { fs::remove_dir(&plan.target).map_err(|e| io_error("Cannot prepare empty destination", e))?; }
            if fail_commit && index == 1 { return Err("Synthetic interrupted commit".into()); }
            fs::rename(&plan.stage, &plan.target).map_err(|e| io_error("Cannot commit imported library", e))?;
        }
        save_journal(&transaction, "complete", counts.0, counts.1)?;
        Ok(())
    })();
    if let Err(error) = result {
        return match rollback(&transaction) {
            Ok(()) => Err(error),
            Err(recovery) => Err(format!("{error}\n{recovery}\nRetry the same import to recover; the old library is unchanged.")),
        };
    }
    finish(&transaction)?;
    Ok(counts)
}

fn option(args: &[String], name: &str) -> Result<Option<String>> {
    let mut result = None;
    for (index, arg) in args.iter().enumerate() {
        let value = if arg == name {
            Some(args.get(index + 1).filter(|value| !value.starts_with("--")).ok_or_else(|| format!("{name} requires a value"))?.clone())
        } else { arg.strip_prefix(&format!("{name}=")).map(str::to_string) };
        if let Some(value) = value { if value.is_empty() || result.replace(value).is_some() { return Err(format!("{name} must appear once with a non-empty value")); } }
    }
    Ok(result)
}

fn notify(message: &str) {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        unsafe extern "system" { fn MessageBoxW(window: *mut c_void, text: *const u16, title: *const u16, kind: u32) -> i32; }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "prt — import".encode_utf16().chain(Some(0)).collect();
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10); }
    }
    #[cfg(not(windows))]
    { let _ = message; }
}

pub fn notify_incomplete() { notify("An earlier library import did not finish. Run Setup again and choose the same old-version folder to recover. No reader was started and the old library is unchanged."); }

pub fn handle_cli(args: &[String], dirs: &Dirs) -> Option<i32> {
    let storage = args.iter().any(|arg| arg == "--storage-info");
    let migration = args.iter().any(|arg| arg == "--migrate-from" || arg.starts_with("--migrate-from="));
    if !storage && !migration { return None; }
    let silent = args.iter().any(|arg| arg == "--silent" || arg == "--background");
    let mut source = None;
    let mut report = None;
    let mut body = json!({"ok":false,"operation":if migration {"migration"} else {"storage-info"},
        "mode":if crate::util::is_installed(&dirs.exe) {"installed"} else {"portable"},
        "data":dirs.data,"papers":dirs.papers,"exe":dirs.exe});
    let result = (|| -> Result<()> {
        if migration && storage { return Err("Choose either --storage-info or --migrate-from.".into()); }
        source = option(args, "--migrate-from")?.map(PathBuf::from);
        if let Some(path) = source.as_ref() { body["source"] = json!(path); }
        if let Some(value) = option(args, "--report")? {
            let path = PathBuf::from(value);
            if !path.is_absolute() { return Err("--report requires a new absolute file path.".into()); }
            reject_links(&path)?;
            let resolved = identity(&path)?;
            let data = identity(&dirs.data)?;
            let papers = identity(&dirs.papers)?;
            if within(&resolved, &data) || within(&resolved, &papers) || resolved == journal_path(dirs)?
                || source.as_ref().map(|source| identity(source).map(|source| within(&resolved, &source))).transpose()?.unwrap_or(false) {
                return Err("The report must be outside the old folder and both destination libraries.".into());
            }
            report = Some(OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| io_error("Cannot create a new report file", e))?);
        }
        if migration {
            let (files, bytes) = migrate_inner(source.as_deref().ok_or("Missing old-version folder")?, dirs, None, false)?;
            body["filesCopied"] = json!(files); body["bytesCopied"] = json!(bytes);
        } else { body["migrationPending"] = json!(pending(dirs)?); }
        Ok(())
    })();
    let mut exit = if result.is_ok() { 0 } else { 2 };
    body["ok"] = json!(result.is_ok());
    if let Err(error) = result { body["error"] = json!(error); }
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{\"ok\":false}".into());
    if let Some(mut file) = report {
        if file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).is_err() { exit = 3; }
    }
    let _ = writeln!(std::io::stdout(), "{text}");
    if exit != 0 && !silent { notify(body["error"].as_str().unwrap_or("Import finished but its report could not be saved. Check the destination before retrying.")); }
    Some(exit)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("prt-migration-test-{}-{nonce}", std::process::id()));
            fs::create_dir(&root).unwrap(); Self(root)
        }
        fn dirs(&self) -> Dirs { Dirs { exe:self.0.join("app"), data:self.0.join("new/data"), papers:self.0.join("documents/papers") } }
        fn source(&self) -> PathBuf {
            let source = self.0.join("old");
            fs::create_dir_all(source.join("data/webview2/Local Storage")).unwrap();
            fs::create_dir_all(source.join("papers/course")).unwrap();
            fs::write(source.join("data/config.json"), b"synthetic configuration").unwrap();
            fs::write(source.join("data/webview2/Local Storage/fixture"), b"synthetic browser preferences").unwrap();
            fs::write(source.join("papers/course/test.pdf"), b"synthetic paper").unwrap(); source
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) { assert!(self.0.starts_with(std::env::temp_dir())); let _ = fs::remove_dir_all(&self.0); }
    }
    #[test]
    fn copies_both_trees_and_browser_preferences_without_touching_source() {
        let test = Sandbox::new(); let source=test.source(); let dirs=test.dirs();
        let counts=migrate_inner(&source,&dirs,None,false).unwrap(); assert_eq!(counts.0,3);
        assert_eq!(fs::read(source.join("data/config.json")).unwrap(),fs::read(dirs.data.join("config.json")).unwrap());
        assert_eq!(fs::read(dirs.data.join("webview2/Local Storage/fixture")).unwrap(),b"synthetic browser preferences");
        assert!(dirs.papers.join("course/test.pdf").exists()); assert!(!pending(&dirs).unwrap());
    }
    #[test]
    fn existing_destination_is_never_merged_or_overwritten() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        fs::create_dir_all(&dirs.data).unwrap();fs::write(dirs.data.join("keep"),b"original").unwrap();
        assert!(migrate_inner(&source,&dirs,None,false).is_err());
        assert_eq!(fs::read(dirs.data.join("keep")).unwrap(),b"original");assert!(!dirs.papers.exists());
    }
    #[test]
    fn empty_destinations_are_accepted() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        fs::create_dir_all(&dirs.data).unwrap();fs::create_dir_all(&dirs.papers).unwrap();
        assert!(migrate_inner(&source,&dirs,None,false).is_ok());
    }
    #[test]
    fn interrupted_copy_leaves_source_and_can_retry() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        assert!(migrate_inner(&source,&dirs,Some(1),false).is_err());
        assert!(!dirs.data.exists());assert!(!dirs.papers.exists());assert!(!pending(&dirs).unwrap());
        assert!(source.join("data/config.json").exists());assert!(migrate_inner(&source,&dirs,None,false).is_ok());
    }
    #[test]
    fn second_commit_failure_rolls_back_first_tree_and_can_retry() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        assert!(migrate_inner(&source,&dirs,None,true).is_err());
        assert!(!dirs.data.exists());assert!(!dirs.papers.exists());assert!(!pending(&dirs).unwrap());
        assert!(migrate_inner(&source,&dirs,None,false).is_ok());
    }
    #[test]
    fn rejects_self_copy_nested_paths_and_shared_destinations() {
        let test=Sandbox::new();let source=test.source();let mut dirs=test.dirs();
        dirs.data=source.join("data");assert!(migrate_inner(&source,&dirs,None,false).is_err());
        dirs=test.dirs();dirs.papers=source.join("nested/papers");assert!(migrate_inner(&source,&dirs,None,false).is_err());
        dirs=test.dirs();dirs.papers=dirs.data.join("papers");assert!(migrate_inner(&source,&dirs,None,false).is_err());
        dirs=test.dirs();dirs.data=test.0.clone();assert!(migrate_inner(&source,&dirs,None,false).is_err());
    }
    #[test]
    fn rejects_missing_or_non_directory_sources_and_destinations() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        assert!(migrate_inner(Path::new("relative"),&dirs,None,false).is_err());
        assert!(migrate_inner(&source.join("data/config.json"),&dirs,None,false).is_err());
        fs::create_dir_all(dirs.data.parent().unwrap()).unwrap();fs::write(&dirs.data,b"not directory").unwrap();
        assert!(migrate_inner(&source,&dirs,None,false).is_err());
    }
    #[test]
    fn accepts_one_source_tree_but_rejects_neither() {
        let test=Sandbox::new();let source=test.0.join("old");let dirs=test.dirs();fs::create_dir(&source).unwrap();
        assert!(migrate_inner(&source,&dirs,None,false).is_err());fs::create_dir(source.join("papers")).unwrap();
        fs::write(source.join("papers/a.pdf"),b"paper").unwrap();assert!(migrate_inner(&source,&dirs,None,false).is_ok());assert!(!dirs.data.exists());
    }
    #[test]
    fn reports_cannot_overwrite_existing_files_or_enter_library_trees() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        let existing=source.join("data/config.json");
        let args=vec!["--migrate-from".into(),source.to_string_lossy().into_owned(),"--report".into(),existing.to_string_lossy().into_owned(),"--silent".into()];
        assert_eq!(handle_cli(&args,&dirs),Some(2));assert_eq!(fs::read(existing).unwrap(),b"synthetic configuration");assert!(!dirs.data.exists());
        let report=test.0.join("report.json");fs::write(&report,b"keep").unwrap();
        assert_eq!(handle_cli(&["--storage-info".into(),"--report".into(),report.to_string_lossy().into_owned(),"--silent".into()],&dirs),Some(2));assert_eq!(fs::read(report).unwrap(),b"keep");
    }
    #[test]
    fn storage_info_does_not_create_libraries() {
        let test=Sandbox::new();let dirs=test.dirs();let report=test.0.join("report.json");
        assert_eq!(handle_cli(&["--storage-info".into(),"--report".into(),report.to_string_lossy().into_owned(),"--silent".into()],&dirs),Some(0));
        let value:Value=serde_json::from_slice(&fs::read(report).unwrap()).unwrap();assert_eq!(value["ok"],true);assert!(!dirs.data.exists());assert!(!dirs.papers.exists());
    }
    fn interrupted_transaction(source: &Path, dirs: &Dirs) -> Transaction {
        let id="aabb-1234".to_string();
        let plans=[&dirs.data,&dirs.papers].iter().enumerate().map(|(index,target)| {
            let target=identity(target).unwrap();fs::create_dir_all(target.parent().unwrap()).unwrap();
            let stage=stage_path(&target,&id,index).unwrap();fs::create_dir(&stage).unwrap();
            fs::write(stage.join(OWNER),id.as_bytes()).unwrap();
            copy_tree(&source.join(if index==0 {"data"} else {"papers"}),&stage,&mut (0,0),None).unwrap();
            Plan { target,stage,present:true }
        }).collect();
        Transaction { journal:journal_path(dirs).unwrap(),id,source:identity(source).unwrap(),plans }
    }
    #[test]
    fn recovers_a_crash_between_commits_before_retrying() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        let transaction=interrupted_transaction(&source,&dirs);save_journal(&transaction,"committing",3,0).unwrap();
        fs::rename(&transaction.plans[0].stage,&transaction.plans[0].target).unwrap();assert!(pending(&dirs).unwrap());
        assert_eq!(migrate_inner(&source,&dirs,None,false).unwrap().0,3);assert!(!pending(&dirs).unwrap());
        assert_eq!(fs::read(dirs.data.join("config.json")).unwrap(),b"synthetic configuration");
        assert!(source.join("data/config.json").exists());
    }
    #[test]
    fn completes_bookkeeping_after_a_committed_import_crashes() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        let transaction=interrupted_transaction(&source,&dirs);
        for plan in &transaction.plans { fs::rename(&plan.stage,&plan.target).unwrap(); }
        save_journal(&transaction,"complete",3,99).unwrap();
        fs::remove_file(transaction.plans[0].target.join(OWNER)).unwrap();
        assert_eq!(migrate_inner(&source,&dirs,None,false).unwrap(),(3,99));assert!(!pending(&dirs).unwrap());
        assert!(!transaction.plans[1].target.join(OWNER).exists());
    }
    #[cfg(windows)]
    #[test]
    fn interrupted_cleanup_retains_ownership_and_retries_safely() {
        use std::os::windows::fs::OpenOptionsExt;
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        let transaction=interrupted_transaction(&source,&dirs);
        save_journal(&transaction,"copying",0,0).unwrap();
        let locked=OpenOptions::new().read(true).share_mode(1).open(transaction.plans[0].stage.join("config.json")).unwrap();
        assert!(rollback(&transaction).is_err());
        assert!(owned(&transaction.plans[0].stage,&transaction.id));assert!(pending(&dirs).unwrap());
        drop(locked);
        assert_eq!(migrate_inner(&source,&dirs,None,false).unwrap().0,3);
        assert!(!pending(&dirs).unwrap());assert!(source.join("data/config.json").exists());
    }
    #[test]
    fn report_cannot_replace_recovery_journal() {
        let test=Sandbox::new();let dirs=test.dirs();fs::create_dir_all(dirs.data.parent().unwrap()).unwrap();
        let path=journal_path(&dirs).unwrap();
        assert_eq!(handle_cli(&["--storage-info".into(),"--report".into(),path.to_string_lossy().into_owned(),"--silent".into()],&dirs),Some(2));
        assert!(!path.exists());
    }
    #[cfg(windows)]
    #[test]
    fn rejects_junctions_without_traversing_external_content() {
        use std::os::windows::process::CommandExt;
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        let external=test.0.join("outside");fs::create_dir(&external).unwrap();fs::write(external.join("keep"),b"outside").unwrap();
        let junction=source.join("papers/link");
        let result=std::process::Command::new("cmd.exe").args(["/d","/c","mklink","/J"]).arg(identity(&junction).unwrap()).arg(identity(&external).unwrap()).creation_flags(0x08000000).output().unwrap();
        assert!(result.status.success(),"Could not create synthetic junction: {} {}",String::from_utf8_lossy(&result.stdout),String::from_utf8_lossy(&result.stderr));
        assert!(migrate_inner(&source,&dirs,None,false).is_err());assert_eq!(fs::read(external.join("keep")).unwrap(),b"outside");
        assert!(!dirs.data.exists());assert!(!dirs.papers.exists());
        fs::remove_dir(&junction).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn running_source_or_destination_is_rejected() {
        let test=Sandbox::new();let source=test.source();let dirs=test.dirs();
        let lock=acquire_data_lock(&source.join("data")).unwrap();assert!(migrate_inner(&source,&dirs,None,false).is_err());drop(lock);
        let lock=acquire_data_lock(&dirs.data).unwrap();assert!(migrate_inner(&source,&dirs,None,false).is_err());drop(lock);
        assert!(migrate_inner(&source,&dirs,None,false).is_ok());
    }
}
