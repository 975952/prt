//! Local PowerPoint automation, using the same worker as the Node backend.
use std::{collections::HashMap, fs, path::PathBuf, process::{Command, Stdio}, sync::{Condvar, Mutex, OnceLock}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

static TICKETS: Mutex<(u64, u64)> = Mutex::new((0, 0));
static READY: Condvar = Condvar::new();
static JOBS: OnceLock<Mutex<HashMap<String, &'static str>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, &'static str>> { JOBS.get_or_init(|| Mutex::new(HashMap::new())) }
fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }
pub fn status(id: &str) -> Option<&'static str> { jobs().lock().unwrap_or_else(|e| e.into_inner()).get(id).copied() }
struct Turn(String);
impl Drop for Turn {
    fn drop(&mut self) {
        jobs().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
        let mut tickets = TICKETS.lock().unwrap_or_else(|e| e.into_inner());
        tickets.1 += 1; READY.notify_all();
    }
}
const UNAVAILABLE: &str = "PPT 转 PDF 需要 Windows 和已安装的 Microsoft PowerPoint";
const FAILED: &str = "PowerPoint 转换失败，请确认文件未损坏、未加密，并已完成 Office 首次启动设置";
struct TempDir(PathBuf);
impl Drop for TempDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

pub fn convert(body: &[u8], name: &str, task_id: &str) -> Result<Vec<u8>, (u16, &'static str)> {
    let ext = if name.to_ascii_lowercase().ends_with(".pptx") { "pptx" } else { "ppt" };
    let magic: &[u8] = if ext == "pptx" { b"PK\x03\x04" } else { b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" };
    if !body.starts_with(magic) { return Err((400, "这不是有效的 PPT/PPTX 文件")); }
    if !cfg!(windows) { return Err((503, UNAVAILABLE)); }
    let id = if valid_id(task_id) { task_id.to_string() } else { String::new() };
    if !id.is_empty() { jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), "waiting"); }
    let mut tickets = TICKETS.lock().unwrap_or_else(|e| e.into_inner());
    let ticket = tickets.0; tickets.0 += 1;
    while tickets.1 != ticket { tickets = READY.wait(tickets).unwrap_or_else(|e| e.into_inner()); }
    drop(tickets);
    let _turn = Turn(id.clone());
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let path = std::env::temp_dir().join(format!("prt-ppt-{}-{stamp}", std::process::id()));
    fs::create_dir(&path).map_err(|_| (500, FAILED))?;
    let dir = TempDir(path);
    let input = dir.0.join(format!("source.{ext}"));
    let output = dir.0.join("converted.pdf");
    let state_path = dir.0.join("status.txt");
    let worker = dir.0.join("convert.ps1");
    fs::write(&input, body).map_err(|_| (500, FAILED))?;
    fs::write(&worker, include_bytes!("../tools/ppt-to-pdf.ps1")).map_err(|_| (500, FAILED))?;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&worker).arg("-InputPath").arg(&input).arg("-OutputPath").arg(&output).arg("-StatePath").arg(&state_path)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|_| (503, UNAVAILABLE))?;
    let start = Instant::now();
    let mut conversion_started = None;
    let mut saw_worker = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(status)) => return Err(if status.code() == Some(2) { (503, UNAVAILABLE) } else { (422, FAILED) }),
            Ok(None) => {},
            Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err((500, FAILED)); }
        }
        if let Ok(state) = fs::read_to_string(&state_path) {
            saw_worker = true;
            if state.trim() == "converting" && conversion_started.is_none() {
                conversion_started = Some(Instant::now());
                if !id.is_empty() { jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), "converting"); }
            }
        }
        if conversion_started.map(|t: Instant| t.elapsed() >= Duration::from_secs(120)).unwrap_or(!saw_worker && start.elapsed() >= Duration::from_secs(15)) {
            // Only stop our helper. Never force-close a user's PowerPoint process.
            let _ = child.kill(); let _ = child.wait();
            return Err((504, "PowerPoint 转换超时，请检查 Office 是否有待处理的提示后重试"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if fs::metadata(&output).map_err(|_| (422, FAILED))?.len() > 256 * 1024 * 1024 { return Err((422, FAILED)); }
    let pdf = fs::read(&output).map_err(|_| (422, FAILED))?;
    if !pdf.starts_with(b"%PDF-") { return Err((422, FAILED)); }
    Ok(pdf)
}
