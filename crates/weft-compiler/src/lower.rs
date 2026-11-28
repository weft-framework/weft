use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::ast::{
    Attr, AttrKind, AttrValue, Comments, Component, Element, Item, LifecycleKind, Model, Node,
    PolicyKind, ReactiveKind, Slots, SourceFile, View,
};
use crate::lexer::{is_ident_continue, is_ident_start, tokenize};
use crate::token::{Token, TokenKind};

#[allow(clippy::missing_const_for_thread_local)]
mod mapping_state {
    use super::{Cell, RefCell};
    thread_local! {
    pub(super) static MAPPING: Cell<bool> = const { Cell::new(false) };
    pub(super) static SOURCE: RefCell<String> = const { RefCell::new(String::new()) };
    }
}
use mapping_state::{MAPPING, SOURCE};

pub(crate) fn marking() -> bool {
    MAPPING.with(|m| m.get())
}

pub(crate) fn mark_str(at: usize) -> String {
    if marking() {
        format!(
            "{}{at}{}",
            crate::sourcemap::MARK,
            crate::sourcemap::MARK_END
        )
    } else {
        String::new()
    }
}

pub(crate) fn mark(out: &mut String, at: usize) {
    if marking() {
        out.push_str(&mark_str(at));
    }
}

pub(crate) fn locate(span: crate::token::Span, needle: &str) -> Option<usize> {
    if !marking() {
        return None;
    }
    SOURCE.with(|s| {
        let s = s.borrow();
        let text = s.get(span.start..span.end.min(s.len()))?;
        text.find(needle).map(|i| span.start + i)
    })
}

pub fn lower(src: &str, file: &SourceFile) -> String {
    lower_marked(src, file)
}

pub fn lower_with_map(src: &str, file: &SourceFile) -> (String, Vec<crate::sourcemap::Mapping>) {
    with_map(src, || lower_marked(src, file))
}

pub(crate) fn with_map(
    src: &str,
    f: impl Fn() -> String,
) -> (String, Vec<crate::sourcemap::Mapping>) {
    use crate::sourcemap::{strip, MARK, MARK_END};
    if src.contains(MARK) || src.contains(MARK_END) {
        return (f(), Vec::new());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            MAPPING.with(|m| m.set(false));
            SOURCE.with(|s| s.borrow_mut().clear());
        }
    }
    let _reset = Reset;
    SOURCE.with(|s| *s.borrow_mut() = src.to_string());
    MAPPING.with(|m| m.set(true));
    let marked = f();
    strip(&marked, src)
}

fn local_name(spec: &str) -> &str {
    let spec = spec.trim();
    let spec = spec.strip_prefix("type ").unwrap_or(spec).trim();
    match spec.rsplit_once(" as ") {
        Some((_, local)) => local.trim(),
        None => spec,
    }
}

pub(crate) fn reactive_decl(r: &crate::ast::Reactive, init: &str) -> String {
    let at = mark_str(r.span.start);
    let ty = r.ty.as_deref().map_or(String::new(), |t| format!("<{t}>"));
    match r.kind {
        ReactiveKind::Signal => format!("{at}const {} = signal{ty}({init});", r.name),
        ReactiveKind::Derived if is_async_derived(r) => {
            format!("{at}const {} = asyncDerived{ty}(async () => {init});", r.name)
        }
        ReactiveKind::Derived => format!("{at}const {} = derived{ty}(() => {init});", r.name),
    }
}

pub(crate) fn is_async_derived(r: &crate::ast::Reactive) -> bool {
    if r.kind != ReactiveKind::Derived {
        return false;
    }
    let e = r.expr.trim_start();
    e.strip_prefix("await")
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_whitespace() || c == '('))
}

fn runtime_imports(src: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for quote in ['"', '\''] {
        let needle = format!("from {quote}@weft-framework/runtime{quote}");
        let mut at = 0;
        while let Some(i) = src[at..].find(&needle) {
            let end = at + i;
            at = end + needle.len();
            let head = &src[..end];
            let Some(close) = head.rfind('}') else {
                continue;
            };
            let Some(open) = head[..close].rfind('{') else {
                continue;
            };
            let before = head[..open].trim_end();
            let before = before
                .strip_suffix("type")
                .map(str::trim_end)
                .unwrap_or(before);
            if !before.ends_with("import") || !head[close + 1..].trim().is_empty() {
                continue;
            }
            for spec in head[open + 1..close].split(',') {
                let name = local_name(spec);
                if !name.is_empty() {
                    out.insert(name.to_string());
                }
            }
        }
    }
    out
}

fn lower_marked(src: &str, file: &SourceFile) -> String {
    let mut out = String::new();

    let comps = || {
        file.items.iter().filter_map(|it| match it {
            Item::Component(c) => Some(c),
            _ => None,
        })
    };
    let has_model = file.items.iter().any(|it| matches!(it, Item::Model(_)));
    let has_file_field = file.items.iter().any(|it| {
        matches!(it, Item::Model(m) if m.fields.iter().any(|f| file_field_type(&f.ty).is_some()))
    });
    let has_action = file.items.iter().any(|it| matches!(it, Item::Action(a) if !a.job));
    let has_job = file.items.iter().any(|it| matches!(it, Item::Action(a) if a.job));
    let has_store = file.items.iter().any(|it| matches!(it, Item::Store(_)));

    if comps().next().is_some() {
        let mut names = vec!["defineComponent", "escapeHtml", "escapeAttr"];
        if comps().any(|c| has_handler_args(&c.view.nodes)) {
            names.push("bindArgs");
        }
        if comps().any(|c| has_slot_children(&c.view.nodes)) {
            names.push("trustHtml");
        }
        if comps().any(|c| has_keyed_each(&c.view.nodes)) {
            names.push("keyed");
        }
        if comps().any(|c| has_await(&c.view.nodes)) {
            names.push("awaitBlock");
        }
        if comps().any(|c| has_can(&c.view.nodes)) {
            names.push("can as __weftCan");
        }
        if comps().any(|c| has_shared(&c.view.nodes)) {
            names.extend(["sharedAttrs", "sharedValue"]);
        }
        if comps().any(|c| has_action_attr(&c.view.nodes)) {
            names.push("actionAttr");
        }
        if comps().any(|c| has_url_attr(&c.view.nodes)) {
            names.push("escapeUrl");
        }
        if comps().any(|c| has_element_spread(&c.view.nodes)) {
            names.push("spreadAttrs");
        }
        if comps().any(|c| has_component_event(&c.view.nodes)) {
            names.push("forwardEvents");
        }
        if comps().any(|c| has_owned_event(&c.view.nodes, false)) {
            names.push("ownerAttr");
        }
        if comps().any(|c| c.params.iter().any(|p| p.rest)) {
            names.push("restProps");
        }
        if comps().any(|c| c.params.iter().any(|p| p.rest && p.ty.contains("Attrs"))) {
            names.push("type Attrs");
        }
        if comps().any(|c| !c.reactives.is_empty()) {
            names.extend(["signal", "derived"]);
        }
        if comps().any(|c| c.reactives.iter().any(|r| !r.client && is_async_derived(r))) {
            names.push("asyncDerived");
        }
        if comps().any(|c| {
            c.style.as_ref().is_some_and(|st| {
                !crate::css::compile(&c.name, &st.css, st.offset)
                    .0
                    .vars
                    .is_empty()
            })
        }) {
            names.push("cssVars");
        }
        if comps().any(|c| c.type_params.is_some()) {
            names.push("type GenericComponent");
        }
        if comps().any(|c| c.params.iter().any(|p| p.name == "children")) {
            names.push("type Html");
        }
        let mine = runtime_imports(src);
        names.retain(|n| !mine.contains(local_name(n)));
        if !names.is_empty() {
            out.push_str(&format!(
                "import {{ {} }} from \"@weft-framework/runtime\";\n",
                names.join(", ")
            ));
        }
    }
    if has_store && !runtime_imports(src).contains("defineStore") {
        out.push_str("import { defineStore } from \"@weft-framework/runtime\";\n");
    }
    if has_model && has_file_field {
        out.push_str("import { defineModel, type FileRef } from \"@weft-framework/data\";\n");
    } else if has_model {
        out.push_str("import { defineModel } from \"@weft-framework/data\";\n");
    }
    if has_action {
        out.push_str("import { defineAction, type ActionContext } from \"@weft-framework/server/action\";\n");
    }
    if has_job {
        out.push_str("import { defineJob, type JobContext } from \"@weft-framework/server/jobs\";\n");
    }
    let mut chunks: Vec<(String, bool)> = Vec::new();
    let mut cursor = 0;
    for item in &file.items {
        let span = item_span(item);
        push_region(src, cursor, span.start, &mut chunks);
        if let Some(last) = chunks.last_mut() {
            let gap = &src[cursor..span.start];
            let tail = &gap[gap.trim_end().len()..];
            last.1 = !gap.trim().is_empty() && tail.matches('\n').count() <= 1;
        }
        let mut lowered = String::new();
        match item {
            Item::Component(c) => lower_component(c, &mut lowered),
            Item::Model(m) => lower_model(m, &mut lowered),
            Item::Actor(a) => lower_actor(a, &mut lowered),
            Item::Action(a) => lower_action(a, &mut lowered),
            Item::Placed(p) => lowered.push_str(&placed_source(p)),
            Item::Store(st) => lower_store(st, &mut lowered),
        }
        chunks.push((lowered.trim_end().to_string(), false));
        cursor = cursor.max(span.end);
    }
    push_region(src, cursor, src.len(), &mut chunks);
    let effects = lower_effects(src, file);
    if !effects.is_empty() {
        chunks.push((effects, false));
    }

    if !out.is_empty() && !chunks.is_empty() {
        out.push('\n');
    }
    for (i, (chunk, _)) in chunks.iter().enumerate() {
        if i > 0 {
            out.push_str(if chunks[i - 1].1 { "\n" } else { "\n\n" });
        }
        out.push_str(chunk);
    }
    if !chunks.is_empty() {
        out.push('\n');
    }
    out
}

fn lower_effects(src: &str, file: &SourceFile) -> String {
    use crate::effects::{allowed, analyze, is_wx};
    let an = analyze(src, file);
    let mut specs: Vec<String> = Vec::new();
    let mut ns = |spec: &str| -> String {
        let i = specs.iter().position(|s| s == spec).unwrap_or_else(|| {
            specs.push(spec.to_string());
            specs.len() - 1
        });
        format!("__weftM{i}")
    };
    let mut body = String::new();
    let fx_of = |name: &str, ns: &mut dyn FnMut(&str) -> String| -> Option<String> {
        let mut parts: Vec<String> = an
            .effects
            .get(name)
            .into_iter()
            .flat_map(|e| e.keys().map(|c| format!("\"{c}\"")))
            .collect();
        for (spec, n) in an.reached.get(name).into_iter().flatten() {
            parts.push(format!("EffectOf<typeof {}, \"{n}\">", ns(spec)));
        }
        (!parts.is_empty()).then(|| parts.join(" | "))
    };
    let mut exported: Vec<&str> = Vec::new();
    for it in &file.items {
        match it {
            Item::Component(c) => exported.push(&c.name),
            Item::Action(a) => exported.push(&a.name),
            Item::Model(m) => {
                body.push_str(&format!(
                    "export declare const __weftEffects_{}: \"db\";\n",
                    m.name
                ));
            }
            _ => {}
        }
    }
    let mut plain: Vec<&String> = an
        .plain_fns
        .iter()
        .filter(|(_, e)| **e)
        .map(|(n, _)| n)
        .collect();
    plain.sort();
    exported.extend(plain.into_iter().map(String::as_str));
    for name in exported {
        if let Some(ty) = fx_of(name, &mut ns) {
            body.push_str(&format!(
                "export declare const __weftEffects_{name}: {ty};\n"
            ));
        }
    }
    let actions: HashSet<&str> = file
        .items
        .iter()
        .filter_map(|it| match it {
            Item::Action(a) => Some(a.name.as_str()),
            _ => None,
        })
        .collect();
    for it in &file.items {
        let (name, uses) = match it {
            Item::Component(c) => (&c.name, &c.uses),
            Item::Action(a) => (&a.name, &a.uses),
            _ => continue,
        };
        let Some(uses) = uses else { continue };
        let Some(set) = allowed(uses, &mut Vec::new()) else {
            continue;
        };
        let bound = if set.is_empty() {
            "never".to_string()
        } else {
            set.iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(" | ")
        };
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let mut n = 0;
        for (r, at) in an.refs.get(name).into_iter().flatten() {
            let sources: Vec<(String, String)> = match an.imports.get(r) {
                Some(imp) if is_wx(&imp.spec) && imp.name != "*" => {
                    vec![(imp.spec.clone(), imp.name.clone())]
                }
                Some(_) => Vec::new(),
                None if r != name && !actions.contains(r.as_str()) => an
                    .reached
                    .get(r)
                    .map(|s| s.iter().cloned().collect())
                    .unwrap_or_default(),
                None => Vec::new(),
            };
            for (spec, exp) in sources {
                if !seen.insert((spec.clone(), exp.clone())) {
                    continue;
                }
                let m = ns(&spec);
                body.push_str(&format!(
                    "export type __weftUses_{name}_{n} = WeftWithin<{bound}, "
                ));
                mark(&mut body, *at);
                body.push_str(&format!("EffectOf<typeof {m}, \"{exp}\">>;\n"));
                n += 1;
            }
        }
    }
    if body.is_empty() {
        return String::new();
    }
    let mut out = String::from("// Capabilities (erased; checked by TypeScript across files).\n");
    if body.contains("EffectOf<") {
        out.push_str(if body.contains("WeftWithin<") {
            "import type { EffectOf, WeftWithin } from \"@weft-framework/runtime\";\n"
        } else {
            "import type { EffectOf } from \"@weft-framework/runtime\";\n"
        });
    }
    for (i, spec) in specs.iter().enumerate() {
        out.push_str(&format!("import type * as __weftM{i} from \"{spec}\";\n"));
    }
    out.push_str(&body);
    out.trim_end().to_string()
}

fn item_span(item: &Item) -> crate::token::Span {
    item.span()
}

fn lower_actor(a: &crate::ast::ActorDecl, out: &mut String) {
    mark(out, a.span.start);
    out.push_str("declare module \"@weft-framework/data\" {\n  interface Register {\n    actor: ");
    mark(out, a.ty_offset);
    out.push_str(&a.ty);
    out.push_str(";\n  }\n}\nexport {};\n");
}

fn lower_store(st: &crate::ast::StoreDecl, out: &mut String) {
    mark(out, st.span.start);
    out.push_str("export const ");
    if let Some(at) = locate(st.span, &st.name) {
        mark(out, at);
    }
    out.push_str(&st.name);
    out.push_str(" = defineStore");
    if let Some(ty) = &st.ty {
        out.push('<');
        if let Some(at) = locate(st.span, ty) {
            mark(out, at);
        }
        out.push_str(ty);
        out.push('>');
    }
    let scope = if st.session { "session" } else { "app" };
    out.push_str(&format!("(\"{}\", \"{scope}\", () => (", st.name));
    out.push_str(&rewrite_at(
        &st.init,
        &Scope::default(),
        Some(st.init_offset),
    ));
    out.push_str("));\n");
}

pub(crate) fn placed_source(p: &crate::ast::Placed) -> String {
    if p.import.is_some() {
        return format!("{}{}", mark_str(p.offset), p.source);
    }
    rewrite_fn(&p.source, &Scope::default(), Some(p.offset))
}

pub(crate) fn action_param_type(ty: &str) -> Option<(&'static str, bool)> {
    if let Some(inner) = held_param(ty) {
        return if held_param(inner).is_some() { None } else { action_param_type(inner) };
    }
    let t: String = ty.chars().filter(|c| !c.is_whitespace()).collect();
    let (base, list) = if let Some(b) = t.strip_suffix("[]") {
        (b.to_string(), true)
    } else if let Some(b) = t.strip_prefix("Array<").and_then(|b| b.strip_suffix('>')) {
        (b.to_string(), true)
    } else {
        (t, false)
    };
    let base = match base.as_str() {
        "string" => "string",
        "number" => "number",
        "boolean" => "boolean",
        "File" => "file",
        "Record<string,string>" if !list => "record",
        _ => return None,
    };
    Some((base, list))
}

pub(crate) fn held_param(ty: &str) -> Option<&str> {
    ty.trim().strip_prefix("Held<").and_then(|b| b.strip_suffix('>')).map(str::trim)
}

fn lower_action(a: &crate::ast::Action, out: &mut String) {
    mark(out, a.span.start);
    out.push_str("export const ");
    out.push_str(&a.name);
    let (define, context) = if a.job {
        ("defineJob", "JobContext")
    } else {
        ("defineAction", "ActionContext")
    };
    out.push_str(&format!(" = {define}(\"{}\", [", a.name));
    for (i, p) in a.params.iter().enumerate() {
        let (ty, list) = action_param_type(&p.ty).unwrap_or(("string", false));
        out.push_str(if i == 0 { "\n  " } else { ",\n  " });
        out.push_str(&format!("{{ name: \"{}\", type: \"{ty}\"", p.name));
        if held_param(&p.ty).is_some() {
            out.push_str(", held: true");
        }
        if list {
            out.push_str(", list: true");
        }
        if p.optional {
            out.push_str(", optional: true");
        }
        out.push_str(" }");
    }
    if !a.params.is_empty() {
        out.push('\n');
    }
    out.push_str(&format!("], async (ctx: {context}"));
    for p in &a.params {
        out.push_str(", ");
        if let Some(at) = locate(p.span, &p.name) {
            mark(out, at);
        }
        out.push_str(&p.name);
        out.push_str(": ");
        if let Some(at) = locate(p.span, &p.ty) {
            mark(out, at);
        }
        out.push_str(held_param(&p.ty).unwrap_or(&p.ty));
        if p.optional {
            out.push_str(" | undefined");
        }
    }
    out.push(')');
    if let Some(ret) = &a.ret {
        out.push_str(": ");
        out.push_str(ret);
    }
    out.push_str(" => {");
    out.push_str(&rewrite_fn(&a.body, &Scope::default(), Some(a.body_offset)));
    out.push_str("});\n");
}

fn push_region(src: &str, start: usize, end: usize, chunks: &mut Vec<(String, bool)>) {
    if let Some(raw) = src.get(start..end) {
        let lead = raw.len() - raw.trim_start_matches(['\n', '\r']).len();
        let region = raw.trim_matches(|c| c == '\n' || c == '\r').trim_end();
        if !region.trim().is_empty() {
            let mut text = String::with_capacity(region.len());
            let mut at = start + lead;
            for line in region.split_inclusive('\n') {
                mark(&mut text, at);
                text.push_str(line);
                at += line.len();
            }
            chunks.push((text, false));
        }
    }
}

fn file_field_type(ty: &str) -> Option<String> {
    let bytes = ty.as_bytes();
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
    let mut out = String::new();
    let mut found = false;
    let mut i = 0;
    while i < ty.len() {
        let word = |w: &str| {
            ty[i..].starts_with(w)
                && (i == 0 || (!ident(bytes[i - 1]) && bytes[i - 1] != b'.'))
                && (i + w.len() == ty.len() || !ident(bytes[i + w.len()]))
        };
        let len = if word("FileRef") {
            7
        } else if word("File") {
            4
        } else {
            0
        };
        if len > 0 {
            out.push_str("FileRef");
            found = true;
            i += len;
        } else {
            let c = ty[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    found.then_some(out)
}

fn lower_model(m: &Model, out: &mut String) {
    let field_names: HashSet<String> = m.fields.iter().map(|f| f.name.clone()).collect();
    mark(out, m.span.start);
    out.push_str("export interface ");
    if let Some(at) = locate(m.span, &m.name) {
        mark(out, at);
    }
    out.push_str(&format!("{} {{\n", m.name));
    for f in &m.fields {
        out.push_str("  ");
        if let Some(at) = locate(f.span, &f.name) {
            mark(out, at);
        }
        out.push_str(&f.name);
        out.push_str(": ");
        if let Some(at) = locate(f.span, &f.ty) {
            mark(out, at);
        }
        match file_field_type(&f.ty) {
            Some(ty) => out.push_str(&ty),
            None => out.push_str(&f.ty),
        }
        if f.attrs.iter().any(|a| a.name == "read" || a.name == "consent") && !crate::check::is_nullable(&f.ty) {
            out.push_str(" | null");
        }
        out.push_str(";\n");
    }
    out.push_str("}\n\n");

    let defaulted: Vec<String> = m
        .fields
        .iter()
        .filter(|f| f.attrs.iter().any(|a| a.name == "default"))
        .map(|f| format!("\"{}\"", f.name))
        .collect();
    let targs = if defaulted.is_empty() {
        m.name.clone()
    } else {
        format!("{}, {}", m.name, defaulted.join(" | "))
    };
    out.push_str(&format!(
        "export const {name} = defineModel<{targs}>(\"{name}\", {{\n",
        name = m.name
    ));
    out.push_str("  fields: {");
    for (i, f) in m.fields.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(" {}: \"{}\"", f.name, escape_dq(&f.ty)));
    }
    out.push_str(if m.fields.is_empty() { "}," } else { " }," });
    out.push('\n');
    lower_field_attrs(m, &field_names, out);

    for policy in &m.policies {
        let name = match policy.kind {
            PolicyKind::Read => "read",
            PolicyKind::Write => "write",
            PolicyKind::Residency => {
                let at = locate(policy.span, &policy.predicate);
                match crate::events::string_literal(&policy.predicate) {
                    Some(region) => out.push_str(&format!("  residency: \"{}\",\n", escape_dq(&region))),
                    None => {
                        let expr = qualify_fields(&policy.predicate, &field_names, at);
                        out.push_str(&format!("  residency: (row) => ({expr}),\n"));
                    }
                }
                continue;
            }
        };
        let at = locate(policy.span, &policy.predicate);
        let pred = qualify_fields(&policy.predicate, &field_names, at);
        out.push_str(&format!("  {name}: (actor, row) => ({pred}),\n"));
        if let Some(expr) = crate::policy::compile_policy(&policy.predicate, &field_names) {
            out.push_str(&format!("  {name}Where: {expr},\n"));
        }
    }

    out.push_str("});\n");
}

fn lower_field_attrs(m: &Model, field_names: &HashSet<String>, out: &mut String) {
    let with: Vec<&crate::ast::Field> = m.fields.iter().filter(|f| !f.attrs.is_empty()).collect();
    if with.is_empty() {
        return;
    }
    out.push_str("  attrs: {");
    for (i, f) in with.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(" {}: {{", f.name));
        for (j, a) in f.attrs.iter().enumerate() {
            out.push_str(if j > 0 { ", " } else { " " });
            match (a.name.as_str(), &a.arg) {
                ("default", Some((expr, at))) => {
                    out.push_str("default: () => (");
                    mark(out, *at);
                    out.push_str(expr);
                    out.push(')');
                }
                ("read", Some((pred, at))) => {
                    let pred = qualify_fields(pred, field_names, Some(*at));
                    out.push_str(&format!("read: (actor, row) => ({pred})"));
                }
                ("consent", Some((arg, _))) => match crate::check::consent_arg(arg) {
                    Some((purpose, None)) => out.push_str(&format!("consent: \"{purpose}\"")),
                    Some((purpose, Some(subject))) => {
                        out.push_str(&format!("consent: {{ purpose: \"{purpose}\", subject: \"{subject}\" }}"))
                    }
                    None => out.push_str("consent: \"\""),
                },
                ("ref", Some((target, _))) => {
                    out.push_str(&format!("ref: \"{}\"", escape_dq(target)));
                }
                ("renamed", Some((old, _))) => {
                    out.push_str(&format!("renamed: \"{}\"", escape_dq(old)));
                }
                ("retain", Some((arg, _))) => match crate::check::retain_ms(arg) {
                    Some(ms) => out.push_str(&format!("retain: {ms}")),
                    None => out.push_str("retain: NaN"),
                },
                (flag, _) => out.push_str(&format!("{flag}: true")),
            }
        }
        out.push_str(" }");
    }
    out.push_str(" },\n");
}

fn qualify_fields(expr: &str, fields: &HashSet<String>, at: Option<usize>) -> String {
    let lead = at.map_or(String::new(), mark_str);
    if fields.is_empty() {
        return lead + expr;
    }
    let (tokens, _diags) = tokenize(expr);
    let mut inserts: Vec<usize> = Vec::new();
    for (k, tok) in tokens.iter().enumerate() {
        if let TokenKind::Ident(name) = &tok.kind {
            let after_dot = k > 0 && tokens[k - 1].kind == TokenKind::Dot;
            if !after_dot && fields.contains(name) {
                inserts.push(tok.span.start);
            }
        }
    }
    if inserts.is_empty() {
        return lead + expr;
    }
    let mut out = lead;
    let mut last = 0;
    for pos in inserts {
        out.push_str(&expr[last..pos]);
        out.push_str("row.");
        if let Some(base) = at {
            mark(&mut out, base + pos);
        }
        last = pos;
    }
    out.push_str(&expr[last..]);
    out
}

fn escape_dq(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Scope {
    pub(crate) sigs: HashSet<String>,
    pub(crate) props: HashSet<String>,
    pub(crate) defaults: HashMap<String, String>,
    pub(crate) client: Rc<HashSet<String>>,
    pub(crate) binds: Rc<Vec<(String, crate::token::Span)>>,
    pub(crate) uses: Rc<Vec<usize>>,
    pub(crate) use_key: Rc<str>,
    pub(crate) css: Option<Rc<CssScope>>,
}

#[derive(Debug)]
pub(crate) struct CssScope {
    pub(crate) class: String,
    pub(crate) vars: Vec<(String, usize)>,
    pub(crate) depth: Cell<u32>,
}

impl Scope {
    pub(crate) fn without<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Scope {
        let mut s = self.clone();
        for n in names {
            s.sigs.remove(n);
            s.props.remove(n);
            s.defaults.remove(n);
        }
        s
    }
}

pub(crate) fn refs_client(expr: &str, client: &HashSet<String>) -> bool {
    !client.is_empty()
        && crate::check::free_idents(expr)
            .iter()
            .any(|(n, _)| client.contains(n))
}

pub(crate) fn client_names(c: &Component) -> HashSet<String> {
    c.reactives
        .iter()
        .filter(|r| r.client)
        .map(|r| r.name.clone())
        .chain(
            c.functions
                .iter()
                .filter(|f| f.client)
                .map(|f| f.name.clone()),
        )
        .collect()
}

pub(crate) fn collect_binds(
    nodes: &[Node],
    client: &HashSet<String>,
    out: &mut Vec<(String, crate::token::Span)>,
) {
    fn push(
        out: &mut Vec<(String, crate::token::Span)>,
        client: &HashSet<String>,
        expr: &str,
        span: crate::token::Span,
    ) {
        if refs_client(expr, client) && !out.iter().any(|(e, _)| e == expr) {
            out.push((expr.to_string(), span));
        }
    }
    for n in nodes {
        match n {
            Node::Interp(i) => push(out, client, &i.expr, i.span),
            Node::Element(e) => {
                if !is_component_name(&e.name) {
                    for a in &e.attrs {
                        if let (AttrKind::Plain | AttrKind::Bind, Some(AttrValue::Expr(x))) =
                            (&a.kind, &a.value)
                        {
                            push(out, client, x, a.span);
                        }
                    }
                }
                collect_binds(&e.children, client, out);
            }
            Node::If(_) | Node::Each(_) | Node::Await(_) => {
                for body in n.blocks() {
                    collect_binds(body, client, out);
                }
            }
            Node::Text(_) => {}
        }
    }
}

pub(crate) fn collect_uses(nodes: &[Node]) -> Vec<&Attr> {
    fn walk<'a>(nodes: &'a [Node], out: &mut Vec<&'a Attr>) {
        for n in nodes {
            match n {
                Node::Element(e) => {
                    if !is_component_name(&e.name) {
                        out.extend(e.attrs.iter().filter(|a| a.kind == AttrKind::Use));
                    }
                    walk(&e.children, out);
                }
                Node::If(_) | Node::Each(_) | Node::Await(_) => {
                    for body in n.blocks() {
                        walk(body, out);
                    }
                }
                Node::Text(_) | Node::Interp(_) => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, &mut out);
    out
}

fn bind_index(scope: &Scope, expr: &str) -> Option<usize> {
    if !refs_client(expr, &scope.client) {
        return None;
    }
    scope.binds.iter().position(|(e, _)| e == expr)
}

fn lower_component(c: &Component, out: &mut String) {
    let props_ty = if c.params.is_empty() {
        "Record<string, never>".to_string()
    } else {
        let fields = c
            .params
            .iter()
            .filter(|p| !p.rest)
            .map(|p| {
                format!(
                    "{}{}: {}",
                    p.name,
                    if p.optional || p.default.is_some() {
                        "?"
                    } else {
                        ""
                    },
                    p.ty
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        match c.params.iter().find(|p| p.rest) {
            Some(r) => format!("{{ {fields} }} & ({})", r.ty),
            None => format!("{{ {fields} }}"),
        }
    };
    let tp = c
        .type_params
        .as_deref()
        .map_or(String::new(), |t| format!("<{t}>"));
    mark(out, c.span.start);
    out.push_str("export const ");
    if let Some(at) = locate(c.span, &c.name) {
        mark(out, at);
    }
    out.push_str(&format!(
        "{name} = defineComponent{erase}(\"{name}\", {tp}(props: {props_ty}) => {{\n",
        name = c.name,
        erase = if c.type_params.is_some() {
            "<never>"
        } else {
            ""
        }
    ));
    if let Some(r) = c.params.iter().find(|p| p.rest) {
        let named: Vec<String> = c
            .params
            .iter()
            .filter(|p| !p.rest)
            .map(|p| js_string(&p.name))
            .collect();
        out.push_str(&format!(
            "  {}const {}: {} = restProps(props, [{}]);\n",
            mark_str(r.span.start),
            r.name,
            r.ty,
            named.join(", ")
        ));
    }

    let client = client_names(c);
    let mut binds = Vec::new();
    collect_binds(&c.view.nodes, &client, &mut binds);
    let island = crate::island::is_island(c);
    let compiled = c
        .style
        .as_ref()
        .map(|st| crate::css::compile(&c.name, &st.css, st.offset).0);
    let scope = Scope {
        sigs: c.reactives.iter().map(|r| r.name.clone()).collect(),
        props: c
            .params
            .iter()
            .filter(|p| !p.rest)
            .map(|p| p.name.clone())
            .collect(),
        defaults: c
            .params
            .iter()
            .filter_map(|p| p.default.clone().map(|d| (p.name.clone(), d)))
            .collect(),
        client: Rc::new(client),
        binds: Rc::new(binds),
        uses: Rc::new(
            collect_uses(&c.view.nodes)
                .iter()
                .map(|a| a.span.start)
                .collect(),
        ),
        use_key: crate::island::island_key(c).into(),
        css: compiled.as_ref().map(|k| {
            Rc::new(CssScope {
                class: k.class.clone(),
                vars: k.vars.clone(),
                depth: Cell::new(0),
            })
        }),
    };
    let mut members: Vec<(usize, &Comments, String)> = Vec::new();
    for r in &c.reactives {
        let init = rewrite_at(&r.expr, &scope, locate(r.span, &r.expr));
        let decl = reactive_decl(r, &init);
        members.push((r.span.start, &r.comments, decl));
    }
    for f in c.functions.iter().filter(|f| !f.client) {
        members.push((
            f.span.start,
            &f.comments,
            rewrite_fn(&f.source, &scope, locate(f.span, &f.source)),
        ));
    }
    let (mounts, destroys) = lifecycle_members(c, false, &scope, &mut members);
    members.sort_by_key(|m| m.0);
    for (_, comments, decl) in members {
        push_comments(&comments.leading, out);
        out.push_str("  ");
        out.push_str(&decl);
        if let Some(t) = &comments.trailing {
            out.push(' ');
            out.push_str(t);
        }
        out.push('\n');
    }
    push_comments(&c.view.comments.leading, out);

    let mut handlers: Vec<String> = Vec::new();
    collect_handlers(&c.view.nodes, &mut handlers);
    handlers.retain(|h| c.functions.iter().any(|f| &f.name == h && !f.client));
    out.push_str("  return {\n    handlers: {");
    if !handlers.is_empty() {
        out.push(' ');
        out.push_str(&handlers.join(", "));
        out.push(' ');
    }
    out.push_str("},\n");
    push_lifecycle(&mounts, &destroys, out);
    out.push_str("    render: () => `");
    lower_view(&c.view, &scope, out);
    out.push_str("`,\n  };\n}");
    let mut opts: Vec<String> = Vec::new();
    if island {
        opts.push(format!("island: \"{}\"", crate::island::island_key(c)));
    }
    if let Some(k) = &compiled {
        opts.push(format!("css: {}", js_string(&k.css)));
    }
    let css_vars = compiled.as_ref().is_some_and(|k| !k.vars.is_empty());
    if is_static_component(c, css_vars) {
        opts.push("static: true".to_string());
    }
    if !island && is_inert_component(c, css_vars) {
        opts.push("inert: true".to_string());
    }
    if !opts.is_empty() {
        out.push_str(&format!(", {{ {} }}", opts.join(", ")));
    }
    out.push(')');
    if c.type_params.is_some() {
        out.push_str(&format!(
            " as unknown as GenericComponent<{tp}(props: {props_ty}) => string>"
        ));
    }
    out.push_str(";\n");
}

pub(crate) fn lifecycle_members<'c>(
    c: &'c Component,
    client: bool,
    scope: &Scope,
    members: &mut Vec<(usize, &'c Comments, String)>,
) -> (Vec<String>, Vec<String>) {
    let (mut mounts, mut destroys) = (Vec::new(), Vec::new());
    for h in c.lifecycle.iter().filter(|h| h.client == client) {
        let list = match h.kind {
            LifecycleKind::Mount => &mut mounts,
            LifecycleKind::Destroy => &mut destroys,
        };
        let name = format!(
            "__{}{}",
            if h.kind == LifecycleKind::Mount {
                "mount"
            } else {
                "destroy"
            },
            list.len()
        );
        let body = rewrite_fn(&h.expr, scope, Some(h.span.start));
        members.push((
            h.span.start,
            &h.comments,
            format!("{}const {name} = {body};", mark_str(h.span.start)),
        ));
        list.push(name);
    }
    (mounts, destroys)
}

pub(crate) fn push_lifecycle(mounts: &[String], destroys: &[String], out: &mut String) {
    if !mounts.is_empty() {
        out.push_str(&format!("    mount: [{}],\n", mounts.join(", ")));
    }
    if !destroys.is_empty() {
        out.push_str(&format!("    destroy: [{}],\n", destroys.join(", ")));
    }
}

fn push_comments(comments: &[String], out: &mut String) {
    for c in comments {
        out.push_str("  ");
        out.push_str(c);
        out.push('\n');
    }
}

fn has_slot_children(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            (is_component_name(&e.name) && !trim_ws_edges(&e.children).is_empty())
                || has_slot_children(&e.children)
        }
        Node::If(b) => {
            b.arms.iter().any(|a| has_slot_children(&a.body))
                || b.else_body.as_deref().is_some_and(has_slot_children)
        }
        Node::Each(b) => has_slot_children(&b.body),
        Node::Await(_) => n.blocks().into_iter().any(has_slot_children),
        Node::Text(_) | Node::Interp(_) => false,
    })
}

fn has_handler_args(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            e.attrs.iter().any(|a| {
                a.kind == AttrKind::Event
                    && matches!(split_handler(&directive_ref(&a.value)), Some((_, Some(_))))
            }) || has_handler_args(&e.children)
        }
        Node::If(b) => {
            b.arms.iter().any(|a| has_handler_args(&a.body))
                || b.else_body.as_deref().is_some_and(has_handler_args)
        }
        Node::Each(b) => has_handler_args(&b.body),
        Node::Await(_) => n.blocks().into_iter().any(has_handler_args),
        Node::Text(_) | Node::Interp(_) => false,
    })
}

fn collect_handlers(nodes: &[Node], out: &mut Vec<String>) {
    for node in nodes {
        match node {
            Node::Element(e) => {
                for a in &e.attrs {
                    if a.kind != AttrKind::Event {
                        continue;
                    }
                    if let Some((name, _)) = split_handler(&directive_ref(&a.value)) {
                        if !out.iter().any(|h| h == name) {
                            out.push(name.to_string());
                        }
                    }
                }
                collect_handlers(&e.children, out);
            }
            Node::If(b) => {
                for arm in &b.arms {
                    collect_handlers(&arm.body, out);
                }
                if let Some(body) = &b.else_body {
                    collect_handlers(body, out);
                }
            }
            Node::Each(b) => collect_handlers(&b.body, out),
            Node::Await(_) => {
                for body in node.blocks() {
                    collect_handlers(body, out);
                }
            }
            Node::Text(_) | Node::Interp(_) => {}
        }
    }
}

pub(crate) fn split_handler(expr: &str) -> Option<(&str, Option<&str>)> {
    let e = expr.trim();
    let name_end = e
        .char_indices()
        .find(|&(i, c)| {
            !(if i == 0 {
                is_ident_start(c)
            } else {
                is_ident_continue(c)
            })
        })
        .map_or(e.len(), |(i, _)| i);
    if name_end == 0 {
        return None;
    }
    let (name, rest) = e.split_at(name_end);
    let rest = rest.trim_start();
    if rest.is_empty() {
        return Some((name, None));
    }
    let inner = rest.strip_prefix('(')?.strip_suffix(')')?;
    let mut depth = 0i32;
    for c in inner.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    let inner = inner.trim();
    Some((name, if inner.is_empty() { None } else { Some(inner) }))
}

fn lower_view(view: &View, scope: &Scope, out: &mut String) {
    lower_nodes(&view.nodes, scope, out);
}

fn lower_nodes(nodes: &[Node], scope: &Scope, out: &mut String) {
    for node in trim_ws_edges(nodes) {
        lower_node(node, scope, out);
    }
}

fn lower_node(node: &Node, scope: &Scope, out: &mut String) {
    match node {
        Node::Text(t) => {
            let mut at = t.span.start;
            for line in t.value.split_inclusive('\n') {
                mark(out, at);
                out.push_str(&escape_template(line));
                at += line.len();
            }
        }
        Node::Interp(i) => {
            let bind = bind_index(scope, &i.expr);
            if let Some(n) = bind {
                out.push_str(&format!("<weft-t data-weft-t=\"{n}\">"));
            }
            out.push_str("${escapeHtml(");
            out.push_str(&rewrite_at(&i.expr, scope, locate(i.span, &i.expr)));
            out.push_str(")}");
            if bind.is_some() {
                out.push_str("</weft-t>");
            }
        }
        Node::Element(e) if is_component_name(&e.name) => lower_component_call(e, scope, out),
        Node::Element(e) => {
            mark(out, e.span.start);
            out.push('<');
            out.push_str(&e.name);
            let css = scope.css.as_deref();
            let is_class = |a: &Attr| a.kind == AttrKind::Plain && a.name == "class";
            let written: Vec<String> = e
                .attrs
                .iter()
                .filter(|a| matches!(a.kind, AttrKind::Plain | AttrKind::Bind))
                .map(|a| a.name.to_ascii_lowercase())
                .chain(css.map(|_| "class".to_string()))
                .collect();
            for attr in &e.attrs {
                match css {
                    _ if attr.kind == AttrKind::Spread => {
                        if let Some(AttrValue::Expr(expr)) = &attr.value {
                            out.push_str("${spreadAttrs(");
                            out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
                            let names: Vec<String> = written.iter().map(|n| js_string(n)).collect();
                            out.push_str(&format!(", [{}])}}", names.join(", ")));
                        }
                    }
                    Some(cs) if is_class(attr) => lower_scoped_class(attr, cs, scope, out),
                    _ if attr.kind == AttrKind::Bind && attr.name == "bind.shared" => {
                        SHARED_INPUT.with(|f| f.set(e.name == "input"));
                        lower_attr(attr, scope, out);
                        SHARED_INPUT.with(|f| f.set(false));
                    }
                    _ => lower_attr(attr, scope, out),
                }
            }
            if let Some(cs) = css {
                if !e.attrs.iter().any(is_class) {
                    out.push_str(&format!(" class=\"{}\"", cs.class));
                }
                if cs.depth.get() == 0 && !cs.vars.is_empty() {
                    out.push_str(&format!("${{cssVars(\"{}\", [", cs.class));
                    for (i, (expr, at)) in cs.vars.iter().enumerate() {
                        if i > 0 {
                            out.push_str(", ");
                        }
                        out.push_str(&rewrite_at(expr, scope, Some(*at)));
                    }
                    out.push_str("])}");
                }
                cs.depth.set(cs.depth.get() + 1);
            }
            let ca: Vec<String> = e
                .attrs
                .iter()
                .filter_map(|a| match (&a.kind, &a.value) {
                    (AttrKind::Bind, _) if a.name == "bind.shared" => None,
                    (AttrKind::Plain | AttrKind::Bind, Some(AttrValue::Expr(x))) => {
                        let q = if is_boolean_attr(&a.name) { "?" } else { "" };
                        bind_index(scope, x).map(|n| format!("{}{q}={n}", a.name))
                    }
                    _ => None,
                })
                .collect();
            if !ca.is_empty() {
                out.push_str(" data-weft-ca=\"");
                out.push_str(&static_attr_value(&ca.join(" ")));
                out.push('"');
            }
            lower_uses(e, scope, out);
            let shared_text = if e.name == "textarea" { shared_of(e) } else { None };
            if let Some((row, field)) = shared_text {
                let row = rewrite_at(&row, scope, locate(e.span, &row));
                out.push_str(&format!(">${{escapeHtml(sharedValue({row}, \"{field}\"))}}</textarea>"));
            } else if crate::markup::VOID_ELEMENTS.contains(&e.name.to_ascii_lowercase().as_str()) {
                out.push_str(" />");
            } else if e.self_closing {
                out.push_str("></");
                out.push_str(&e.name);
                out.push('>');
            } else {
                out.push('>');
                for child in &e.children {
                    lower_node(child, scope, out);
                }
                out.push_str("</");
                out.push_str(&e.name);
                out.push('>');
            }
            if let Some(cs) = css {
                cs.depth.set(cs.depth.get() - 1);
            }
        }
        Node::If(b) => {
            out.push_str("${");
            for arm in &b.arms {
                out.push('(');
                if let Some(verb) = &b.can {
                    out.push_str(&format!("__weftCan(\"{verb}\", "));
                }
                out.push_str(&rewrite_at(&arm.cond, scope, locate(b.span, &arm.cond)));
                if b.can.is_some() {
                    out.push(')');
                }
                out.push_str(") ? `");
                lower_nodes(&arm.body, scope, out);
                out.push_str("` : ");
            }
            match &b.else_body {
                Some(body) => {
                    out.push('`');
                    lower_nodes(body, scope, out);
                    out.push('`');
                }
                None => out.push_str("``"),
            }
            out.push('}');
        }
        Node::Await(b) => lower_await(b, scope, out),
        Node::Each(b) => {
            out.push_str("${(");
            out.push_str(&rewrite_at(&b.expr, scope, locate(b.span, &b.expr)));
            out.push_str(").map((");
            out.push_str(&b.item);
            if let Some(index) = &b.index {
                out.push_str(", ");
                out.push_str(index);
            }
            let inner = scope.without(std::iter::once(b.item.as_str()).chain(b.index.as_deref()));
            match &b.key {
                None => {
                    out.push_str(") => `");
                    lower_nodes(&b.body, &inner, out);
                    out.push_str("`).join(\"\")}");
                }
                Some(key) => {
                    out.push_str(") => { const ");
                    out.push_str(KEY_VAR);
                    out.push_str(" = String(");
                    out.push_str(&rewrite_at(key, &inner, locate(b.span, key)));
                    out.push_str("); return `");
                    lower_keyed_roots(&b.body, &inner, out);
                    out.push_str("`; }).join(\"\")}");
                }
            }
        }
    }
}

fn lower_await(b: &crate::ast::AwaitBlock, scope: &Scope, out: &mut String) {
    out.push_str("${awaitBlock(");
    out.push_str(&rewrite_at(&b.expr, scope, locate(b.span, &b.expr)));
    out.push_str(", () => `");
    lower_nodes(&b.pending, scope, out);
    out.push('`');
    for branch in [&b.then, &b.catch] {
        match branch {
            Some(br) => {
                let name = br.binding.as_deref().unwrap_or("_");
                out.push_str(&format!(", ({name}) => `"));
                let inner = scope.without(br.binding.as_deref());
                lower_nodes(&br.body, &inner, out);
                out.push('`');
            }
            None => out.push_str(", undefined"),
        }
    }
    out.push_str(")}");
}

const KEY_VAR: &str = "__weftKey";

fn lower_keyed_roots(nodes: &[Node], scope: &Scope, out: &mut String) {
    let mut n = 0;
    for node in trim_ws_edges(nodes) {
        let key = if n == 0 {
            format!("${{escapeAttr({KEY_VAR})}}")
        } else {
            format!("${{escapeAttr({KEY_VAR})}}:{n}")
        };
        match node {
            Node::Element(e) if is_component_name(&e.name) => {
                let mut call = String::new();
                lower_component_call(e, scope, &mut call);
                let call = &call[2..call.len() - 1];
                let raw = if n == 0 {
                    KEY_VAR.to_string()
                } else {
                    format!("`${{{KEY_VAR}}}:{n}`")
                };
                out.push_str(&format!("${{keyed({raw}, () => {call})}}"));
                n += 1;
            }
            Node::Element(e) => {
                let mut el = String::new();
                lower_node(node, scope, &mut el);
                let at = el.find('<').map_or(0, |i| i + 1) + e.name.len();
                el.insert_str(at, &format!(" data-weft-key=\"{key}\""));
                out.push_str(&el);
                n += 1;
            }
            _ => lower_node(node, scope, out),
        }
    }
}

fn has_keyed_each(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => has_keyed_each(&e.children),
        Node::If(b) => {
            b.arms.iter().any(|a| has_keyed_each(&a.body))
                || b.else_body.as_deref().is_some_and(has_keyed_each)
        }
        Node::Each(b) => b.key.is_some() || has_keyed_each(&b.body),
        Node::Await(_) => n.blocks().into_iter().any(has_keyed_each),
        Node::Text(_) | Node::Interp(_) => false,
    })
}

thread_local! {
    static SHARED_INPUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn shared_of(e: &Element) -> Option<(String, String)> {
    e.attrs.iter().find_map(|a| match (&a.kind, &a.value) {
        (AttrKind::Bind, Some(AttrValue::Expr(x))) if a.name == "bind.shared" => crate::check::shared_target(x),
        _ => None,
    })
}

fn has_shared(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => shared_of(e).is_some() || has_shared(&e.children),
        _ => n.blocks().into_iter().any(has_shared),
    })
}

fn has_can(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::If(b) => b.can.is_some() || n.blocks().into_iter().any(has_can),
        Node::Element(e) => has_can(&e.children),
        _ => n.blocks().into_iter().any(has_can),
    })
}

fn has_await(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Await(_) => true,
        Node::Element(e) => has_await(&e.children),
        _ => n.blocks().into_iter().any(has_await),
    })
}

fn is_static_component(c: &Component, css_vars: bool) -> bool {
    fn plain(nodes: &[Node]) -> bool {
        nodes.iter().all(|n| match n {
            Node::Text(_) => true,
            Node::Element(e) => {
                !is_component_name(&e.name)
                    && e.name != "slot"
                    && e.attrs.iter().all(|a| {
                        a.kind == AttrKind::Plain && !matches!(a.value, Some(AttrValue::Expr(_)))
                    })
                    && plain(&e.children)
            }
            _ => false,
        })
    }
    c.params.is_empty()
        && c.reactives.is_empty()
        && c.functions.is_empty()
        && c.lifecycle.is_empty()
        && c.type_params.is_none()
        && !css_vars
        && plain(&c.view.nodes)
}

fn is_inert_component(c: &Component, css_vars: bool) -> bool {
    fn quiet(nodes: &[Node]) -> bool {
        nodes.iter().all(|n| match n {
            Node::Text(_) | Node::Interp(_) => true,
            Node::Element(e) => {
                e.attrs
                    .iter()
                    .all(|a| matches!(a.kind, AttrKind::Plain | AttrKind::Spread))
                    && quiet(&e.children)
            }
            Node::If(b) => {
                b.arms.iter().all(|a| quiet(&a.body)) && b.else_body.as_deref().map_or(true, quiet)
            }
            Node::Each(b) => quiet(&b.body),
            Node::Await(_) => false,
        })
    }
    c.reactives.is_empty()
        && c.functions.iter().all(|f| !f.client)
        && c.lifecycle.is_empty()
        && !css_vars
        && quiet(&c.view.nodes)
}

fn is_action_attr(attr: &Attr) -> bool {
    attr.kind == AttrKind::Plain
        && matches!(attr.name.as_str(), "action" | "formaction")
        && matches!(attr.value, Some(AttrValue::Expr(_)))
}

fn is_url_attr(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "href"
            | "src"
            | "xlink:href"
            | "action"
            | "formaction"
            | "poster"
            | "cite"
            | "background"
            | "ping"
    )
}

fn push_escaped(name: &str, js: &str, out: &mut String) {
    if is_url_attr(name) {
        out.push_str(&format!(
            "${{escapeUrl({js}, \"{}\")}}",
            name.to_ascii_lowercase()
        ));
    } else {
        out.push_str(&format!("${{escapeAttr({js})}}"));
    }
}

fn has_url_attr(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            (!is_component_name(&e.name)
                && e.attrs.iter().any(|a| {
                    matches!(a.value, Some(AttrValue::Expr(_)))
                        && is_url_attr(&a.name)
                        && ((a.kind == AttrKind::Plain
                            && !is_action_attr(a)
                            && !is_boolean_attr(&a.name))
                            || a.kind == AttrKind::Bind)
                }))
                || has_url_attr(&e.children)
        }
        _ => n.blocks().into_iter().any(has_url_attr),
    })
}

fn has_element_spread(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            (!is_component_name(&e.name) && e.attrs.iter().any(|a| a.kind == AttrKind::Spread))
                || has_element_spread(&e.children)
        }
        _ => n.blocks().into_iter().any(has_element_spread),
    })
}

fn has_component_event(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            (is_component_name(&e.name) && e.attrs.iter().any(|a| a.kind == AttrKind::Event))
                || has_component_event(&e.children)
        }
        _ => n.blocks().into_iter().any(has_component_event),
    })
}

fn has_owned_event(nodes: &[Node], inside: bool) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) if is_component_name(&e.name) => {
            e.attrs.iter().any(|a| a.kind == AttrKind::Event) || has_owned_event(&e.children, true)
        }
        Node::Element(e) => {
            (inside && e.attrs.iter().any(|a| a.kind == AttrKind::Event)) || has_owned_event(&e.children, inside)
        }
        _ => n.blocks().into_iter().any(|b| has_owned_event(b, inside)),
    })
}

thread_local! {
    static IN_CALL: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

fn has_action_attr(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            (!is_component_name(&e.name) && e.attrs.iter().any(is_action_attr))
                || has_action_attr(&e.children)
        }
        _ => n.blocks().into_iter().any(has_action_attr),
    })
}

pub(crate) fn is_component_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn lower_component_call(e: &Element, scope: &Scope, out: &mut String) {
    IN_CALL.with(|d| d.set(d.get() + 1));
    lower_component_call_inner(e, scope, out);
    IN_CALL.with(|d| d.set(d.get() - 1));
}

fn lower_component_call_inner(e: &Element, scope: &Scope, out: &mut String) {
    let mut props: Vec<String> = Vec::new();
    let mut events = String::new();
    for attr in e.attrs.iter().filter(|a| a.kind == AttrKind::Event) {
        lower_attr(attr, scope, &mut events);
    }
    if !events.is_empty() {
        props.push(format!("\"data-weft-events\": forwardEvents(`{events}`)"));
    }
    for attr in &e.attrs {
        if attr.kind == AttrKind::Spread {
            if let Some(AttrValue::Expr(expr)) = &attr.value {
                props.push(format!(
                    "{}...({})",
                    mark_str(attr.span.start),
                    rewrite_at(expr, scope, locate(attr.span, expr))
                ));
            }
            continue;
        }
        if attr.kind != AttrKind::Plain {
            continue;
        }
        let value = match &attr.value {
            None => "true".to_string(),
            Some(AttrValue::Str(s)) => js_string(s),
            Some(AttrValue::Expr(expr)) => rewrite_at(expr, scope, locate(attr.span, expr)),
        };
        let key = if crate::lexer::is_ident(&attr.name) {
            attr.name.clone()
        } else {
            js_string(&attr.name)
        };
        props.push(format!("{}{}: {}", mark_str(attr.span.start), key, value));
    }

    let slots = Slots::of(&e.children);
    for name in slots.names() {
        let mut html = String::from("trustHtml(`");
        for (_, filler) in slots.named.iter().filter(|(n, _)| *n == name) {
            lower_slot_filler(filler, scope, &mut html);
        }
        html.push_str("`)");
        props.push(format!("{name}: {html}"));
    }
    if !slots.rest.is_empty() {
        let mut children = String::from("trustHtml(`");
        for k in slots.rest {
            lower_node(k, scope, &mut children);
        }
        children.push_str("`)");
        props.push(format!("children: {children}"));
    }

    out.push_str("${");
    mark(out, e.span.start + 1);
    out.push_str(&e.name);
    if props.is_empty() {
        out.push_str("({})");
    } else {
        out.push_str("({ ");
        out.push_str(&props.join(", "));
        out.push_str(" })");
    }
    out.push('}');
}

fn lower_slot_filler(filler: &Element, scope: &Scope, out: &mut String) {
    if filler.name == "template" {
        for k in trim_ws_edges(&filler.children) {
            lower_node(k, scope, out);
        }
    } else {
        let mut el = filler.clone();
        el.attrs
            .retain(|a| !(a.kind == AttrKind::Plain && a.name == "slot"));
        lower_node(&Node::Element(el), scope, out);
    }
}

fn lower_scoped_class(attr: &Attr, cs: &CssScope, scope: &Scope, out: &mut String) {
    out.push_str(" class=\"");
    match &attr.value {
        None => {}
        Some(AttrValue::Str(s)) => {
            out.push_str(&static_attr_value(s));
            out.push(' ');
        }
        Some(AttrValue::Expr(expr)) => {
            out.push_str("${escapeAttr(");
            out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
            out.push_str(")} ");
        }
    }
    out.push_str(&cs.class);
    out.push('"');
    if matches!(&attr.value, Some(AttrValue::Expr(x)) if bind_index(scope, x).is_some()) {
        out.push_str(&format!(" data-weft-sc=\"{}\"", cs.class));
    }
}

fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn lower_uses(e: &Element, scope: &Scope, out: &mut String) {
    let mut parts: Vec<String> = Vec::new();
    for a in e.attrs.iter().filter(|a| a.kind == AttrKind::Use) {
        let Some(n) = scope.uses.iter().position(|s| *s == a.span.start) else {
            continue;
        };
        parts.push(match &a.value {
            Some(AttrValue::Expr(x)) if !refs_client(x, &scope.client) => {
                format!("[{n}, ({})]", rewrite_at(x, scope, locate(a.span, x)))
            }
            Some(AttrValue::Str(s)) => format!("[{n}, {}]", js_string(s)),
            _ => format!("[{n}]"),
        });
    }
    if parts.is_empty() {
        return;
    }
    out.push_str(&format!(
        " data-weft-use=\"${{escapeAttr(JSON.stringify([{}, {}]))}}\"",
        js_string(&scope.use_key),
        parts.join(", ")
    ));
}

fn lower_attr(attr: &Attr, scope: &Scope, out: &mut String) {
    match attr.kind {
        AttrKind::Spread | AttrKind::Use => {}
        AttrKind::Plain if is_action_attr(attr) => {
            if let Some(AttrValue::Expr(expr)) = &attr.value {
                out.push_str(&format!("${{actionAttr(\"{}\", ", attr.name));
                out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
                out.push_str(")}");
            }
        }
        AttrKind::Plain
            if is_boolean_attr(&attr.name) && matches!(attr.value, Some(AttrValue::Expr(_))) =>
        {
            if let Some(AttrValue::Expr(expr)) = &attr.value {
                out.push_str("${(");
                out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
                out.push_str(") ? \" ");
                out.push_str(&attr.name);
                out.push_str("\" : \"\"}");
            }
        }
        AttrKind::Plain if matches!(attr.value, Some(AttrValue::Expr(_))) => {
            if let Some(AttrValue::Expr(expr)) = &attr.value {
                out.push_str("${((__v) => __v == null ? \"\" : ` ");
                mark(out, attr.span.start);
                out.push_str(&attr.name);
                out.push_str("=\"");
                push_escaped(&attr.name, "__v", out);
                out.push_str("\"`)(");
                out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
                out.push_str(")}");
            }
        }
        AttrKind::Plain => {
            out.push(' ');
            out.push_str(&attr.name);
            if let Some(AttrValue::Str(s)) = &attr.value {
                out.push_str("=\"");
                out.push_str(&static_attr_value(s));
                out.push('"');
            }
        }
        AttrKind::Event => {
            let value = directive_ref(&attr.value);
            let (name, args) = split_handler(&value).unwrap_or((value.as_str(), None));
            let spec = crate::events::parse(&attr.name).ok();
            let event = spec.as_ref().map_or(attr.name.as_str(), |s| s.event);
            let in_browser = scope.client.contains(name);
            out.push_str(if in_browser {
                " data-weft-do-"
            } else {
                " data-weft-on-"
            });
            out.push_str(event);
            out.push_str("=\"");
            out.push_str(&static_attr_value(name));
            out.push('"');
            if let Some(spec) = &spec {
                let mods = spec.encode();
                if !mods.is_empty() {
                    out.push_str(" data-weft-mod-");
                    out.push_str(event);
                    out.push_str("=\"");
                    out.push_str(&static_attr_value(&mods));
                    out.push('"');
                }
                if let Some(opt) = spec.optimistic() {
                    out.push_str(" data-weft-opt-");
                    out.push_str(event);
                    out.push_str("=\"");
                    out.push_str(&static_attr_value(opt));
                    out.push('"');
                }
                if let Some(msg) = spec.confirm() {
                    out.push_str(" data-weft-confirm-");
                    out.push_str(event);
                    out.push_str("=\"");
                    out.push_str(&static_attr_value(&msg));
                    out.push('"');
                } else if let Some(expr) = spec.confirm_expr() {
                    out.push_str(" data-weft-confirm-");
                    out.push_str(event);
                    out.push_str("=\"${escapeAttr(String(");
                    out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
                    out.push_str("))}\"");
                }
            }
            if let (Some(args), true) = (args, in_browser) {
                out.push_str(" data-weft-doargs-");
                out.push_str(event);
                out.push_str("=\"${escapeAttr(JSON.stringify([");
                out.push_str(&rewrite_at(args, scope, locate(attr.span, args)));
                out.push_str("]))}\"");
            } else if let Some(args) = args {
                out.push_str(" data-weft-args-");
                out.push_str(event);
                out.push_str("=\"${escapeAttr(bindArgs([");
                out.push_str(&rewrite_at(args, scope, locate(attr.span, args)));
                out.push_str("]))}\"");
            }
            if IN_CALL.with(|d| d.get()) > 0 {
                out.push_str("${ownerAttr(\"");
                out.push_str(event);
                out.push_str("\")}");
            }
        }
        AttrKind::Bind if attr.name == "bind.shared" => {
            if let Some((row, field)) = attr.value.as_ref().and_then(|v| match v {
                AttrValue::Expr(x) => crate::check::shared_target(x),
                AttrValue::Str(_) => None,
            }) {
                let row = rewrite_at(&row, scope, locate(attr.span, &row));
                out.push_str(&format!("${{sharedAttrs({row}, \"{field}\")}}"));
                if SHARED_INPUT.with(|f| f.get()) {
                    out.push_str(&format!(" value=\"${{escapeHtml(sharedValue({row}, \"{field}\"))}}\""));
                }
            }
        }
        AttrKind::Bind if attr.name == "busy" && attr.value.is_none() => {
            out.push_str(" data-weft-busy");
        }
        AttrKind::Bind => {
            if let Some(AttrValue::Expr(expr)) = &attr.value {
                if is_boolean_attr(&attr.name) {
                    out.push_str("${(");
                    out.push_str(&rewrite_at(expr, scope, locate(attr.span, expr)));
                    out.push_str(") ? \" ");
                    out.push_str(&attr.name);
                    out.push_str("\" : \"\"}");
                } else {
                    out.push(' ');
                    out.push_str(&attr.name);
                    out.push_str("=\"");
                    push_escaped(
                        &attr.name,
                        &rewrite_at(expr, scope, locate(attr.span, expr)),
                        out,
                    );
                    out.push('"');
                }
                out.push_str(" data-weft-bind-");
                out.push_str(&attr.name);
                out.push_str("=\"");
                out.push_str(&static_attr_value(expr));
                out.push('"');
            }
        }
    }
}

pub(crate) fn rewrite_at(expr: &str, scope: &Scope, at: Option<usize>) -> String {
    if at.is_none() && scope.sigs.is_empty() && scope.props.is_empty() {
        return expr.to_string();
    }
    let (tokens, _diags) = tokenize(expr);
    let bound = crate::check::arrow_params(&tokens);
    let scope = scope.without(bound.iter().copied());
    let mut out = at.map_or(String::new(), mark_str);
    out.push_str(&rewrite_tokens(expr, &tokens, &scope, at));
    out
}

pub(crate) fn rewrite_fn(source: &str, scope: &Scope, at: Option<usize>) -> String {
    if at.is_none() && scope.sigs.is_empty() && scope.props.is_empty() {
        return source.to_string();
    }
    let (tokens, _diags) = tokenize(source);
    let mut bound: HashSet<&str> = crate::check::arrow_params(&tokens);
    bound.extend(fn_params(&tokens));
    let scope = scope.without(bound.iter().copied());
    let mut out = at.map_or(String::new(), mark_str);
    out.push_str(&rewrite_tokens(source, &tokens, &scope, at));
    out
}

fn fn_params(tokens: &[Token]) -> Vec<&str> {
    let mut names = Vec::new();
    let Some(open) = tokens.iter().position(|t| t.kind == TokenKind::LParen) else {
        return names;
    };
    let mut depth = 0i32;
    for k in open..tokens.len() {
        match &tokens[k].kind {
            TokenKind::LParen | TokenKind::LBrace | TokenKind::LBracket => depth += 1,
            TokenKind::RParen | TokenKind::RBrace | TokenKind::RBracket => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            TokenKind::Ident(n) => {
                if matches!(
                    tokens[k - 1].kind,
                    TokenKind::LParen
                        | TokenKind::Comma
                        | TokenKind::DotDotDot
                        | TokenKind::LBrace
                        | TokenKind::LBracket
                ) {
                    names.push(n.as_str());
                }
            }
            _ => {}
        }
    }
    names
}

fn opens_object(tokens: &[Token], k: usize) -> bool {
    if k == 0 {
        return true;
    }
    matches!(
        tokens[k - 1].kind,
        TokenKind::LParen
            | TokenKind::LBracket
            | TokenKind::Comma
            | TokenKind::Eq
            | TokenKind::Colon
            | TokenKind::Question
            | TokenKind::DotDotDot
            | TokenKind::AmpAmp
            | TokenKind::PipePipe
            | TokenKind::Keyword(crate::token::Keyword::Return)
    )
}

enum Edit {
    Prefix(usize),
    Suffix(usize),
    Shorthand(usize, String),
    Replace(std::ops::Range<usize>, String),
    Mark(usize),
}

impl Edit {
    fn pos(&self) -> usize {
        match self {
            Edit::Prefix(p) | Edit::Suffix(p) | Edit::Shorthand(p, _) | Edit::Mark(p) => *p,
            Edit::Replace(r, _) => r.start,
        }
    }
}

fn rewrite_tokens(src: &str, tokens: &[Token], scope: &Scope, base: Option<usize>) -> String {
    let mut stack: Vec<bool> = Vec::new();
    let mut edits: Vec<Edit> = Vec::new();
    if base.is_some() {
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                edits.push(Edit::Mark(i + 1));
            }
        }
    }
    for (k, tok) in tokens.iter().enumerate() {
        match &tok.kind {
            TokenKind::LBrace => stack.push(opens_object(tokens, k)),
            TokenKind::LParen | TokenKind::LBracket => stack.push(false),
            TokenKind::RBrace | TokenKind::RParen | TokenKind::RBracket => {
                stack.pop();
            }
            TokenKind::Template(_) => {
                let body = tok.span.start + 1;
                let (_, subs) = crate::lexer::scan_template(src.as_bytes(), body);
                for r in subs {
                    let inner = &src[r.clone()];
                    let rewritten = rewrite_at(inner, scope, base.map(|b| b + r.start));
                    if rewritten != inner {
                        edits.push(Edit::Replace(r, rewritten));
                    }
                }
            }
            TokenKind::Ident(name) => {
                let is_sig = scope.sigs.contains(name);
                let is_prop = scope.props.contains(name);
                if !is_sig && !is_prop {
                    continue;
                }
                let prev = k.checked_sub(1).map(|p| &tokens[p].kind);
                if prev == Some(&TokenKind::Dot) {
                    continue;
                }
                let next = tokens.get(k + 1).map(|t| &t.kind);
                let in_object = stack.last() == Some(&true);
                let key_pos =
                    in_object && matches!(prev, Some(TokenKind::LBrace) | Some(TokenKind::Comma));
                if key_pos && next == Some(&TokenKind::Colon) {
                    continue;
                }
                let value = if is_sig {
                    format!("{name}.value")
                } else if let Some(d) = scope.defaults.get(name) {
                    format!("(props.{name} ?? ({d}))")
                } else {
                    format!("props.{name}")
                };
                if key_pos && matches!(next, Some(TokenKind::Comma) | Some(TokenKind::RBrace)) {
                    edits.push(Edit::Shorthand(tok.span.end, format!(": {value}")));
                } else if is_sig {
                    edits.push(Edit::Suffix(tok.span.end));
                } else if scope.defaults.contains_key(name) {
                    edits.push(Edit::Replace(tok.span.start..tok.span.end, value));
                } else {
                    edits.push(Edit::Prefix(tok.span.start));
                }
            }
            _ => {}
        }
    }
    if edits.is_empty() {
        return src.to_string();
    }
    edits.sort_by_key(Edit::pos);
    let mut out = String::with_capacity(src.len() + edits.len() * 8);
    let mut last = 0;
    for e in edits {
        if e.pos() < last {
            continue;
        }
        let (pos, text) = match e {
            Edit::Prefix(p) => (p, "props.".to_string()),
            Edit::Suffix(p) => (p, ".value".to_string()),
            Edit::Shorthand(p, t) => (p, t),
            Edit::Mark(p) => (p, String::new()),
            Edit::Replace(range, t) => {
                out.push_str(&src[last..range.start]);
                out.push_str(&t);
                last = range.end;
                continue;
            }
        };
        out.push_str(&src[last..pos]);
        out.push_str(&text);
        if let Some(b) = base {
            mark(&mut out, b + pos);
        }
        last = pos;
    }
    out.push_str(&src[last..]);
    out
}

pub(crate) fn is_boolean_attr(name: &str) -> bool {
    matches!(
        name,
        "allowfullscreen"
            | "async"
            | "autofocus"
            | "autoplay"
            | "checked"
            | "controls"
            | "default"
            | "defer"
            | "disabled"
            | "formnovalidate"
            | "hidden"
            | "inert"
            | "ismap"
            | "itemscope"
            | "loop"
            | "multiple"
            | "muted"
            | "nomodule"
            | "novalidate"
            | "open"
            | "playsinline"
            | "readonly"
            | "required"
            | "reversed"
            | "selected"
    )
}

fn directive_ref(value: &Option<AttrValue>) -> String {
    match value {
        Some(AttrValue::Expr(e)) => e.clone(),
        Some(AttrValue::Str(s)) => s.clone(),
        None => String::new(),
    }
}

fn static_attr_value(s: &str) -> String {
    escape_template(&html_escape_attr(s))
}

fn html_escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

fn escape_template(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '`' => out.push_str("\\`"),
            '$' => out.push_str("\\$"),
            _ => out.push(c),
        }
    }
    out
}

fn trim_ws_edges(nodes: &[Node]) -> &[Node] {
    let is_ws = |n: &Node| matches!(n, Node::Text(t) if t.value.trim().is_empty());
    let start = nodes.iter().position(|n| !is_ws(n));
    let Some(start) = start else { return &[] };
    let end = nodes.iter().rposition(|n| !is_ws(n)).unwrap();
    &nodes[start..=end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    fn lower_src(src: &str) -> String {
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "diagnostics: {diags:?}");
        lower(src, &file)
    }

    #[test]
    fn source_maps_point_back_into_the_wx_source() {
        let src = concat!(
            "import { x } from \"./x.wx\"\n",
            "\n",
            "component Card(user: { name: string }, items: string[]) {\n",
            "  signal count = 0\n",
            "  function bump(by: number) {\n",
            "    count = count + by\n",
            "    return `${count}/${user.name}`\n",
            "  }\n",
            "  view {\n",
            "    <p title={user.name}>Hi {user.nmae}!</p>\n",
            "    {#each items as it (it)}<i>{it}</i>{/each}\n",
            "    <Other v={count} />\n",
            "  }\n",
            "}\n",
            "\n",
            "model Task { id: string }\n",
        );
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        let (mapped, maps) = lower_with_map(src, &file);
        assert_eq!(mapped, lower(src, &file), "marks never change the output");
        assert!(!mapped.contains(crate::sourcemap::MARK));
        for (i, w) in maps.windows(2).enumerate() {
            assert!(
                (w[0].gen_line, w[0].gen_col) < (w[1].gen_line, w[1].gen_col),
                "order at {i}"
            );
        }

        let find = |text: &str, needle: &str, n: usize| -> (u32, u32) {
            let at = text.match_indices(needle).nth(n).unwrap().0;
            let line = text[..at].matches('\n').count() as u32;
            let col = (at - text[..at].rfind('\n').map_or(0, |i| i + 1)) as u32;
            (line, col)
        };
        for (needle, gen_n, src_n) in [
            ("import", 2, 0),
            ("nmae", 0, 0),
            ("title", 0, 0),
            ("<p", 0, 0),
            ("by", 1, 1),
            ("user.name}`", 0, 0),
            ("Other", 0, 0),
            ("Task", 0, 0),
        ] {
            let (gl, gc) = find(&mapped, needle, gen_n);
            let want = find(src, needle, src_n);
            assert_eq!(
                crate::sourcemap::original(&maps, gl, gc),
                Some(want),
                "`{needle}` at {gl}:{gc} in:\n{mapped}"
            );
        }
    }

    #[test]
    fn template_substitutions_are_rewritten() {
        let out = lower_src(concat!(
            "component C(name: string, xs: number[]) {\n",
            "  signal n = 1\n",
            "  derived label = `${name}: ${n + 1} of ${xs.map((n) => `#${n}`).join()}`\n",
            "  view { <p title={`t-${n}`}>{`${name}!`} {`${`${n}`}`}</p> }\n",
            "}\n",
        ));
        assert!(
            out.contains(
                "`${props.name}: ${n.value + 1} of ${props.xs.map((n) => `#${n}`).join()}`"
            ),
            "props/signals rewritten, the arrow parameter `n` shadows the signal: {out}"
        );
        assert!(out.contains("(`t-${n.value}`)}"), "{out}");
        assert!(out.contains("escapeHtml(`${props.name}!`)"), "{out}");
        assert!(
            out.contains("escapeHtml(`${`${n.value}`}`)"),
            "nested: {out}"
        );
    }

    #[test]
    fn html_content_models_lower_faithfully() {
        let out = lower_src(concat!(
            "component C(x: string) { view {\n",
            "  <div/><br><textarea>{x} < y</textarea><!-- gone --><pre>\n  a\n    b</pre>\n",
            "} }\n",
        ));
        assert!(
            out.contains("<div></div><br />"),
            "a non-void self-closing tag is closed: {out}"
        );
        assert!(
            out.contains("<textarea>${escapeHtml(props.x)} < y</textarea>"),
            "{out}"
        );
        assert!(!out.contains("gone"), "{out}");
        assert!(
            out.contains("<pre>\n  a\n    b</pre>"),
            "pre keeps its whitespace: {out}"
        );
    }

    #[test]
    fn named_slots_become_trusted_props() {
        let out = lower_src(concat!(
            "component Card(header: Html, footer?: Html, children: Html) { view {\n",
            "  <section><h2>{header}</h2>{children}<small>{footer}</small></section>\n",
            "} }\n",
            "component P(name: string) { view {\n",
            "  <Card>\n",
            "    <template slot=\"header\">Hi {name}</template>\n",
            "    <p>body</p>\n",
            "    <a slot=\"footer\" href=\"/x\">more</a>\n",
            "    <b slot=\"footer\">!</b>\n",
            "  </Card>\n",
            "} }\n",
        ));
        assert!(
            out.contains(concat!(
                "${Card({ header: trustHtml(`Hi ${escapeHtml(props.name)}`), ",
                "footer: trustHtml(`<a href=\"/x\">more</a><b>!</b>`), ",
                "children: trustHtml(`<p>body</p>`) })}"
            )),
            "{out}"
        );
        let only = lower_src(concat!(
            "component C(a: Html) { view { {a} } }\n",
            "component P() { view { <C>  <i slot=\"a\">x</i>  </C> } }\n",
        ));
        assert!(
            only.contains("${C({ a: trustHtml(`<i>x</i>`) })}"),
            "{only}"
        );
    }

    #[test]
    fn await_block_lowers_to_branch_closures() {
        let out = lower_src(concat!(
            "component U(user: Promise<{ name: string }>, n: number) { view {\n",
            "  {#await user}<p>{n}</p>{:then n}<p>{n.name}</p>{:catch}<p>err</p>{/await}\n",
            "} }\n",
        ));
        assert!(out.contains("awaitBlock } from \"@weft-framework/runtime\""), "{out}");
        assert!(
            out.contains(concat!(
                "${awaitBlock(props.user, () => `<p>${escapeHtml(props.n)}</p>`, ",
                "(n) => `<p>${escapeHtml(n.name)}</p>`, (_) => `<p>err</p>`)}"
            )),
            "the then-binding shadows the prop: {out}"
        );
        let only_then = lower_src(
            "component V(p: Promise<string>) { view { {#await p}{:then v}{v}{/await} } }",
        );
        assert!(
            only_then
                .contains("awaitBlock(props.p, () => ``, (v) => `${escapeHtml(v)}`, undefined)"),
            "{only_then}"
        );
    }

    #[test]
    fn keyed_each_keys_roots_and_component_instances() {
        let out = lower_src(concat!(
            "component Row(t: string) { view { <i>{t}</i> } }\n",
            "component L(items: { id: number; t: string }[]) { view {\n",
            "  <ul>{#each items as item, i (item.id)}<li>{item.t}</li><Row t={item.t} />{/each}</ul>\n",
            "} }\n",
        ));
        assert!(out.contains("keyed } from \"@weft-framework/runtime\""), "{out}");
        assert!(
            out.contains(concat!(
                "${(props.items).map((item, i) => { const __weftKey = String(item.id); return ",
                "`<li data-weft-key=\"${escapeAttr(__weftKey)}\">${escapeHtml(item.t)}</li>",
                "${keyed(`${__weftKey}:1`, () => Row({ t: item.t }))}`; }).join(\"\")}"
            )),
            "{out}"
        );
        let plain =
            lower_src("component P(xs: string[]) { view { {#each xs as x}<b>{x}</b>{/each} } }");
        assert!(plain.contains("(props.xs).map((x) => `<b>"), "{plain}");
        assert!(!plain.contains("keyed"), "{plain}");
    }

    #[test]
    fn comments_are_kept_and_never_swallow_code() {
        let out = lower_src(concat!(
            "/** Docs. */\n",
            "component C() {\n",
            "  // a count\n",
            "  signal n = 0 // starts at 0\n",
            "  derived d = f(n, /* ) */ 1)\n",
            "  function inc() {\n",
            "    // don't stop here: ) }\n",
            "    n = n + 1\n",
            "  } // inc\n",
            "  // markup\n",
            "  view { <button @click={inc}>{d}</button> }\n",
            "}\n",
        ));
        let want = [
            "/** Docs. */\nexport const C",
            "  // a count\n  const n = signal(0); // starts at 0\n",
            "derived(() => f(n.value, /* ) */ 1));",
            "// don't stop here: ) }\n    n.value = n.value + 1\n  } // inc\n",
            "  // markup\n  return {",
            "handlers: { inc }",
        ];
        for w in want {
            assert!(out.contains(w), "missing {w:?} in:\n{out}");
        }
    }

    #[test]
    fn prop_defaults_are_applied_on_read() {
        let out = lower_src(
            "component Counter(start: number = 0, step: number = 1) {\n  signal count = start\n  function increment() { count = count + step }\n  view { <button @click={increment}>{count}</button> }\n}",
        );
        assert!(
            out.contains("(props: { start?: number; step?: number }) => {"),
            "got:\n{out}"
        );
        assert!(out.contains("const count = signal((props.start ?? (0)));"), "got:\n{out}");
        assert!(out.contains("count.value = count.value + (props.step ?? (1))"), "got:\n{out}");
        assert!(!out.contains("start: number = 0"), "got:\n{out}");
    }

    #[test]
    fn greeting_lowers_with_escaped_interp() {
        let src = "component Greeting(name: string) { view { <h1>Hello, {name}</h1> } }";
        let out = lower_src(src);
        assert!(out.contains(
            "import { defineComponent, escapeHtml, escapeAttr } from \"@weft-framework/runtime\";"
        ));
        assert!(out.contains(
            "export const Greeting = defineComponent(\"Greeting\", (props: { name: string }) => {"
        ));
        assert!(
            out.contains("handlers: {},"),
            "got:
{out}"
        );
        assert!(
            out.contains("render: () => `<h1>Hello, ${escapeHtml(props.name)}</h1>`,"),
            "got:\n{out}"
        );
    }

    #[test]
    fn constant_component_is_marked_static() {
        let out =
            lower_src("component Logo() { view { <div class=\"logo\"><b>Weft</b> app</div> } }");
        assert!(out.contains("static: true"), "got:\n{out}");
        for src in [
            "component A(t: string) { view { <p>x</p> } }",
            "component B() { signal n = 0; view { <p>{n}</p> } }",
            "component C() { view { <p>{1 + 1}</p> } }",
            "component D() { view { <Logo /> } }",
            "component E() { view { <div><slot /></div> } }",
            "component F() { view { <p title={\"x\"}>x</p> } }",
        ] {
            let out = lower_src(src);
            assert!(!out.contains("static: true"), "{src} got:\n{out}");
        }
    }

    #[test]
    fn quiet_component_is_marked_inert() {
        for src in [
            "component A() { view { <p>x</p> } }",
            "component B(t: string, xs: string[]) { view { <h1 title={t}>{t}</h1>{#each xs as x}<Row v={x} />{/each}<slot /> } }",
            "component C(ok: boolean) { view { {#if ok}<form action={save}><button>Go</button></form>{:else}<p>no</p>{/if} } }",
            "component S(children: Html, ...attrs: Attrs) { view { <summary {...attrs}>{children}</summary> } }",
            "component N(path: string) { function current(href: string): boolean { return href === path } view { <a href={path} class={current(path) ? \"active\" : \"\"}>x</a> } }",
            "const links = [{ href: \"/\", label: \"Home\" }];\ncomponent Nav(path: string) {\n  function current(href: string): boolean { return href === path }\n  view {\n    <nav>{#each links as link (link.href)}<a href={link.href} class={current(link.href) ? \"active\" : \"\"} aria-current={current(link.href) ? \"page\" : false}>{link.label}</a>{/each}</nav>\n  }\n}\n",
        ] {
            let out = lower_src(src);
            assert!(out.contains("inert: true"), "{src} got:\n{out}");
        }
        for src in [
            "component D() { signal n = 0; view { <p>{n}</p> } }",
            "component E() { view { <button @click={go}>x</button> } }",
            "component F(v: string) { view { <p :title={v}>x</p> } }",
            "import { tabs } from \"@weft-framework/ui\";\ncomponent G() { view { <div use:tabs>x</div> } }",
        ] {
            let out = lower_src(src);
            assert!(!out.contains("inert: true"), "{src} got:\n{out}");
        }
    }

    #[test]
    fn attribute_expression_is_escaped() {
        let src = "component A(url: string, t: string) { view { <a href={url} title={t}>go</a> } }";
        let out = lower_src(src);
        assert!(
            out.contains(concat!(
                "<a${((__v) => __v == null ? \"\" : ` href=\"${escapeUrl(__v, \"href\")}\"`)(props.url)}",
                "${((__v) => __v == null ? \"\" : ` title=\"${escapeAttr(__v)}\"`)(props.t)}>go</a>"
            )),
            "got:\n{out}"
        );
        assert!(
            out.contains("escapeAttr, escapeUrl } from \"@weft-framework/runtime\""),
            "got:\n{out}"
        );
        let plain = lower_src("component B(t: string) { view { <p title={t}>x</p> } }");
        assert!(!plain.contains("escapeUrl"), "got:\n{plain}");
    }

    #[test]
    fn static_attribute_and_self_closing() {
        let src = "component Img() { view { <img src=\"a.png\"/> } }";
        let out = lower_src(src);
        assert!(out.contains("<img src=\"a.png\" />"), "got:\n{out}");
    }

    #[test]
    fn template_metachars_in_text_are_neutralised() {
        let src = "component P() { view { <p>a $ b ` c</p> } }";
        let out = lower_src(src);
        assert!(out.contains("a \\$ b \\` c"), "got:\n{out}");
    }

    #[test]
    fn no_items_no_prelude() {
        let out = lower_src("const x = 1;");
        assert_eq!(
            out,
            "const x = 1;
"
        );
    }

    #[test]
    fn event_directive_lowers_to_marker() {
        let src = "component B() { view { <button @click={increment}>+</button> } }";
        let out = lower_src(src);
        assert!(
            out.contains("<button data-weft-on-click=\"increment\">+</button>"),
            "got:\n{out}"
        );
    }

    #[test]
    fn bind_directive_renders_and_marks_reactive() {
        let src = "component L(url: string) { view { <a :href={url}>go</a> } }";
        let out = lower_src(src);
        assert!(
            out.contains(
                "<a href=\"${escapeUrl(props.url, \"href\")}\" data-weft-bind-href=\"url\">go</a>"
            ),
            "got:\n{out}"
        );
    }

    #[test]
    fn signals_lower_and_references_read_value() {
        let src = "component Counter() {\n  signal count = 0\n  derived doubled = count * 2\n  view { <p>{count} is {doubled}</p> }\n}";
        let out = lower_src(src);
        assert!(
            out.contains(
                "import { defineComponent, escapeHtml, escapeAttr, signal, derived } from \"@weft-framework/runtime\";"
            ),
            "got:\n{out}"
        );
        assert!(out.contains("const count = signal(0);"), "got:\n{out}");
        assert!(
            out.contains("const doubled = derived(() => count.value * 2);"),
            "got:\n{out}"
        );
        assert!(out.contains("${escapeHtml(count.value)}"), "got:\n{out}");
        assert!(out.contains("${escapeHtml(doubled.value)}"), "got:\n{out}");
    }

    #[test]
    fn typed_reactives_pass_the_type_through() {
        let out = lower_src("component C() {\n  signal names: string[] = []\n  derived n: number = names.length\n  view { <p>{n}</p> }\n}");
        assert!(out.contains("const names = signal<string[]>([]);"), "got:\n{out}");
        assert!(out.contains("const n = derived<number>(() =>"), "got:\n{out}");
    }

    #[test]
    fn file_fields_lower_to_file_ref() {
        let src = "model Profile {\n  id: string\n  avatar: File | null\n  @read(true)\n  @write(true)\n}";
        let out = lower_src(src);
        assert!(
            out.contains("import { defineModel, type FileRef } from \"@weft-framework/data\";"),
            "got:\n{out}"
        );
        assert!(out.contains("  avatar: FileRef | null;"), "got:\n{out}");
        assert!(out.contains("avatar: \"File | null\""), "got:\n{out}");
        assert_eq!(file_field_type("Files"), None);
        assert_eq!(file_field_type("ns.File"), None);
        assert_eq!(file_field_type("MyFile"), None);
        assert_eq!(file_field_type("File[]").as_deref(), Some("FileRef[]"));
        assert_eq!(file_field_type("FileRef | null").as_deref(), Some("FileRef | null"));
        let plain = lower_src("model Note {\n  id: string\n  @read(true)\n}");
        assert!(plain.contains("import { defineModel } from \"@weft-framework/data\";"), "got:\n{plain}");
    }

    #[test]
    fn model_lowers_to_interface_and_define_model() {
        let src = "model Invoice {\n  owner: User\n  amount: Money\n  @read(actor == owner)\n  @write(actor == owner)\n}";
        let out = lower_src(src);
        assert!(
            out.contains("import { defineModel } from \"@weft-framework/data\";"),
            "got:\n{out}"
        );
        assert!(out.contains("export interface Invoice {"), "got:\n{out}");
        assert!(out.contains("  owner: User;"), "got:\n{out}");
        assert!(out.contains("  amount: Money;"), "got:\n{out}");
        assert!(
            out.contains("export const Invoice = defineModel<Invoice>(\"Invoice\", {"),
            "got:\n{out}"
        );
        assert!(
            out.contains("fields: { owner: \"User\", amount: \"Money\" },"),
            "got:\n{out}"
        );
        assert!(
            out.contains("read: (actor, row) => (actor == row.owner),"),
            "got:\n{out}"
        );
        assert!(
            out.contains("write: (actor, row) => (actor == row.owner),"),
            "got:\n{out}"
        );
    }

    #[test]
    fn field_consent_lowers_to_a_purpose_and_widens_the_type() {
        let out = lower_src(
            "model Visit {\n  id: string\n  owner: string\n  device: string @consent(\"analytics\")\n  city: string @consent(\"location\", owner) @read(actor.staff)\n  @read(true)\n}",
        );
        assert!(out.contains("  device: string | null;\n"), "got:\n{out}");
        assert!(out.contains("device: { consent: \"analytics\" }"), "got:\n{out}");
        assert!(out.contains("city: { consent: { purpose: \"location\", subject: \"owner\" }, read: (actor, row) => ("), "got:\n{out}");
    }

    #[test]
    fn field_read_rule_lowers_to_a_function_and_widens_the_type() {
        let out = lower_src(
            "model Person {\n  id: string\n  email: string @read(id == actor.id)\n  phone: string | null @read(actor.admin)\n  @read(true)\n}",
        );
        assert!(out.contains("  email: string | null;\n"), "got:\n{out}");
        assert!(out.contains("  phone: string | null;\n"), "got:\n{out}");
        assert!(out.contains("email: { read: (actor, row) => ("), "got:\n{out}");
        assert!(out.contains("row.id == actor.id)"), "got:\n{out}");
        assert!(out.contains("fields: { id: \"string\", email: \"string\", phone: \"string | null\" }"), "got:\n{out}");
    }

    #[test]
    fn model_residency_lowers_to_a_region_or_a_function() {
        let out = lower_src("model Doc {\n  id: string\n  @read(true)\n  @residency(\"eu\")\n}");
        assert!(out.contains("  residency: \"eu\",\n"), "got:\n{out}");
        let out = lower_src("model Doc {\n  id: string\n  tenant: string\n  @residency(tenant == \"acme\" ? \"us\" : null)\n}");
        assert!(
            out.contains("residency: (row) => (row.tenant == \"acme\" ? \"us\" : null),"),
            "got:\n{out}"
        );
    }

    #[test]
    fn model_predicate_does_not_qualify_property_names() {
        let src = "model Doc {\n  owner: User\n  @read(actor.id == owner.id)\n}";
        let out = lower_src(src);
        assert!(
            out.contains("read: (actor, row) => (actor.id == row.owner.id),"),
            "got:\n{out}"
        );
    }

    #[test]
    fn if_else_lowers_to_ternary() {
        let src = "component C(ok: boolean) { view { {#if ok}<p>yes</p>{:else}<p>no</p>{/if} } }";
        let out = lower_src(src);
        assert!(
            out.contains("${(props.ok) ? `<p>yes</p>` : `<p>no</p>`}"),
            "got:\n{out}"
        );
    }

    #[test]
    fn can_block_lowers_to_the_runtime_check() {
        let src = "component C(task: { id: string }) { view { {#can write(task)}<button>Edit</button>{:else}<p>no</p>{/can} } }";
        let out = lower_src(src);
        assert!(
            out.contains("${(__weftCan(\"write\", props.task)) ? `<button>Edit</button>` : `<p>no</p>`}"),
            "got:\n{out}"
        );
        assert!(out.contains("can as __weftCan"), "got:\n{out}");
        let plain = lower_src("component C(ok: boolean) { view { {#if ok}<p>yes</p>{/if} } }");
        assert!(!plain.contains("__weftCan"), "got:\n{plain}");
    }

    #[test]
    fn shared_fields_lower_to_the_runtime_helpers() {
        let src = concat!(
            "component C(note: { id: string, body: string, title: string }) { view { <div>",
            "<textarea :bind.shared={note.body} aria-label=\"Body\"></textarea>",
            "<input :bind.shared={note.title} aria-label=\"Title\" />",
            "</div> } }"
        );
        let out = lower_src(src);
        assert!(
            out.contains("<textarea${sharedAttrs(props.note, \"body\")} aria-label=\"Body\">${escapeHtml(sharedValue(props.note, \"body\"))}</textarea>"),
            "got:\n{out}"
        );
        assert!(
            out.contains("${sharedAttrs(props.note, \"title\")} value=\"${escapeHtml(sharedValue(props.note, \"title\"))}\""),
            "got:\n{out}"
        );
        assert!(out.contains("sharedAttrs") && out.contains("sharedValue"), "got:\n{out}");
        assert!(!out.contains("data-weft-ca"), "got:\n{out}");
        let plain = lower_src("component C(ok: boolean) { view { <p>x</p> } }");
        assert!(!plain.contains("sharedAttrs"), "got:\n{plain}");
    }

    #[test]
    fn if_without_else_lowers_to_empty_branch() {
        let src = "component C(ok: boolean) { view { {#if ok}<p>yes</p>{/if} } }";
        let out = lower_src(src);
        assert!(
            out.contains("${(props.ok) ? `<p>yes</p>` : ``}"),
            "got:\n{out}"
        );
    }

    #[test]
    fn each_lowers_to_map_join_with_escaped_item() {
        let src = "component C(items: string[]) { view { <ul>{#each items as item}<li>{item}</li>{/each}</ul> } }";
        let out = lower_src(src);
        assert!(
            out.contains(
                "<ul>${(props.items).map((item) => `<li>${escapeHtml(item)}</li>`).join(\"\")}</ul>"
            ),
            "got:\n{out}"
        );
    }

    #[test]
    fn each_binding_shadows_a_signal_of_the_same_name() {
        let src = "component C() {\n  signal item = 0\n  view { {#each list as item}<li>{item}</li>{/each} }\n}";
        let out = lower_src(src);
        assert!(
            out.contains("(item) => `<li>${escapeHtml(item)}</li>`"),
            "got:\n{out}"
        );
    }

    #[test]
    fn local_function_is_emitted_with_signal_writes_rewritten() {
        let src = "component C() {\n  signal count = 0\n  function increment(): void {\n    count = count + 1\n  }\n  view { <button @click={increment}>{count}</button> }\n}";
        let out = lower_src(src);
        assert!(
            out.contains(
                "  function increment(): void {\n    count.value = count.value + 1\n  }\n"
            ),
            "got:\n{out}"
        );
        let f = out.find("function increment").unwrap();
        let r = out.find("render: () => `").unwrap();
        assert!(f < r, "got:\n{out}");
    }

    #[test]
    fn component_invocation_lowers_to_props_call() {
        let src = "component P(user: User) { view { <Greeting name={user.name} punct=\"!\" /> } }";
        let out = lower_src(src);
        assert!(
            out.contains("${Greeting({ name: props.user.name, punct: \"!\" })}"),
            "got:\n{out}"
        );
    }

    #[test]
    fn bound_boolean_attribute_renders_bare_or_not_at_all() {
        let src = "component L(open: boolean) { view { <div :hidden={!open}>x</div> } }";
        let out = lower_src(src);
        assert!(out.contains("<div${(!props.open) ? \" hidden\" : \"\"} data-weft-bind-hidden="), "got:\n{out}");
        assert!(!out.contains("hidden=\"${"), "got:\n{out}");
    }

    #[test]
    fn component_events_are_rendered_at_the_call_and_forwarded() {
        let src = "component P() {\n  function pick(id: string, e: WeftEvent) { }\n  view { <Select name=\"s\" @change={pick(\"a\")} /> }\n}";
        let out = lower_src(src);
        assert!(
            out.contains("${Select({ \"data-weft-events\": forwardEvents(` data-weft-on-change=\"pick\" data-weft-args-change=\"${escapeAttr(bindArgs([\"a\"]))}\"${ownerAttr(\"change\")}`), name: \"s\" })}"),
            "got:\n{out}"
        );
        assert!(out.contains("forwardEvents"), "imported:\n{out}");
        assert!(out.contains("ownerAttr"), "imported:\n{out}");
    }

    #[test]
    fn handlers_passed_into_a_component_name_their_owner() {
        let src = "component P() {\n  function add() { }\n  function top() { }\n  view {\n    <button @click={top}>t</button>\n    <Shell><form @submit={add}><button>a</button></form></Shell>\n  }\n}";
        let out = lower_src(src);
        assert!(out.contains("<form data-weft-on-submit=\"add\"${ownerAttr(\"submit\")}>"), "got:\n{out}");
        assert!(out.contains("<button data-weft-on-click=\"top\">t</button>"), "its own markup needs none:\n{out}");
        assert!(out.contains("ownerAttr } from") || out.contains("ownerAttr,") || out.contains(", ownerAttr"), "imported:\n{out}");

        let plain = lower_src("component Q() {\n  function top() { }\n  view { <button @click={top}>t</button> }\n}");
        assert!(!plain.contains("ownerAttr"), "not imported when unused:\n{plain}");
    }

    #[test]
    fn component_invocation_without_props_calls_bare() {
        let src = "component P() { view { <div><Footer/></div> } }";
        let out = lower_src(src);
        assert!(out.contains("<div>${Footer({})}</div>"), "got:\n{out}");
    }

    #[test]
    fn component_children_become_a_children_prop() {
        let src = "component P() { view { <Card>hi {name}</Card> } }";
        let out = lower_src(src);
        assert!(
            out.contains("${Card({ children: trustHtml(`hi ${escapeHtml(name)}`) })}"),
            "got:\n{out}"
        );
    }

    #[test]
    fn slot_imports_trusted_markup_helpers() {
        let src = "component Card(children: Html) { view { <div>{children}</div> } }\ncomponent P() { view { <Card><b>x</b></Card> } }";
        let out = lower_src(src);
        assert!(
            out.starts_with(
                "import { defineComponent, escapeHtml, escapeAttr, trustHtml, type Html } from \"@weft-framework/runtime\";"
            ),
            "got:\n{out}"
        );
        assert!(out.contains("${escapeHtml(props.children)}"), "got:\n{out}");
    }

    #[test]
    fn property_access_on_signal_is_not_rewritten() {
        let src = "component U() {\n  signal user = getUser()\n  view { <p>{user.name}</p> }\n}";
        let out = lower_src(src);
        assert!(
            out.contains("${escapeHtml(user.value.name)}"),
            "got:\n{out}"
        );
    }

    #[test]
    fn field_attributes_lower_to_model_config() {
        let src = "model Post {\n  id: string @default(crypto.randomUUID())\n  author: string @ref(User) @index;\n  slug: string @unique @renamed(name)\n  title: string\n}";
        let out = lower_src(src);
        assert!(
            out.contains("export const Post = defineModel<Post, \"id\">(\"Post\", {"),
            "{out}"
        );
        assert!(
            out.contains(
                "  attrs: { id: { default: () => (crypto.randomUUID()) }, \
                 author: { ref: \"User\", index: true }, slug: { unique: true, renamed: \"name\" } },\n"
            ),
            "{out}"
        );
        assert!(
            out.contains("  author: string;\n  slug: string;"),
            "types end at the attributes: {out}"
        );
        let kept = lower_src("model Log {\n  id: string\n  at: number @retain(30d) @index\n}");
        assert!(kept.contains("  attrs: { at: { retain: 2592000000, index: true } },\n"), "{kept}");
    }

    #[test]
    fn handlers_expose_only_event_referenced_functions() {
        let src = "component C() {\n  signal n = 0\n  function inc() { n = n + 1 }\n  function secret() { n = 0 }\n  view { <button @click={inc}>{n}</button> }\n}";
        let out = lower_src(src);
        assert!(out.contains("handlers: { inc },"), "got:\n{out}");
        assert!(
            out.contains("function secret()"),
            "still emitted for local use"
        );
    }

    #[test]
    fn handler_call_arguments_become_server_rendered_json() {
        let src = "component C(items: Item[]) {\n  function remove(id: string) { }\n  view { {#each items as item}<button @click={remove(item.id)}>x</button>{/each} }\n}";
        let out = lower_src(src);
        assert!(
            out.contains(
                "<button data-weft-on-click=\"remove\" data-weft-args-click=\"${escapeAttr(bindArgs([item.id]))}\">x</button>"
            ),
            "got:\n{out}"
        );
        assert!(out.contains("handlers: { remove },"), "got:\n{out}");
        assert!(
            out.contains("import { defineComponent, escapeHtml, escapeAttr, bindArgs } from"),
            "got:\n{out}"
        );
    }

    #[test]
    fn function_parameters_shadow_signals_and_props() {
        let src = "component C(step: number) {\n  signal count = 0\n  function set(count: number) { total(count, step) }\n  view { <p>{count}</p> }\n}";
        let out = lower_src(src);
        assert!(
            out.contains("function set(count: number) { total(count, props.step) }"),
            "got:\n{out}"
        );
    }

    #[test]
    fn object_keys_and_arrow_params_are_not_rewritten() {
        let src = "component C(id: string) {\n  signal count = 0\n  view { <p>{fmt({ count: count, id })}{list.map((count) => count)}</p> }\n}";
        let out = lower_src(src);
        assert!(
            out.contains("fmt({ count: count.value, id: props.id })"),
            "got:\n{out}"
        );
        assert!(out.contains("list.map((count) => count)"), "got:\n{out}");
    }

    #[test]
    fn boolean_attribute_expression_renders_by_presence() {
        let src = "component C(done: boolean) { view { <input type=\"checkbox\" checked={done} disabled /> } }";
        let out = lower_src(src);
        assert!(
            out.contains(
                "<input type=\"checkbox\"${(props.done) ? \" checked\" : \"\"} disabled />"
            ),
            "got:\n{out}"
        );
    }

    #[test]
    fn split_handler_forms() {
        assert_eq!(split_handler("save"), Some(("save", None)));
        assert_eq!(
            split_handler(" remove(item.id) "),
            Some(("remove", Some("item.id")))
        );
        assert_eq!(split_handler("go()"), Some(("go", None)));
        assert_eq!(split_handler("a(b)(c)"), None);
        assert_eq!(split_handler("() => x"), None);
        assert_eq!(split_handler("a.b"), None);
    }

    #[test]
    fn runtime_names_the_file_imports_are_not_imported_twice() {
        let src = "import { trustHtml, escapeHtml as esc, type Html } from \"@weft-framework/runtime\";\ncomponent Card(children: Html) {\n  view { <div>{children}</div> }\n}\ncomponent C(name: string) {\n  view { <Card><p>{trustHtml(esc(name))}</p></Card> }\n}";
        let out = lower_src(src);
        let generated = out
            .lines()
            .find(|l| l.starts_with("import { defineComponent"))
            .unwrap_or_else(|| panic!("got:\n{out}"));
        assert!(!generated.contains("trustHtml"), "got:\n{out}");
        assert!(!generated.contains("type Html"), "got:\n{out}");
        assert!(
            generated.contains("escapeHtml"),
            "a different local name is not the same binding:\n{out}"
        );
        assert!(out.contains("import { trustHtml, escapeHtml as esc, type Html } from \"@weft-framework/runtime\";"), "got:\n{out}");
        assert_eq!(
            runtime_imports(
                "import type { Html } from '@weft-framework/runtime'\nimport { x } from \"./x\""
            ),
            ["Html".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn derived_values_may_await() {
        let src = "component Page() {\n  signal n = 1\n  derived row = await load(n)\n  derived awaited = awaitable(n)\n  client signal q = \"\"\n  client derived hits = await Promise.resolve(q.length)\n  view { <p>{row}{awaited}{hits}</p> }\n}\nasync function load(n: number) { return n }\nfunction awaitable(n: number) { return n }\n";
        let out = lower_src(src);
        assert!(
            out.contains("const row = asyncDerived(async () => await load(n.value));"),
            "{out}"
        );
        assert!(
            out.contains("const awaited = derived(() => awaitable(n.value));"),
            "{out}"
        );
        assert!(out.contains(", asyncDerived }"), "{out}");
        let island = crate::island::lower_client(&parse(src).0).unwrap_or_default();
        assert!(
            island.contains("import { defineIsland, signal, derived, asyncDerived }"),
            "{island}"
        );
        assert!(
            island.contains(
                "const hits = asyncDerived(async () => await Promise.resolve(q.value.length));"
            ),
            "{island}"
        );
        let plain = lower_src(
            "component P() {\n  signal n = 1\n  derived d = n + 1\n  view { <p>{d}</p> }\n}\n",
        );
        assert!(!plain.contains("asyncDerived"), "{plain}");
    }

    #[test]
    fn component_functions_may_be_async() {
        let src = "component Page() {\n  signal status = \"\"\n  client signal open = false\n  async function save() {\n    const r = await fetch(\"/x\")\n    status = r.ok ? \"saved\" : \"failed\"\n  }\n  client async function toggle() {\n    await Promise.resolve()\n    open = !open\n  }\n  view { <div><button @click={save}>{status}</button><button @click={toggle}>{open}</button></div> }\n}\n";
        let out = lower_src(src);
        assert!(out.contains("async function save()"), "{out}");
        assert!(out.contains("status.value = r.ok"), "{out}");
        let island = crate::island::lower_client(&parse(src).0).unwrap_or_default();
        assert!(island.contains("async function toggle()"), "{island}");
    }

    #[test]
    fn record_action_params_lower_to_record_specs() {
        let out = lower_src("action save(vars: Record<string, string>) {}\n");
        assert!(
            out.contains("{ name: \"vars\", type: \"record\" }"),
            "{out}"
        );
        assert_eq!(action_param_type("Record<string, string>[]"), None);
        assert_eq!(action_param_type("Record<string, number>"), None);
    }

    #[test]
    fn file_action_params_lower_to_file_specs() {
        let out = lower_src("action up(doc: File, more: File[]) {}\n");
        assert!(out.contains("{ name: \"doc\", type: \"file\" }"), "{out}");
        assert!(
            out.contains("{ name: \"more\", type: \"file\", list: true }"),
            "{out}"
        );
    }

    #[test]
    fn confirm_messages_may_be_expressions() {
        let src = "component C(label: string, t: (k: string) => string) {
  function drop() { }
  view {
    <button @click.confirm(t(\"items.delete\"))={drop}>x</button>
    <button @click.confirm(label)={drop}>y</button>
  }
}";
        let out = lower_src(src);
        assert!(
            out.contains(
                "data-weft-confirm-click=\"${escapeAttr(String(props.t(\"items.delete\")))}\""
            ),
            "got:
{out}"
        );
        assert!(
            out.contains("data-weft-confirm-click=\"${escapeAttr(String(props.label))}\""),
            "got:
{out}"
        );
    }

    #[test]
    fn event_modifiers_lower_to_static_data() {
        let src = "component C(id: string) {\n  function search() { }\n  function drop(x: string) { }\n  function poll() { }\n  view {\n    <input @input.debounce(250ms)={search}/>\n    <button :busy @click.confirm(\"Delete \\\"it\\\"?\").once={drop(id)}>x</button>\n    <div @every(5s)={poll}></div>\n  }\n}";
        let out = lower_src(src);
        assert!(
            out.contains(
                "<input data-weft-on-input=\"search\" data-weft-mod-input=\"debounce=250\" />"
            ),
            "got:\n{out}"
        );
        assert!(
            out.contains(
                "<button data-weft-busy data-weft-on-click=\"drop\" data-weft-mod-click=\"confirm once\" \
                 data-weft-confirm-click=\"Delete &quot;it&quot;?\" data-weft-args-click=\"${escapeAttr(bindArgs([props.id]))}\">x</button>"
            ),
            "got:\n{out}"
        );
        assert!(
            out.contains(
                "<div data-weft-on-every=\"poll\" data-weft-mod-every=\"every=5000\"></div>"
            ),
            "got:\n{out}"
        );
        assert!(
            out.contains("handlers: { search, drop, poll },"),
            "got:\n{out}"
        );
    }

    #[test]
    fn actor_lowers_to_register_augmentation() {
        let out = lower_src("interface User { id: string }\nactor User\n");
        assert!(
            out.contains(
                "declare module \"@weft-framework/data\" {\n  interface Register {\n    actor: User;\n  }\n}\nexport {};"
            ),
            "{out}"
        );
        assert!(out.contains("interface User { id: string }"), "{out}");
    }

    #[test]
    fn jobs_lower_to_define_job() {
        let out = lower_src(concat!(
            "job sendWelcome(user: string, tries?: number) {\n",
            "  return ctx.user\n}\n",
            "component Page() {\n  view {\n    <button onclick={() => sendWelcome}>x</button>\n  }\n}\n",
        ));
        assert!(
            out.contains("import { defineJob, type JobContext } from \"@weft-framework/server/jobs\";"),
            "{out}"
        );
        assert!(!out.contains("defineAction"), "{out}");
        assert!(out.contains(concat!(
            "export const sendWelcome = defineJob(\"sendWelcome\", [\n",
            "  { name: \"user\", type: \"string\" },\n",
            "  { name: \"tries\", type: \"number\", optional: true }\n",
            "], async (ctx: JobContext, user: string, tries: number | undefined) => {\n",
            "  return ctx.user\n});"
        )), "{out}");
    }

    #[test]
    fn held_action_parameters_lower_to_their_inner_type() {
        let out = lower_src("action rename(id: Held<string>, title: string) {\n  return id + title\n}\n");
        assert!(out.contains(concat!(
            "export const rename = defineAction(\"rename\", [\n",
            "  { name: \"id\", type: \"string\", held: true },\n",
            "  { name: \"title\", type: \"string\" }\n",
            "], async (ctx: ActionContext, id: string, title: string) => {\n",
        )), "{out}");
    }

    #[test]
    fn actions_lower_to_define_action_and_form_attrs() {
        let out = lower_src(concat!(
            "action add(title: string, n?: number, tags: Array<string>, ok: boolean) {\n",
            "  return ctx.session + title\n}\n",
            "component Page() {\n  view {\n    <form action={add}><button formaction={add}>Go</button></form>\n",
            "    <form action=\"/search\"></form>\n  }\n}\n",
        ));
        assert!(
            out.contains(
                "import { defineAction, type ActionContext } from \"@weft-framework/server/action\";"
            ),
            "{out}"
        );
        assert!(out.contains(concat!(
            "export const add = defineAction(\"add\", [\n",
            "  { name: \"title\", type: \"string\" },\n",
            "  { name: \"n\", type: \"number\", optional: true },\n",
            "  { name: \"tags\", type: \"string\", list: true },\n",
            "  { name: \"ok\", type: \"boolean\" }\n",
            "], async (ctx: ActionContext, title: string, n: number | undefined, tags: Array<string>, ok: boolean) => {\n",
            "  return ctx.session + title\n});"
        )), "{out}");
        assert!(out.contains("actionAttr } from \"@weft-framework/runtime\""), "{out}");
        assert!(
            out.contains(
                "<form${actionAttr(\"action\", add)}><button${actionAttr(\"formaction\", add)}>"
            ),
            "{out}"
        );
        assert!(
            out.contains("<form action=\"/search\">"),
            "plain URLs untouched: {out}"
        );
    }

    #[test]
    fn stores_lower_to_define_store() {
        let out = lower_src("store app visits = 0\nstore session cart: string[] = []\n");
        assert!(
            out.contains("import { defineStore } from \"@weft-framework/runtime\";"),
            "{out}"
        );
        assert!(
            out.contains("export const visits = defineStore(\"visits\", \"app\", () => (0));"),
            "{out}"
        );
        assert!(
            out.contains(
                "export const cart = defineStore<string[]>(\"cart\", \"session\", () => ([]));"
            ),
            "{out}"
        );
    }

    #[test]
    fn capabilities_lower_to_erased_declarations() {
        let out = lower_src(concat!(
            "import { Card } from \"./Card.wx\"\n",
            "import { helper as h } from \"./util.ts\"\n",
            "model Note { id: string\n  @read(true)\n  @write(true)\n}\n",
            "export function pull() { return fetch(\"/x\") }\n",
            "component Page() uses db {\n  signal n = Note\n  view { <Card /> <p>{h()}</p> }\n}\n",
            "component Pure() {\n  view { <p /> }\n}\n",
        ));
        assert!(
            out.contains("import type { EffectOf, WeftWithin } from \"@weft-framework/runtime\";"),
            "{out}"
        );
        assert!(
            out.contains("import type * as __weftM0 from \"./Card.wx\";"),
            "{out}"
        );
        assert!(
            out.contains("export declare const __weftEffects_Note: \"db\";"),
            "{out}"
        );
        assert!(
            out.contains("export declare const __weftEffects_pull: \"net\";"),
            "{out}"
        );
        assert!(
            out.contains("export declare const __weftEffects_Page: \"db\" | EffectOf<typeof __weftM0, \"Card\">;"),
            "{out}"
        );
        assert!(
            !out.contains("__weftEffects_Pure"),
            "a pure declaration has none: {out}"
        );
        assert!(
            out.contains("export type __weftUses_Page_0 = WeftWithin<\"db\", EffectOf<typeof __weftM0, \"Card\">>;"),
            "{out}"
        );
        assert!(
            !out.contains("util.ts\";\nexport"),
            "plain .ts imports are opaque: {out}"
        );
    }

    #[test]
    fn styled_components_scope_their_elements() {
        let src = concat!(
            "component Card(accent: string, kind: string) {\n",
            "  view {\n    <div class=\"card\"><p class={kind}>x</p><Other /></div>\n    <span />\n  }\n",
            "  style { .card { color: {accent} } }\n}\n",
        );
        let out = lower_src(src);
        let class = crate::css::scope_class("Card", " .card { color: {accent} } ");
        assert!(out.contains("cssVars"), "{out}");
        assert!(
            out.contains(&format!(
                "<div class=\"card {class}\"${{cssVars(\"{class}\", [props.accent])}}>"
            )),
            "{out}"
        );
        assert!(
            out.contains(&format!(
                "<p class=\"${{escapeAttr(props.kind)}} {class}\">"
            )),
            "{out}"
        );
        assert!(
            out.contains(&format!("<span class=\"{class}\"${{cssVars(")),
            "every top-level element carries the values: {out}"
        );
        assert!(
            !out.contains("<Other class"),
            "child components are not touched: {out}"
        );
        assert!(
            out.contains(&format!(
                ", {{ css: \".card:where(.{class}){{color:var(--{class}-0)}}\" }})"
            )),
            "{out}"
        );
    }
}
