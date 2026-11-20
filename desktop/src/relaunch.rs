//! Forward an icon launch to the process that owns this library, even during startup.
use std::fs::{File, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{self, Read, Write};
use std::os::windows::{fs::OpenOptionsExt, io::{AsRawHandle, FromRawHandle}};
use std::path::Path;
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT},
    System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId, PIPE_REJECT_REMOTE_CLIENTS},
    UI::WindowsAndMessaging::AllowSetForegroundWindow,
};

fn pipe_name(data: &Path) -> io::Result<String> {
    let path = crate::migration::identity(data).map_err(io::Error::other)?;
    let mut hash = DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut hash);
    Ok(format!(r"\\.\pipe\prt-relaunch-{:016x}", hash.finish()))
}

pub fn forward(data: &Path) -> io::Result<()> {
    let name = pipe_name(data)?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match OpenOptions::new().write(true)
            .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION).open(&name) {
            Ok(mut pipe) => {
                let mut pid = 0;
                unsafe {
                    if GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) != 0 {
                        AllowSetForegroundWindow(pid);
                    }
                }
                return pipe.write_all(&[1]);
            }
            Err(e) if Instant::now() < deadline && (e.kind() == io::ErrorKind::NotFound
                || e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e),
        }
    }
}

pub fn listen(data: &Path, on_launch: impl Fn() -> bool + Send + 'static) -> io::Result<()> {
    let name: Vec<u16> = pipe_name(data)?.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_REJECT_REMOTE_CLIENTS, 1, 0, 1, 0, std::ptr::null()) };
    if handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    let mut pipe = unsafe { File::from_raw_handle(handle) };
    std::thread::spawn(move || loop {
        let handle = pipe.as_raw_handle();
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
            || io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32);
        let mut command = [0];
        let launch = connected && pipe.read_exact(&mut command).is_ok() && command == [1];
        unsafe { DisconnectNamedPipe(handle); }
        if launch && !on_launch() { break; }
    });
    Ok(())
}
