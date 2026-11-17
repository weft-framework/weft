mod analysis;
mod rpc;
mod text;
mod ts;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};

use serde_json::{json, Value};
use weft_compiler::{Severity, Span};

use analysis::{Analysis, Kind, Symbol};
use text::{path_key, relative_to, Encoding, LineIndex};
pub use text::{path_to_uri, uri_to_path};
use ts::{Session, Sessions};
pub use ts::{TsPrepare, TsProject};

#[derive(Clone, Debug)]
pub struct TypeDiag {
    pub file: PathBuf,
    pub line: u32,
    pub col: u32,
    pub error: bool,
    pub message: String,
    pub code: String,
}

pub type TypeChecker = Arc<dyn Fn(&Path) -> Result<Vec<TypeDiag>, String> + Send + Sync>;

#[derive(Default)]
pub struct Options {
    pub type_check: Option<TypeChecker>,
    pub ts: Option<TsPrepare>,
}

enum Event {
    Message(Value),
    Types(PathBuf, Result<Vec<TypeDiag>, String>),
    End,
}

pub fn serve<R: BufRead + Send + 'static>(
    input: R,
    mut output: impl Write,
    opts: Options,
) -> io::Result<()> {
    let (tx, rx) = mpsc::channel();
    let reader = tx.clone();
    std::thread::spawn(move || {
        let mut input = input;
        loop {
            match rpc::read(&mut input) {
                Ok(Some(msg)) => {
                    if reader.send(Event::Message(msg)).is_err() {
                        return;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = reader.send(Event::End);
                    return;
                }
            }
        }
    });
    let checker = opts.type_check.clone();
    let mut server = Server::new(opts);
    for event in rx {
        let out = match event {
            Event::Message(msg) => server.handle(&msg),
            Event::Types(root, result) => server.types_done(&root, result),
            Event::End => break,
        };
        for msg in &out {
            rpc::write(&mut output, msg)?;
        }
        for root in server.take_jobs() {
            if let Some(check) = checker.clone() {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let result = check(&root);
                    let _ = tx.send(Event::Types(root, result));
                });
            }
        }
        if server.exit {
            break;
        }
    }
    Ok(())
}

struct Doc {
    text: String,
    analysis: Analysis,
    good: Option<Analysis>,
}

pub struct Server {
    docs: HashMap<String, Doc>,
    enc: Encoding,
    typed: bool,
    types: HashMap<String, (PathBuf, PathBuf, Vec<TypeDiag>)>,
    running: HashSet<PathBuf>,
    again: HashSet<PathBuf>,
    jobs: Vec<PathBuf>,
    ts_prepare: Option<TsPrepare>,
    sessions: RefCell<Sessions>,
    notes: RefCell<Vec<Value>>,
    shutdown: bool,
    pub exit: bool,
}

const NOT_FOUND: i64 = -32601;
const INVALID: i64 = -32602;
const FAILED: i64 = -32803;

impl Server {
    pub fn new(opts: Options) -> Self {
        Server {
            docs: HashMap::new(),
            enc: Encoding::Utf16,
            typed: opts.type_check.is_some(),
            types: HashMap::new(),
            running: HashSet::new(),
            again: HashSet::new(),
            jobs: Vec::new(),
            ts_prepare: opts.ts,
            sessions: RefCell::new(HashMap::new()),
            notes: RefCell::new(Vec::new()),
            shutdown: false,
            exit: false,
        }
    }

    pub fn take_jobs(&mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.jobs)
    }

    pub fn handle(&mut self, msg: &Value) -> Vec<Value> {
        let method = msg["method"].as_str().unwrap_or("");
        let params = &msg["params"];
        let Some(id) = msg.get("id").cloned() else {
            return self.notification(method, params);
        };
        if method.is_empty() {
            return Vec::new();
        }
        if self.shutdown && method != "exit" {
            return vec![error(id, -32600, "the server is shutting down")];
        }
        let result = match method {
            "initialize" => Ok(self.initialize(params)),
            "shutdown" => {
                self.shutdown = true;
                Ok(Value::Null)
            }
            "textDocument/hover" => Ok(self.hover(params)),
            "textDocument/definition" => Ok(self.definition(params)),
            "textDocument/completion" => Ok(self.completion(params)),
            "textDocument/prepareRename" => self.prepare_rename(params),
            "textDocument/rename" => self.rename(params),
            "textDocument/formatting" => self.formatting(params),
            "textDocument/documentSymbol" => Ok(self.outline(params)),
            "textDocument/references" => Ok(self.references(params)),
            _ => Err((NOT_FOUND, format!("unsupported method {method}"))),
        };
        let mut out = vec![match result {
            Ok(v) => json!({"jsonrpc": "2.0", "id": id, "result": v}),
            Err((code, m)) => error(id, code, &m),
        }];
        out.append(&mut self.notes.borrow_mut());
        out
    }

    fn note(&self, message: String) {
        self.notes
            .borrow_mut()
            .push(json!({"jsonrpc": "2.0", "method": "window/logMessage",
            "params": {"type": 3, "message": format!("weft: {message}")}}));
    }

    fn notification(&mut self, method: &str, params: &Value) -> Vec<Value> {
        match method {
            "exit" => {
                self.exit = true;
                Vec::new()
            }
            "textDocument/didOpen" => {
                let doc = &params["textDocument"];
                let uri = doc["uri"].as_str().unwrap_or("").to_string();
                self.set_text(&uri, doc["text"].as_str().unwrap_or(""));
                vec![self.publish(&uri)]
            }
            "textDocument/didChange" => {
                let uri = params["textDocument"]["uri"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let Some(change) = params["contentChanges"].as_array().and_then(|c| c.last())
                else {
                    return Vec::new();
                };
                self.set_text(&uri, change["text"].as_str().unwrap_or(""));
                if let Some(p) = uri_to_path(&uri) {
                    self.types.remove(&path_key(&p));
                }
                vec![self.publish(&uri)]
            }
            "textDocument/didClose" => {
                let uri = params["textDocument"]["uri"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                self.docs.remove(&uri);
                vec![self.publish(&uri)]
            }
            "textDocument/didSave" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or("");
                if let Some(root) = uri_to_path(uri).and_then(|p| project_root(&p)) {
                    self.schedule(root);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn schedule(&mut self, root: PathBuf) {
        if !self.typed {
            return;
        }
        if self.running.contains(&root) {
            self.again.insert(root);
        } else {
            self.running.insert(root.clone());
            self.jobs.push(root);
        }
    }

    pub fn types_done(&mut self, root: &Path, result: Result<Vec<TypeDiag>, String>) -> Vec<Value> {
        self.running.remove(root);
        self.sessions
            .borrow_mut()
            .retain(|r, s| r != root || s.is_ok());
        if self.again.remove(root) {
            self.schedule(root.to_path_buf());
        }
        let mut out = Vec::new();
        let diags = match result {
            Ok(d) => d,
            Err(m) => {
                out.push(json!({"jsonrpc": "2.0", "method": "window/logMessage",
                    "params": {"type": 3, "message": format!("weft: type check: {m}")}}));
                return out;
            }
        };
        let mut touched: HashSet<String> = self
            .types
            .iter()
            .filter(|(_, (r, _, _))| r == root)
            .map(|(k, _)| k.clone())
            .collect();
        self.types.retain(|_, (r, _, _)| r != root);
        for d in diags {
            let key = path_key(&d.file);
            touched.insert(key.clone());
            self.types
                .entry(key)
                .or_insert_with(|| (root.to_path_buf(), d.file.clone(), Vec::new()))
                .2
                .push(d);
        }
        let mut keys: Vec<String> = touched.into_iter().collect();
        keys.sort();
        for key in keys {
            let uri = self
                .docs
                .keys()
                .find(|u| uri_to_path(u).is_some_and(|p| path_key(&p) == key))
                .cloned()
                .or_else(|| self.types.get(&key).map(|(_, f, _)| path_to_uri(f)));
            if let Some(uri) = uri {
                out.push(self.publish(&uri));
            }
        }
        out
    }

    fn set_text(&mut self, uri: &str, text: &str) {
        let analysis = Analysis::new(text);
        let ok = !analysis
            .diagnostics
            .iter()
            .any(|d| d.severity == Severity::Error);
        let prev = self.docs.remove(uri);
        let good = if ok {
            Some(analysis.clone())
        } else {
            prev.and_then(|d| d.good)
        };
        self.docs.insert(
            uri.to_string(),
            Doc {
                text: text.to_string(),
                analysis,
                good,
            },
        );
    }

    fn initialize(&mut self, params: &Value) -> Value {
        let offered = &params["capabilities"]["general"]["positionEncodings"];
        let utf8 = offered
            .as_array()
            .is_some_and(|a| a.iter().any(|e| e == "utf-8"));
        self.enc = if utf8 {
            Encoding::Utf8
        } else {
            Encoding::Utf16
        };
        json!({
            "capabilities": {
                "positionEncoding": if utf8 { "utf-8" } else { "utf-16" },
                "textDocumentSync": {"openClose": true, "change": 1, "save": {"includeText": false}},
                "hoverProvider": true,
                "definitionProvider": true,
                "completionProvider": {"triggerCharacters": ["<", "@", "#", ":", "/", "."]},
                "renameProvider": {"prepareProvider": true},
                "documentFormattingProvider": true,
                "documentSymbolProvider": true,
                "referencesProvider": true
            },
            "serverInfo": {"name": "weft-lsp", "version": env!("CARGO_PKG_VERSION")}
        })
    }

    fn range(&self, text: &str, span: Span) -> Value {
        let ix = LineIndex::new(text, self.enc);
        let (sl, sc) = ix.position(span.start);
        let (el, ec) = ix.position(span.end);
        json!({"start": {"line": sl, "character": sc}, "end": {"line": el, "character": ec}})
    }

    fn publish(&self, uri: &str) -> Value {
        let mut diags = Vec::new();
        let text = match self.docs.get(uri) {
            Some(doc) => {
                for d in &doc.analysis.diagnostics {
                    let span = widen(&doc.text, d.span);
                    diags.push(json!({
                        "range": self.range(&doc.text, span),
                        "severity": if d.severity == Severity::Error { 1 } else { 2 },
                        "source": "weft",
                        "message": d.message,
                    }));
                }
                Some(doc.text.clone())
            }
            None => None,
        };
        let path = uri_to_path(uri);
        if let Some((_, file, tds)) = path.as_ref().and_then(|p| self.types.get(&path_key(p))) {
            let text = text
                .or_else(|| std::fs::read_to_string(file).ok())
                .unwrap_or_default();
            let ix16 = LineIndex::new(&text, Encoding::Utf16);
            for d in tds {
                let at = ix16.offset(d.line.saturating_sub(1), d.col.saturating_sub(1));
                let span = widen(&text, Span::new(at, at));
                diags.push(json!({
                    "range": self.range(&text, span),
                    "severity": if d.error { 1 } else { 2 },
                    "source": "ts",
                    "code": d.code,
                    "message": d.message,
                }));
            }
        }
        json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": {"uri": uri, "diagnostics": diags}})
    }

    fn at(&self, params: &Value) -> Option<(&str, &Doc, usize)> {
        let uri = params["textDocument"]["uri"].as_str()?;
        let (key, doc) = self.docs.get_key_value(uri)?;
        let pos = &params["position"];
        let ix = LineIndex::new(&doc.text, self.enc);
        let offset = ix.offset(
            pos["line"].as_u64()? as u32,
            pos["character"].as_u64()? as u32,
        );
        Some((key.as_str(), doc, offset))
    }

    fn hover(&self, params: &Value) -> Value {
        let Some((uri, doc, offset)) = self.at(params) else {
            return Value::Null;
        };
        let sym = doc.analysis.symbol_at(offset);
        let weft = sym.map(|sym| {
            let mut detail = sym.detail.clone();
            let mut label = sym.kind.label();
            if let Some(Target { sym: target, .. }) = self.follow(uri, sym) {
                detail = target.detail;
                label = target.kind.label();
            }
            format!("```weft\n{detail}\n```\n({label})")
        });
        let word = word_at(&doc.text, offset);
        let wants_ts = match sym {
            Some(s) => !matches!(
                s.kind,
                Kind::Component | Kind::Model | Kind::Store | Kind::Action
            ),
            None => doc.analysis.in_code(offset),
        };
        let types = if wants_ts && !word.is_empty() {
            self.ts_hover(uri, doc, word.start)
        } else {
            None
        };
        let value = match (weft, types) {
            (Some(w), Some(t)) => format!("{w}\n\n{t}"),
            (Some(w), None) => w,
            (None, Some(t)) => t,
            (None, None) => return Value::Null,
        };
        json!({
            "contents": {"kind": "markdown", "value": value},
            "range": self.range(&doc.text, word),
        })
    }

    fn follow(&self, uri: &str, sym: &Symbol) -> Option<Target> {
        let (spec, imported) = sym.import.as_ref()?;
        if !spec.starts_with('.') {
            return None;
        }
        let dir = uri_to_path(uri)?.parent()?.to_path_buf();
        let path = dir.join(spec);
        let target_uri = self
            .docs
            .keys()
            .find(|u| uri_to_path(u).is_some_and(|p| path_key(&p) == path_key(&path)))
            .cloned()
            .unwrap_or_else(|| path_to_uri(&path));
        let text = match self.docs.get(&target_uri) {
            Some(d) => d.text.clone(),
            None => std::fs::read_to_string(&path).ok()?,
        };
        let a = Analysis::new(&text);
        let found = a.symbols.iter().find(|s| {
            s.scope.is_none()
                && s.kind != Kind::Import
                && (s.name == *imported || imported == "default")
        })?;
        Some(Target {
            uri: target_uri,
            sym: found.clone(),
            text,
        })
    }

    fn definition(&self, params: &Value) -> Value {
        let Some((uri, doc, offset)) = self.at(params) else {
            return Value::Null;
        };
        let Some(sym) = doc.analysis.symbol_at(offset) else {
            return Value::Null;
        };
        if let Some(t) = self.follow(uri, sym) {
            return json!({"uri": t.uri, "range": self.range(&t.text, t.sym.name_span)});
        }
        json!({"uri": uri, "range": self.range(&doc.text, sym.name_span)})
    }

    fn completion(&self, params: &Value) -> Value {
        let Some((uri, doc, offset)) = self.at(params) else {
            return Value::Null;
        };
        if let Some(items) = self.ts_members(uri, doc, offset) {
            return json!(items);
        }
        json!(complete(doc, offset))
    }

    fn prepare_rename(&self, params: &Value) -> Result<Value, (i64, String)> {
        let (uri, doc, offset) = self
            .at(params)
            .ok_or((INVALID, "unknown document".to_string()))?;
        let word = word_at(&doc.text, offset);
        let name = match renameable(&doc.analysis, offset) {
            Ok(sym) => sym.name.clone(),
            Err(e) => {
                self.ts_locations(uri, doc, offset, "rename")
                    .ok_or(e)?
                    .map_err(|m| (FAILED, m))?;
                doc.text[word.start..word.end].to_string()
            }
        };
        Ok(json!({"range": self.range(&doc.text, word), "placeholder": name}))
    }

    fn rename(&self, params: &Value) -> Result<Value, (i64, String)> {
        let (uri, doc, offset) = self
            .at(params)
            .ok_or((INVALID, "unknown document".to_string()))?;
        let new = params["newName"].as_str().unwrap_or("");
        if !weft_compiler::lexer::is_ident(new) || weft_compiler::Keyword::from_ident(new).is_some()
        {
            return Err((INVALID, format!("`{new}` is not a valid name")));
        }
        let a = &doc.analysis;
        let sym = match renameable(a, offset) {
            Ok(sym) => sym,
            Err(e) => {
                let found = self
                    .ts_locations(uri, doc, offset, "rename")
                    .ok_or(e)?
                    .map_err(|m| (FAILED, m))?;
                return self.rename_edits(found, new);
            }
        };
        if a.visible(sym.name_span.start)
            .iter()
            .any(|s| s.name == new && s.scope == sym.scope)
        {
            return Err((FAILED, format!("`{new}` is already declared here")));
        }
        let edits: Vec<Value> = a
            .occurrences(sym)
            .into_iter()
            .map(|s| json!({"range": self.range(&doc.text, s), "newText": new}))
            .collect();
        Ok(json!({"changes": {uri: edits}}))
    }

    fn rename_edits(&self, found: Vec<Found>, new: &str) -> Result<Value, (i64, String)> {
        let mut changes = serde_json::Map::new();
        for (file, text, spans) in found {
            if file.ends_with(".wx")
                && Analysis::new(&text)
                    .symbols
                    .iter()
                    .any(|s| s.name == new && s.scope.is_none())
            {
                let name = uri_to_path(&file).map_or(file.clone(), |p| p.display().to_string());
                return Err((FAILED, format!("`{new}` is already declared in {name}")));
            }
            let edits: Vec<Value> = spans
                .into_iter()
                .map(|s| json!({"range": self.range(&text, s), "newText": new}))
                .collect();
            changes.insert(file, json!(edits));
        }
        Ok(json!({ "changes": changes }))
    }

    fn references(&self, params: &Value) -> Value {
        let Some((uri, doc, offset)) = self.at(params) else {
            return Value::Null;
        };
        let a = &doc.analysis;
        let here = |sym: &Symbol| vec![(uri.to_string(), doc.text.clone(), a.occurrences(sym))];
        let found = match a.symbol_at(offset) {
            Some(sym) if sym.kind.is_local() => here(sym),
            sym => match self.ts_locations(uri, doc, offset, "references") {
                Some(Ok(found)) if !found.is_empty() => found,
                _ => match sym {
                    Some(sym) => here(sym),
                    None => return Value::Null,
                },
            },
        };
        let mut out = Vec::new();
        for (file, text, spans) in found {
            for s in spans {
                out.push(json!({"uri": file, "range": self.range(&text, s)}));
            }
        }
        json!(out)
    }

    fn with_ts<T>(
        &self,
        path: &Path,
        f: impl FnOnce(&mut Session) -> Result<Option<T>, String>,
    ) -> Option<T> {
        let prepare = self.ts_prepare.as_ref()?;
        let root = project_root(path)?;
        let mut sessions = self.sessions.borrow_mut();
        let entry = sessions.entry(root.clone()).or_insert_with(|| {
            let started = prepare(&root).and_then(|p| Session::start(&root, p));
            if let Err(e) = &started {
                self.note(format!("TypeScript service: {e}"));
            }
            started
        });
        let session = entry.as_mut().ok()?;
        match f(session) {
            Ok(v) => v,
            Err(e) => {
                self.note(e);
                sessions.remove(&root);
                None
            }
        }
    }

    fn text_of(&self, path: &Path) -> Option<(String, String)> {
        let key = path_key(path);
        if let Some((uri, d)) = self
            .docs
            .iter()
            .find(|(u, _)| uri_to_path(u).is_some_and(|p| path_key(&p) == key))
        {
            return Some((uri.clone(), d.text.clone()));
        }
        Some((path_to_uri(path), std::fs::read_to_string(path).ok()?))
    }

    fn overlays(&self, project: &TsProject) -> Vec<Value> {
        let mut v = Vec::new();
        for (uri, d) in &self.docs {
            let Some(path) = uri_to_path(uri) else {
                continue;
            };
            if path.extension().and_then(|e| e.to_str()) != Some("wx") {
                continue;
            }
            let Some(rel) = relative_to(&path, &project.src) else {
                continue;
            };
            if let Some((text, _)) = ts::lower(&d.analysis) {
                let gen = project.out.join(rel).with_extension("ts");
                v.push(json!({"file": gen, "text": text}));
            }
        }
        v
    }

    fn ts_request(
        project: &TsProject,
        path: &Path,
        a: &Analysis,
        at: usize,
        op: &str,
    ) -> Option<Value> {
        let rel = relative_to(path, &project.src)?;
        let gen = project.out.join(rel).with_extension("ts");
        let (text, maps) = ts::lower(a)?;
        let (line, col) = ts::to_generated(&a.src, &text, &maps, at)?;
        Some(json!({
            "op": op, "file": gen, "line": line, "character": col,
            "overlays": [{"file": gen, "text": text}],
        }))
    }

    fn ts_hover(&self, uri: &str, doc: &Doc, at: usize) -> Option<String> {
        let path = uri_to_path(uri)?;
        self.with_ts(&path, |s| {
            let Some(req) = Self::ts_request(&s.project, &path, &doc.analysis, at, "hover") else {
                return Ok(None);
            };
            let r = s.request(req)?;
            let Some(display) = r["display"].as_str().filter(|d| !d.is_empty()) else {
                return Ok(None);
            };
            let mut out = format!("```typescript\n{display}\n```");
            if let Some(docs) = r["docs"].as_str().filter(|d| !d.is_empty()) {
                out.push_str("\n\n");
                out.push_str(docs);
            }
            Ok(Some(out))
        })
    }

    fn ts_members(&self, uri: &str, doc: &Doc, offset: usize) -> Option<Vec<Value>> {
        let text = &doc.text;
        let offset = offset.min(text.len());
        let start = word_at(text, offset).start.min(offset);
        let dot = text[..start].strip_suffix('.')?;
        let prev = dot.chars().next_back()?;
        if !(is_word(prev) || matches!(prev, ')' | ']' | '?' | '!')) {
            return None;
        }
        let patched = if start == offset {
            format!("{}__weftc{}", &text[..offset], &text[offset..])
        } else {
            text.clone()
        };
        let a = Analysis::new(&patched);
        if !a.in_code(start) {
            return None;
        }
        let path = uri_to_path(uri)?;
        self.with_ts(&path, |s| {
            let Some(req) = Self::ts_request(&s.project, &path, &a, start, "completion") else {
                return Ok(None);
            };
            let r = s.request(req)?;
            if r["member"] != json!(true) {
                return Ok(None);
            }
            let items = r["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| {
                    let kind = ts::completion_kind(e["kind"].as_str().unwrap_or(""));
                    json!({"label": e["name"], "kind": kind, "detail": e["kind"]})
                })
                .collect();
            Ok(Some(items))
        })
    }

    fn ts_locations(
        &self,
        uri: &str,
        doc: &Doc,
        offset: usize,
        op: &str,
    ) -> Option<Result<Vec<Found>, String>> {
        let word = word_at(&doc.text, offset);
        if word.is_empty() {
            return None;
        }
        let name = doc.text[word.start..word.end].to_string();
        let path = uri_to_path(uri)?;
        self.with_ts(&path, |s| {
            let Some(mut req) = Self::ts_request(&s.project, &path, &doc.analysis, word.start, op)
            else {
                return Ok(None);
            };
            req["overlays"] = json!(self.overlays(&s.project));
            let r = s.request(req)?;
            if let Some(e) = r["error"].as_str() {
                return Ok(Some(Err(e.to_string())));
            }
            Ok(Some(Ok(self.map_locations(
                &s.project,
                &r["locations"],
                &name,
            ))))
        })
    }

    fn map_locations(&self, project: &TsProject, locations: &Value, name: &str) -> Vec<Found> {
        let mut files: Vec<Found> = Vec::new();
        let mut sources: HashMap<String, Option<Mapped>> = HashMap::new();
        for loc in locations.as_array().into_iter().flatten() {
            let Some(file) = loc["file"].as_str() else {
                continue;
            };
            let entry = sources
                .entry(path_key(Path::new(file)))
                .or_insert_with(|| self.source_for(project, Path::new(file)));
            let Some(m) = entry else {
                continue;
            };
            let (line, col) = (
                loc["start"]["line"].as_u64().unwrap_or(0) as u32,
                loc["start"]["character"].as_u64().unwrap_or(0) as u32,
            );
            let at = match &m.maps {
                Some(maps) => ts::to_source(&m.text, maps, line, col),
                None => Some(LineIndex::new(&m.text, Encoding::Utf16).offset(line, col)),
            };
            let span = at.map(|at| Span::new(at, at + name.len()));
            let Some(span) = span.filter(|s| word_at(&m.text, s.start) == *s) else {
                continue;
            };
            if m.text.get(span.start..span.end) != Some(name) {
                continue;
            }
            let i = match files.iter().position(|f| f.0 == m.uri) {
                Some(i) => i,
                None => {
                    files.push((m.uri.clone(), m.text.clone(), Vec::new()));
                    files.len() - 1
                }
            };
            files[i].2.push(span);
        }
        for (uri, text, spans) in &mut files {
            if !uri.ends_with(".wx") {
                continue;
            }
            let a = Analysis::new(text);
            let extra: Vec<Span> = spans
                .iter()
                .filter_map(|s| a.symbol_at(s.start))
                .filter(|sym| sym.name == name && !sym.kind.is_local())
                .flat_map(|sym| a.occurrences(sym))
                .collect();
            spans.extend(extra);
            spans.sort_by_key(|s| (s.start, s.end));
            spans.dedup();
        }
        files
    }

    fn source_for(&self, project: &TsProject, gen: &Path) -> Option<Mapped> {
        let rel = relative_to(gen, &project.out)?;
        let rel = rel.to_string_lossy().replace('\\', "/");
        let (wx_rel, client) = match rel.strip_suffix(".client.ts") {
            Some(stem) => (format!("{stem}.wx"), true),
            None => (
                format!("{}.wx", rel.strip_suffix(".ts").unwrap_or(&rel)),
                false,
            ),
        };
        if let Some((uri, text)) = self.text_of(&project.src.join(&wx_rel)) {
            let a = Analysis::new(&text);
            let (_, maps) = if client {
                ts::lower_client(&a)?
            } else {
                ts::lower(&a)?
            };
            return Some(Mapped {
                uri,
                text,
                maps: Some(maps),
            });
        }
        let (uri, text) = self.text_of(&project.src.join(&rel))?;
        Some(Mapped {
            uri,
            text,
            maps: None,
        })
    }

    fn formatting(&self, params: &Value) -> Result<Value, (i64, String)> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or("");
        let Some(doc) = self.docs.get(uri) else {
            return Ok(Value::Null);
        };
        match weft_fmt::format(&doc.text) {
            Ok(out) if out == doc.text => Ok(json!([])),
            Ok(out) => Ok(json!([{
                "range": self.range(&doc.text, Span::new(0, doc.text.len())),
                "newText": out,
            }])),
            Err(weft_fmt::Error::Syntax(_)) => Ok(json!([])),
            Err(e) => Err((FAILED, e.to_string())),
        }
    }

    fn outline(&self, params: &Value) -> Value {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or("");
        let Some(doc) = self.docs.get(uri) else {
            return Value::Null;
        };
        let a = &doc.analysis;
        let node = |i: usize| -> Value {
            let s = &a.symbols[i];
            let kind = match s.kind {
                Kind::Component => 5,
                Kind::Model => 23,
                Kind::Function | Kind::Action => 12,
                Kind::Param => 7,
                Kind::Placed => 14,
                _ => 13,
            };
            json!({
                "name": s.name,
                "detail": s.detail.lines().next().unwrap_or(""),
                "kind": kind,
                "range": self.range(&doc.text, s.span),
                "selectionRange": self.range(&doc.text, s.name_span),
                "children": [],
            })
        };
        let mut out = Vec::new();
        for (i, s) in a.symbols.iter().enumerate() {
            if s.parent.is_some() || s.kind == Kind::Import {
                continue;
            }
            let mut n = node(i);
            let kids: Vec<Value> = a
                .symbols
                .iter()
                .enumerate()
                .filter(|(_, c)| c.parent == Some(i) && c.kind != Kind::Binding)
                .map(|(j, _)| node(j))
                .collect();
            n["children"] = json!(kids);
            out.push(n);
        }
        json!(out)
    }
}

type Found = (String, String, Vec<Span>);

struct Mapped {
    uri: String,
    text: String,
    maps: Option<Vec<weft_compiler::sourcemap::Mapping>>,
}

struct Target {
    uri: String,
    sym: Symbol,
    text: String,
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn renameable(a: &Analysis, offset: usize) -> Result<&Symbol, (i64, String)> {
    let sym = a
        .symbol_at(offset)
        .ok_or((FAILED, "no name to rename here".to_string()))?;
    if !sym.kind.is_local() {
        return Err((
            FAILED,
            format!(
                "only names declared in a component (signals, derived values, functions, \
                 parameters, bindings) can be renamed; `{}` is a {}",
                sym.name,
                sym.kind.label()
            ),
        ));
    }
    Ok(sym)
}

fn is_word(c: char) -> bool {
    weft_compiler::lexer::is_ident_continue(c) || c == '$'
}

fn word_at(text: &str, offset: usize) -> Span {
    let offset = offset.min(text.len());
    let start = text[..offset]
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map_or(offset, |(i, _)| i);
    let end = text[offset..]
        .char_indices()
        .find(|(_, c)| !is_word(*c))
        .map_or(text.len(), |(i, _)| offset + i);
    Span::new(start, end)
}

fn widen(text: &str, span: Span) -> Span {
    if !span.is_empty() {
        return span;
    }
    let w = word_at(text, span.start);
    if !w.is_empty() && w.start == span.start {
        return w;
    }
    let next = text[span.start.min(text.len())..]
        .chars()
        .next()
        .filter(|c| *c != '\n' && *c != '\r')
        .map_or(0, char::len_utf8);
    Span::new(span.start, span.start + next)
}

fn project_root(file: &Path) -> Option<PathBuf> {
    let dirs = || file.ancestors().skip(1);
    dirs()
        .find(|d| d.join("weft.config.ts").is_file() || d.join("weft.config.js").is_file())
        .or_else(|| dirs().find(|d| d.join("package.json").is_file()))
        .map(Path::to_path_buf)
}

const HTML_TAGS: &[&str] = &[
    "a", "article", "aside", "button", "details", "dialog", "div", "em", "fieldset", "footer",
    "form", "h1", "h2", "h3", "h4", "header", "img", "input", "label", "legend", "li", "main",
    "nav", "ol", "option", "p", "pre", "section", "select", "small", "span", "strong", "summary",
    "table", "tbody", "td", "template", "textarea", "th", "thead", "time", "tr", "ul",
];

const MEMBER_KEYWORDS: &[&str] = &[
    "signal",
    "derived",
    "function",
    "view",
    "style",
    "client",
    "server",
    "onMount",
    "onDestroy",
];

const ITEM_KEYWORDS: &[&str] = &[
    "component",
    "model",
    "action",
    "job",
    "store",
    "actor",
    "client",
    "server",
    "import",
    "export",
];

fn item(label: &str, kind: u32, detail: &str) -> Value {
    json!({"label": label, "kind": kind, "detail": detail})
}

fn complete(doc: &Doc, offset: usize) -> Vec<Value> {
    let text = &doc.text;
    let offset = offset.min(text.len());
    let line = &text[text[..offset].rfind('\n').map_or(0, |i| i + 1)..offset];
    let word_len = line
        .chars()
        .rev()
        .take_while(|c| is_word(*c))
        .map(char::len_utf8)
        .sum::<usize>();
    let before = &line[..line.len() - word_len];
    let a = if doc.analysis.file.items.is_empty() {
        doc.good.as_ref().unwrap_or(&doc.analysis)
    } else {
        &doc.analysis
    };
    let comp = a.component_at(offset);
    let in_view = comp.is_some_and(|c| c.view.span.start <= offset && offset <= c.view.span.end);
    let in_style = comp
        .and_then(|c| c.style.as_ref())
        .is_some_and(|s| s.span.start <= offset && offset <= s.span.end);

    if before.ends_with("{#") {
        return ["if", "each", "await", "can"]
            .iter()
            .map(|k| item(k, 14, "block"))
            .collect();
    }
    if before.ends_with("{:") {
        return ["else", "else if", "then", "catch"]
            .iter()
            .map(|k| item(k, 14, "block branch"))
            .collect();
    }
    if before.ends_with("{/") {
        return ["if", "each", "await", "can"]
            .iter()
            .map(|k| item(k, 14, "end of block"))
            .collect();
    }
    if let Some(at) = line.rfind('@') {
        let directive = &line[at + 1..];
        if (in_view || line.contains('<'))
            && directive
                .chars()
                .all(|c| is_word(c) || matches!(c, '.' | '(' | ')' | '-'))
        {
            if directive.contains('.') {
                return weft_compiler::events::COMMON_MODS
                    .iter()
                    .map(|m| item(m, 20, "modifier"))
                    .collect();
            }
            let mut v: Vec<Value> = weft_compiler::events::DOM_EVENTS
                .iter()
                .map(|e| item(e, 23, "event"))
                .collect();
            v.extend(
                weft_compiler::events::TRIGGERS
                    .iter()
                    .map(|t| item(t, 23, "trigger")),
            );
            return v;
        }
    }
    if before.ends_with('<') || before.ends_with("</") {
        let mut v: Vec<Value> = Vec::new();
        let mut seen = HashSet::new();
        for s in a.visible(offset) {
            let tag = matches!(s.kind, Kind::Component | Kind::Import)
                && s.name.starts_with(|c: char| c.is_ascii_uppercase());
            if tag && seen.insert(s.name.clone()) {
                v.push(item(&s.name, 7, &s.detail));
            }
        }
        v.extend(HTML_TAGS.iter().map(|t| item(t, 10, "element")));
        return v;
    }
    if in_style {
        return Vec::new();
    }
    if in_view
        && !a.in_code(offset)
        && !inside_braces(text, comp.map_or(0, |c| c.view.span.start), offset)
    {
        return Vec::new();
    }
    let mut v = Vec::new();
    let mut seen = HashSet::new();
    for s in a.visible(offset) {
        if seen.insert(s.name.clone()) {
            let kind = match s.kind {
                Kind::Component => 7,
                Kind::Model => 22,
                Kind::Function | Kind::Action => 3,
                Kind::Import => 9,
                Kind::Placed => 21,
                _ => 6,
            };
            v.push(item(&s.name, kind, &s.detail));
        }
    }
    let line_start = before.trim().is_empty();
    if line_start && comp.is_some() && !in_view {
        v.extend(MEMBER_KEYWORDS.iter().map(|k| item(k, 14, "keyword")));
    } else if line_start && comp.is_none() {
        v.extend(ITEM_KEYWORDS.iter().map(|k| item(k, 14, "keyword")));
    }
    v
}

fn inside_braces(text: &str, from: usize, offset: usize) -> bool {
    let mut depth = 0i32;
    for b in text.as_bytes()[from.min(offset)..offset].iter() {
        match b {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
    }
    depth > 0
}

#[cfg(test)]
mod tests;
