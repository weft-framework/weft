use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use weft_compiler::sourcemap::{generated, original, Mapping};
use weft_compiler::Severity;

use crate::analysis::Analysis;
use crate::text::{Encoding, LineIndex};

#[derive(Clone, Debug)]
pub struct TsProject {
    pub src: PathBuf,
    pub out: PathBuf,
    pub typescript: PathBuf,
}

pub type TsPrepare = Arc<dyn Fn(&Path) -> Result<TsProject, String> + Send + Sync>;

const SCRIPT: &str = include_str!("ts_service.cjs");

const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct Session {
    pub project: TsProject,
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    next: u64,
}

impl Session {
    pub fn start(root: &Path, project: TsProject) -> Result<Session, String> {
        let dir = root.join(".weft");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let script = dir.join("ts-service.cjs");
        if fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
            fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;
        }
        let mut child = Command::new("node")
            .arg(&script)
            .arg(&project.typescript)
            .arg(&project.out)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("cannot run node: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
        Ok(Session {
            project,
            child,
            stdin,
            lines,
            next: 0,
        })
    }

    pub fn request(&mut self, mut req: Value) -> Result<Value, String> {
        self.next += 1;
        req["id"] = json!(self.next);
        writeln!(self.stdin, "{req}")
            .and_then(|()| self.stdin.flush())
            .map_err(|e| format!("TypeScript service: {e}"))?;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .map_err(|_| "TypeScript service did not answer".to_string())?;
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply["id"] != json!(self.next) {
                continue;
            }
            if let Some(e) = reply.get("error") {
                return Err(format!("TypeScript service: {e}"));
            }
            return Ok(reply["result"].clone());
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn lower(a: &Analysis) -> Option<(String, Vec<Mapping>)> {
    if a.diagnostics.iter().any(|d| d.severity == Severity::Error) {
        return None;
    }
    let (ts, maps) = weft_compiler::lower_with_map(&a.src, &a.file);
    Some((weft_compiler::rewrite_wx_imports(&ts), maps))
}

pub(crate) fn lower_client(a: &Analysis) -> Option<(String, Vec<Mapping>)> {
    if a.diagnostics.iter().any(|d| d.severity == Severity::Error) {
        return None;
    }
    let (ts, maps) = weft_compiler::lower_client_with_map(&a.src, &a.file)?;
    Some((weft_compiler::rewrite_wx_imports(&ts), maps))
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

fn find_word(hay: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = hay[from..].find(name).map(|i| from + i) {
        let before = hay[..i].chars().next_back();
        let after = hay[i + name.len()..].chars().next();
        if !before.is_some_and(is_word) && !after.is_some_and(is_word) {
            return Some(i);
        }
        from = i + name.len();
    }
    None
}

pub(crate) fn to_generated(
    src: &str,
    gen: &str,
    maps: &[Mapping],
    at: usize,
) -> Option<(u32, u32)> {
    let word: String = src[at..].chars().take_while(|c| is_word(*c)).collect();
    let (line, col) = LineIndex::new(src, Encoding::Utf16).position(at);
    let gix = LineIndex::new(gen, Encoding::Utf16);
    let candidates = generated(maps, line, col);
    for &(gl, gc) in &candidates {
        let g = gix.offset(gl, gc);
        if word.is_empty() || gen[g..].starts_with(word.as_str()) {
            return Some((gl, gc));
        }
    }
    for &(gl, gc) in &candidates {
        let g = gix.offset(gl, gc);
        let end = gen[g..].find('\n').map_or(gen.len(), |i| g + i);
        if let Some(i) = find_word(&gen[g..end], &word).filter(|&i| i <= 24) {
            return Some(gix.position(g + i));
        }
    }
    None
}

pub(crate) fn to_source(src: &str, maps: &[Mapping], line: u32, col: u32) -> Option<usize> {
    let (l, c) = original(maps, line, col)?;
    Some(LineIndex::new(src, Encoding::Utf16).offset(l, c))
}

pub(crate) fn completion_kind(kind: &str) -> u32 {
    match kind {
        "method" => 2,
        "function" | "local function" => 3,
        "constructor" => 4,
        "property" | "getter" | "setter" | "accessor" => 10,
        "class" | "local class" => 7,
        "interface" => 8,
        "module" | "external module name" => 9,
        "enum" => 13,
        "keyword" => 14,
        "enum member" => 20,
        "type" | "type parameter" => 25,
        _ => 6,
    }
}

pub(crate) type Sessions = HashMap<PathBuf, Result<Session, String>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_names_are_found() {
        let src = "{title}";
        let gen = "x(props.title)";
        let maps = [Mapping {
            gen_line: 0,
            gen_col: 2,
            src_line: 0,
            src_col: 1,
        }];
        assert_eq!(to_generated(src, gen, &maps, 1), Some((0, 8)));
        assert_eq!(find_word("a.titles title", "title"), Some(9));
    }
}
