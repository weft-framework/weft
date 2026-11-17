use std::ops::Range;

use weft_compiler::ast::{Component, Item, Node, ReactiveKind, SourceFile};
use weft_compiler::lexer::{is_ident_continue, scan_template};
use weft_compiler::{check, parse, tokenize, Diagnostic, Severity, Span, TokenKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Component,
    Model,
    Store,
    Action,
    Placed,
    Signal,
    Derived,
    Function,
    Param,
    Binding,
    Import,
}

impl Kind {
    pub fn is_local(self) -> bool {
        matches!(
            self,
            Kind::Signal | Kind::Derived | Kind::Function | Kind::Param | Kind::Binding
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Component => "component",
            Kind::Model => "model",
            Kind::Store => "store",
            Kind::Action => "action",
            Kind::Placed => "declaration",
            Kind::Signal => "signal",
            Kind::Derived => "derived",
            Kind::Function => "function",
            Kind::Param => "parameter",
            Kind::Binding => "binding",
            Kind::Import => "import",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: String,
    pub kind: Kind,
    pub name_span: Span,
    pub span: Span,
    pub scope: Option<Span>,
    pub detail: String,
    pub import: Option<(String, String)>,
    pub parent: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Ref {
    pub name: String,
    pub span: Span,
}

#[derive(Clone)]
pub struct Analysis {
    pub src: String,
    pub file: SourceFile,
    pub diagnostics: Vec<Diagnostic>,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Ref>,
    pub code: Vec<Range<usize>>,
}

impl Analysis {
    pub fn new(src: &str) -> Self {
        let (file, mut diagnostics) = parse(src);
        if !diagnostics.iter().any(|d| d.severity == Severity::Error) {
            diagnostics.extend(check(src, &file));
        }
        let mut a = Analysis {
            src: src.to_string(),
            file,
            diagnostics,
            symbols: Vec::new(),
            refs: Vec::new(),
            code: Vec::new(),
        };
        a.collect();
        a
    }

    pub fn symbol_at(&self, offset: usize) -> Option<&Symbol> {
        if let Some(s) = self
            .symbols
            .iter()
            .find(|s| s.name_span.start <= offset && offset <= s.name_span.end)
        {
            return Some(s);
        }
        let r = self
            .refs
            .iter()
            .find(|r| r.span.start <= offset && offset <= r.span.end)?;
        self.resolve(&r.name, r.span.start)
    }

    pub fn resolve(&self, name: &str, offset: usize) -> Option<&Symbol> {
        self.visible(offset).into_iter().find(|s| s.name == name)
    }

    pub fn visible(&self, offset: usize) -> Vec<&Symbol> {
        let mut v: Vec<&Symbol> = self
            .symbols
            .iter()
            .filter(|s| s.scope.is_none_or_contains(offset))
            .collect();
        v.sort_by_key(|s| s.scope.map_or(usize::MAX, |sc| sc.end - sc.start));
        v
    }

    pub fn occurrences(&self, sym: &Symbol) -> Vec<Span> {
        let mut out = vec![sym.name_span];
        for r in &self.refs {
            if r.name == sym.name
                && r.span != sym.name_span
                && self
                    .resolve(&r.name, r.span.start)
                    .is_some_and(|s| s.name_span == sym.name_span)
            {
                out.push(r.span);
            }
        }
        out.sort_by_key(|s| s.start);
        out
    }

    pub fn component_at(&self, offset: usize) -> Option<&Component> {
        self.file.items.iter().find_map(|i| match i {
            Item::Component(c) if c.body.start <= offset && offset <= c.body.end => Some(c),
            _ => None,
        })
    }

    pub fn in_code(&self, offset: usize) -> bool {
        self.code
            .iter()
            .any(|r| r.start <= offset && offset <= r.end)
    }

    fn push(&mut self, sym: Symbol) -> usize {
        self.symbols.push(sym);
        self.symbols.len() - 1
    }

    fn collect(&mut self) {
        let src = self.src.clone();
        let items = self.file.items.clone();
        let mut pos = 0;
        for item in &items {
            let span = item.span();
            self.plain_code(&src, pos..span.start);
            pos = span.end;
            match item {
                Item::Component(c) => self.component(&src, c),
                Item::Model(m) => {
                    let fields: Vec<String> = m
                        .fields
                        .iter()
                        .map(|f| format!("  {}: {}", f.name, f.ty))
                        .collect();
                    let detail = format!("model {} {{\n{}\n}}", m.name, fields.join("\n"));
                    self.top(&src, Kind::Model, &m.name, span, "model".len(), detail);
                }
                Item::Store(s) => {
                    let scope = if s.session { "session" } else { "app" };
                    let ty = s.ty.as_ref().map(|t| format!(": {t}")).unwrap_or_default();
                    let detail = format!("store {scope} {}{ty}", s.name);
                    self.top(&src, Kind::Store, &s.name, span, "store".len(), detail);
                    self.code_range(&src, s.init_offset..s.init_offset + s.init.len());
                }
                Item::Action(a) => {
                    let detail = header(&src[span.start..a.body_offset.saturating_sub(1)]);
                    let kw = if a.job { "job" } else { "action" };
                    self.top(&src, Kind::Action, &a.name, span, kw.len(), detail);
                    self.code_range(&src, a.body_offset..a.body_offset + a.body.len());
                }
                Item::Placed(p) => {
                    let side = if p.client { "client" } else { "server" };
                    let first = p.source.split('{').next().unwrap_or("").trim();
                    let detail = format!("{side} {}", header(first));
                    self.top(&src, Kind::Placed, &p.name, span, side.len(), detail);
                    self.code_range(&src, p.offset..p.offset + p.source.len());
                }
                Item::Actor(_) => {}
            }
        }
        self.plain_code(&src, pos..src.len());
    }

    fn top(&mut self, src: &str, kind: Kind, name: &str, span: Span, skip: usize, detail: String) {
        if let Some(name_span) = find_word(src, span.start + skip, span.end, name) {
            self.push(Symbol {
                name: name.to_string(),
                kind,
                name_span,
                span,
                scope: None,
                detail,
                import: None,
                parent: None,
            });
        }
    }

    fn component(&mut self, src: &str, c: &Component) {
        let detail = header(&src[c.span.start..c.body.start - 1]);
        let Some(name_span) =
            find_word(src, c.span.start + "component".len(), c.body.start, &c.name)
        else {
            return;
        };
        let me = self.push(Symbol {
            name: c.name.clone(),
            kind: Kind::Component,
            name_span,
            span: c.span,
            scope: None,
            detail,
            import: None,
            parent: None,
        });
        let scope = Some(c.span);
        let member = |name: &str, kind, name_span, span, detail: String| Symbol {
            name: name.to_string(),
            kind,
            name_span,
            span,
            scope,
            detail,
            import: None,
            parent: Some(me),
        };
        for p in &c.params {
            let ns = Span::new(p.span.start, p.span.start + p.name.len());
            let q = if p.optional { "?" } else { "" };
            let s = member(
                &p.name,
                Kind::Param,
                ns,
                p.span,
                format!("(parameter) {}{q}: {}", p.name, p.ty),
            );
            self.push(s);
        }
        for r in &c.reactives {
            let Some(ns) = find_word(src, r.span.start, r.span.end, &r.name) else {
                continue;
            };
            let (kind, word) = match r.kind {
                ReactiveKind::Signal => (Kind::Signal, "signal"),
                ReactiveKind::Derived => (Kind::Derived, "derived"),
            };
            let client = if r.client { "client " } else { "" };
            let expr = r.expr.lines().next().unwrap_or("");
            let s = member(
                &r.name,
                kind,
                ns,
                r.span,
                format!("{client}{word} {} = {expr}", r.name),
            );
            self.push(s);
        }
        for f in &c.functions {
            let Some(ns) = find_word(src, f.span.start + "function".len(), f.span.end, &f.name)
            else {
                continue;
            };
            let client = if f.client { "client " } else { "" };
            let head = header(f.source.split('{').next().unwrap_or(""));
            let s = member(
                &f.name,
                Kind::Function,
                ns,
                f.span,
                format!("{client}{head}"),
            );
            self.push(s);
        }
        let view_brace = c.view.span.start.saturating_sub(1);
        let members_end = src[c.body.start..view_brace]
            .rfind("view")
            .map_or(view_brace, |i| c.body.start + i);
        self.code_range(src, c.body.start..members_end);
        self.bindings(src, &c.view.nodes, me);
        self.markup(src, c.view.span.start..c.view.span.end);
        if let Some(style) = &c.style {
            self.style_refs(src, style.offset..style.offset + style.css.len());
        }
    }

    fn bindings(&mut self, src: &str, nodes: &[Node], parent: usize) {
        for n in nodes {
            match n {
                Node::Each(e) => {
                    let header_end = src[e.span.start..e.span.end]
                        .find('}')
                        .map_or(e.span.end, |i| e.span.start + i);
                    let header = &src[e.span.start..header_end];
                    let after_as = header
                        .rfind(" as ")
                        .map_or(e.span.start, |i| e.span.start + i + 4);
                    for name in std::iter::once(&e.item).chain(e.index.as_ref()) {
                        if let Some(ns) = find_word(src, after_as, header_end, name) {
                            self.push(Symbol {
                                name: name.clone(),
                                kind: Kind::Binding,
                                name_span: ns,
                                span: e.span,
                                scope: Some(e.span),
                                detail: format!("(each) {name} of {}", e.expr),
                                import: None,
                                parent: Some(parent),
                            });
                        }
                    }
                }
                Node::Await(a) => {
                    for (word, branch) in [("then", &a.then), ("catch", &a.catch)] {
                        let Some(name) = branch.as_ref().and_then(|b| b.binding.as_ref()) else {
                            continue;
                        };
                        let text = &src[a.span.start..a.span.end];
                        let Some(at) = find_keyword(text, word) else {
                            continue;
                        };
                        if let Some(ns) =
                            find_word(src, a.span.start + at + word.len(), a.span.end, name)
                        {
                            self.push(Symbol {
                                name: name.clone(),
                                kind: Kind::Binding,
                                name_span: ns,
                                span: a.span,
                                scope: Some(a.span),
                                detail: format!("(await {word}) {name} of {}", a.expr),
                                import: None,
                                parent: Some(parent),
                            });
                        }
                    }
                }
                Node::Element(el) => self.bindings(src, &el.children, parent),
                _ => {}
            }
            for b in n.blocks() {
                self.bindings(src, b, parent);
            }
        }
    }

    fn plain_code(&mut self, src: &str, range: Range<usize>) {
        if range.is_empty() {
            return;
        }
        self.imports(src, range.clone());
        self.code_range(src, range);
    }

    fn imports(&mut self, src: &str, range: Range<usize>) {
        let text = &src[range.clone()];
        let (tokens, _) = tokenize(text);
        let mut i = 0;
        while i < tokens.len() {
            if tokens[i].kind != TokenKind::Keyword(weft_compiler::Keyword::Import) {
                i += 1;
                continue;
            }
            let start = i;
            let mut names: Vec<(String, String, Span)> = Vec::new();
            i += 1;
            if matches!(
                &tokens.get(i).map(|t| &t.kind),
                Some(TokenKind::Keyword(weft_compiler::Keyword::Type))
            ) {
                i += 1;
            }
            if let Some(TokenKind::Ident(n)) = tokens.get(i).map(|t| &t.kind) {
                names.push(("default".into(), n.clone(), tokens[i].span));
                i += 1;
                if tokens.get(i).map(|t| &t.kind) == Some(&TokenKind::Comma) {
                    i += 1;
                }
            }
            if tokens.get(i).map(|t| &t.kind) == Some(&TokenKind::LBrace) {
                i += 1;
                while let Some(t) = tokens.get(i) {
                    match &t.kind {
                        TokenKind::RBrace | TokenKind::Eof => break,
                        TokenKind::Ident(n) => {
                            let imported = n.clone();
                            let mut local = (n.clone(), t.span);
                            if matches!(&tokens.get(i + 1).map(|t| &t.kind), Some(TokenKind::Ident(w)) if w == "as")
                            {
                                if let Some(TokenKind::Ident(l)) =
                                    tokens.get(i + 2).map(|t| &t.kind)
                                {
                                    local = (l.clone(), tokens[i + 2].span);
                                    i += 2;
                                }
                            }
                            names.push((imported, local.0, local.1));
                        }
                        _ => {}
                    }
                    i += 1;
                }
            }
            while let Some(t) = tokens.get(i) {
                match &t.kind {
                    TokenKind::Str(spec) => {
                        let end = t.span.end;
                        let detail = text[tokens[start].span.start..end].to_string();
                        for (imported, local, sp) in names.drain(..) {
                            self.symbols.push(Symbol {
                                name: local,
                                kind: Kind::Import,
                                name_span: Span::new(range.start + sp.start, range.start + sp.end),
                                span: Span::new(
                                    range.start + tokens[start].span.start,
                                    range.start + end,
                                ),
                                scope: None,
                                detail: detail.clone(),
                                import: Some((spec.clone(), imported)),
                                parent: None,
                            });
                        }
                        break;
                    }
                    TokenKind::Keyword(weft_compiler::Keyword::Import) | TokenKind::Eof => break,
                    _ => i += 1,
                }
            }
        }
    }

    fn code_range(&mut self, src: &str, range: Range<usize>) {
        if range.is_empty() || range.end > src.len() {
            return;
        }
        self.code.push(range.clone());
        let text = &src[range.clone()];
        let (tokens, _) = tokenize(text);
        let mut prev_dot = false;
        for t in &tokens {
            match &t.kind {
                TokenKind::Ident(n) if !prev_dot && text[t.span.start..t.span.end] == **n => {
                    self.refs.push(Ref {
                        name: n.clone(),
                        span: Span::new(range.start + t.span.start, range.start + t.span.end),
                    });
                }
                TokenKind::Template(_) => {
                    let (_, subs) = scan_template(text.as_bytes(), t.span.start + 1);
                    for s in subs {
                        self.code_range(src, range.start + s.start..range.start + s.end);
                    }
                }
                _ => {}
            }
            prev_dot = t.kind == TokenKind::Dot;
        }
    }

    fn style_refs(&mut self, src: &str, range: Range<usize>) {
        let css = &src[range.clone()];
        let mut i = 0;
        while let Some(open) = css[i..].find('{') {
            let at = i + open + 1;
            let len = css[at..]
                .find(|c: char| !is_ident_continue(c))
                .unwrap_or(css.len() - at);
            if len > 0 && css[at + len..].starts_with('}') {
                let name = &css[at..at + len];
                if weft_compiler::lexer::is_ident(name) {
                    self.refs.push(Ref {
                        name: name.to_string(),
                        span: Span::new(range.start + at, range.start + at + len),
                    });
                }
            }
            i = at;
        }
    }

    fn markup(&mut self, src: &str, range: Range<usize>) {
        let b = src.as_bytes();
        let mut i = range.start;
        while i < range.end {
            if src[i..].starts_with("<!--") {
                i = src[i..].find("-->").map_or(range.end, |e| i + e + 3);
                continue;
            }
            match b[i] {
                b'{' => {
                    let Some(end) = braces(b, i + 1) else { return };
                    let mut start = i + 1;
                    while start < end && b[start].is_ascii_whitespace() {
                        start += 1;
                    }
                    if start < end && matches!(b[start], b'#' | b':' | b'/') {
                        start += 1;
                    }
                    self.code_range(src, start..end - 1);
                    i = end;
                }
                b'<' => i = self.tag(src, i, range.end),
                _ => i += 1,
            }
        }
    }

    fn tag(&mut self, src: &str, i: usize, end: usize) -> usize {
        let b = src.as_bytes();
        let close = b.get(i + 1) == Some(&b'/');
        let name_start = i + 1 + close as usize;
        let mut j = name_start;
        while j < end && (is_ident_continue(b[j] as char) || matches!(b[j], b'-' | b'.' | b':')) {
            j += 1;
        }
        let name = &src[name_start..j];
        if name.is_empty() {
            return i + 1;
        }
        if name.starts_with(|c: char| c.is_ascii_uppercase()) {
            self.refs.push(Ref {
                name: name.to_string(),
                span: Span::new(name_start, j),
            });
        }
        while j < end {
            match b[j] {
                b'>' => {
                    j += 1;
                    break;
                }
                q @ (b'"' | b'\'') => {
                    j = src[j + 1..].find(q as char).map_or(end, |e| j + 1 + e + 1);
                }
                b'{' => {
                    let Some(e) = braces(b, j + 1) else {
                        return end;
                    };
                    self.code_range(src, j + 1..e - 1);
                    j = e;
                }
                _ => j += 1,
            }
        }
        let lower = name.to_ascii_lowercase();
        if !close && (lower == "script" || lower == "style") {
            let needle = format!("</{lower}");
            let rest = src[j..end].to_ascii_lowercase();
            return rest.find(&needle).map_or(end, |e| j + e);
        }
        j
    }
}

trait ScopeExt {
    fn is_none_or_contains(&self, offset: usize) -> bool;
}

impl ScopeExt for Option<Span> {
    fn is_none_or_contains(&self, offset: usize) -> bool {
        self.map_or(true, |s| s.start <= offset && offset <= s.end)
    }
}

fn braces(b: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 1;
    while i < b.len() {
        let c = b[i];
        i += 1;
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            q @ (b'"' | b'\'' | b'`') => {
                while i < b.len() {
                    let d = b[i];
                    i += 1;
                    if d == b'\\' {
                        i += 1;
                    } else if d == q {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    None
}

pub fn find_word(src: &str, from: usize, to: usize, word: &str) -> Option<Span> {
    let to = to.min(src.len());
    let mut at = from;
    while at < to {
        let i = src[at..to].find(word)? + at;
        let before = src[..i].chars().next_back();
        let after = src[i + word.len()..].chars().next();
        let boundary = |c: Option<char>| c.map_or(true, |c| !is_ident_continue(c) && c != '$');
        if boundary(before) && boundary(after) {
            return Some(Span::new(i, i + word.len()));
        }
        at = i + word.len();
    }
    None
}

fn find_keyword(text: &str, word: &str) -> Option<usize> {
    find_word(text, 0, text.len(), word).map(|s| s.start)
}

fn header(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "import { Card as Box } from \"./Card.wx\"\n\
store app visits = 0\n\
component Counter(start: number) {\n\
  signal count = start\n\
  derived hue = count * 2\n\
  function inc() { count += 1; obj.count = 2 }\n\
  view {\n\
    <Box title={count}>count</Box>\n\
    {#each [1, 2] as count, i}<p>{count}{i}</p>{/each}\n\
    <button @click={inc}>{visits.value}</button>\n\
  }\n\
  style { p { color: hsl({hue} 50% 50%) } }\n\
}\n";

    fn at(a: &Analysis, needle: &str, nth: usize) -> usize {
        a.src.match_indices(needle).nth(nth).unwrap().0
    }

    #[test]
    fn declarations_and_scopes() {
        let a = Analysis::new(SRC);
        let names: Vec<(&str, Kind)> = a
            .symbols
            .iter()
            .map(|s| (s.name.as_str(), s.kind))
            .collect();
        for want in [
            ("Box", Kind::Import),
            ("visits", Kind::Store),
            ("Counter", Kind::Component),
            ("start", Kind::Param),
            ("count", Kind::Signal),
            ("hue", Kind::Derived),
            ("inc", Kind::Function),
            ("count", Kind::Binding),
            ("i", Kind::Binding),
        ] {
            assert!(names.contains(&want), "{want:?} in {names:?}");
        }
        let imp = a.symbols.iter().find(|s| s.kind == Kind::Import).unwrap();
        assert_eq!(
            imp.import,
            Some(("./Card.wx".to_string(), "Card".to_string()))
        );
    }

    #[test]
    fn references_resolve_to_the_innermost_declaration() {
        let a = Analysis::new(SRC);
        let signal = a.symbols.iter().find(|s| s.kind == Kind::Signal).unwrap();
        let occ = a.occurrences(signal);
        assert_eq!(occ.len(), 4, "{occ:?}");
        let inner = a.symbol_at(at(&a, "{count}{i}", 0) + 1).unwrap();
        assert_eq!(inner.kind, Kind::Binding);
        let hue = a.symbols.iter().find(|s| s.name == "hue").unwrap();
        assert_eq!(a.occurrences(hue).len(), 2);
        let tag = a.symbol_at(at(&a, "<Box", 0) + 2).unwrap();
        assert_eq!(tag.kind, Kind::Import);
        assert_eq!(a.occurrences(tag).len(), 3);
    }
}
