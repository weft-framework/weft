use std::fs;
use std::path::{Path, PathBuf};

use weft_compiler::ast::{AttrKind, AttrValue, Item, Node};
use weft_compiler::{line_col, parse};

use crate::types::{source_dir, ProjectDiag};

#[derive(Debug, PartialEq)]
enum Seg {
    Static(String),
    Param,
    Rest { optional: bool },
}

fn pattern(rel: &str) -> Vec<Seg> {
    let no_ext = rel
        .replace('\\', "/")
        .trim_end_matches(".wx")
        .trim_end_matches(".ts")
        .to_string();
    let mut parts: Vec<&str> = no_ext.split('/').collect();
    if parts.last() == Some(&"index") {
        parts.pop();
    }
    parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .map(|p| {
            if p.starts_with("[[...") && p.ends_with("]]") {
                Seg::Rest { optional: true }
            } else if p.starts_with("[...") && p.ends_with(']') {
                Seg::Rest { optional: false }
            } else if p.starts_with('[') && p.ends_with(']') {
                Seg::Param
            } else {
                Seg::Static(p.to_string())
            }
        })
        .collect()
}

const DYN: char = '\u{1}';
const ANY: char = '\u{2}';

fn matches(pat: &[Seg], path: &[&str]) -> bool {
    if let Some(p) = path.first() {
        if p.contains(ANY) {
            return true;
        }
    }
    match pat.first() {
        None => path.is_empty(),
        Some(Seg::Static(s)) => match path.first() {
            Some(p) if p.contains(DYN) => matches(&pat[1..], &path[1..]),
            Some(p) => p == s && matches(&pat[1..], &path[1..]),
            None => false,
        },
        Some(Seg::Param) => !path.is_empty() && matches(&pat[1..], &path[1..]),
        Some(Seg::Rest { optional }) => *optional || !path.is_empty(),
    }
}

fn path_expr(s: &str) -> Option<String> {
    let s = s.trim_start();
    let mut chars = s.char_indices().peekable();
    let (_, q) = chars.next()?;
    if q != '"' && q != '\'' && q != '`' {
        return None;
    }
    let mut out = String::new();
    let mut end = None;
    while let Some((i, ch)) = chars.next() {
        match ch {
            '\\' => {
                if let Some((_, c)) = chars.next() {
                    out.push(c);
                }
            }
            '$' if q == '`' && chars.peek().map(|p| p.1) == Some('{') => {
                chars.next();
                let mut depth = 1;
                for (_, c) in chars.by_ref() {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                out.push(DYN);
            }
            c if c == q => {
                end = Some(i + c.len_utf8());
                break;
            }
            c => out.push(c),
        }
    }
    let rest = s[end?..].trim_start();
    if rest.starts_with('+') {
        out.push(ANY);
    } else if !(rest.is_empty() || rest.starts_with([')', ',', '}', ';'])) {
        return None;
    }
    (out.starts_with('/') && !out.starts_with("//") && !out.starts_with("/\\")).then_some(out)
}

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if name != "node_modules" && !name.starts_with('.') {
                files(&p, out);
            }
        } else {
            out.push(p);
        }
    }
}

fn routes(pages: &Path) -> Vec<Vec<Seg>> {
    let mut all = Vec::new();
    files(pages, &mut all);
    all.iter()
        .filter_map(|p| {
            let rel = p.strip_prefix(pages).ok()?.to_string_lossy().replace('\\', "/");
            let module = rel.ends_with(".wx") || (rel.ends_with(".ts") && !rel.ends_with(".d.ts"));
            if !module || rel.ends_with(".client.ts") || rel.split('/').any(|s| s.starts_with('_')) {
                return None;
            }
            Some(pattern(&rel))
        })
        .collect()
}

fn links(nodes: &[Node], out: &mut Vec<(String, usize)>) {
    for n in nodes {
        if let Node::Element(e) = n {
            for a in &e.attrs {
                let named = a.name.eq_ignore_ascii_case("href") || a.name.eq_ignore_ascii_case("action");
                if !matches!(a.kind, AttrKind::Plain | AttrKind::Bind) || !named {
                    continue;
                }
                let path = match &a.value {
                    Some(AttrValue::Str(v)) if v.starts_with('/') && !v.starts_with("//") && !v.starts_with("/\\") => {
                        Some(v.clone())
                    }
                    Some(AttrValue::Expr(x)) => path_expr(x),
                    _ => None,
                };
                if let Some(p) = path {
                    out.push((p, a.span.start));
                }
            }
            links(&e.children, out);
        } else {
            for b in n.blocks() {
                links(b, out);
            }
        }
    }
}

fn calls(source: &str, out: &mut Vec<(String, usize)>) {
    for name in ["redirect(", "navigate("] {
        let mut from = 0;
        while let Some(i) = source[from..].find(name) {
            let at = from + i;
            from = at + name.len();
            let before = source[..at].chars().next_back();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
                continue;
            }
            let line = &source[source[..at].rfind('\n').map_or(0, |n| n + 1)..at];
            let t = line.trim_start();
            if t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") {
                continue;
            }
            if let Some(p) = path_expr(&source[from..]) {
                out.push((p, at));
            }
        }
    }
}

fn served(path: &str, routes: &[Vec<Seg>], public: &Path) -> bool {
    if path.starts_with("/_weft/") || path == "/sitemap.xml" || path == "/robots.txt" {
        return true;
    }
    let trimmed = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    let segs: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if routes.iter().any(|r| matches(r, &segs)) {
        return true;
    }
    if segs.iter().any(|s| *s == ".." || *s == "." || s.contains(['\\', DYN, ANY])) {
        return false;
    }
    !segs.is_empty() && public.join(segs.join("/")).is_file()
}

fn shown(path: &str) -> String {
    path.replace(DYN, "${…}").replace(ANY, "…")
}

pub fn report(root: &Path) -> Vec<ProjectDiag> {
    let src = source_dir(root);
    let pages = src.join("pages");
    if !pages.is_dir() {
        return Vec::new();
    }
    let routes = routes(&pages);
    let public = root.join("public");
    let middleware = src.join("middleware.ts").is_file();
    let mut sources = Vec::new();
    files(&src, &mut sources);
    sources.retain(|p| {
        let name = p.to_string_lossy();
        name.ends_with(".wx") || (name.ends_with(".ts") && !name.ends_with(".d.ts"))
    });
    sources.sort();
    let mut out = Vec::new();
    for file in sources {
        let Ok(source) = fs::read_to_string(&file) else {
            continue;
        };
        let mut found = Vec::new();
        if file.extension().is_some_and(|e| e == "wx") {
            let (ast, _) = parse(&source);
            for item in &ast.items {
                if let Item::Component(c) = item {
                    links(&c.view.nodes, &mut found);
                }
            }
        }
        calls(&source, &mut found);
        found.sort_by_key(|f| f.1);
        for (link, offset) in found {
            let path = link.split(['?', '#']).next().unwrap_or("");
            if served(path, &routes, &public) {
                continue;
            }
            let (line, col) = line_col(&source, offset);
            out.push(ProjectDiag {
                file: file.clone(),
                line: line as u32,
                col: col as u32,
                error: !middleware,
                message: format!(
                    "link to {}: no page, API route or public file serves it{}",
                    shown(path),
                    if middleware { " (src/middleware.ts may)" } else { "" }
                ),
                code: "link-missing-route".to_string(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(rel: &str, path: &str) -> bool {
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        matches(&pattern(rel), &segs)
    }

    #[test]
    fn file_routes_match_like_the_server() {
        assert!(m("index.wx", "/"));
        assert!(!m("index.wx", "/x"));
        assert!(m("app/index.wx", "/app"));
        assert!(m("app/tasks/[id].wx", "/app/tasks/42"));
        assert!(!m("app/tasks/[id].wx", "/app/tasks"));
        assert!(!m("app/tasks/[id].wx", "/app/tasks/1/2"));
        assert!(m("docs/[...path].wx", "/docs/a/b"));
        assert!(!m("docs/[...path].wx", "/docs"));
        assert!(m("files/[[...p]].wx", "/files"));
        assert!(m("files/[[...p]].wx", "/files/x/y"));
        assert!(m("api/tasks/export.ts", "/api/tasks/export"));
    }

    #[test]
    fn paths_written_as_expressions() {
        assert_eq!(path_expr("\"/a/b\")"), Some("/a/b".into()));
        assert_eq!(path_expr("'/a\\'b'"), Some("/a'b".into()));
        assert_eq!(path_expr("`/t/${t.id}/x`"), Some(format!("/t/{DYN}/x")));
        assert_eq!(path_expr("`/t/${f({ a: 1 })}`"), Some(format!("/t/{DYN}")));
        assert_eq!(path_expr("\"/notes/\" + note.id)"), Some(format!("/notes/{ANY}")));
        assert_eq!(path_expr("\"/a\" || other"), None, "only a whole literal or a concatenation");
        assert_eq!(path_expr("next)"), None);
        assert_eq!(path_expr("\"//evil.example\")"), None);
        assert_eq!(path_expr("\"https://x.test/\")"), None);
        let m = |rel: &str, p: &str| {
            let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
            matches(&pattern(rel), &segs)
        };
        assert!(m("t/[id].wx", &format!("/t/{DYN}")));
        assert!(m("t/new.wx", &format!("/t/{DYN}")), "a dynamic segment may spell a static one");
        assert!(!m("t/[id].wx", &format!("/t/{DYN}/x")), "but it is one segment");
        assert!(!m("t/[id].wx", "/t"));
        assert!(m("t/[id]/edit.wx", &format!("/t/{ANY}")));
        assert!(!m("t/[id].wx", &format!("/u/{ANY}")));
    }

    #[test]
    fn reports_dynamic_links_and_redirects() {
        let dir = std::env::temp_dir().join(format!("weft-links-dyn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/pages/tasks")).unwrap();
        fs::write(dir.join("src/pages/tasks/[id].wx"), "").unwrap();
        fs::write(
            dir.join("src/pages/index.wx"),
            "component Page() {\n  view {\n    <a href={`/tasks/${t.id}`}>a</a>\n    <a href={`/tasks/${t.id}/edit`}>b</a>\n\
             \x20   <a :href={\"/tasks\"}>c</a>\n  }\n}\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/actions.ts"),
            "export const go = () => redirect(\"/tasks/\" + id)\n// redirect(\"/in-a-comment\")\n\
             export const no = () => redirect(\"/gone?x=1\")\nexport const dyn = (n: string) => redirect(n)\n\
             export const nav = () => navigate(`/tasks/${1}`)\nconst myredirect = (x: string) => x; myredirect(\"/not-a-call\")\n",
        )
        .unwrap();
        let shown: Vec<(String, u32, String)> = report(&dir)
            .iter()
            .map(|d| (d.file.file_name().unwrap().to_string_lossy().to_string(), d.line, d.message.clone()))
            .collect();
        let msg = |p: &str| format!("link to {p}: no page, API route or public file serves it");
        assert_eq!(
            shown,
            vec![
                ("actions.ts".to_string(), 3, msg("/gone")),
                ("index.wx".to_string(), 4, msg("/tasks/${…}/edit")),
                ("index.wx".to_string(), 5, msg("/tasks")),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_starters_link_only_to_what_they_serve() {
        let templates = Path::new(env!("CARGO_MANIFEST_DIR")).join("templates");
        for t in fs::read_dir(&templates).unwrap().flatten() {
            if t.path().join("src/pages").is_dir() {
                let diags = report(&t.path());
                let shown: Vec<String> = diags.iter().map(|d| format!("{}:{} {}", d.file.display(), d.line, d.message)).collect();
                assert!(shown.is_empty(), "{shown:#?}");
            }
        }
    }

    #[test]
    fn reports_missing_routes() {
        let dir = std::env::temp_dir().join(format!("weft-links-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/pages/blog")).unwrap();
        fs::create_dir_all(dir.join("public/img")).unwrap();
        fs::write(dir.join("public/img/logo.svg"), "<svg/>").unwrap();
        fs::write(dir.join("src/pages/_layout.wx"), "").unwrap();
        fs::write(dir.join("src/pages/blog/[slug].wx"), "").unwrap();
        fs::write(
            dir.join("src/pages/index.wx"),
            "component Page() {\n  view {\n    <a href=\"/blog/hello?x=1#top\">a</a>\n    <a href=\"/img/logo.svg\">b</a>\n\
             \x20   <a href=\"/_weft/dev/mail\">c</a>\n    <a href={dynamic}>d</a>\n    <a href=\"https://example.com/x\">e</a>\n\
             \x20   {#if x}<form action=\"/nope\"></form>{/if}\n    <a href=\"/blog\">f</a>\n    <a href=\"/_layout\">g</a>\n\
             \x20   <a href=\"/../secret.txt\">h</a>\n  }\n}\n",
        )
        .unwrap();
        let diags = report(&dir);
        let shown: Vec<(u32, bool, String)> = diags.iter().map(|d| (d.line, d.error, d.message.clone())).collect();
        assert_eq!(
            shown,
            vec![
                (8, true, "link to /nope: no page, API route or public file serves it".to_string()),
                (9, true, "link to /blog: no page, API route or public file serves it".to_string()),
                (10, true, "link to /_layout: no page, API route or public file serves it".to_string()),
                (11, true, "link to /../secret.txt: no page, API route or public file serves it".to_string()),
            ]
        );
        fs::write(dir.join("src/middleware.ts"), "").unwrap();
        let diags = report(&dir);
        assert_eq!(diags.len(), 4);
        assert!(diags.iter().all(|d| !d.error && d.message.ends_with("(src/middleware.ts may)")));
        let _ = fs::remove_dir_all(&dir);
    }
}
