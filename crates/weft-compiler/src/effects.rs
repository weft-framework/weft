use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::ast::{AttrValue, Component, Item, Node, SourceFile, Uses};
use crate::check::free_idents;
use crate::diagnostics::Diagnostic;
use crate::lexer::tokenize;
use crate::token::{Keyword, Span, TokenKind};

pub const CAPS: &[&str] = &["db", "net", "fs", "auth"];

const NET_GLOBALS: &[&str] = &["fetch", "WebSocket", "EventSource", "XMLHttpRequest"];

fn module_cap(spec: &str) -> Option<&'static str> {
    let bare = spec.strip_prefix("node:").unwrap_or(spec);
    match bare {
        "fs" | "fs/promises" => Some("fs"),
        "http" | "https" | "http2" | "net" | "tls" | "dgram" | "dns" | "dns/promises"
        | "undici" | "ws" => Some("net"),
        "@weft/server/auth" => Some("auth"),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reason {
    pub via: String,
    pub leaf: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Import {
    pub(crate) spec: String,
    pub(crate) name: String,
}

pub(crate) type Reached = BTreeSet<(String, String)>;

#[derive(Debug, Default)]
pub(crate) struct Analysis {
    pub(crate) effects: HashMap<String, BTreeMap<&'static str, Reason>>,
    pub(crate) reached: HashMap<String, Reached>,
    pub(crate) refs: HashMap<String, Vec<(String, usize)>>,
    pub(crate) imports: HashMap<String, Import>,
    pub(crate) plain_fns: HashMap<String, bool>,
    pub(crate) models: BTreeSet<String>,
}

pub(crate) fn is_wx(spec: &str) -> bool {
    (spec.starts_with("./") || spec.starts_with("../")) && spec.ends_with(".wx")
}

pub(crate) fn analyze(src: &str, file: &SourceFile) -> Analysis {
    let mut an = Analysis::default();
    let mut flows: BTreeSet<String> = BTreeSet::new();

    let mut cursor = 0;
    for it in &file.items {
        let span = it.span();
        if span.start > cursor {
            plain_region(src, cursor, span.start, &mut an);
        }
        cursor = cursor.max(span.end);
        match it {
            Item::Model(m) => {
                an.models.insert(m.name.clone());
            }
            Item::Component(c) => {
                an.refs.insert(c.name.clone(), component_refs(src, c));
                flows.insert(c.name.clone());
            }
            Item::Action(a) => {
                let mut refs = offset_idents(&a.body, a.body_offset);
                if reads_session(&a.body) {
                    refs.push(("ctx.session".to_string(), a.body_offset));
                }
                an.refs.insert(a.name.clone(), refs);
            }
            Item::Placed(p) if p.import.is_some() => {
                for n in &p.names {
                    an.refs.insert(n.clone(), Vec::new());
                    flows.insert(n.clone());
                }
            }
            Item::Placed(p) => {
                an.refs
                    .insert(p.name.clone(), offset_idents(&p.source, p.offset));
                flows.insert(p.name.clone());
            }
            Item::Store(_) | Item::Actor(_) => {}
        }
    }
    if cursor < src.len() {
        plain_region(src, cursor, src.len(), &mut an);
    }
    flows.extend(an.plain_fns.keys().cloned());

    let names: Vec<String> = an.refs.keys().cloned().collect();
    for d in &names {
        let mut caps = BTreeMap::new();
        let mut reached = Reached::new();
        for (r, _) in &an.refs[d] {
            if let Some(cap) = leaf_cap(r, &an.models, &an.imports) {
                caps.entry(cap).or_insert_with(|| Reason {
                    via: r.clone(),
                    leaf: r.clone(),
                });
            }
            if let Some(imp) = an.imports.get(r) {
                if is_wx(&imp.spec) && imp.name != "*" {
                    reached.insert((imp.spec.clone(), imp.name.clone()));
                }
            }
        }
        an.effects.insert(d.clone(), caps);
        an.reached.insert(d.clone(), reached);
    }
    loop {
        let mut changed = false;
        for d in &names {
            for (r, _) in an.refs[d].clone() {
                if &r == d || !flows.contains(&r) {
                    continue;
                }
                let theirs = an.effects.get(&r).cloned().unwrap_or_default();
                let their_reach = an.reached.get(&r).cloned().unwrap_or_default();
                let mine = an.effects.get_mut(d).expect("analysed");
                for (cap, why) in theirs {
                    if !mine.contains_key(cap) {
                        mine.insert(
                            cap,
                            Reason {
                                via: r.clone(),
                                leaf: why.leaf,
                            },
                        );
                        changed = true;
                    }
                }
                let reach = an.reached.get_mut(d).expect("analysed");
                for x in their_reach {
                    changed |= reach.insert(x);
                }
            }
        }
        if !changed {
            break;
        }
    }
    an
}

fn leaf_cap(
    name: &str,
    models: &BTreeSet<String>,
    imports: &HashMap<String, Import>,
) -> Option<&'static str> {
    if name == "ctx.session" {
        return Some("auth");
    }
    if models.contains(name) {
        return Some("db");
    }
    if let Some(imp) = imports.get(name) {
        return module_cap(&imp.spec);
    }
    if NET_GLOBALS.contains(&name) {
        return Some("net");
    }
    None
}

fn offset_idents(text: &str, at: usize) -> Vec<(String, usize)> {
    free_idents(text)
        .into_iter()
        .map(|(n, off)| (n, at + off))
        .collect()
}

fn reads_session(body: &str) -> bool {
    let (toks, _) = tokenize(body);
    toks.windows(3).any(|w| {
        matches!(&w[0].kind, TokenKind::Ident(a) if a == "ctx")
            && matches!(w[1].kind, TokenKind::Dot)
            && matches!(&w[2].kind, TokenKind::Ident(b) if b == "session")
    })
}

fn find_from(src: &str, from: usize, needle: &str) -> usize {
    src.get(from..)
        .and_then(|s| s.find(needle))
        .map_or(from, |i| from + i)
}

fn component_refs(src: &str, c: &Component) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    for r in &c.reactives {
        let eq = find_from(src, r.span.start, "=");
        out.extend(offset_idents(&r.expr, find_from(src, eq, &r.expr)));
    }
    for f in &c.functions {
        out.extend(offset_idents(&f.source, f.span.start));
    }
    for h in &c.lifecycle {
        out.extend(offset_idents(&h.expr, h.span.start));
    }
    view_refs(src, &c.view.nodes, &mut out);
    out
}

fn view_refs(src: &str, nodes: &[Node], out: &mut Vec<(String, usize)>) {
    for n in nodes {
        match n {
            Node::Interp(i) => out.extend(offset_idents(
                &i.expr,
                find_from(src, i.span.start, &i.expr),
            )),
            Node::Element(e) => {
                if e.name.starts_with(|c: char| c.is_ascii_uppercase()) {
                    out.push((e.name.clone(), e.span.start + 1));
                }
                for a in &e.attrs {
                    if let Some(AttrValue::Expr(x)) = &a.value {
                        out.extend(offset_idents(x, find_from(src, a.span.start, x)));
                    }
                }
                view_refs(src, &e.children, out);
            }
            Node::If(b) => {
                let mut at = b.span.start;
                for arm in &b.arms {
                    at = find_from(src, at, &arm.cond);
                    out.extend(offset_idents(&arm.cond, at));
                }
            }
            Node::Each(b) => out.extend(offset_idents(
                &b.expr,
                find_from(src, b.span.start, &b.expr),
            )),
            Node::Await(b) => out.extend(offset_idents(
                &b.expr,
                find_from(src, b.span.start, &b.expr),
            )),
            Node::Text(_) => {}
        }
        for body in n.blocks() {
            view_refs(src, body, out);
        }
    }
}

fn plain_region(src: &str, start: usize, end: usize, an: &mut Analysis) {
    let Some(region) = src.get(start..end) else {
        return;
    };
    let (toks, _) = tokenize(region);
    let mut depth = 0i32;
    let mut k = 0;
    while k < toks.len() {
        match &toks[k].kind {
            TokenKind::LBrace | TokenKind::LParen | TokenKind::LBracket => depth += 1,
            TokenKind::RBrace | TokenKind::RParen | TokenKind::RBracket => depth -= 1,
            TokenKind::Keyword(Keyword::Import) if depth == 0 => {
                k = import_clause(&toks, k + 1, an);
                continue;
            }
            TokenKind::Keyword(Keyword::Function) if depth == 0 => {
                let exported = k > 0
                    && matches!(toks[k - 1].kind, TokenKind::Keyword(Keyword::Export))
                    || k > 1
                        && matches!(&toks[k - 1].kind, TokenKind::Ident(w) if w == "async")
                        && matches!(toks[k - 2].kind, TokenKind::Keyword(Keyword::Export));
                if let Some(TokenKind::Ident(name)) = toks.get(k + 1).map(|t| &t.kind) {
                    let mut j = k + 2;
                    let mut paren = 0i32;
                    while j < toks.len() {
                        match toks[j].kind {
                            TokenKind::LParen => paren += 1,
                            TokenKind::RParen => paren -= 1,
                            TokenKind::LBrace if paren == 0 => break,
                            _ => {}
                        }
                        j += 1;
                    }
                    let open = j;
                    let mut d = 0i32;
                    while j < toks.len() {
                        match toks[j].kind {
                            TokenKind::LBrace => d += 1,
                            TokenKind::RBrace => {
                                d -= 1;
                                if d == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        j += 1;
                    }
                    if open < toks.len() && j < toks.len() {
                        let (a, b) = (toks[open].span.start, toks[j].span.end);
                        an.refs
                            .insert(name.clone(), offset_idents(&region[a..b], start + a));
                        an.plain_fns.insert(name.clone(), exported);
                        k = j + 1;
                        continue;
                    }
                }
            }
            _ => {}
        }
        k += 1;
    }
}

fn import_clause(toks: &[crate::token::Token], mut k: usize, an: &mut Analysis) -> usize {
    if matches!(toks.get(k).map(|t| &t.kind), Some(TokenKind::Ident(w)) if w == "type") {
        while k < toks.len() && !matches!(toks[k].kind, TokenKind::Str(_)) {
            k += 1;
        }
        return k + 1;
    }
    let mut names: Vec<(String, String)> = Vec::new();
    let mut braces = false;
    while k < toks.len() {
        match &toks[k].kind {
            TokenKind::Str(spec) => {
                for (local, name) in names {
                    an.imports.insert(
                        local,
                        Import {
                            spec: spec.clone(),
                            name,
                        },
                    );
                }
                return k + 1;
            }
            TokenKind::LBrace => braces = true,
            TokenKind::RBrace => braces = false,
            TokenKind::Star => {
                if let Some(TokenKind::Ident(ns)) = toks.get(k + 2).map(|t| &t.kind) {
                    names.push((ns.clone(), "*".to_string()));
                    k += 3;
                    continue;
                }
            }
            TokenKind::Ident(w) if w == "type" && braces => {}
            TokenKind::Ident(n) => {
                let next = toks.get(k + 1).map(|t| &t.kind);
                if matches!(next, Some(TokenKind::Ident(a)) if a == "as") {
                    if let Some(TokenKind::Ident(local)) = toks.get(k + 2).map(|t| &t.kind) {
                        names.push((local.clone(), n.clone()));
                        k += 3;
                        continue;
                    }
                }
                let exported = if braces {
                    n.clone()
                } else {
                    "default".to_string()
                };
                names.push((n.clone(), exported));
            }
            TokenKind::Keyword(Keyword::From) | TokenKind::Comma => {}
            _ => return k,
        }
        k += 1;
    }
    k
}

pub(crate) fn check(file: &SourceFile, an: &Analysis, diags: &mut Vec<Diagnostic>) {
    for it in &file.items {
        let (name, uses) = match it {
            Item::Component(c) => (&c.name, &c.uses),
            Item::Action(a) => (&a.name, &a.uses),
            _ => continue,
        };
        let Some(uses) = uses else {
            continue;
        };
        let Some(allowed) = allowed(uses, diags) else {
            continue;
        };
        let mut reported: BTreeSet<(String, &str)> = BTreeSet::new();
        for (r, at) in an.refs.get(name).into_iter().flatten() {
            if r == name {
                continue;
            }
            let mut caps: Vec<(&'static str, String)> = Vec::new();
            if let Some(why) = an.effects.get(r) {
                let is_action = file
                    .items
                    .iter()
                    .any(|it| matches!(it, Item::Action(a) if &a.name == r));
                if !is_action {
                    caps.extend(why.iter().map(|(c, w)| (*c, w.leaf.clone())));
                }
            }
            if let Some(cap) = leaf_cap(r, &an.models, &an.imports) {
                caps.push((cap, r.clone()));
            }
            for (cap, leaf) in caps {
                if allowed.contains(cap) || !reported.insert((r.clone(), cap)) {
                    continue;
                }
                let through = if &leaf == r {
                    String::new()
                } else {
                    format!(" (through `{leaf}`)")
                };
                let len = if r == "ctx.session" { 3 } else { r.len() };
                diags.push(Diagnostic::error(
                    format!(
                        "`{name}` is declared `uses {}` but `{r}` uses `{cap}`{through}",
                        declared(uses)
                    ),
                    Span::new(*at, at + len),
                ));
            }
        }
    }
}

pub(crate) fn allowed(uses: &Uses, diags: &mut Vec<Diagnostic>) -> Option<BTreeSet<&'static str>> {
    let mut set = BTreeSet::new();
    let mut ok = true;
    for (cap, span) in &uses.caps {
        if cap == "none" {
            if uses.caps.len() > 1 {
                diags.push(Diagnostic::error(
                    "`uses none` cannot be combined with capabilities",
                    *span,
                ));
                ok = false;
            }
            continue;
        }
        match CAPS.iter().find(|c| **c == cap) {
            Some(c) => {
                set.insert(*c);
            }
            None => {
                diags.push(Diagnostic::error(
                    format!("unknown capability `{cap}`; capabilities are db, net, fs and auth (or `none`)"),
                    *span,
                ));
                ok = false;
            }
        }
    }
    ok.then_some(set)
}

fn declared(uses: &Uses) -> String {
    uses.caps
        .iter()
        .map(|(c, _)| c.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}
