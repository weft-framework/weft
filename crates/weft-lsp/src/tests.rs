use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::*;

const URI: &str = "file:///project/src/pages/Counter.wx";

const SRC: &str = "component Counter(start: number) {
  signal count = start
  function inc() {
    count += 1
  }
  view {
    <button @click={inc}>{count}</button>
  }
}
";

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

fn note(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

fn open(server: &mut Server, uri: &str, text: &str) -> Value {
    let out = server.handle(&note(
        "textDocument/didOpen",
        json!({"textDocument": {"uri": uri, "languageId": "weft", "version": 1, "text": text}}),
    ));
    out.into_iter().next().unwrap()
}

fn pos(text: &str, needle: &str, plus: usize) -> Value {
    let at = text.find(needle).unwrap() + plus;
    let line = text[..at].matches('\n').count();
    let col = at - text[..at].rfind('\n').map_or(0, |i| i + 1);
    json!({"line": line, "character": col})
}

fn ask(
    server: &mut Server,
    method: &str,
    uri: &str,
    text: &str,
    needle: &str,
    plus: usize,
    extra: Value,
) -> Value {
    let mut params = json!({"textDocument": {"uri": uri}, "position": pos(text, needle, plus)});
    if let Value::Object(m) = extra {
        for (k, v) in m {
            params[k] = v;
        }
    }
    let out = server.handle(&request(7, method, params));
    out.into_iter().next().unwrap()
}

fn server() -> Server {
    let mut s = Server::new(Options::default());
    let init = s.handle(&request(1, "initialize", json!({"capabilities": {}})));
    assert_eq!(
        init[0]["result"]["capabilities"]["positionEncoding"],
        "utf-16"
    );
    s
}

#[test]
fn diagnostics_follow_the_text() {
    let mut s = server();
    let d = open(&mut s, URI, SRC);
    assert_eq!(d["method"], "textDocument/publishDiagnostics");
    assert_eq!(d["params"]["diagnostics"], json!([]));
    let out = s.handle(&note(
        "textDocument/didChange",
        json!({"textDocument": {"uri": URI, "version": 2}, "contentChanges": [{"text": "component A() { view { <p> } }"}]}),
    ));
    let diags = out[0]["params"]["diagnostics"].as_array().unwrap();
    assert!(!diags.is_empty());
    assert_eq!(diags[0]["severity"], 1);
    assert_eq!(diags[0]["source"], "weft");
}

#[test]
fn hover_and_definition() {
    let mut s = server();
    open(&mut s, URI, SRC);
    let h = ask(
        &mut s,
        "textDocument/hover",
        URI,
        SRC,
        "{count}",
        2,
        json!({}),
    );
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("signal count = start"), "{md}");
    let d = ask(
        &mut s,
        "textDocument/definition",
        URI,
        SRC,
        "{inc}",
        1,
        json!({}),
    );
    assert_eq!(
        d["result"]["range"]["start"],
        json!({"line": 2, "character": 11})
    );
    let none = ask(
        &mut s,
        "textDocument/hover",
        URI,
        SRC,
        "button",
        0,
        json!({}),
    );
    assert_eq!(none["result"], Value::Null);
}

#[test]
fn rename_covers_the_component_and_refuses_top_level_names() {
    let mut s = server();
    open(&mut s, URI, SRC);
    let p = ask(
        &mut s,
        "textDocument/prepareRename",
        URI,
        SRC,
        "count +=",
        1,
        json!({}),
    );
    assert_eq!(p["result"]["placeholder"], "count");
    let r = ask(
        &mut s,
        "textDocument/rename",
        URI,
        SRC,
        "count +=",
        1,
        json!({"newName": "total"}),
    );
    let edits = r["result"]["changes"][URI].as_array().unwrap();
    assert_eq!(edits.len(), 3, "{edits:?}");
    assert!(edits.iter().all(|e| e["newText"] == "total"));
    let bad = ask(
        &mut s,
        "textDocument/rename",
        URI,
        SRC,
        "count +=",
        1,
        json!({"newName": "inc"}),
    );
    assert!(bad["error"]["message"]
        .as_str()
        .unwrap()
        .contains("already declared"));
    let kw = ask(
        &mut s,
        "textDocument/rename",
        URI,
        SRC,
        "count +=",
        1,
        json!({"newName": "view"}),
    );
    assert!(kw["error"].is_object());
    let top = ask(
        &mut s,
        "textDocument/prepareRename",
        URI,
        SRC,
        "Counter",
        1,
        json!({}),
    );
    assert!(top["error"]["message"]
        .as_str()
        .unwrap()
        .contains("component"));
}

#[test]
fn completion_by_context() {
    let mut s = server();
    let text = "component A(n: number) {\n  signal count = 0\n  view {\n    <b @c>{c}</b>\n    {#\n  }\n}\n";
    open(&mut s, URI, text);
    let labels = |v: &Value| -> Vec<String> {
        v["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["label"].as_str().unwrap().to_string())
            .collect()
    };
    let names = ask(
        &mut s,
        "textDocument/completion",
        URI,
        text,
        "{c}",
        2,
        json!({}),
    );
    let l = labels(&names);
    assert!(
        l.contains(&"count".into()) && l.contains(&"n".into()) && l.contains(&"A".into()),
        "{l:?}"
    );
    let events = ask(
        &mut s,
        "textDocument/completion",
        URI,
        text,
        "@c>",
        2,
        json!({}),
    );
    assert!(labels(&events).contains(&"click".into()));
    let blocks = ask(
        &mut s,
        "textDocument/completion",
        URI,
        text,
        "{#\n",
        2,
        json!({}),
    );
    assert!(labels(&blocks).contains(&"each".into()));
    let member = ask(
        &mut s,
        "textDocument/completion",
        URI,
        text,
        "  view",
        2,
        json!({}),
    );
    assert!(labels(&member).contains(&"derived".into()));
    let markup_text = ask(
        &mut s,
        "textDocument/completion",
        URI,
        text,
        "</b>",
        0,
        json!({}),
    );
    assert_eq!(labels(&markup_text), Vec::<String>::new());
}

#[test]
fn formatting_and_outline() {
    let mut s = server();
    let messy = "component A() {\n      signal n = 0\n view {\n<p>{n}</p>\n}\n}\n";
    open(&mut s, URI, messy);
    let f = s.handle(&request(
        3,
        "textDocument/formatting",
        json!({"textDocument": {"uri": URI}, "options": {}}),
    ));
    let edit = &f[0]["result"][0];
    assert_eq!(
        edit["newText"],
        "component A() {\n  signal n = 0\n  view {\n    <p>{n}</p>\n  }\n}\n"
    );
    let o = s.handle(&request(
        4,
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": URI}}),
    ));
    assert_eq!(o[0]["result"][0]["name"], "A");
    assert_eq!(o[0]["result"][0]["children"][0]["name"], "n");
}

#[test]
fn imports_are_followed_into_wx_files() {
    let dir = std::env::temp_dir().join(format!("weft-lsp-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("Card.wx"),
        "component Card(title: string) {\n  view { <h2>{title}</h2> }\n}\n",
    )
    .unwrap();
    let page = dir.join("Page.wx");
    let text = "import { Card } from \"./Card.wx\"\ncomponent Page() {\n  view { <Card title=\"x\" /> }\n}\n";
    let uri = path_to_uri(&page);
    let mut s = server();
    open(&mut s, &uri, text);
    let d = ask(
        &mut s,
        "textDocument/definition",
        &uri,
        text,
        "<Card",
        2,
        json!({}),
    );
    assert!(
        d["result"]["uri"].as_str().unwrap().ends_with("Card.wx"),
        "{d}"
    );
    assert_eq!(
        d["result"]["range"]["start"],
        json!({"line": 0, "character": 10})
    );
    let h = ask(
        &mut s,
        "textDocument/hover",
        &uri,
        text,
        "<Card",
        2,
        json!({}),
    );
    assert!(h["result"]["contents"]["value"]
        .as_str()
        .unwrap()
        .contains("component Card(title: string)"));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn type_diagnostics_arrive_after_save() {
    let dir = std::env::temp_dir().join(format!("weft-lsp-types-{}", std::process::id()));
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("package.json"), "{}").unwrap();
    let file = dir.join("src").join("A.wx");
    let text = "component A() {\n  view { <p>{nmae}</p> }\n}\n";
    fs::write(&file, text).unwrap();
    let uri = path_to_uri(&file);
    let checker: TypeChecker = Arc::new(|_root: &Path| Ok(Vec::new()));
    let mut s = Server::new(Options {
        type_check: Some(checker),
        ts: None,
    });
    s.handle(&request(1, "initialize", json!({"capabilities": {}})));
    open(&mut s, &uri, text);
    s.handle(&note(
        "textDocument/didSave",
        json!({"textDocument": {"uri": uri}}),
    ));
    let jobs = s.take_jobs();
    assert_eq!(jobs.len(), 1);
    let found = vec![TypeDiag {
        file: file.clone(),
        line: 2,
        col: 14,
        error: true,
        message: "Cannot find name 'nmae'.".into(),
        code: "TS2304".into(),
    }];
    let out = s.types_done(&jobs[0], Ok(found));
    let all = out[0]["params"]["diagnostics"].as_array().unwrap();
    let diags: Vec<&Value> = all.iter().filter(|d| d["source"] == "ts").collect();
    assert_eq!(diags.len(), 1, "{all:?}");
    assert_eq!(
        diags[0]["range"]["start"],
        json!({"line": 1, "character": 13})
    );
    assert_eq!(
        diags[0]["range"]["end"],
        json!({"line": 1, "character": 17}),
        "the whole name"
    );
    s.handle(&note(
        "textDocument/didSave",
        json!({"textDocument": {"uri": uri}}),
    ));
    let jobs = s.take_jobs();
    let out = s.types_done(&jobs[0], Ok(Vec::new()));
    let left = out[0]["params"]["diagnostics"].as_array().unwrap();
    assert!(left.iter().all(|d| d["source"] != "ts"), "{left:?}");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn serves_over_a_stream_until_exit() {
    let mut input = Vec::new();
    for m in [
        request(
            1,
            "initialize",
            json!({"capabilities": {"general": {"positionEncodings": ["utf-8", "utf-16"]}}}),
        ),
        note("initialized", json!({})),
        request(2, "textDocument/unknown", json!({})),
        request(3, "shutdown", Value::Null),
        note("exit", Value::Null),
    ] {
        rpc::write(&mut input, &m).unwrap();
    }
    let mut output = Vec::new();
    serve(Cursor::new(input), &mut output, Options::default()).unwrap();
    let mut r = Cursor::new(output);
    let init = rpc::read(&mut r).unwrap().unwrap();
    assert_eq!(init["result"]["capabilities"]["positionEncoding"], "utf-8");
    let unknown = rpc::read(&mut r).unwrap().unwrap();
    assert_eq!(unknown["error"]["code"], -32601);
    let shut = rpc::read(&mut r).unwrap().unwrap();
    assert_eq!(shut["id"], 3);
    assert!(rpc::read(&mut r).unwrap().is_none());
    let _ = PathBuf::new();
}

fn repo_typescript() -> Option<PathBuf> {
    let ts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/typescript");
    let node = std::process::Command::new("node").arg("--version").output();
    (ts.join("package.json").is_file() && node.is_ok_and(|o| o.status.success())).then_some(ts)
}

const CARD: &str = "export function shout(s: string): string {
  return s.toUpperCase()
}

component Card(title: string) {
  view {
    <h2>{title.length}</h2>
  }
}
";

const APP: &str = "import { Card, shout } from \"./Card.wx\"

component App() {
  signal name = \"weft\"

  function loud(word: string) {
    return shout(word).trim()
  }

  view {
    <Card title={loud(name)} />
  }
}
";

#[test]
fn typescript_service_answers_through_the_mappings() {
    let Some(typescript) = repo_typescript() else {
        eprintln!("skipped: no node or no node_modules/typescript");
        return;
    };
    let root = std::env::temp_dir().join(format!("weft-lsp-ts-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let src = root.join("src");
    fs::create_dir_all(&src).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(src.join("Card.wx"), CARD).unwrap();
    fs::write(src.join("App.wx"), APP).unwrap();
    let prepare: TsPrepare = Arc::new(move |root: &Path| {
        let src = root.join("src");
        let out = root.join(".weft").join("lsp");
        fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        for name in ["Card", "App"] {
            let text = fs::read_to_string(src.join(format!("{name}.wx"))).unwrap();
            let (ts, _) = ts::lower(&Analysis::new(&text)).ok_or("front end")?;
            fs::write(out.join(format!("{name}.ts")), ts).map_err(|e| e.to_string())?;
        }
        let config = r#"{"compilerOptions": {"strict": true, "noEmit": true,
            "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
            "allowImportingTsExtensions": true, "skipLibCheck": true},
            "include": ["**/*.ts"]}"#;
        fs::write(out.join("tsconfig.json"), config).map_err(|e| e.to_string())?;
        Ok(TsProject {
            src,
            out,
            typescript: typescript.clone(),
        })
    });
    let mut s = Server::new(Options {
        type_check: None,
        ts: Some(prepare),
    });
    s.handle(&request(1, "initialize", json!({"capabilities": {}})));
    let (card, app) = (
        path_to_uri(&src.join("Card.wx")),
        path_to_uri(&src.join("App.wx")),
    );
    open(&mut s, &card, CARD);
    open(&mut s, &app, APP);

    let h = ask(
        &mut s,
        "textDocument/hover",
        &card,
        CARD,
        "length",
        1,
        json!({}),
    );
    let value = h["result"]["contents"]["value"].as_str().unwrap_or("");
    assert!(value.contains("length: number"), "{h}");

    let edited = APP.replace("shout(word).trim()", "word.");
    s.handle(&note(
        "textDocument/didChange",
        json!({"textDocument": {"uri": app, "version": 2}, "contentChanges": [{"text": edited}]}),
    ));
    let c = ask(
        &mut s,
        "textDocument/completion",
        &app,
        &edited,
        "word.",
        5,
        json!({}),
    );
    let labels: Vec<&str> = c["result"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["label"].as_str())
        .collect();
    assert!(labels.contains(&"toUpperCase"), "{c}");
    s.handle(&note(
        "textDocument/didChange",
        json!({"textDocument": {"uri": app, "version": 3}, "contentChanges": [{"text": APP}]}),
    ));

    let r = ask(
        &mut s,
        "textDocument/rename",
        &app,
        APP,
        "shout(word)",
        1,
        json!({"newName": "yell"}),
    );
    let changes = &r["result"]["changes"];
    assert_eq!(changes[&card].as_array().map(Vec::len), Some(1), "{r}");
    assert_eq!(changes[&app].as_array().map(Vec::len), Some(2), "{r}");

    let r = ask(
        &mut s,
        "textDocument/rename",
        &app,
        APP,
        "<Card",
        2,
        json!({"newName": "Panel"}),
    );
    let changes = &r["result"]["changes"];
    assert_eq!(changes[&card].as_array().map(Vec::len), Some(1), "{r}");
    assert_eq!(changes[&app].as_array().map(Vec::len), Some(2), "{r}");

    let r = ask(
        &mut s,
        "textDocument/rename",
        &app,
        APP,
        "trim()",
        1,
        json!({"newName": "x"}),
    );
    assert!(r["error"]["message"].as_str().is_some(), "{r}");

    let refs = ask(
        &mut s,
        "textDocument/references",
        &card,
        CARD,
        "shout(",
        1,
        json!({}),
    );
    assert_eq!(refs["result"].as_array().map(Vec::len), Some(3), "{refs}");
    drop(s);
    let _ = fs::remove_dir_all(&root);
}
