use crate::util::Dirs;
use std::{fs, io::{self, BufRead, BufReader, Write}, path::{Path, PathBuf}};

fn batch_id() -> String {
    format!("{}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos(), std::process::id())
}

pub fn enqueue(dirs: &Dirs, path: &Path) -> io::Result<()> {
    let source = path.canonicalize()?;
    let queue = dirs.data.join("shell-open");
    fs::create_dir_all(&queue)?;
    let staging = queue.join(batch_id()).with_extension("tmp");
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&staging)?;
    file.write_all(source.to_string_lossy().as_bytes())?;
    drop(file);
    fs::rename(&staging, staging.with_extension("request"))
}

fn identical(a: &Path, b: &Path) -> io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() { return Ok(false); }
    let mut left = BufReader::new(fs::File::open(a)?);
    let mut right = BufReader::new(fs::File::open(b)?);
    loop {
        let (x, y) = (left.fill_buf()?, right.fill_buf()?);
        let n = x.len().min(y.len());
        if n == 0 { return Ok(x.is_empty() && y.is_empty()); }
        if x[..n] != y[..n] { return Ok(false); }
        left.consume(n);
        right.consume(n);
    }
}

fn import(papers: &Path, source: &Path) -> io::Result<String> {
    let source = source.canonicalize()?;
    if !source.is_file() || !source.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "请选择 PDF 文件"));
    }
    if let Ok(relative) = source.strip_prefix(papers.canonicalize()?) {
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let tmp = papers.join(format!(".prt-{}.tmp", batch_id()));
    let result = (|| {
        for index in 0.. {
            let name = if index == 0 { source.file_name().unwrap().to_string_lossy().into_owned() }
                else { format!("{stem} ({index}).pdf") };
            let dest = papers.join(&name);
            if dest.exists() {
                if dest.is_file() && identical(&source, &dest)? { return Ok(name); }
                continue;
            }
            if !tmp.exists() { fs::copy(&source, &tmp)?; }
            // Windows rename fails if the destination appeared during the copy.
            match fs::rename(&tmp, &dest) {
                Ok(()) => return Ok(name),
                Err(_) if dest.exists() => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    })();
    let _ = fs::remove_file(tmp);
    result
}

pub fn next(dirs: &Dirs) -> io::Result<Option<String>> {
    let queue = dirs.data.join("shell-open");
    if !queue.exists() { return Ok(None); }
    let mut entries: Vec<PathBuf> = fs::read_dir(queue)?.filter_map(Result::ok).map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "request")).collect();
    entries.sort();
    for path in entries {
        let claimed = path.with_extension("opening");
        if fs::rename(path, &claimed).is_err() { continue; }
        let result = fs::read_to_string(&claimed).and_then(|s| import(&dirs.papers, Path::new(&s)));
        let _ = fs::remove_file(claimed);
        return result.map(Some);
    }
    Ok(None)
}
