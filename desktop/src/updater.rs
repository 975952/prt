//! Official release updates. This module never reads the user's model or library data.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LATEST: &str = "https://api.github.com/repos/975952/prt/releases/latest";
const MAX_RELEASE: u64 = 2 * 1024 * 1024;
const MAX_SUMS: u64 = 64 * 1024;
const MAX_BINARY: u64 = 300 * 1024 * 1024;
const PLAN: &str = "update-plan.json";
const HELPER: &str = "update-helper.exe";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug)]
struct Release { version: String, url: String, sha256: String, size: u64, asset: String }
#[derive(Default)]
struct State {
    phase: &'static str, error: String, release: Option<Release>, payload: Option<PathBuf>,
    bytes: u64, total: u64, launching: bool,
}
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| {
        let failed = std::env::args().any(|arg| arg == "--update-failed");
        Mutex::new(State { phase: if failed { "error" } else { "idle" },
            error: if failed { "The update could not be completed. The previous reader has been reopened.".into() } else { String::new() }, ..State::default() })
    })
}
fn lock() -> std::sync::MutexGuard<'static, State> { state().lock().unwrap_or_else(|e| e.into_inner()) }
fn installed() -> bool {
    std::env::current_exe().ok().and_then(|p| p.parent().map(crate::util::is_installed)).unwrap_or(false)
}
fn auto_allowed() -> bool {
    !["PRT_BACKGROUND", "PRT_DIAGNOSTICS"].iter().any(|key| std::env::var_os(key).is_some())
        && !std::env::args().any(|arg| arg == "--background")
}
fn status_of(s: &State) -> Value {
    json!({"supported":cfg!(windows), "currentVersion":env!("CARGO_PKG_VERSION"),
        "mode":if installed() {"installed"} else {"portable"}, "phase":s.phase,
        "availableVersion":s.release.as_ref().map(|r| r.version.as_str()).unwrap_or(""),
        "error":s.error, "bytes":s.bytes, "total":s.total, "autoCheckAllowed":auto_allowed()})
}
pub fn status() -> Value { status_of(&lock()) }
pub fn is_ready() -> bool { let s = lock(); s.phase == "ready" && s.payload.is_some() && !s.launching }

fn version(raw: &str) -> Option<[u64; 3]> {
    let mut parts = raw.strip_prefix('v').unwrap_or(raw).split('.');
    let mut result = [0; 3];
    for n in &mut result {
        let part = parts.next()?;
        if part.is_empty() || (part.len() > 1 && part.starts_with('0')) || !part.bytes().all(|c| c.is_ascii_digit()) { return None; }
        *n = part.parse().ok()?;
    }
    if parts.next().is_some() { None } else { Some(result) }
}
fn asset_url(tag: &str, asset: &str) -> String { format!("https://github.com/975952/prt/releases/download/{tag}/{asset}") }
fn validate_asset(value: &Value, tag: &str, name: &str, max: u64) -> Result<(String, u64)> {
    let matches: Vec<_> = value.get("assets").and_then(Value::as_array).ok_or("Release has no assets")?
        .iter().filter(|a| a["name"].as_str() == Some(name)).collect();
    if matches.len() != 1 { return Err(format!("Release must contain exactly one {name}")); }
    let a = matches[0];
    let expected = asset_url(tag, name);
    if a["browser_download_url"].as_str() != Some(expected.as_str()) { return Err("Update asset URL is not an official release URL".into()); }
    let size = a["size"].as_u64().filter(|n| *n > 0 && *n <= max).ok_or("Invalid update asset size")?;
    Ok((expected, size))
}
fn release_assets(value: &Value, current: &str, is_installed: bool) -> Result<Option<(Release, String)>> {
    if value["draft"] != false || value["prerelease"] != false { return Err("Only stable public releases can be installed".into()); }
    let tag = value["tag_name"].as_str().ok_or("Release has no version")?;
    if !tag.starts_with('v') { return Err("Release version must be vX.Y.Z".into()); }
    let remote = version(tag).ok_or("Release version must be vX.Y.Z")?;
    let local = version(current).ok_or("Invalid current version")?;
    if remote <= local { return Ok(None); }
    let asset = if is_installed { "prt-setup.exe" } else { "prt.exe" };
    let (url, size) = validate_asset(value, tag, asset, MAX_BINARY)?;
    let (sums, _) = validate_asset(value, tag, "SHA256SUMS.txt", MAX_SUMS)?;
    Ok(Some((Release { version: tag[1..].into(), url, size, sha256: String::new(), asset: asset.into() }, sums)))
}
fn checksum(sums: &str, asset: &str) -> Result<String> {
    let mut found = None;
    for line in sums.lines() {
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else { continue; };
        let Some(name) = parts.next() else { continue; };
        if name.trim_start_matches('*') != asset { continue; }
        if parts.next().is_some() || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || found.is_some() {
            return Err("Invalid or duplicate release checksum".into());
        }
        found = Some(hash.to_ascii_lowercase());
    }
    found.ok_or_else(|| format!("Release checksum is missing for {asset}"))
}
fn agent() -> Result<ureq::Agent> {
    let tls = ureq::native_tls::TlsConnector::new().map_err(|_| "Cannot initialize system TLS")?;
    Ok(ureq::AgentBuilder::new().tls_connector(std::sync::Arc::new(tls))
        .timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(15)).redirects(0).build())
}
fn allowed_redirect(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false; };
    u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && u.port().is_none()
        && matches!(u.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"))
}
fn response(client: &ureq::Agent, url: &str, timeout: Duration) -> Result<ureq::Response> {
    let started = Instant::now();
    let mut next = url.to_owned();
    for _ in 0..5 {
        let remaining = timeout.checked_sub(started.elapsed()).ok_or("Update request timed out")?;
        let res = client.get(&next).set("User-Agent", concat!("prt/", env!("CARGO_PKG_VERSION")))
            .set("Accept", "application/vnd.github+json").timeout(remaining).call()
            .map_err(|e| match e { ureq::Error::Status(code, _) => format!("Update server returned HTTP {code}"),
                _ => "Cannot connect to the update server".into() })?;
        if (300..400).contains(&res.status()) {
            let location = res.header("Location").ok_or("Update redirect has no location")?;
            if !allowed_redirect(location) { return Err("Update redirect is not an official HTTPS download host".into()); }
            next = location.to_owned();
        } else if res.status() == 200 { return Ok(res); }
        else { return Err("Unexpected update response".into()); }
    }
    Err("Too many update redirects".into())
}
fn text_response(response: ureq::Response, max: u64) -> Result<String> {
    let mut bytes = Vec::new();
    response.into_reader().take(max + 1).read_to_end(&mut bytes).map_err(|_| "Cannot read update metadata")?;
    if bytes.len() as u64 > max { return Err("Update metadata exceeds the size limit".into()); }
    String::from_utf8(bytes).map_err(|_| "Invalid update metadata encoding".into())
}
fn check_release() -> Result<Option<Release>> {
    prune_completed_updates();
    let client = agent()?;
    let raw = text_response(response(&client, LATEST, Duration::from_secs(45))?, MAX_RELEASE)?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| "Invalid release metadata")?;
    let Some((mut release, sums_url)) = release_assets(&value, env!("CARGO_PKG_VERSION"), installed())? else { return Ok(None); };
    release.sha256 = checksum(&text_response(response(&client, &sums_url, Duration::from_secs(45))?, MAX_SUMS)?, &release.asset)?;
    Ok(Some(release))
}
fn worker(name: &str, task: impl FnOnce() -> Result<()> + Send + 'static) -> Result<()> {
    std::thread::Builder::new().name(name.into()).spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task))
            .unwrap_or_else(|_| Err("Update task failed unexpectedly".into()));
        if let Err(error) = result { let mut s = lock(); s.phase = "error"; s.error = error; }
    }).map(|_| ()).map_err(|_| { let mut s = lock(); s.phase = "error"; s.error = "Cannot start update task".into(); s.error.clone() })
}
pub fn check() -> Result<Value> {
    { let mut s = lock();
      if s.launching || matches!(s.phase, "checking" | "downloading" | "ready") { return Ok(status_of(&s)); }
      s.phase = "checking"; s.error.clear(); s.release = None; s.payload = None; s.bytes = 0; s.total = 0; }
    worker("prt-update-check", || {
        let release = check_release()?;
        let mut s = lock(); s.phase = if release.is_some() { "available" } else { "up_to_date" };
        s.total = release.as_ref().map(|r| r.size).unwrap_or(0); s.release = release; Ok(())
    })?;
    Ok(status())
}
fn cache_root() -> Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(dirs::data_local_dir).ok_or("Cannot locate the update cache")?;
    if !base.is_absolute() { return Err("Update cache must be an absolute path".into()); }
    Ok(base.join("prt").join("updates"))
}
fn unique_directory(root: &Path, ver: &str) -> Result<PathBuf> {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fs::create_dir_all(root).map_err(|_| "Cannot create the update cache")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Invalid system clock")?.as_nanos();
    let serial=SERIAL.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
    let dir = root.join(format!("{ver}-{}-{nonce}-{serial}", std::process::id()));
    fs::create_dir(&dir).map_err(|_| "Cannot create the update download directory")?;
    Ok(dir)
}
fn prune_completed_updates() {
    let Ok(root)=cache_root() else {return;};
    let Ok(entries)=fs::read_dir(&root) else {return;};
    for entry in entries.take(200).flatten() {
        let dir=entry.path();
        let Ok(meta)=fs::symlink_metadata(&dir) else {continue;};
        if !meta.is_dir() || meta.file_type().is_symlink() {continue;}
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 {continue;} }
        let marker=dir.join("completed");
        let old=fs::metadata(&marker).and_then(|m|m.modified()).ok().and_then(|t|t.elapsed().ok())
            .is_some_and(|elapsed|elapsed>Duration::from_secs(7*24*3600));
        if !old {continue;}
        // Only successful helper leftovers are eligible; never recurse into arbitrary files.
        let Ok(files)=fs::read_dir(&dir) else {continue;};
        if files.filter_map(|f|f.ok()).any(|f|!matches!(f.file_name().to_str(),Some(HELPER|"completed"))) {continue;}
        if fs::remove_file(dir.join(HELPER)).is_err() {continue;}
        let _=fs::remove_file(marker); let _=fs::remove_dir(dir);
    }
}
fn write_verified(mut input: impl Read, path: &Path, expected_size: u64, expected_hash: &str,
    mut progress: impl FnMut(u64)) -> Result<()> {
    if expected_size == 0 || expected_size > MAX_BINARY { return Err("Invalid update binary size".into()); }
    let mut output = OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "Cannot create update download")?;
    let result = (|| {
        let mut hash = Sha256::new(); let mut bytes = 0u64; let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = input.read(&mut buffer).map_err(|_| "Update download interrupted")?;
            if n == 0 { break; } bytes += n as u64;
            if bytes > expected_size || bytes > MAX_BINARY { return Err("Update download exceeds the expected size".into()); }
            output.write_all(&buffer[..n]).map_err(|_| "Cannot save update download")?;
            hash.update(&buffer[..n]); progress(bytes);
        }
        if bytes != expected_size { return Err("Update download is incomplete".into()); }
        if format!("{:x}", hash.finalize()) != expected_hash { return Err("Update SHA256 verification failed".into()); }
        output.sync_all().map_err(|_| "Cannot flush update download")?; Ok(())
    })();
    drop(output);
    if result.is_err() { let _ = fs::remove_file(path); }
    result
}
pub fn download() -> Result<Value> {
    let release;
    { let mut s = lock();
      if s.launching || matches!(s.phase, "checking" | "downloading" | "ready") { return Ok(status_of(&s)); }
      release = s.release.clone().ok_or("Check for an update before downloading")?;
      s.phase = "downloading"; s.error.clear(); s.bytes = 0; s.total = release.size; s.payload = None; }
    worker("prt-update-download", move || {
        let directory = unique_directory(&cache_root()?, &release.version)?;
        let payload = directory.join(&release.asset);
        let result = (|| {
            let res = response(&agent()?, &release.url, Duration::from_secs(600))?;
            if res.header("Content-Length").and_then(|s| s.parse::<u64>().ok()).is_some_and(|n| n != release.size) {
                return Err("Update size does not match the release metadata".into());
            }
            write_verified(res.into_reader(), &payload, release.size, &release.sha256, |bytes| lock().bytes = bytes)?;
            let mut s = lock(); s.payload = Some(payload.clone()); s.phase = "ready"; Ok(())
        })();
        if result.is_err() { let _ = fs::remove_file(&payload); let _ = fs::remove_dir(&directory); } result
    })?;
    Ok(status())
}
fn sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|_| "Cannot open update file")?;
    let mut hash = Sha256::new(); let mut buffer = [0u8; 64 * 1024];
    loop { let n = file.read(&mut buffer).map_err(|_| "Cannot read update file")?; if n == 0 { break; } hash.update(&buffer[..n]); }
    Ok(format!("{:x}", hash.finalize()))
}
fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}
fn helper_command(helper: &Path, plan: &Path) -> Command {
    let mut command = Command::new(helper);
    #[cfg(not(test))] command.arg("--apply-update").arg(plan);
    #[cfg(test)] command.args(["--exact", "updater::tests::helper_process_fixture", "--nocapture"])
        .env("PRT_UPDATER_TEST_ROLE", "helper").env("PRT_UPDATER_TEST_PLAN", plan);
    hidden(&mut command); command
}
fn restart_command(target: &Path, failed: bool) -> Command {
    let mut command = Command::new(target);
    #[cfg(not(test))] if failed { command.arg("--update-failed"); }
    #[cfg(test)] command.args(["--exact", "updater::tests::helper_process_fixture", "--nocapture"])
        .env("PRT_UPDATER_TEST_ROLE", "restarted").env("PRT_UPDATER_TEST_RESTART_FAILED", if failed {"1"}else{"0"});
    hidden(&mut command); command
}
fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) { (Ok(a), Ok(b)) => a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()), _ => false }
}

#[cfg(windows)]
mod process {
    use super::*;
    use std::ffi::c_void;
    #[repr(C)] #[derive(Default)] struct FileTime { low: u32, high: u32 }
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetProcessTimes(handle: *mut c_void, created: *mut FileTime, exited: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn QueryFullProcessImageNameW(handle: *mut c_void, flags: u32, name: *mut u16, length: *mut u32) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    }
    pub struct Process(*mut c_void);
    impl Drop for Process { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    impl Process {
        pub fn open(pid: u32) -> Result<Self> {
            let handle = unsafe { OpenProcess(0x00100000 | 0x1000, 0, pid) };
            if handle.is_null() { Err("Cannot verify the running reader process".into()) } else { Ok(Self(handle)) }
        }
        pub fn created(&self) -> Result<u64> {
            let (mut a, mut b, mut c, mut d) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
            if unsafe { GetProcessTimes(self.0, &mut a, &mut b, &mut c, &mut d) } == 0 { return Err("Cannot verify reader start time".into()); }
            Ok((a.high as u64) << 32 | a.low as u64)
        }
        pub fn image(&self) -> Result<PathBuf> {
            let mut path = vec![0u16; 32768]; let mut length = path.len() as u32;
            if unsafe { QueryFullProcessImageNameW(self.0, 0, path.as_mut_ptr(), &mut length) } == 0 { return Err("Cannot verify the reader executable".into()); }
            Ok(PathBuf::from(String::from_utf16_lossy(&path[..length as usize])))
        }
        pub fn wait(&self, milliseconds: u32) -> Result<()> {
            if unsafe { WaitForSingleObject(self.0, milliseconds) } == 0 { Ok(()) } else { Err("The reader did not exit in time. No update was applied.".into()) }
        }
    }
}

pub fn launch_installer() -> Result<()> {
    #[cfg(not(windows))] { return Err("Updates are supported on Windows only".into()); }
    #[cfg(windows)] {
        let (release, payload) = { let mut s = lock();
            if s.phase != "ready" || s.launching { return Err("The update is not ready".into()); }
            let result = (s.release.clone().ok_or("Missing release")?, s.payload.clone().ok_or("Missing update download")?);
            s.launching = true; result };
        let result = (|| {
            if sha256(&payload)? != release.sha256 { return Err("Update SHA256 verification failed".into()); }
            let target = std::env::current_exe().map_err(|_| "Cannot locate the reader executable")?;
            let directory = payload.parent().ok_or("Invalid update directory")?;
            let helper = directory.join(HELPER); let plan = directory.join(PLAN);
            fs::copy(&target, &helper).map_err(|_| "Cannot prepare the update helper")?;
            let parent = process::Process::open(std::process::id())?;
            let value = json!({"version":release.version,"mode":if installed(){"installed"}else{"portable"},
                "target":target,"payload":payload,"sha256":release.sha256,"size":release.size,
                "parentPid":std::process::id(),"parentCreated":parent.created()?.to_string()});
            fs::write(&plan, serde_json::to_vec(&value).map_err(|_| "Cannot encode update plan")?).map_err(|_| "Cannot save update plan")?;
            let _ = fs::remove_file(directory.join("helper-ready"));
            let _ = fs::remove_file(directory.join("helper-error.txt"));
            let mut child = helper_command(&helper, &plan).spawn().map_err(|_| "Cannot start update helper")?;
            let acknowledged = (|| {
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(5) {
                    if directory.join("helper-ready").is_file() { return Ok(()); }
                    if child.try_wait().map_err(|_| "Cannot verify update helper")?.is_some() { return Err("The update helper could not start safely".into()); }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err("Update helper did not acknowledge startup. Keep the reader open and retry.".into())
            })();
            if acknowledged.is_err() { let _ = child.kill(); let _ = child.wait(); }
            acknowledged
        })();
        if result.is_err() { lock().launching = false; }
        result
    }
}
fn plan_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> { value[key].as_str().filter(|s| !s.is_empty()).ok_or_else(|| format!("Invalid update plan: {key}")) }
fn checked_plan(path: &Path) -> Result<(Value, PathBuf)> {
    let path = fs::canonicalize(path).map_err(|_| "Cannot find update plan")?;
    let root = fs::canonicalize(cache_root()?).map_err(|_| "Cannot verify update cache")?;
    let directory = path.parent().ok_or("Invalid update plan directory")?.to_path_buf();
    if path.file_name().and_then(|s| s.to_str()) != Some(PLAN) || directory.parent() != Some(root.as_path()) {
        return Err("Update plan is outside the update cache".into());
    }
    if !same_path(&std::env::current_exe().map_err(|_| "Cannot locate update helper")?, &directory.join(HELPER)) {
        return Err("Update helper must run from its own download directory".into());
    }
    let raw = fs::read(&path).map_err(|_| "Cannot read update plan")?;
    if raw.len() > 16384 { return Err("Update plan is too large".into()); }
    let value: Value = serde_json::from_slice(&raw).map_err(|_| "Invalid update plan JSON")?;
    if version(plan_string(&value, "version")?).is_none() { return Err("Invalid update version".into()); }
    let mode = plan_string(&value, "mode")?;
    let asset = match mode { "installed" => "prt-setup.exe", "portable" => "prt.exe", _ => return Err("Invalid update mode".into()) };
    if !same_path(Path::new(plan_string(&value, "payload")?), &directory.join(asset)) { return Err("Invalid update payload path".into()); }
    let target = Path::new(plan_string(&value, "target")?);
    if !target.is_absolute() || target.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref() != Some("exe")
        || same_path(target, &directory.join(HELPER)) || target.starts_with(&root) { return Err("Invalid reader executable path".into()); }
    Ok((value, directory))
}
fn portable_replace(payload: &Path, target: &Path, backup: &Path) -> Result<()> {
    let stage = target.with_extension(format!("update-{}.tmp", std::process::id()));
    fs::copy(payload, &stage).map_err(|_| "Cannot stage the new reader executable")?;
    if let Err(error) = fs::rename(target, backup) { let _ = fs::remove_file(&stage); return Err(format!("Cannot preserve the previous reader: {error}")); }
    if let Err(error) = fs::rename(&stage, target) {
        let _ = fs::rename(backup, target); let _ = fs::remove_file(&stage);
        return Err(format!("Cannot install the new reader: {error}"));
    }
    Ok(())
}
fn installer_command(payload: &Path, target: &Path) -> Result<Command> {
    let mut command = Command::new(payload);
    command.args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"])
        .arg(format!("/DIR={}", target.parent().ok_or("Missing install directory")?.display()));
    hidden(&mut command); Ok(command)
}
fn wait_installer_for(child: &mut Child, timeout: Duration) -> Result<()> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(status) = child.try_wait().map_err(|_| "Cannot wait for setup")? {
            return if status.success() { Ok(()) } else { Err(format!("Setup failed ({status})")) };
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("Setup has not completed. Check the installation before restarting prt.".into())
}
fn recover_reader(target: &Path, backup: &Path, original_hash: &str) -> Result<()> {
    if sha256(target).ok().as_deref() != Some(original_hash) {
        if sha256(backup).ok().as_deref() != Some(original_hash) { return Err("The previous reader is preserved but could not be verified for restart".into()); }
        if target.exists() {
            let rejected = target.with_extension(format!("failed-update-{}.exe",std::process::id()));
            portable_replace(backup, target, &rejected)?;
        } else { fs::copy(backup,target).map_err(|_| "Cannot restore the previous reader executable")?; }
    }
    restart_command(target, true).current_dir(target.parent().ok_or("Missing reader directory")?).spawn()
        .map_err(|_| "The previous executable is preserved but could not be restarted")?;
    Ok(())
}
#[cfg(windows)]
fn apply_update(plan: &Path) -> Result<()> {
    let (value, directory) = checked_plan(plan)?;
    let target = PathBuf::from(plan_string(&value, "target")?);
    let payload = PathBuf::from(plan_string(&value, "payload")?);
    let parent_pid = value["parentPid"].as_u64().filter(|p| *p > 0 && *p <= u32::MAX as u64).ok_or("Invalid parent process")? as u32;
    let parent = process::Process::open(parent_pid)?;
    if !same_path(&parent.image()?, &target) || parent.created()?.to_string() != plan_string(&value, "parentCreated")? {
        return Err("Reader process identity did not match the update plan".into());
    }
    if sha256(&std::env::current_exe().map_err(|_| "Cannot locate helper")?)? != sha256(&target)? {
        return Err("Update helper does not match the running reader".into());
    }
    let original_hash = sha256(&target)?;
    let size = value["size"].as_u64().filter(|n| *n > 0 && *n <= MAX_BINARY).ok_or("Invalid update size")?;
    if fs::metadata(&payload).map_err(|_| "Missing update download")?.len() != size
        || sha256(&payload)? != plan_string(&value, "sha256")? { return Err("Update verification failed before installation".into()); }
    fs::write(directory.join("helper-ready"), b"ready").map_err(|_| "Cannot acknowledge update startup")?;
    parent.wait(60000)?;
    // Recheck after the wait: a download changed while the reader was closing is never executed.
    let backup = target.with_extension(format!("previous-{}.exe", std::process::id()));
    let installed_mode = value["mode"] == "installed";
    let mut installer_running = false;
    let applied = (|| {
        if sha256(&payload)? != plan_string(&value, "sha256")? { return Err("Update download changed before installation".into()); }
        if installed_mode {
            fs::copy(&target, &backup).map_err(|_| "Cannot back up the installed reader")?;
            let mut child = installer_command(&payload,&target)?.spawn().map_err(|_| "Cannot start setup")?;
            let result = wait_installer_for(&mut child,Duration::from_secs(600));
            installer_running = !matches!(child.try_wait(),Ok(Some(_)));
            result
        } else { portable_replace(&payload,&target,&backup) }
    })();
    if let Err(error) = applied {
        if installer_running { return Err(error); } // Setup still owns installation files; never race it with rollback or restart.
        let recovery = recover_reader(&target,&backup,&original_hash);
        return Err(match recovery { Ok(())=>error,Err(recovery)=>format!("{error}. {recovery}") });
    }
    let launched = restart_command(&target,false).current_dir(target.parent().ok_or("Missing reader directory")?).spawn();
    if let Err(error) = launched {
        let recovery = recover_reader(&target,&backup,&original_hash);
        return Err(format!("The update could not restart prt: {error}{}", recovery.err().map(|e|format!(". {e}")).unwrap_or_default()));
    }
    let _ = fs::remove_file(&backup);
    let _ = fs::remove_file(&payload);
    let _ = fs::remove_file(directory.join(PLAN));
    let _ = fs::remove_file(directory.join("helper-ready"));
    let _ = fs::write(directory.join("completed"),b"Update installed and reader restarted. Old helper cache is removed after seven days.");
    Ok(())
}
/// Runs before normal storage initialization and the single-instance guard.
pub fn handle_cli(args: &[String]) -> Option<i32> {
    if !args.iter().any(|arg| arg == "--apply-update") { return None; }
    if args.len() != 2 || args[0] != "--apply-update" { return Some(2); }
    #[cfg(windows)] let result = apply_update(Path::new(&args[1]));
    #[cfg(not(windows))] let result: Result<()> = Err("Updates require Windows".into());
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            // Write only beside this helper, never into a path supplied by an invalid plan.
            if let Ok(current) = std::env::current_exe() {
                if current.file_name().and_then(|s| s.to_str()) == Some(HELPER) {
                    if let Some(dir) = current.parent() { let _ = fs::write(dir.join("helper-error.txt"), &error); }
                }
            }
            let _ = writeln!(std::io::stderr(), "{error}"); Some(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(installed: bool) -> Value {
        let tag = "v9.8.7"; let name = if installed { "prt-setup.exe" } else { "prt.exe" };
        json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":[
            {"name":name,"browser_download_url":asset_url(tag,name),"size":3},
            {"name":"SHA256SUMS.txt","browser_download_url":asset_url(tag,"SHA256SUMS.txt"),"size":100}]})
    }
    struct Scratch(PathBuf);
    impl Scratch { fn new() -> Self { Self(unique_directory(&std::env::temp_dir().join("prt-updater-tests"), "test").unwrap()) } }
    impl Drop for Scratch { fn drop(&mut self) { assert!(self.0.starts_with(std::env::temp_dir())); let _ = fs::remove_dir_all(&self.0); } }
    #[test] fn stable_versions_only_and_strictly_newer() {
        for bad in ["1.2", "1.2.3.4", "1.2.3-beta", "1.2.3+1", "01.2.3", "1.-2.3", "1.2.3/"] { assert_eq!(version(bad),None,"{bad}"); }
        assert!(release_assets(&fixture(false),"9.8.7",false).unwrap().is_none());
        assert!(release_assets(&fixture(false),"10.0.0",false).unwrap().is_none());
        assert_eq!(release_assets(&fixture(true),"1.4.3",true).unwrap().unwrap().0.asset,"prt-setup.exe");
        let mut f=fixture(false); f["prerelease"]=json!(true); assert!(release_assets(&f,"1.0.0",false).is_err());
    }
    #[test] fn only_fixed_repository_tag_and_asset_urls() {
        for url in ["http://github.com/975952/prt/releases/download/v9.8.7/prt.exe", "https://evil.test/prt.exe", "https://github.com/other/prt/releases/download/v9.8.7/prt.exe", "https://github.com/975952/prt/releases/download/v9.8.6/prt.exe"] {
            let mut f=fixture(false); f["assets"][0]["browser_download_url"]=json!(url); assert!(release_assets(&f,"1.0.0",false).is_err());
        }
        let mut f=fixture(false); f["assets"].as_array_mut().unwrap().pop(); assert!(release_assets(&f,"1.0.0",false).is_err());
        assert!(!allowed_redirect("http://release-assets.githubusercontent.com/a"));
        assert!(!allowed_redirect("https://github.com.evil.test/a"));
        assert!(!allowed_redirect("https://user@github.com/a"));
        assert!(allowed_redirect("https://release-assets.githubusercontent.com/a?token=x"));
    }
    #[test] fn checksums_are_required_and_unambiguous() {
        let h="a".repeat(64); assert_eq!(checksum(&format!("{h}  prt.exe\n"),"prt.exe").unwrap(),h);
        assert!(checksum(&format!("{h} other.exe"),"prt.exe").is_err());
        assert!(checksum(&format!("{h} prt.exe\n{h} prt.exe"),"prt.exe").is_err());
        assert!(checksum("xyz prt.exe","prt.exe").is_err());
    }
    #[test] fn failed_or_tampered_download_never_remains_installable() {
        let dir=Scratch::new(); let file=dir.0.join("prt.exe"); let hash=format!("{:x}",Sha256::digest(b"abc"));
        write_verified(&b"abc"[..],&file,3,&hash, |_|{}).unwrap(); assert_eq!(sha256(&file).unwrap(),hash); fs::remove_file(&file).unwrap();
        for data in [&b"ab"[..],&b"abcd"[..],&b"xyz"[..]] { assert!(write_verified(data,&file,3,&hash, |_|{}).is_err()); assert!(!file.exists()); }
        struct Failed; impl Read for Failed { fn read(&mut self,_:&mut [u8])->std::io::Result<usize>{Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset,"test"))} }
        assert!(write_verified(Failed,&file,3,&hash, |_|{}).is_err()); assert!(!file.exists());
    }
    #[test] fn portable_replacement_preserves_backup_and_never_changes_library() {
        let dir=Scratch::new(); let target=dir.0.join("prt.exe"); let payload=dir.0.join("new.exe"); let backup=dir.0.join("old.exe");
        fs::write(&target,b"old").unwrap(); fs::write(&payload,b"new").unwrap(); fs::create_dir(dir.0.join("data")).unwrap(); fs::write(dir.0.join("data/sentinel"),b"keep").unwrap();
        portable_replace(&payload,&target,&backup).unwrap(); assert_eq!(fs::read(&target).unwrap(),b"new"); assert_eq!(fs::read(&backup).unwrap(),b"old"); assert_eq!(fs::read(dir.0.join("data/sentinel")).unwrap(),b"keep");
    }
    #[test] fn installed_update_keeps_explicit_install_directory() {
        let command=installer_command(Path::new("C:/cache/prt-setup.exe"),Path::new("C:/Custom App/prt.exe")).unwrap();
        let args:Vec<_>=command.get_args().map(|s|s.to_string_lossy().to_string()).collect();
        assert_eq!(&args[..4],["/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/SP-"]);
        assert_eq!(args[4],"/DIR=C:/Custom App");
    }
    #[cfg(windows)] #[test] fn process_handle_verifies_image_start_time_and_timeout() {
        let p=process::Process::open(std::process::id()).unwrap(); assert!(p.created().unwrap()>0);
        assert!(same_path(&p.image().unwrap(),&std::env::current_exe().unwrap())); assert!(p.wait(1).is_err());
    }
    #[test] fn bounded_real_http_download_rejects_short_body_and_untrusted_redirect() {
        use std::net::TcpListener;
        let server=TcpListener::bind("127.0.0.1:0").unwrap(); let address=server.local_addr().unwrap();
        let server_thread=std::thread::spawn(move || {
            for body in ["HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
                "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nab",
                "HTTP/1.1 302 Found\r\nLocation: http://evil.test/payload.exe\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"] {
                let (mut stream,_)=server.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request=[0u8;4096]; let _=stream.read(&mut request); stream.write_all(body.as_bytes()).unwrap();
            }
        });
        // Only this private test function can pass a fixture URL. Public check/download use LATEST and validated release URLs.
        let client=ureq::AgentBuilder::new().try_proxy_from_env(false).redirects(0).build();
        let url=format!("http://{address}/fixture"); let dir=Scratch::new(); let file=dir.0.join("prt.exe");
        let hash=format!("{:x}",Sha256::digest(b"abc"));
        write_verified(response(&client,&url,Duration::from_secs(3)).unwrap().into_reader(),&file,3,&hash, |_|{}).unwrap();
        fs::remove_file(&file).unwrap();
        assert!(write_verified(response(&client,&url,Duration::from_secs(3)).unwrap().into_reader(),&file,3,&hash, |_|{}).is_err());
        assert!(!file.exists()); assert!(response(&client,&url,Duration::from_secs(3)).is_err()); server_thread.join().unwrap();
    }
    #[cfg(windows)] #[test] fn helper_process_fixture() {
        let Ok(role)=std::env::var("PRT_UPDATER_TEST_ROLE") else { return; };
        let root=PathBuf::from(std::env::var_os("PRT_UPDATER_TEST_ROOT").unwrap());
        match role.as_str() {
            "parent" => {
                let installed_mode=installed(); let payload=root.join("local/prt/updates/fixture").join(if installed_mode {"prt-setup.exe"}else{"prt.exe"});
                { let mut s=lock(); s.phase="ready"; s.payload=Some(payload.clone()); s.release=Some(Release {
                    version:"9.8.7".into(),url:asset_url("v9.8.7",if installed_mode {"prt-setup.exe"}else{"prt.exe"}),
                    sha256:sha256(&payload).unwrap(),size:fs::metadata(&payload).unwrap().len(),asset:payload.file_name().unwrap().to_string_lossy().into_owned(),
                }); }
                launch_installer().unwrap();
                fs::write(root.join("parent-ack"),b"safe to exit").unwrap();
            }
            "helper" => {
                let plan=std::env::var("PRT_UPDATER_TEST_PLAN").unwrap();
                let code=handle_cli(&["--apply-update".into(),plan]).unwrap();
                fs::write(root.join("helper-exit"),code.to_string()).unwrap();
                assert_eq!(code,if std::env::var_os("PRT_UPDATER_TEST_FAILURE").is_some(){2}else{0});
            }
            "restarted" => {
                fs::write(root.join("restart.json"),serde_json::to_vec(&json!({
                    "exe":std::env::current_exe().unwrap(),"hash":sha256(&std::env::current_exe().unwrap()).unwrap(),
                    "data":std::env::var("PRT_DATA_DIR").unwrap(),"papers":std::env::var("PRT_PAPERS_DIR").unwrap(),
                    "failed":std::env::var("PRT_UPDATER_TEST_RESTART_FAILED").unwrap()
                })).unwrap()).unwrap();
            }
            _=>panic!("Invalid fixture role"),
        }
    }
    #[cfg(windows)] fn helper_roundtrip(installed_mode: bool, fail: bool) {
        let dir=Scratch::new(); let app=dir.0.join("custom install"); let cache=dir.0.join("local/prt/updates/fixture");
        fs::create_dir_all(&app).unwrap(); fs::create_dir_all(&cache).unwrap();
        for folder in ["data","papers"] { fs::create_dir(dir.0.join(folder)).unwrap(); fs::write(dir.0.join(folder).join("sentinel"),b"private fixture").unwrap(); }
        let target=app.join("prt.exe"); fs::copy(std::env::current_exe().unwrap(),&target).unwrap();
        let original_hash=sha256(&target).unwrap();
        let new_reader=dir.0.join("new-reader.exe"); fs::copy(&target,&new_reader).unwrap();
        OpenOptions::new().append(true).open(&new_reader).unwrap().write_all(b"verified new reader fixture").unwrap();
        let expected=sha256(&new_reader).unwrap();
        if installed_mode {
            fs::write(app.join("prt-installed.flag"),b"installed").unwrap();
            let source=dir.0.join("fake-setup.rs");
            fs::write(&source,r#"fn main() {
                let root=std::path::PathBuf::from(std::env::var_os("PRT_UPDATER_TEST_ROOT").unwrap());
                let args:Vec<String>=std::env::args().skip(1).collect();
                std::fs::write(root.join("setup-args.txt"),args.join("\n")).unwrap();
                let target=std::path::PathBuf::from(args.iter().find_map(|a|a.strip_prefix("/DIR=")).unwrap()).join("prt.exe");
                if std::env::var_os("PRT_UPDATER_TEST_FAILURE").is_some() {std::fs::write(target,b"failed partial installation").unwrap();std::process::exit(7);}
                std::fs::copy(root.join("new-reader.exe"),target).unwrap();
            }"#).unwrap();
            let result=hidden(Command::new("rustc").arg("--crate-name").arg("prt_setup_fixture").arg(&source).arg("-o").arg(cache.join("prt-setup.exe"))).output().unwrap();
            assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        } else if fail {fs::write(cache.join("prt.exe"),b"hash-verified invalid executable fixture").unwrap();}
        else { fs::copy(&new_reader,cache.join("prt.exe")).unwrap(); }
        let mut command=Command::new(&target);
        command.args(["--exact","updater::tests::helper_process_fixture","--nocapture"])
            .env("PRT_UPDATER_TEST_ROLE","parent").env("PRT_UPDATER_TEST_ROOT",&dir.0)
            .env("LOCALAPPDATA",dir.0.join("local")).env("PRT_DATA_DIR",dir.0.join("data"))
            .env("PRT_PAPERS_DIR",dir.0.join("papers")).env("PRT_BACKGROUND","1").env("PRT_DIAGNOSTICS","1")
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if fail {command.env("PRT_UPDATER_TEST_FAILURE","1");}
        let mut child=hidden(&mut command).spawn().unwrap();
        let until=Instant::now(); let mut exited=false;
        while until.elapsed()<Duration::from_secs(25) {
            if let Some(status)=child.try_wait().unwrap() { assert!(status.success()); exited=true; }
            if exited && dir.0.join("restart.json").exists() && dir.0.join("helper-exit").exists() { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !exited { let _=child.kill(); let _=child.wait(); }
        assert!(dir.0.join("parent-ack").exists(),"helper handshake");
        assert_eq!(fs::read_to_string(dir.0.join("helper-exit")).unwrap_or_default(),if fail {"2"}else{"0"},
            "{}",fs::read_to_string(cache.join("helper-error.txt")).unwrap_or_default());
        let restarted:Value=serde_json::from_slice(&fs::read(dir.0.join("restart.json")).unwrap()).unwrap();
        assert!(same_path(Path::new(restarted["exe"].as_str().unwrap()),&target)); assert_eq!(restarted["hash"],if fail {original_hash}else{expected});
        assert_eq!(restarted["failed"],if fail {"1"}else{"0"});
        assert_eq!(restarted["data"],dir.0.join("data").to_string_lossy().as_ref());
        assert_eq!(restarted["papers"],dir.0.join("papers").to_string_lossy().as_ref());
        for folder in ["data","papers"] { assert_eq!(fs::read(dir.0.join(folder).join("sentinel")).unwrap(),b"private fixture"); }
        if installed_mode { assert_eq!(fs::read_to_string(dir.0.join("setup-args.txt")).unwrap(),format!("/VERYSILENT\n/SUPPRESSMSGBOXES\n/NORESTART\n/SP-\n/DIR={}",app.display())); }
    }
    #[cfg(windows)] #[test] fn real_helper_portable_waits_replaces_restarts_and_preserves_data() { helper_roundtrip(false,false); }
    #[cfg(windows)] #[test] fn real_helper_installed_runs_setup_in_original_directory_and_restarts() { helper_roundtrip(true,false); }
    #[cfg(windows)] #[test] fn real_helper_portable_failed_restart_restores_old_reader() { helper_roundtrip(false,true); }
    #[cfg(windows)] #[test] fn real_helper_installed_failed_setup_restores_old_reader() { helper_roundtrip(true,true); }
}
