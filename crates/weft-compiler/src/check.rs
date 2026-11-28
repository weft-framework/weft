use std::collections::{HashMap, HashSet};

use crate::ast::{
    Attr, AttrKind, AttrValue, Component, Element, Item, Model, Node, PolicyKind, Slots, SourceFile,
};
use crate::diagnostics::Diagnostic;
use crate::lexer::tokenize;
use crate::lower::{is_component_name, split_handler};
use crate::token::{Keyword, Span, Token, TokenKind};

pub(crate) fn retain_ms(arg: &str) -> Option<u64> {
    let arg = arg.trim();
    let unit = arg.chars().last()?;
    let digits = &arg[..arg.len() - unit.len_utf8()];
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    let per: u64 = match unit {
        'm' => 60_000,
        'h' => 3_600_000,
        'd' => 86_400_000,
        'w' => 7 * 86_400_000,
        'y' => 365 * 86_400_000,
        _ => return None,
    };
    let ms = n.checked_mul(per)?;
    (60_000..(1u64 << 53)).contains(&ms).then_some(ms)
}

pub(crate) fn shared_target(expr: &str) -> Option<(String, String)> {
    let expr = expr.trim();
    let dot = expr.rfind('.')?;
    let field = &expr[dot + 1..];
    let row = expr[..dot].trim_end();
    let row = row.strip_suffix('?').unwrap_or(row).trim_end();
    let ident = !field.is_empty()
        && field.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    (ident && !row.is_empty() && !row.ends_with('.')).then(|| (row.to_string(), field.to_string()))
}

pub(crate) fn consent_arg(arg: &str) -> Option<(String, Option<String>)> {
    let arg = arg.trim();
    let rest = arg.strip_prefix('"')?;
    let end = rest.find('"')?;
    let purpose = &rest[..end];
    let tail = rest[end + 1..].trim();
    let words_ok = !purpose.is_empty()
        && purpose.starts_with(|c: char| c.is_ascii_lowercase())
        && !purpose.ends_with(['-', '_'])
        && !purpose.contains("--")
        && !purpose.contains("__")
        && !purpose.contains("-_")
        && !purpose.contains("_-")
        && purpose.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !words_ok {
        return None;
    }
    if tail.is_empty() {
        return Some((purpose.to_string(), None));
    }
    let field = tail.strip_prefix(',')?.trim();
    let ident = !field.is_empty()
        && field.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    ident.then(|| (purpose.to_string(), Some(field.to_string())))
}

pub(crate) fn is_nullable(ty: &str) -> bool {
    let t = ty.trim();
    t.ends_with('?')
        || t.split('|')
            .any(|m| matches!(m.trim(), "null" | "undefined"))
}

pub fn check(src: &str, file: &SourceFile) -> Vec<Diagnostic> {
    let components: HashMap<&str, &Component> = file
        .items
        .iter()
        .filter_map(|it| match it {
            Item::Component(c) => Some((c.name.as_str(), c)),
            _ => None,
        })
        .collect();

    let mut module = module_names(src, file);
    for it in &file.items {
        let name = match it {
            Item::Component(c) => &c.name,
            Item::Model(m) => &m.name,
            Item::Action(a) => &a.name,
            Item::Placed(p) => {
                module.extend(p.names.iter().cloned());
                continue;
            }
            Item::Store(st) => &st.name,
            Item::Actor(_) => continue,
        };
        module.insert(name.clone());
    }

    let models = file
        .items
        .iter()
        .filter_map(|it| match it {
            Item::Model(m) => Some((m.name.as_str(), m)),
            _ => None,
        })
        .collect();
    let mut cx = Checker {
        src,
        module,
        components,
        models,
        actions: file
            .items
            .iter()
            .filter_map(|it| match it {
                Item::Action(a) => Some(a.name.clone()),
                _ => None,
            })
            .collect(),
        shared: file
            .items
            .iter()
            .flat_map(|it| match it {
                Item::Placed(p) if p.client => p.names.clone(),
                _ => Vec::new(),
            })
            .collect(),
        local_fns: HashSet::new(),
        client: HashSet::new(),
        server: HashSet::new(),
        foreign: 0,
        diags: Vec::new(),
    };
    cx.duplicate_items(file);
    let effects = crate::effects::analyze(src, file);
    crate::effects::check(file, &effects, &mut cx.diags);
    for it in &file.items {
        match it {
            Item::Component(c) => cx.component(c),
            Item::Model(m) => cx.model(m),
            Item::Action(a) => cx.action(a),
            Item::Placed(p) if p.client && p.import.is_none() => {
                let actions = std::mem::take(&mut cx.actions);
                cx.side(&p.source, p.offset, true, &[p.name.as_str()]);
                cx.actions = actions;
            }
            Item::Placed(_) | Item::Actor(_) | Item::Store(_) => {}
        }
    }
    cx.diags
}

const GLOBALS: &[&str] = &[
    "Array",
    "ArrayBuffer",
    "BigInt",
    "Boolean",
    "Date",
    "Error",
    "Infinity",
    "Intl",
    "JSON",
    "Map",
    "Math",
    "NaN",
    "Number",
    "Object",
    "Promise",
    "Proxy",
    "Reflect",
    "RegExp",
    "Set",
    "String",
    "Symbol",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "URLSearchParams",
    "Uint8Array",
    "WeakMap",
    "WeakSet",
    "clearInterval",
    "clearTimeout",
    "console",
    "crypto",
    "decodeURI",
    "decodeURIComponent",
    "document",
    "encodeURI",
    "encodeURIComponent",
    "fetch",
    "globalThis",
    "isFinite",
    "isNaN",
    "location",
    "navigator",
    "parseFloat",
    "parseInt",
    "performance",
    "queueMicrotask",
    "setInterval",
    "setTimeout",
    "structuredClone",
    "window",
];

const OPERATOR_WORDS: &[&str] = &[
    "as",
    "delete",
    "in",
    "instanceof",
    "keyof",
    "of",
    "satisfies",
    "super",
    "this",
    "typeof",
    "void",
];

const HTML_ELEMENTS: &[&str] = &[
    "a",
    "abbr",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "base",
    "bdi",
    "bdo",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "circle",
    "cite",
    "clipPath",
    "code",
    "col",
    "colgroup",
    "data",
    "datalist",
    "dd",
    "defs",
    "del",
    "details",
    "dfn",
    "dialog",
    "div",
    "dl",
    "dt",
    "ellipse",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "foreignObject",
    "form",
    "g",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "iframe",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "line",
    "linearGradient",
    "link",
    "main",
    "map",
    "mark",
    "mask",
    "menu",
    "meta",
    "meter",
    "nav",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "path",
    "picture",
    "polygon",
    "polyline",
    "pre",
    "progress",
    "q",
    "radialGradient",
    "rect",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "script",
    "search",
    "section",
    "select",
    "slot",
    "small",
    "source",
    "span",
    "stop",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "svg",
    "symbol",
    "table",
    "tbody",
    "td",
    "template",
    "text",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "title",
    "tr",
    "track",
    "tspan",
    "u",
    "ul",
    "use",
    "var",
    "video",
    "wbr",
];

struct Checker<'a> {
    src: &'a str,
    module: HashSet<String>,
    components: HashMap<&'a str, &'a Component>,
    models: HashMap<&'a str, &'a Model>,
    actions: HashSet<String>,
    shared: HashSet<String>,
    local_fns: HashSet<String>,
    client: HashSet<String>,
    server: HashSet<String>,
    foreign: usize,
    diags: Vec<Diagnostic>,
}

impl<'a> Checker<'a> {
    fn error(&mut self, msg: impl Into<String>, span: Span) {
        self.diags.push(Diagnostic::error(msg, span));
    }

    fn warning(&mut self, msg: impl Into<String>, span: Span) {
        self.diags.push(Diagnostic::warning(msg, span));
    }

    fn locate(&self, within: Span, from: usize, needle: &str) -> usize {
        let end = within.end.min(self.src.len());
        let start = from.max(within.start).min(end);
        self.src
            .get(start..end)
            .and_then(|s| s.find(needle))
            .map(|i| start + i)
            .unwrap_or(within.start)
    }

    fn after(&self, within: Span, marker: &str) -> usize {
        self.locate(within, within.start, marker) + marker.len()
    }

    fn duplicate_items(&mut self, file: &SourceFile) {
        let mut seen: HashSet<&str> = HashSet::new();
        for it in &file.items {
            let (name, span) = match it {
                Item::Component(c) => (c.name.as_str(), c.span),
                Item::Model(m) => (m.name.as_str(), m.span),
                Item::Actor(a) => ("actor", a.span),
                Item::Action(a) => (a.name.as_str(), a.span),
                Item::Placed(p) => (p.name.as_str(), p.span),
                Item::Store(st) => (st.name.as_str(), st.span),
            };
            if !seen.insert(name) {
                self.error(format!("`{name}` is defined more than once"), span);
            }
        }
    }

    fn component(&mut self, c: &'a Component) {
        let mut scope: HashSet<String> = HashSet::new();
        let declared = c
            .params
            .iter()
            .map(|p| (p.name.as_str(), p.span))
            .chain(c.reactives.iter().map(|r| (r.name.as_str(), r.span)))
            .chain(c.functions.iter().map(|f| (f.name.as_str(), f.span)));
        for (name, span) in declared {
            if !scope.insert(name.to_string()) {
                self.error(
                    format!(
                        "`{name}` is declared more than once in component `{}`",
                        c.name
                    ),
                    span,
                );
            }
        }

        for p in &c.params {
            if p.name == "props" {
                self.error(
                    "`props` is reserved in components; it names the props object",
                    p.span,
                );
            }
        }
        self.local_fns = c.functions.iter().map(|f| f.name.clone()).collect();
        self.client = c
            .reactives
            .iter()
            .filter(|r| r.client)
            .map(|r| r.name.clone())
            .chain(
                c.functions
                    .iter()
                    .filter(|f| f.client)
                    .map(|f| f.name.clone()),
            )
            .collect();
        self.server = c
            .params
            .iter()
            .map(|p| p.name.clone())
            .chain(
                c.reactives
                    .iter()
                    .filter(|r| !r.client)
                    .map(|r| r.name.clone()),
            )
            .chain(
                c.functions
                    .iter()
                    .filter(|f| !f.client)
                    .map(|f| f.name.clone()),
            )
            .collect();

        for r in &c.reactives {
            let from = self.after(r.span, "=");
            let at = self.locate(r.span, from, &r.expr);
            self.expr(&r.expr, at, &scope);
            self.side(&r.expr, at, r.client, &[]);
        }
        for f in &c.functions {
            let own: Vec<&str> = std::iter::once(f.name.as_str()).collect();
            self.side(&f.source, f.span.start, f.client, &own);
        }
        for h in &c.lifecycle {
            self.side(&h.expr, h.span.start, h.client, &[]);
        }
        self.nodes(&c.view.nodes, &scope);
        self.diags.extend(crate::a11y::lint(&c.view.nodes));
        if let Some(st) = &c.style {
            let (compiled, diags) = crate::css::compile(&c.name, &st.css, st.offset);
            self.diags.extend(diags);
            for (expr, at) in &compiled.vars {
                self.expr(expr, *at, &scope);
                self.server_only(expr, *at, "a style value");
            }
        }
    }

    fn nodes(&mut self, nodes: &'a [Node], scope: &HashSet<String>) {
        for n in nodes {
            self.node(n, scope);
        }
    }

    fn node(&mut self, n: &'a Node, scope: &HashSet<String>) {
        match n {
            Node::Text(_) => {}
            Node::Interp(i) => {
                let at = self.locate(i.span, i.span.start, &i.expr);
                self.expr(&i.expr, at, scope);
                self.client_binding(&i.expr, at);
            }
            Node::Element(e) => self.element(e, scope),
            Node::If(b) => {
                let mut cursor = self.after(b.span, if b.can.is_some() { "#can" } else { "#if" });
                for (k, arm) in b.arms.iter().enumerate() {
                    if k > 0 {
                        cursor = self.locate(b.span, cursor, ":else") + ":else".len();
                    }
                    let at = self.locate(b.span, cursor, &arm.cond);
                    self.expr(&arm.cond, at, scope);
                    self.server_only(&arm.cond, at, if b.can.is_some() { "`{#can}`" } else { "`{#if}`" });
                    cursor = at + arm.cond.len();
                    self.nodes(&arm.body, scope);
                }
                if let Some(body) = &b.else_body {
                    self.nodes(body, scope);
                }
            }
            Node::Await(b) => {
                let from = self.after(b.span, "#await");
                let at = self.locate(b.span, from, &b.expr);
                self.expr(&b.expr, at, scope);
                self.server_only(&b.expr, at, "`{#await}`");
                if b.expr.contains('(') {
                    self.warning(
                        "`{#await}` of a call starts a new promise on every render; \
                         await a stable value (a prop, a signal or `load` data)"
                            .to_string(),
                        b.span,
                    );
                }
                self.nodes(&b.pending, scope);
                for br in [&b.then, &b.catch].into_iter().flatten() {
                    let mut inner = scope.clone();
                    if let Some(name) = &br.binding {
                        inner.insert(name.clone());
                    }
                    self.nodes(&br.body, &inner);
                }
            }
            Node::Each(b) => {
                let from = self.after(b.span, "#each");
                let at = self.locate(b.span, from, &b.expr);
                self.expr(&b.expr, at, scope);
                self.server_only(&b.expr, at, "`{#each}`");
                let mut inner = scope.clone();
                inner.insert(b.item.clone());
                if let Some(index) = &b.index {
                    inner.insert(index.clone());
                }
                if let Some(key) = &b.key {
                    let at = self.locate(b.span, from, key);
                    self.expr(key, at, &inner);
                    let stray = b.body.iter().any(|n| match n {
                        Node::Text(t) => !t.value.trim().is_empty(),
                        Node::Interp(_) => true,
                        _ => false,
                    });
                    if stray {
                        self.error(
                            "a keyed `{#each}` body must consist of elements or components \
                             (wrap text in an element)"
                                .to_string(),
                            b.span,
                        );
                    }
                }
                self.nodes(&b.body, &inner);
            }
        }
    }

    fn element(&mut self, e: &'a Element, scope: &HashSet<String>) {
        let name_start = e.span.start + 1;
        let name_span = Span::new(name_start, name_start + e.name.len());

        if is_component_name(&e.name) {
            let root = e.name.split('.').next().unwrap_or(&e.name);
            if let Some(def) = self.components.get(e.name.as_str()).copied() {
                self.props(e, def, name_span);
            } else if !self.module.contains(root) {
                self.error(format!("unknown component <{}>", e.name), name_span);
            }
            for attr in &e.attrs {
                if attr.kind == AttrKind::Use {
                    self.error(
                        format!(
                            "`use:{}` attaches to an HTML element; a component renders \
                             no element of its own (put it on an element inside <{}>, or \
                             pass the function as a prop)",
                            attr.name, e.name
                        ),
                        attr.span,
                    );
                } else if attr.kind == AttrKind::Event {
                    let closed = self
                        .components
                        .get(e.name.as_str())
                        .is_some_and(|def| !def.params.iter().any(|p| p.rest));
                    if closed {
                        self.warning(
                            format!(
                                "<{}> takes no `...attrs`, so `@{}` reaches no element and is ignored",
                                e.name, attr.name
                            ),
                            attr.span,
                        );
                    }
                } else if !matches!(attr.kind, AttrKind::Plain | AttrKind::Spread) {
                    self.warning(
                        format!(
                            "directives on components are not supported yet; `{}` is ignored",
                            attr.name
                        ),
                        attr.span,
                    );
                }
            }
        } else if !e.name.contains('-') && !HTML_ELEMENTS.contains(&e.name.as_str()) {
            self.warning(format!("unknown HTML element <{}>", e.name), name_span);
        } else if matches!(e.name.as_str(), "script" | "style") {
            self.warning(
                format!(
                    "a <{}> in a view is blocked by the page's Content-Security-Policy; \
                     load it from src/index.html or a file in public/",
                    e.name
                ),
                name_span,
            );
        }

        if !is_component_name(&e.name) && self.foreign == 0 {
            self.html_attrs(e);
        }
        let mut events: Vec<&str> = Vec::new();
        for attr in &e.attrs {
            if attr.kind == AttrKind::Event {
                let ev = crate::events::parse(&attr.name).map_or(attr.name.as_str(), |s| s.event);
                if events.contains(&ev) {
                    self.error(
                        format!(
                            "<{}> already has an `@{ev}` directive; handle the cases \
                             in one function (it receives the event, e.g. `event.key`)",
                            e.name
                        ),
                        attr.span,
                    );
                }
                events.push(ev);
                self.event_handler(attr, scope);
                continue;
            }
            if attr.kind == AttrKind::Bind && attr.name == "bind.shared" {
                self.shared_field(e, attr, scope);
                continue;
            }
            if attr.kind == AttrKind::Bind && attr.name == "busy" {
                if attr.value.is_some() {
                    self.error(
                        "`:busy` takes no value; it marks the element busy (and \
                         disables a form control) while its component's events are pending",
                        attr.span,
                    );
                }
                continue;
            }
            if attr.kind == AttrKind::Use {
                if !is_component_name(&e.name) {
                    self.attachment(attr, scope);
                }
                continue;
            }
            if attr.kind == AttrKind::Spread {
                if let Some(AttrValue::Expr(expr)) = &attr.value {
                    let from = self.after(attr.span, "...");
                    let at = self.locate(attr.span, from, expr);
                    self.expr(expr, at, scope);
                    self.server_only(expr, at, "a `{...spread}`");
                }
                continue;
            }
            if attr.kind == AttrKind::Bind && attr.value.is_none() {
                self.error(
                    format!("`:{}` needs a value: `:{}={{expr}}`", attr.name, attr.name),
                    attr.span,
                );
                continue;
            }
            if let Some(AttrValue::Expr(expr)) = &attr.value {
                let from = self.after(attr.span, "=");
                let at = self.locate(attr.span, from, expr);
                self.expr(expr, at, scope);
                if is_component_name(&e.name) {
                    self.server_only(expr, at, "a component prop");
                } else {
                    self.client_binding(expr, at);
                }
            }
        }
        let foreign = matches!(e.name.as_str(), "svg" | "math");
        self.foreign += usize::from(foreign);
        self.nodes(&e.children, scope);
        self.foreign -= usize::from(foreign);
    }

    fn shared_field(&mut self, e: &Element, attr: &Attr, scope: &HashSet<String>) {
        let Some(AttrValue::Expr(expr)) = &attr.value else {
            self.error("`:bind.shared` needs the field: `:bind.shared={note.body}`", attr.span);
            return;
        };
        let from = self.after(attr.span, "=");
        let at = self.locate(attr.span, from, expr);
        let Some((row, _)) = shared_target(expr) else {
            self.error(
                "`:bind.shared` takes a row's field, `{note.body}`: the row a model handed out, then the field",
                attr.span,
            );
            return;
        };
        self.expr(&row, at, scope);
        self.server_only(&row, at, "`:bind.shared`");
        let text_input = e.name == "input"
            && e.attrs.iter().all(|a| {
                !(a.kind == AttrKind::Plain && a.name.eq_ignore_ascii_case("type"))
                    || matches!(&a.value, Some(AttrValue::Str(t)) if ["text", "search"].contains(&t.to_ascii_lowercase().as_str()))
            });
        if e.name != "textarea" && !text_input {
            self.error("`:bind.shared` goes on a `<textarea>` or a text `<input>`", attr.span);
            return;
        }
        if e.name == "textarea" && !e.children.is_empty() {
            self.error("a shared `<textarea>` is empty: its text comes from `:bind.shared`", attr.span);
        }
        if e.attrs.iter().any(|a| a.name.eq_ignore_ascii_case("value") && a.kind != AttrKind::Event) {
            self.error("a shared field has no `value` of its own: it comes from `:bind.shared`", attr.span);
        }
    }

    fn html_attrs(&mut self, e: &Element) {
        use crate::html::{classify_attr, element_attrs, suggest, AttrVerdict};
        use crate::html::{ARIA_ATTRS, ARIA_ROLES, GLOBAL_ATTRS};
        for attr in &e.attrs {
            if matches!(
                attr.kind,
                AttrKind::Event | AttrKind::Spread | AttrKind::Use
            ) || (attr.kind == AttrKind::Bind && (attr.name == "busy" || attr.name == "bind.shared"))
            {
                continue;
            }
            if attr.name.eq_ignore_ascii_case("srcdoc")
                && matches!(attr.value, Some(AttrValue::Expr(_)))
                && !script_free_sandbox(e)
            {
                self.error(
                    "`srcdoc` takes HTML, so a dynamic value could run script; \
                     add a static `sandbox` without `allow-scripts`, use a static string, \
                     or `src` with a sandboxed URL",
                    attr.span,
                );
            }
            let Some(verdict) = classify_attr(&e.name, &attr.name) else {
                return;
            };
            let hint =
                |s: Option<&str>| s.map_or(String::new(), |s| format!(" (did you mean `{s}`?)"));
            match verdict {
                AttrVerdict::Ok => {}
                AttrVerdict::Unknown => {
                    let own = element_attrs(&e.name).unwrap_or(&[]);
                    let s = suggest(&attr.name, own.iter().chain(GLOBAL_ATTRS).copied());
                    self.warning(
                        format!("<{}> has no attribute `{}`{}", e.name, attr.name, hint(s)),
                        attr.span,
                    );
                }
                AttrVerdict::UnknownAria => {
                    let s = suggest(&attr.name, ARIA_ATTRS.iter().copied());
                    self.warning(
                        format!("`{}` is not a WAI-ARIA attribute{}", attr.name, hint(s)),
                        attr.span,
                    );
                }
                AttrVerdict::InlineHandler => {
                    let event = &attr.name[2..];
                    self.error(
                        format!(
                            "inline handler `{}` is refused by the page CSP; \
                             use `@{}={{handler}}`",
                            attr.name,
                            event.to_ascii_lowercase()
                        ),
                        attr.span,
                    );
                }
                AttrVerdict::Reserved => self.warning(
                    format!(
                        "`{}`: `data-weft-*` attributes are written by the compiler \
                         and read by the runtime; choose another name",
                        attr.name
                    ),
                    attr.span,
                ),
            }
            if attr.name == "role" {
                if let Some(AttrValue::Str(roles)) = &attr.value {
                    for role in roles.split_ascii_whitespace() {
                        if !ARIA_ROLES.contains(&role) {
                            let s = suggest(role, ARIA_ROLES.iter().copied());
                            self.warning(
                                format!("`{role}` is not a WAI-ARIA role{}", hint(s)),
                                attr.span,
                            );
                        }
                    }
                }
            }
        }
    }

    fn event_handler(&mut self, attr: &Attr, scope: &HashSet<String>) {
        let base = attr.span.start + 1;
        let problems = match crate::events::parse(&attr.name) {
            Ok(spec) => crate::events::validate(&spec),
            Err(p) => vec![p],
        };
        for p in problems {
            let span = Span::new(base + p.at, (base + p.at + p.len).min(attr.span.end));
            if p.warning {
                self.warning(p.message, span);
            } else {
                self.error(p.message, span);
            }
        }
        let Some(AttrValue::Expr(expr)) = &attr.value else {
            self.error(
                format!(
                    "`@{}` needs a handler: `@{}={{name}}`",
                    attr.name, attr.name
                ),
                attr.span,
            );
            return;
        };
        match split_handler(expr) {
            None => self.error(
                format!(
                    "`@{}` must name a component function, optionally called: `{{name}}` or `{{name(args)}}`",
                    attr.name
                ),
                attr.span,
            ),
            Some((name, _)) if !self.local_fns.contains(name) => self.error(
                format!("`{name}` is not a function declared in this component"),
                attr.span,
            ),
            Some((name, _))
                if !self.client.contains(name)
                    && crate::events::parse(&attr.name)
                        .is_ok_and(|s| crate::events::client_only(s.event)) =>
            {
                let ev = crate::events::parse(&attr.name).map_or("", |s| s.event);
                self.error(
                    format!(
                        "`@{ev}` fires many times a second and runs only in the browser; \
                         declare `client function {name}` to handle it"
                    ),
                    attr.span,
                )
            }
            Some((_, Some(args))) => {
                let from = self.after(attr.span, "=");
                let at = self.locate(attr.span, from, args);
                self.expr(args, at, scope);
                self.server_only(args, at, "a handler argument");
            }
            Some((_, None)) => {}
        }
        let Ok(spec) = crate::events::parse(&attr.name) else {
            return;
        };
        if let Some(opt) = spec.optimistic() {
            let handler = split_handler(expr).map(|(n, _)| n);
            if !self.client.contains(opt) || !self.local_fns.contains(opt) {
                self.error(
                    format!(
                        "`.optimistic({opt})` needs a `client function {opt}` in this component"
                    ),
                    attr.span,
                );
            } else if handler.is_some_and(|h| self.client.contains(h)) {
                self.error(
                    "`.optimistic` pairs a client function with a server handler; \
                     this handler already runs in the browser",
                    attr.span,
                );
            }
        }
    }

    fn attachment(&mut self, attr: &Attr, scope: &HashSet<String>) {
        let path_ok = !attr.name.is_empty()
            && attr.name.split('.').all(|seg| {
                seg.chars()
                    .next()
                    .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
                    && seg
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
            });
        let root = attr.name.split('.').next().unwrap_or_default();
        let local = self.client.contains(root) && self.local_fns.contains(root);
        if !path_ok {
            self.error(
                format!(
                    "`use:{}` must name a function: `use:name` or `use:name={{value}}`",
                    attr.name
                ),
                attr.span,
            );
        } else if !(local && !attr.name.contains('.')) && !self.shared.contains(root) {
            let why = if self.local_fns.contains(root) || self.server.contains(root) {
                format!("`{root}` runs on the server")
            } else {
                format!("`{root}` is not declared here")
            };
            self.error(
                format!(
                    "`use:{}` needs a function that runs in the browser, and {why}; declare \
                     `client function {root}(el: HTMLElement, value) {{ ... }}` in this \
                     component, or a module-level `client` function or import",
                    attr.name
                ),
                attr.span,
            );
        }
        if let Some(AttrValue::Expr(expr)) = &attr.value {
            let from = self.after(attr.span, "=");
            let at = self.locate(attr.span, from, expr);
            self.expr(expr, at, scope);
            self.client_binding(expr, at);
        }
    }

    fn side(&mut self, source: &str, at: usize, client: bool, own: &[&str]) {
        for (name, off) in free_idents(source) {
            if own.contains(&name.as_str()) {
                continue;
            }
            let start = at + off;
            let span = Span::new(start, start + name.len());
            let shipped = self.actions.contains(&name) || self.shared.contains(&name);
            if client && (self.server.contains(&name) || (self.module.contains(&name) && !shipped))
            {
                self.error(
                    format!(
                        "`{name}` is not available in the browser; client code can use \
                         client signals, client functions, this file's actions and \
                         JavaScript globals"
                    ),
                    span,
                );
            } else if !client && self.client.contains(&name) {
                self.error(
                    format!(
                        "`{name}` lives in the browser (`client`); server code cannot \
                         read or change it"
                    ),
                    span,
                );
            }
        }
    }

    fn server_only(&mut self, expr: &str, at: usize, what: &str) {
        for (name, off) in free_idents(expr) {
            if self.client.contains(&name) {
                let start = at + off;
                self.error(
                    format!(
                        "{what} is evaluated on the server and cannot read client \
                         `{name}`; bind it to an attribute instead (`:hidden={{!{name}}}`)"
                    ),
                    Span::new(start, start + name.len()),
                );
            }
        }
    }

    fn client_binding(&mut self, expr: &str, at: usize) {
        let names = free_idents(expr);
        if !names.iter().any(|(n, _)| self.client.contains(n)) {
            return;
        }
        for (name, off) in names {
            if self.client.contains(&name)
                || self.shared.contains(&name)
                || GLOBALS.contains(&name.as_str())
            {
                continue;
            }
            let start = at + off;
            self.error(
                format!(
                    "this binding reads client state, so it runs in the browser, \
                     where `{name}` does not exist; use only client signals here"
                ),
                Span::new(start, start + name.len()),
            );
        }
    }

    fn props(&mut self, e: &Element, def: &Component, at: Span) {
        let declared: HashSet<&str> = def
            .params
            .iter()
            .filter(|p| !p.rest)
            .map(|p| p.name.as_str())
            .collect();
        let open = def.params.iter().any(|p| p.rest);
        let spread = e.attrs.iter().any(|a| a.kind == AttrKind::Spread);
        let mut given: HashSet<&str> = HashSet::new();
        for attr in &e.attrs {
            if attr.kind != AttrKind::Plain {
                continue;
            }
            if !open && !declared.contains(attr.name.as_str()) {
                self.error(
                    format!("<{}> has no prop `{}`", e.name, attr.name),
                    attr.span,
                );
            }
            given.insert(attr.name.as_str());
        }

        let slots = Slots::of(&e.children);
        for child in &e.children {
            if let Node::Element(c) = child {
                if c.slot() == Some(Err(())) {
                    self.error(
                        format!(
                            "a slot name must be a plain string: `slot=\"name\"` (in <{}>)",
                            e.name
                        ),
                        c.span,
                    );
                }
            }
        }
        for &(name, filler) in &slots.named {
            if name == "children" || !crate::lexer::is_ident(name) {
                self.error(
                    format!(
                        "`{name}` is not a valid slot name (an identifier other than `children`)"
                    ),
                    filler.span,
                );
            } else if declared.contains(name) {
                given.insert(name);
            } else {
                self.error(
                    format!(
                        "<{}> has no slot `{name}` (declare a `{name}: Html` prop)",
                        e.name
                    ),
                    filler.span,
                );
            }
        }
        if !slots.rest.is_empty() {
            if declared.contains("children") {
                given.insert("children");
            } else {
                self.error(
                    format!(
                        "<{}> does not accept children (declare a `children: Html` prop)",
                        e.name
                    ),
                    at,
                );
            }
        }

        for p in def.params.iter().filter(|_| !spread) {
            if !p.rest
                && !given.contains(p.name.as_str())
                && !p.optional
                && p.default.is_none()
                && !is_optional_type(&p.ty)
            {
                self.error(
                    format!("<{}> is missing required prop `{}`", e.name, p.name),
                    at,
                );
            }
        }
    }

    fn action(&mut self, a: &crate::ast::Action) {
        let what = if a.job { "job" } else { "action" };
        if a.name.is_empty() {
            self.error(format!("expected {} name", if a.job { "a job" } else { "an action" }), a.span);
        }
        let mut held_done = false;
        for p in &a.params {
            if crate::lower::held_param(&p.ty).is_some() {
                if a.job {
                    self.error(
                        format!("job parameter `{}: {}`: jobs take no held parameters", p.name, p.ty),
                        p.span,
                    );
                } else if held_done {
                    self.error(
                        format!("`{}: {}`: held parameters come first, before the form's fields", p.name, p.ty),
                        p.span,
                    );
                } else if p.optional {
                    self.error(format!("`{}?`: a held parameter is always bound, so never optional", p.name), p.span);
                }
            } else {
                held_done = true;
            }
            if p.rest {
                self.error(
                    format!(
                        "`...{}`: {}'s parameters are named fields; \
                         rest parameters are for components",
                        p.name,
                        if a.job { "a job" } else { "an action" }
                    ),
                    p.span,
                );
            }
            if p.name == "ctx" {
                self.error(
                    format!(
                        "`ctx` is reserved in {what}s; it names the {}",
                        if a.job { "job context" } else { "request context" }
                    ),
                    p.span,
                );
            } else if p.name.starts_with("_weft") {
                self.error(
                    format!("`{}`: names starting `_weft` are reserved", p.name),
                    p.span,
                );
            }
            let file = matches!(crate::lower::action_param_type(&p.ty), Some(("file", _)));
            if file && (a.job || crate::lower::held_param(&p.ty).is_some()) {
                self.error(
                    format!(
                        "{what} parameter `{}: {}` cannot be a file; {}",
                        p.name,
                        p.ty,
                        if a.job {
                            "store the upload first and pass its key"
                        } else {
                            "held values are signed into the page, not uploaded"
                        }
                    ),
                    p.span,
                );
            } else if crate::lower::action_param_type(&p.ty).is_none() {
                self.error(
                    format!(
                        "{what} parameter `{}: {}` cannot be decoded from {}; use \
                         `string`, `number`, `boolean`, `File`, an array of one (`T[]`) \
                         or `Record<string, string>`",
                        p.name,
                        p.ty,
                        if a.job { "stored JSON" } else { "a form" }
                    ),
                    p.span,
                );
            }
        }
    }

    fn residency(&mut self, p: &crate::ast::Policy, at: usize, scope: &HashSet<String>) {
        let span = Span::new(at, at + p.predicate.len());
        if let Some(region) = crate::events::string_literal(&p.predicate) {
            let ok = region.len() <= 32
                && region.starts_with(|c: char| c.is_ascii_lowercase())
                && region.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !ok {
                self.error(
                    format!("`@residency(\"{region}\")`: a region is lowercase letters, digits and `-` (`eu`, `us-east`)"),
                    span,
                );
            }
            return;
        }
        let (tokens, _) = crate::lexer::tokenize(&p.predicate);
        if tokens.iter().enumerate().any(|(k, t)| {
            matches!(&t.kind, crate::token::TokenKind::Ident(n) if n == "actor")
                && !(k > 0 && tokens[k - 1].kind == crate::token::TokenKind::Dot)
        }) {
            self.error("`@residency` depends on the row only, not on `actor`", span);
        }
        self.expr(&p.predicate, at, scope);
    }

    fn model(&mut self, m: &Model) {
        let mut scope: HashSet<String> = HashSet::new();
        scope.insert("actor".to_string());
        for f in &m.fields {
            if f.name == "actor" {
                self.error(
                    "`actor` is reserved in models; it names the acting principal",
                    f.span,
                );
            }
            if !scope.insert(f.name.clone()) {
                self.error(
                    format!(
                        "field `{}` is declared more than once in model `{}`",
                        f.name, m.name
                    ),
                    f.span,
                );
            }
        }
        self.field_attrs(m, &scope);

        let mut seen_read = false;
        let mut seen_write = false;
        let mut seen_residency = false;
        for p in &m.policies {
            let (seen, word) = match p.kind {
                PolicyKind::Read => (&mut seen_read, "read"),
                PolicyKind::Write => (&mut seen_write, "write"),
                PolicyKind::Residency => (&mut seen_residency, "residency"),
            };
            if *seen {
                self.error(
                    format!(
                        "model `{}` has more than one `@{word}`{}",
                        m.name,
                        if p.kind == PolicyKind::Residency { "" } else { "; combine them with `&&` or `||`" }
                    ),
                    p.span,
                );
            }
            *seen = true;

            let from = self.after(p.span, "(");
            let at = self.locate(p.span, from, &p.predicate);
            if p.kind == PolicyKind::Residency {
                self.residency(p, at, &scope);
                continue;
            }
            self.expr(&p.predicate, at, &scope);

            let fields: HashSet<String> = m.fields.iter().map(|f| f.name.clone()).collect();
            if crate::policy::compile_policy(&p.predicate, &fields).is_none() {
                self.warning(
                    format!(
                        "`@{word}` cannot be compiled to a database filter; it is enforced \
                         in the application after rows are loaded (use comparisons of \
                         `actor` and fields joined by `&&`, `||`, `!`)"
                    ),
                    Span::new(at, at + p.predicate.len()),
                );
            }
        }
    }

    fn field_attrs(&mut self, m: &Model, scope: &HashSet<String>) {
        const FLAGS: [&str; 5] = ["id", "unique", "index", "tenant", "softDelete"];
        const WITH_ARG: [&str; 4] = ["default", "ref", "renamed", "retain"];
        let mut key: Option<&str> = None;
        let mut tenant: Option<&str> = None;
        let mut bin: Option<&str> = None;
        let mut kept: Option<&str> = None;
        for f in &m.fields {
            let mut seen = HashSet::new();
            for a in &f.attrs {
                let name = a.name.as_str();
                if !seen.insert(name) {
                    self.error(format!("`@{name}` is repeated on `{}`", f.name), a.span);
                    continue;
                }
                if name == "write" {
                    self.error(
                        "`@write` is a model rule; put it on its own line (a field has `@read`)",
                        a.span,
                    );
                    continue;
                }
                if name == "consent" {
                    let parsed = a.arg.as_ref().and_then(|(s, _)| consent_arg(s));
                    let Some((_, subject)) = parsed else {
                        self.error(
                            "`@consent` names a purpose, and optionally the field holding whose consent it is: \
                             `@consent(\"analytics\")`, `@consent(\"location\", owner)`",
                            a.span,
                        );
                        continue;
                    };
                    if let Some(s) = subject {
                        if s == f.name {
                            self.error(format!("`{}` cannot be its own consent subject", f.name), a.span);
                        } else if !m.fields.iter().any(|g| g.name == s) {
                            self.error(format!("the consent subject `{s}` is not a field of `{}`", m.name), a.span);
                        }
                    }
                    let structural = ["id", "tenant", "softDelete"];
                    let is_key = f.attrs.iter().any(|b| b.name == "id")
                        || (f.name == "id" && !m.fields.iter().any(|g| g.attrs.iter().any(|b| b.name == "id")));
                    if is_key || f.attrs.iter().any(|b| structural.contains(&b.name.as_str())) {
                        self.error(
                            format!("`{}` is the key, tenant or trash field; it cannot need consent", f.name),
                            a.span,
                        );
                    }
                    continue;
                }
                if name == "read" {
                    let Some((pred, at)) = a.arg.as_ref().filter(|(s, _)| !s.is_empty()) else {
                        self.error("`@read` on a field needs a rule: `@read(owner == actor.id)`", a.span);
                        continue;
                    };
                    let structural = ["id", "tenant", "softDelete"];
                    let is_key = f.attrs.iter().any(|b| b.name == "id")
                        || (f.name == "id" && !m.fields.iter().any(|g| g.attrs.iter().any(|b| b.name == "id")));
                    if is_key || f.attrs.iter().any(|b| structural.contains(&b.name.as_str())) {
                        self.error(
                            format!("`{}` is the key, tenant or trash field; it cannot have its own `@read`", f.name),
                            a.span,
                        );
                    }
                    self.expr(pred, *at, scope);
                    continue;
                }
                if FLAGS.contains(&name) {
                    if a.arg.is_some() {
                        self.error(format!("`@{name}` takes no argument"), a.span);
                    }
                } else if WITH_ARG.contains(&name) {
                    if a.arg.as_ref().map_or(true, |(s, _)| s.is_empty()) {
                        let what = match name {
                            "ref" => "Model",
                            "renamed" => "oldName",
                            "retain" => "30d",
                            _ => "expr",
                        };
                        self.error(
                            format!("`@{name}` needs an argument: `@{name}({what})`"),
                            a.span,
                        );
                        continue;
                    }
                } else {
                    let s = crate::html::suggest(name, FLAGS.iter().chain(&WITH_ARG).copied());
                    let hint = s.map_or(String::new(), |s| format!(" (did you mean `@{s}`?)"));
                    self.error(
                        format!(
                            "unknown field attribute `@{name}`{hint}; attributes: @id, @unique, \
                             @index, @tenant, @softDelete, @default(expr), @ref(Model), \
                             @renamed(oldName), @retain(30d), @read(rule), @consent(\"purpose\")"
                        ),
                        a.span,
                    );
                    continue;
                }
                match (name, &a.arg) {
                    ("id", _) => {
                        if let Some(prev) = key {
                            self.error(
                                format!(
                                    "model `{}` has more than one `@id` (`{prev}` and `{}`)",
                                    m.name, f.name
                                ),
                                a.span,
                            );
                        }
                        key = Some(&f.name);
                        if is_nullable(&f.ty) {
                            self.error(format!("the key `{}` cannot be nullable", f.name), a.span);
                        }
                    }
                    ("tenant", _) => {
                        if let Some(prev) = tenant {
                            self.error(
                                format!(
                                    "model `{}` has more than one `@tenant` (`{prev}` and `{}`)",
                                    m.name, f.name
                                ),
                                a.span,
                            );
                        }
                        tenant = Some(&f.name);
                        if is_nullable(&f.ty) {
                            self.error(
                                format!("the tenant field `{}` cannot be nullable", f.name),
                                a.span,
                            );
                        }
                    }
                    ("softDelete", _) => {
                        if let Some(prev) = bin {
                            self.error(
                                format!(
                                    "model `{}` has more than one `@softDelete` (`{prev}` and `{}`)",
                                    m.name, f.name
                                ),
                                a.span,
                            );
                        }
                        bin = Some(&f.name);
                        let ty: String = f.ty.chars().filter(|c| !c.is_whitespace()).collect();
                        if ty != "number|null" {
                            self.error(
                                format!(
                                    "the @softDelete field `{}` is `number | null`: when the row \
                                     was trashed, or null",
                                    f.name
                                ),
                                a.span,
                            );
                        }
                    }
                    ("default", Some((expr, at))) => {
                        self.expr(expr, *at, &HashSet::new());
                    }
                    ("ref", Some((target, at))) => self.field_ref(f, target, *at),
                    ("retain", Some((arg, at))) => {
                        let span = Span::new(*at, *at + arg.len());
                        if let Some(prev) = kept {
                            self.error(
                                format!(
                                    "model `{}` has more than one `@retain` (`{prev}` and `{}`)",
                                    m.name, f.name
                                ),
                                a.span,
                            );
                        }
                        kept = Some(&f.name);
                        let ty: String = f.ty.chars().filter(|c| !c.is_whitespace()).collect();
                        if ty != "number" && ty != "number|null" {
                            self.error(
                                format!(
                                    "the @retain field `{}` is a time in ms: `number` or \
                                     `number | null`",
                                    f.name
                                ),
                                a.span,
                            );
                        }
                        if retain_ms(arg).is_none() {
                            self.error(
                                format!(
                                    "`@retain({arg})`: a whole number and a unit, m h d w or y \
                                     (`@retain(30d)`), at least a minute"
                                ),
                                span,
                            );
                        }
                    }
                    ("renamed", Some((old, at))) => {
                        let span = Span::new(*at, *at + old.len());
                        if !crate::events::is_ident(old) {
                            self.error(
                                format!("`@renamed({old})`: the former name is a plain identifier"),
                                span,
                            );
                        } else if old == &f.name {
                            self.error(format!("`@renamed({old})` names the field itself"), span);
                        } else if m.fields.iter().any(|g| &g.name == old) {
                            self.error(
                                format!(
                                    "`@renamed({old})`: `{old}` is still a field of `{}`",
                                    m.name
                                ),
                                span,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        if key.is_none() && !m.fields.iter().any(|f| f.name == "id") {
            self.error(
                format!(
                    "model `{}` has no key: add an `id` field or mark one `@id`",
                    m.name
                ),
                m.span,
            );
        }
    }

    fn field_ref(&mut self, f: &crate::ast::Field, target: &str, at: usize) {
        let span = Span::new(at, at + target.len());
        if !crate::events::is_ident(target) {
            self.error("`@ref` names a model: `@ref(User)`", span);
            return;
        }
        if let Some(t) = self.models.get(target).copied() {
            let key = t
                .fields
                .iter()
                .find(|k| k.attrs.iter().any(|a| a.name == "id"))
                .or_else(|| t.fields.iter().find(|k| k.name == "id"));
            if let Some(k) = key {
                let want = k.ty.trim();
                let have = f.ty.trim();
                let base = have
                    .trim_end_matches("| null")
                    .trim_end_matches("| undefined")
                    .trim();
                if base != want {
                    self.error(
                        format!(
                            "`{}` references `{target}`, whose key `{}` is `{want}`, but is `{have}`",
                            f.name, k.name
                        ),
                        span,
                    );
                }
            }
        } else if !self.module.contains(target) {
            self.error(
                format!("`@ref({target})`: no model `{target}` here or imported"),
                span,
            );
        }
    }

    fn expr(&mut self, expr: &str, at: usize, scope: &HashSet<String>) {
        for (name, off) in free_idents(expr) {
            if scope.contains(&name)
                || self.module.contains(&name)
                || GLOBALS.contains(&name.as_str())
            {
                continue;
            }
            let start = at + off;
            self.error(
                format!("unknown name `{name}`"),
                Span::new(start, start + name.len()),
            );
        }
    }
}

fn script_free_sandbox(e: &Element) -> bool {
    let spread = e.attrs.iter().any(|a| a.kind == AttrKind::Spread);
    if spread || !e.name.eq_ignore_ascii_case("iframe") {
        return false;
    }
    let mut sandboxes = e
        .attrs
        .iter()
        .filter(|a| a.kind == AttrKind::Plain && a.name.eq_ignore_ascii_case("sandbox"));
    let (Some(sandbox), None) = (sandboxes.next(), sandboxes.next()) else {
        return false;
    };
    match &sandbox.value {
        None => true,
        Some(AttrValue::Str(tokens)) => !tokens
            .split_ascii_whitespace()
            .any(|t| t.eq_ignore_ascii_case("allow-scripts")),
        Some(AttrValue::Expr(_)) => false,
    }
}

fn is_optional_type(ty: &str) -> bool {
    ty.split('|').any(|part| part.trim() == "undefined")
}

pub(crate) fn free_idents(expr: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    free_idents_into(expr, 0, &HashSet::new(), &mut out);
    out
}

fn blank_regexes(expr: &str) -> String {
    let s = expr.as_bytes();
    let mut out = s.to_vec();
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            b'"' | b'\'' => {
                let q = s[i];
                i += 1;
                while i < s.len() && s[i] != q && s[i] != b'\n' {
                    i += if s[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'`' => match crate::lexer::scan_template(s, i + 1) {
                (Some(end), _) => i = end + 1,
                (None, _) => break,
            },
            b'/' if s.get(i + 1) == Some(&b'/') => {
                while i < s.len() && s[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if s.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < s.len() && !(s[i] == b'*' && s[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b'/' if regex_may_start(&s[..i]) => {
                let start = i;
                let mut class = false;
                i += 1;
                while i < s.len() && s[i] != b'\n' {
                    match s[i] {
                        b'\\' => i += 1,
                        b'[' => class = true,
                        b']' => class = false,
                        b'/' if !class => break,
                        _ => {}
                    }
                    i += 1;
                }
                i += 1;
                while i < s.len() && s[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let end = i.min(s.len());
                out[start..end].fill(b' ');
            }
            _ => i += 1,
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| expr.to_string())
}

fn regex_may_start(before: &[u8]) -> bool {
    let t = before.trim_ascii_end();
    let Some(&last) = t.last() else {
        return true;
    };
    if last.is_ascii_alphanumeric() || last == b'_' || last == b'$' {
        let word_start = t
            .iter()
            .rposition(|c| !(c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$'))
            .map_or(0, |p| p + 1);
        return matches!(
            &t[word_start..],
            b"return" | b"typeof" | b"case" | b"in" | b"of" | b"delete" | b"void" | b"throw" | b"new" | b"else"
                | b"do" | b"yield" | b"await" | b"instanceof"
        );
    }
    !matches!(last, b')' | b']' | b'}' | b'"' | b'\'' | b'`')
}

fn free_idents_into(
    expr: &str,
    base: usize,
    outer: &HashSet<String>,
    out: &mut Vec<(String, usize)>,
) {
    let blanked = blank_regexes(expr);
    let expr = blanked.as_str();
    let (toks, _diags) = tokenize(expr);
    let mut bound: HashSet<String> = arrow_params(&toks).into_iter().map(String::from).collect();
    bound.extend(outer.iter().cloned());

    for (k, tok) in toks.iter().enumerate() {
        if let TokenKind::Template(_) = &tok.kind {
            let (_, subs) = crate::lexer::scan_template(expr.as_bytes(), tok.span.start + 1);
            for r in subs {
                free_idents_into(&expr[r.clone()], base + r.start, &bound, out);
            }
            continue;
        }
        let TokenKind::Ident(name) = &tok.kind else {
            continue;
        };
        let prev = k.checked_sub(1).map(|j| &toks[j].kind);
        let next = toks.get(k + 1).map(|t| &t.kind);

        if matches!(prev, Some(TokenKind::Dot)) {
            continue;
        }
        if matches!(prev, Some(TokenKind::Ident(w)) if w == "as" || w == "satisfies") {
            continue;
        }
        if matches!(next, Some(TokenKind::Colon))
            && matches!(prev, Some(TokenKind::LBrace) | Some(TokenKind::Comma))
        {
            continue;
        }
        if OPERATOR_WORDS.contains(&name.as_str()) || bound.contains(name.as_str()) {
            continue;
        }
        out.push((name.clone(), base + tok.span.start));
    }
}

pub(crate) fn arrow_params(toks: &[Token]) -> HashSet<&str> {
    let mut bound = HashSet::new();
    for k in 1..toks.len() {
        if toks[k].kind != TokenKind::FatArrow {
            continue;
        }
        match &toks[k - 1].kind {
            TokenKind::Ident(n) => {
                bound.insert(n.as_str());
            }
            TokenKind::RParen => {
                let mut depth = 0i32;
                let mut j = k - 1;
                loop {
                    match &toks[j].kind {
                        TokenKind::RParen => depth += 1,
                        TokenKind::LParen => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        TokenKind::Ident(n) => {
                            bound.insert(n.as_str());
                        }
                        _ => {}
                    }
                    if j == 0 {
                        break;
                    }
                    j -= 1;
                }
            }
            _ => {}
        }
    }
    bound
}

fn module_names(src: &str, file: &SourceFile) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut cursor = 0;
    for it in &file.items {
        let span = it.span();
        if span.start > cursor {
            if let Some(region) = src.get(cursor..span.start) {
                declared_names(region, &mut names);
            }
        }
        cursor = cursor.max(span.end);
    }
    if let Some(region) = src.get(cursor..) {
        declared_names(region, &mut names);
    }
    names
}

fn declared_names(region: &str, out: &mut HashSet<String>) {
    let (toks, _diags) = tokenize(region);
    let mut k = 0;
    let mut depth = 0usize;
    while k < toks.len() {
        match &toks[k].kind {
            TokenKind::LBrace => depth += 1,
            TokenKind::RBrace => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            TokenKind::Keyword(Keyword::Const | Keyword::Let | Keyword::Var) => {
                k = collect_binding(&toks, k + 1, out);
                continue;
            }
            TokenKind::Keyword(
                Keyword::Function | Keyword::Class | Keyword::Interface | Keyword::Type,
            ) => {
                if let Some(TokenKind::Ident(n)) = toks.get(k + 1).map(|t| &t.kind) {
                    out.insert(n.clone());
                }
            }
            TokenKind::Ident(w) if w == "enum" || w == "namespace" => {
                if let Some(TokenKind::Ident(n)) = toks.get(k + 1).map(|t| &t.kind) {
                    out.insert(n.clone());
                }
            }
            TokenKind::Keyword(Keyword::Import) => {
                let mut j = k + 1;
                while let Some(t) = toks.get(j) {
                    match &t.kind {
                        TokenKind::Keyword(Keyword::From)
                        | TokenKind::Semicolon
                        | TokenKind::Str(_)
                        | TokenKind::Eof => break,
                        TokenKind::Ident(n) if n != "as" => {
                            out.insert(n.clone());
                        }
                        _ => {}
                    }
                    j += 1;
                }
                k = j;
                continue;
            }
            _ => {}
        }
        k += 1;
    }
}

fn collect_binding(toks: &[Token], k: usize, out: &mut HashSet<String>) -> usize {
    match toks.get(k).map(|t| &t.kind) {
        Some(TokenKind::Ident(n)) => {
            out.insert(n.clone());
            k + 1
        }
        Some(TokenKind::LBrace) | Some(TokenKind::LBracket) => {
            let mut depth = 0i32;
            let mut j = k;
            while let Some(t) = toks.get(j) {
                match &t.kind {
                    TokenKind::LBrace | TokenKind::LBracket => depth += 1,
                    TokenKind::RBrace | TokenKind::RBracket => {
                        depth -= 1;
                        if depth == 0 {
                            return j + 1;
                        }
                    }
                    TokenKind::Ident(n) => {
                        let is_key =
                            matches!(toks.get(j + 1).map(|t| &t.kind), Some(TokenKind::Colon));
                        if !is_key {
                            out.insert(n.clone());
                        }
                    }
                    TokenKind::Eof => return j,
                    _ => {}
                }
                j += 1;
            }
            j
        }
        _ => k,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::Severity;
    use crate::parser::parse;

    fn diags(src: &str) -> Vec<Diagnostic> {
        let (file, pdiags) = parse(src);
        assert!(pdiags.is_empty(), "parse diagnostics: {pdiags:?}");
        check(src, &file)
    }

    fn errors(src: &str) -> Vec<String> {
        diags(src)
            .into_iter()
            .filter(|d| d.severity == Severity::Error)
            .map(|d| d.message)
            .collect()
    }

    #[test]
    fn attribute_names_are_validated_per_element() {
        let diags = |view: &str| -> Vec<String> {
            let src = format!("component C(u: string) {{ view {{ {view} }} }}");
            let (file, pd) = crate::parser::parse(&src);
            assert!(pd.is_empty(), "{pd:?}");
            check(&src, &file).into_iter().map(|d| d.message).collect()
        };
        let clean = diags(concat!(
            "<a href=\"/\" class=\"x\" data-id=\"1\" aria-label=\"home\" role=\"link\">h</a>",
            "<input type=\"text\" :value={u} placeholder=\"p\" />",
            "<svg viewBox=\"0 0 1 1\"><circle cx=\"1\" stroke-width=\"2\" /></svg>",
            "<my-widget anything=\"x\"></my-widget>",
            "<button type=\"button\" @click={u}>b</button>",
        ));
        assert!(
            clean
                .iter()
                .all(|m| !m.contains("attribute") && !m.contains("role")),
            "{clean:?}"
        );

        let typo = diags("<a hreff=\"/\">x</a>");
        assert!(
            typo.iter()
                .any(|m| m == "<a> has no attribute `hreff` (did you mean `href`?)"),
            "{typo:?}"
        );
        let wrong_el = diags("<div href=\"/\"></div>");
        assert!(
            wrong_el
                .iter()
                .any(|m| m.starts_with("<div> has no attribute `href`")),
            "{wrong_el:?}"
        );
        let aria = diags("<div aria-lable=\"x\"></div>");
        assert!(
            aria.iter().any(|m| m.contains("did you mean `aria-label`")),
            "{aria:?}"
        );
        let role = diags("<div role=\"buton\"></div>");
        assert!(
            role.iter()
                .any(|m| m.contains("`buton` is not a WAI-ARIA role (did you mean `button`?)")),
            "{role:?}"
        );
        let reserved = diags("<li data-weft-key=\"1\"></li>");
        assert!(
            reserved.iter().any(|m| m.contains("data-weft-*")),
            "{reserved:?}"
        );
        let bound = diags("<a :hreff={u}>x</a>");
        assert!(
            bound.iter().any(|m| m.contains("`hreff`")),
            "bound attributes are checked too: {bound:?}"
        );

        let inline = errors("component C() { view { <button onclick=\"go()\">x</button> } }");
        assert!(
            inline.iter().any(|m| m.contains("use `@click={handler}`")),
            "{inline:?}"
        );
    }

    #[test]
    fn template_substitutions_are_checked() {
        let ok = errors("component C(a: string) { view { {`${a} ${[1].map((i) => `${i}`)}`} } }");
        assert!(ok.is_empty(), "{ok:?}");
        let bad = errors("component C(a: string) { view { {`${a} and ${nope}`} } }");
        assert!(bad.iter().any(|e| e.contains("`nope`")), "{bad:?}");
        let found = free_idents("`x ${y}`");
        assert_eq!(found, vec![("y".to_string(), 5)]);
    }

    #[test]
    fn script_and_style_in_views_warn_about_the_csp() {
        let src = "component C() { view { <style>p { color: red }</style><p /> } }";
        let (file, diags) = crate::parser::parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        let warnings = check(src, &file);
        assert!(
            warnings
                .iter()
                .any(|d| d.message.contains("Content-Security-Policy")),
            "{warnings:?}"
        );
    }

    #[test]
    fn named_slots_are_checked_against_props() {
        let card =
            "component Card(header: Html, children?: Html) { view { {header}{children} } }\n";
        let ok = errors(&format!(
            "{card}component P() {{ view {{ <Card><template slot=\"header\">h</template></Card> }} }}"
        ));
        assert!(ok.is_empty(), "{ok:?}");
        let missing = errors(&format!(
            "{card}component P() {{ view {{ <Card>body</Card> }} }}"
        ));
        assert!(
            missing
                .iter()
                .any(|e| e.contains("missing required prop `header`")),
            "{missing:?}"
        );
        let unknown = errors(&format!(
            "{card}component P() {{ view {{ <Card><b slot=\"header\">h</b><i slot=\"side\">s</i></Card> }} }}"
        ));
        assert!(
            unknown.iter().any(|e| e.contains("has no slot `side`")),
            "{unknown:?}"
        );
        let dynamic = errors(&format!(
            "{card}component P(s: string) {{ view {{ <Card><b slot={{s}}>h</b></Card> }} }}"
        ));
        assert!(
            dynamic.iter().any(|e| e.contains("plain string")),
            "{dynamic:?}"
        );
        let reserved = errors(&format!(
            "{card}component P() {{ view {{ <Card><b slot=\"header\">h</b><b slot=\"children\">c</b></Card> }} }}"
        ));
        assert!(
            reserved.iter().any(|e| e.contains("not a valid slot name")),
            "{reserved:?}"
        );
    }

    #[test]
    fn await_block_scopes_and_warns_on_calls() {
        let ok = errors("component C(p: Promise<string>) { view { {#await p}..{:then v}{v}{:catch e}{String(e)}{/await} } }");
        assert!(ok.is_empty(), "{ok:?}");
        let leak =
            errors("component C(p: Promise<string>) { view { {#await p}{v}{:then v}{/await} } }");
        assert!(
            leak.iter().any(|e| e.contains("`v`")),
            "the binding is not in scope while pending: {leak:?}"
        );

        let (file, diags) =
            crate::parser::parse("component C() { view { {#await fetch(\"/x\")}..{/await} } }");
        assert!(diags.is_empty());
        let warnings = check(
            "component C() { view { {#await fetch(\"/x\")}..{/await} } }",
            &file,
        );
        assert!(
            warnings
                .iter()
                .any(|d| d.message.contains("new promise on every render")),
            "{warnings:?}"
        );

        for bad in [
            "{#await}x{/await}",
            "{#await p}{:catch e}{:then v}{/await}",
            "{#await p}{:then a b}{/await}",
            "{#await p}{:else}{/await}",
        ] {
            let src = format!("component C(p: Promise<number>) {{ view {{ {bad} }} }}");
            let (_, diags) = crate::parser::parse(&src);
            assert!(!diags.is_empty(), "{bad} should not parse");
        }
    }

    #[test]
    fn keyed_each_checks_key_and_body() {
        let ok = errors("component C(xs: { id: number }[]) { view { {#each xs as x (x.id)}<p>{x.id}</p>{/each} } }");
        assert!(ok.is_empty(), "{ok:?}");
        let bad_key =
            errors("component C(xs: number[]) { view { {#each xs as x (y.id)}<p />{/each} } }");
        assert!(bad_key.iter().any(|e| e.contains("`y`")), "{bad_key:?}");
        let text = errors("component C(xs: number[]) { view { {#each xs as x (x)}text{/each} } }");
        assert!(
            text.iter().any(|e| e.contains("keyed `{#each}`")),
            "{text:?}"
        );
        let (_, diags) = crate::parser::parse(
            "component C(xs: number[]) { view { {#each xs as x ()}<p />{/each} } }",
        );
        assert!(
            diags.iter().any(|d| d.message.contains("parenthesised")),
            "{diags:?}"
        );
    }

    #[test]
    fn unknown_name_is_reported_at_its_span() {
        let src = "component G(name: string) { view { <h1>Hello, {nmae}</h1> } }";
        let ds = diags(src);
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(ds[0].message, "unknown name `nmae`");
        assert_eq!(&src[ds[0].span.start..ds[0].span.end], "nmae");
    }

    #[test]
    fn params_signals_and_functions_are_in_scope() {
        let src = "component C(step: number) {\n  signal count = 0\n  derived next = count + step\n  function bump() { count = next }\n  view { <button @click={bump}>{count}</button> }\n}";
        assert!(diags(src).is_empty(), "{:?}", diags(src));
    }

    #[test]
    fn event_handler_must_be_a_local_function() {
        let src = "component C(cb: () => void) {\n  function ok(n: number) { }\n  view { <i @click={ok}/><i @click={ok(1)}/><i @click={cb}/><i @click={() => ok(2)}/><i @click/> }\n}";
        assert_eq!(
            errors(src),
            vec![
                "`cb` is not a function declared in this component",
                "`@click` must name a component function, optionally called: `{name}` or `{name(args)}`",
                "`@click` needs a handler: `@click={name}`",
            ]
        );
    }

    #[test]
    fn props_is_a_reserved_param_name() {
        let src = "component C(props: string) { view { <p>{props}</p> } }";
        assert_eq!(
            errors(src),
            vec!["`props` is reserved in components; it names the props object"]
        );
    }

    #[test]
    fn unknown_name_in_derived_initializer() {
        let src =
            "component C() {\n  signal a = 1\n  derived b = a + missing\n  view { <p>{b}</p> }\n}";
        assert_eq!(errors(src), vec!["unknown name `missing`"]);
    }

    #[test]
    fn properties_keys_arrows_and_globals_are_not_free() {
        let src = "component C(items: Item[]) { view { <p>{items.map((it) => fmt({ label: it.name })).join(Math.max(1, 2) > 0 ? \",\" : \"\")}</p> } }\nimport { fmt } from \"./fmt\";";
        assert!(errors(src).is_empty(), "{:?}", errors(src));
    }

    #[test]
    fn module_declarations_are_in_scope() {
        let src = "const TITLE = \"x\";\nconst { a, b: renamed } = obj;\nfunction helper() {}\ncomponent C() { view { <p>{TITLE}{a}{renamed}{helper()}</p> } }";
        assert!(errors(src).is_empty(), "{:?}", errors(src));
        let bad = "const { a, b: renamed } = obj;\ncomponent C() { view { <p>{b}</p> } }";
        assert_eq!(errors(bad), vec!["unknown name `b`"]);
    }

    #[test]
    fn each_bindings_are_scoped_to_the_body() {
        let src = "component C(xs: string[]) { view { {#each xs as x, i}<li>{i}{x}</li>{/each}<p>{x}</p> } }";
        assert_eq!(errors(src), vec!["unknown name `x`"]);
    }

    #[test]
    fn if_conditions_are_checked_per_arm() {
        let src = "component C(n: number) { view { {#if n > 0}a{:else if m < 0}b{/if} } }";
        let ds = diags(src);
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(&src[ds[0].span.start..ds[0].span.end], "m");
    }

    #[test]
    fn attribute_and_directive_expressions_are_checked() {
        let src = "component C() {
  function go(n: number) { }
  view { <a href={url} @click={go(missing)}>x</a> }
}";
        assert_eq!(
            errors(src),
            vec!["unknown name `url`", "unknown name `missing`"]
        );
    }

    #[test]
    fn unknown_component_is_an_error_but_imported_is_not() {
        assert_eq!(
            errors("component C() { view { <Missing /> } }"),
            vec!["unknown component <Missing>"]
        );
        let src =
            "import { Icon } from \"./icon\";\ncomponent C() { view { <Icon name=\"x\" /> } }";
        assert!(errors(src).is_empty(), "{:?}", errors(src));
    }

    #[test]
    fn regex_literals_are_not_names() {
        let names = |e: &str| free_idents(e).into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert_eq!(names("s.replace(/(.{4})/g, \"$1 \")"), vec!["s"]);
        assert_eq!(names("x.split(/[\\s,/]+/u).map((p) => p + flag)"), vec!["x", "flag"]);
        assert_eq!(names("a / b / gi"), vec!["a", "b", "gi"]);
        assert_eq!(names("(n) / total"), vec!["n", "total"]);
        assert_eq!(names("ok ? /y/i.test(v) : w"), vec!["ok", "v", "w"]);
        assert_eq!(names("`${t.replace(/z/g, \"\")}` + q"), vec!["t", "q"]);
    }

    #[test]
    fn events_on_components_are_checked_and_need_rest_attrs() {
        let open = "component Sel(...attrs: Attrs) { view { <select {...attrs}></select> } }\n";
        let ok = format!("{open}component P() {{\n  function pick() {{ }}\n  view {{ <Sel @change={{pick}} /> }}\n}}");
        assert!(diags(&ok).is_empty(), "{:?}", diags(&ok));
        let bad = format!("{open}component P() {{ view {{ <Sel @change={{nope}} /> }} }}");
        assert_eq!(errors(&bad), vec!["`nope` is not a function declared in this component"]);
        let closed = "component Sel(name: string) { view { <select name={name} aria-label=\"x\"></select> } }\ncomponent P() {\n  function pick() { }\n  view { <Sel name=\"a\" @change={pick} /> }\n}";
        let warned: Vec<String> = diags(closed).into_iter().map(|d| d.message).collect();
        assert_eq!(warned, vec!["<Sel> takes no `...attrs`, so `@change` reaches no element and is ignored"]);
    }

    #[test]
    fn props_are_checked_against_a_local_component() {
        let lib = "component Badge(label: string, tone: string | undefined) { view { <span>{label}</span> } }\n";
        let ok = format!("{lib}component P() {{ view {{ <Badge label=\"a\" /> }} }}");
        assert!(errors(&ok).is_empty(), "{:?}", errors(&ok));

        let missing = format!("{lib}component P() {{ view {{ <Badge /> }} }}");
        assert_eq!(
            errors(&missing),
            vec!["<Badge> is missing required prop `label`"]
        );

        let extra = format!("{lib}component P() {{ view {{ <Badge label=\"a\" size=\"s\" /> }} }}");
        assert_eq!(errors(&extra), vec!["<Badge> has no prop `size`"]);

        let kids = format!("{lib}component P() {{ view {{ <Badge label=\"a\">hi</Badge> }} }}");
        assert_eq!(
            errors(&kids),
            vec!["<Badge> does not accept children (declare a `children: Html` prop)"]
        );
    }

    #[test]
    fn children_prop_is_satisfied_by_element_children() {
        let src = "component Card(children: Html) { view { <div>{children}</div> } }\ncomponent P() { view { <Card><p>x</p></Card> } }";
        assert!(errors(src).is_empty(), "{:?}", errors(src));
    }

    #[test]
    fn unknown_html_element_is_a_warning_custom_element_is_fine() {
        let ds = diags("component C() { view { <dvi>x</dvi><my-widget /> } }");
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(ds[0].severity, Severity::Warning);
        assert_eq!(ds[0].message, "unknown HTML element <dvi>");
    }

    #[test]
    fn model_predicates_resolve_fields_and_actor() {
        let ok = "model Doc {\n  id: string\n  owner: User\n  @read(actor.id == owner.id)\n}";
        assert!(errors(ok).is_empty(), "{:?}", errors(ok));
        let bad = "model Doc {\n  id: string\n  owner: User\n  @read(actor.id == ownr.id)\n}";
        assert_eq!(errors(bad), vec!["unknown name `ownr`"]);
    }

    #[test]
    fn predicates_outside_the_sql_subset_warn() {
        let pushable = "model Doc {\n  id: string\n  owner: User\n  @read(actor.id == owner.id)\n}";
        assert!(diags(pushable).is_empty());
        let app_only =
            "model Doc {\n  id: string\n  tags: string[]\n  @read(tags.includes(actor.tag))\n}";
        let d = diags(app_only);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].severity, crate::diagnostics::Severity::Warning);
        assert!(d[0]
            .message
            .starts_with("`@read` cannot be compiled to a database filter"));
    }

    #[test]
    fn field_attributes_are_checked() {
        let ok = "model User {\n  handle: string @id\n  email: string @unique\n  joined: number @default(Date.now())\n}\nmodel Post {\n  id: string @default(crypto.randomUUID())\n  author: string @ref(User) @index\n}";
        assert!(errors(ok).is_empty(), "{:?}", errors(ok));
        let one = |fields: &str| {
            let src = format!("model U {{\n  id: string\n{fields}\n}}");
            errors(&src).into_iter().next().unwrap_or_default()
        };
        assert!(one("  a: string @uniqe")
            .starts_with("unknown field attribute `@uniqe` (did you mean `@unique`?)"));
        assert_eq!(one("  a: string @unique(x)"), "`@unique` takes no argument");
        assert_eq!(
            one("  a: string @default"),
            "`@default` needs an argument: `@default(expr)`"
        );
        assert_eq!(
            one("  a: string @index @index"),
            "`@index` is repeated on `a`"
        );
        assert_eq!(
            one("  a: string @write(true)"),
            "`@write` is a model rule; put it on its own line (a field has `@read`)"
        );
        assert_eq!(one("  a: string @read(a == actor.id)"), "");
        assert_eq!(one("  a: string @read(nope == actor.id)"), "unknown name `nope`");
        assert_eq!(
            one("  a: string @read"),
            "`@read` on a field needs a rule: `@read(owner == actor.id)`"
        );
        assert_eq!(
            one("  a: string @tenant @read(true)"),
            "`a` is the key, tenant or trash field; it cannot have its own `@read`"
        );
        assert_eq!(one("  a: number @default(actor.n)"), "unknown name `actor`");
        assert_eq!(
            one("  a: string @default(id)"),
            "unknown name `id`",
            "defaults cannot read fields"
        );
        assert_eq!(
            one("  a: string @ref(Nope)"),
            "`@ref(Nope)`: no model `Nope` here or imported"
        );
        assert!(one("  a: string @renamed(b)").is_empty());
        assert!(one("  org: string @tenant @index").is_empty());
        assert_eq!(
            one("  org: string | null @tenant"),
            "the tenant field `org` cannot be nullable"
        );
        assert_eq!(
            one("  a: string @tenant\n  b: string @tenant"),
            "model `U` has more than one `@tenant` (`a` and `b`)"
        );
        assert!(one("  deletedAt: number | null @softDelete @index").is_empty());
        assert_eq!(
            one("  deletedAt: number @softDelete"),
            "the @softDelete field `deletedAt` is `number | null`: when the row was trashed, or null"
        );
        assert_eq!(
            one("  a: number | null @softDelete\n  b: number | null @softDelete"),
            "model `U` has more than one `@softDelete` (`a` and `b`)"
        );
        assert!(one("  createdAt: number @retain(30d) @index").is_empty());
        assert!(one("  closedAt: number | null @retain(1y)").is_empty());
        assert_eq!(
            one("  at: string @retain(30d)"),
            "the @retain field `at` is a time in ms: `number` or `number | null`"
        );
        assert_eq!(
            one("  a: number @retain(1d)\n  b: number @retain(2d)"),
            "model `U` has more than one `@retain` (`a` and `b`)"
        );
        for bad in ["30", "d", "30s", "1.5d", "-1d", "0m", "30 d", "9999999999y"] {
            assert_eq!(
                one(&format!("  at: number @retain({bad})")),
                format!(
                    "`@retain({bad})`: a whole number and a unit, m h d w or y (`@retain(30d)`), \
                     at least a minute"
                )
            );
        }
        assert_eq!(one("  at: number @retain"), "`@retain` needs an argument: `@retain(30d)`");
        assert_eq!(retain_ms("30d"), Some(30 * 86_400_000));
        assert_eq!(retain_ms("1m"), Some(60_000));
        assert_eq!(retain_ms("2w"), Some(14 * 86_400_000));
        assert_eq!(retain_ms("1y"), Some(365 * 86_400_000));
        assert_eq!(retain_ms("1h"), Some(3_600_000));
        assert_eq!(
            one("  gone: number | null @softdelete"),
            "unknown field attribute `@softdelete` (did you mean `@softDelete`?); attributes: @id, @unique, \
             @index, @tenant, @softDelete, @default(expr), @ref(Model), @renamed(oldName), \
             @retain(30d), @read(rule), @consent(\"purpose\")"
        );
        assert_eq!(one("  a: string @consent(\"analytics\")"), "");
        assert_eq!(one("  a: string @consent(\"loc-share\", id)"), "");
        let bad = "`@consent` names a purpose, and optionally the field holding whose consent it is: \
                   `@consent(\"analytics\")`, `@consent(\"location\", owner)`";
        for arg in ["", "(analytics)", "(\"Analytics\")", "(\"a b\")", "(\"a\", 1x)", "(\"a\" id)", "(\"a-\")"] {
            assert_eq!(one(&format!("  a: string @consent{arg}")), bad, "{arg}");
        }
        assert_eq!(one("  a: string @consent(\"p\", nope)"), "the consent subject `nope` is not a field of `U`");
        assert_eq!(one("  a: string @consent(\"p\", a)"), "`a` cannot be its own consent subject");
        assert_eq!(
            one("  a: string @tenant @consent(\"p\")"),
            "`a` is the key, tenant or trash field; it cannot need consent"
        );
        assert_eq!(
            one("  a: string @renamed(a)"),
            "`@renamed(a)` names the field itself"
        );
        assert_eq!(
            one("  a: string @renamed(id)"),
            "`@renamed(id)`: `id` is still a field of `U`"
        );
        assert_eq!(
            one("  a: string @renamed(x.y)"),
            "`@renamed(x.y)`: the former name is a plain identifier"
        );
        assert_eq!(
            errors("model K {\n  a: string @id\n  b: string @id\n}"),
            vec!["model `K` has more than one `@id` (`a` and `b`)"]
        );
        assert_eq!(
            errors("model K {\n  a: string | null @id\n}"),
            vec!["the key `a` cannot be nullable"]
        );
        assert_eq!(
            errors("model K {\n  a: string\n}"),
            vec!["model `K` has no key: add an `id` field or mark one `@id`"]
        );
        let mismatch =
            "model A {\n  id: number\n}\nmodel B {\n  id: string\n  a: string @ref(A)\n}";
        assert_eq!(
            errors(mismatch),
            vec!["`a` references `A`, whose key `id` is `number`, but is `string`"]
        );
        let nullable_ref =
            "model A {\n  id: string\n}\nmodel B {\n  id: string\n  a: string | null @ref(A)\n}";
        assert!(errors(nullable_ref).is_empty(), "an optional reference");
    }

    #[test]
    fn model_duplicates_are_reported() {
        let src =
            "model Doc {\n  id: string\n  a: string\n  a: number\n  @read(true)\n  @read(false)\n}";
        assert_eq!(
            errors(src),
            vec![
                "field `a` is declared more than once in model `Doc`",
                "model `Doc` has more than one `@read`; combine them with `&&` or `||`",
            ]
        );
    }

    #[test]
    fn model_residency_is_checked() {
        assert!(errors("model Doc {\n  id: string\n  @residency(\"us-east\")\n}").is_empty());
        assert!(errors("model Doc {\n  id: string\n  t: string\n  @residency(t == \"a\" ? \"eu\" : null)\n}").is_empty());
        assert_eq!(
            errors("model Doc {\n  id: string\n  @residency(\"EU West\")\n  @residency(\"eu\")\n}"),
            vec![
                "`@residency(\"EU West\")`: a region is lowercase letters, digits and `-` (`eu`, `us-east`)",
                "model `Doc` has more than one `@residency`",
            ]
        );
        assert_eq!(
            errors("model Doc {\n  id: string\n  @residency(actor.region)\n}"),
            vec!["`@residency` depends on the row only, not on `actor`"]
        );
    }

    #[test]
    fn duplicate_declarations_are_reported() {
        let src = "component C(x: number) {\n  signal x = 1\n  view { <p>{x}</p> }\n}";
        assert_eq!(
            errors(src),
            vec!["`x` is declared more than once in component `C`"]
        );
        let items = "component A() { view { <p/> } }\ncomponent A() { view { <p/> } }";
        assert_eq!(errors(items), vec!["`A` is defined more than once"]);
    }

    #[test]
    fn event_directives_are_validated() {
        let ok = "component C() {\n  function f() { }\n  view { <input @keydown.enter.prevent={f} @input.debounce(300)={f}/><button :busy @click.confirm('Go?')={f}>go</button><div @every(10s)={f}></div> }\n}";
        assert!(errors(ok).is_empty(), "{:?}", errors(ok));
        let bad = "component C() {\n  function f() { }\n  view { <i @clik={f}/><i @click.debouce={f}/><i @keydown.enter={f} @keydown.esc={f}/><b :busy={1}/><b :title/> }\n}";
        let ds = diags(bad);
        let errs: Vec<&str> = ds
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .map(|d| d.message.as_str())
            .collect();
        assert_eq!(errs.len(), 5, "{errs:?}");
        assert!(
            errs[0].starts_with("`@clik` is not an event Weft delivers (did you mean `@click`?)")
        );
        assert_eq!(
            errs[1],
            "unknown event modifier `.debouce` (did you mean `.debounce`?)"
        );
        assert!(errs[2].starts_with("<i> already has an `@keydown` directive"));
        assert!(errs[3].starts_with("`:busy` takes no value"));
        assert_eq!(errs[4], "`:title` needs a value: `:title={expr}`");
        let d = ds.iter().find(|d| d.message.contains("debouce")).unwrap();
        assert_eq!(&bad[d.span.start..d.span.end], "debouce");
        let poll =
            "component C() {\n  function f() { }\n  view { <div @every(250ms)={f}></div> }\n}";
        let w = diags(poll);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].severity, Severity::Warning);
    }

    #[test]
    fn the_client_server_boundary_is_checked() {
        let ok = "component C(title: string) {\n  client signal open = false\n  client function toggle() { open = !open }\n  client function mark() { open = true }\n  function save() { }\n  view { <h2>{title}</h2><button @click={toggle} :aria-expanded={open}>{open ? \"Hide\" : \"Show\"}</button><button @click.optimistic(mark)={save}>s</button> }\n}";
        assert!(errors(ok).is_empty(), "{:?}", errors(ok));

        let first = |src: &str| errors(src).into_iter().next().unwrap_or_default();
        let wrap = |members: &str, view: &str| {
            format!("component C(title: string) {{\n  client signal open = false\n  signal n = 0\n{members}\n  view {{ {view} }}\n}}")
        };
        assert!(first(&wrap(
            "  client function f() { n = n + 1 }",
            "<i @click={f}/>"
        ))
        .starts_with("`n` is not available in the browser"));
        assert!(first(&wrap("  client signal t = title", "<i/>"))
            .starts_with("`title` is not available in the browser"));
        assert!(
            first(&wrap("  function f() { open = false }", "<i @click={f}/>"))
                .starts_with("`open` lives in the browser")
        );
        assert!(first(&wrap("  onMount(() => { open = true })", "<i/>"))
            .starts_with("`open` lives in the browser"));
        assert!(first(&wrap("  client onMount(() => { n = 1 })", "<i/>"))
            .starts_with("`n` is not available in the browser"));
        assert!(errors(&wrap(
            "  onMount(() => { n = 1 })\n  client onDestroy(() => { open = false })",
            "<i/>"
        ))
        .is_empty());
        assert!(first(&wrap("", "{#if open}<p/>{/if}"))
            .starts_with("`{#if}` is evaluated on the server and cannot read client `open`"));
        assert!(first(&wrap("", "<p>{open ? title : \"\"}</p>"))
            .contains("where `title` does not exist"));
        assert_eq!(
            first(&wrap("  function s() { }", "<i @click.optimistic(s)={s}/>")),
            "`.optimistic(s)` needs a `client function s` in this component"
        );
        assert!(first(&wrap(
            "  client function f() { open = true }",
            "<i @click.optimistic(f)={f}/>"
        ))
        .contains("already runs in the browser"));
    }

    #[test]
    fn one_actor_per_file() {
        let errs = errors("interface U { id: string }\nactor U\nactor { id: string }\n");
        assert!(
            errs.iter()
                .any(|e| e.contains("`actor` is defined more than once")),
            "{errs:?}"
        );
        assert!(errors("interface U { id: string }\nactor U\n").is_empty());
    }

    #[test]
    fn actions_take_file_uploads_but_jobs_and_held_values_do_not() {
        let ok = errors("action up(doc: File, more: File[], logo?: File) {}\n");
        assert!(ok.is_empty(), "{ok:?}");
        let errs = errors("job j(doc: File) {}\n");
        assert!(
            errs.iter()
                .any(|e| e.contains("cannot be a file; store the upload")),
            "{errs:?}"
        );
        let errs = errors("action a(f: Held<File>) {}\n");
        assert!(
            errs.iter()
                .any(|e| e.contains("cannot be a file; held values")),
            "{errs:?}"
        );
    }

    #[test]
    fn job_parameters_must_be_decodable() {
        let errs = errors("interface U { id: string }\njob j(ctx: string, u: U) {}\n");
        assert!(errs.iter().any(|e| e.starts_with("`ctx` is reserved in jobs")), "{errs:?}");
        assert!(
            errs.iter()
                .any(|e| e.starts_with("job parameter `u: U` cannot be decoded from stored JSON")),
            "{errs:?}"
        );
    }

    #[test]
    fn held_parameters_come_first_and_only_in_actions() {
        assert!(errors("action a(id: Held<string>, n: number) {}\n").is_empty());
        let errs = errors("action a(n: number, id: Held<string>) {}\n");
        assert!(errs.iter().any(|e| e.contains("held parameters come first")), "{errs:?}");
        let errs = errors("action a(id?: Held<string>) {}\n");
        assert!(errs.iter().any(|e| e.contains("never optional")), "{errs:?}");
        let errs = errors("action a(id: Held<Held<string>>) {}\n");
        assert!(errs.iter().any(|e| e.contains("cannot be decoded")), "{errs:?}");
        let errs = errors("job a(id: Held<string>) {}\n");
        assert!(errs.iter().any(|e| e.contains("jobs take no held parameters")), "{errs:?}");
    }

    #[test]
    fn action_parameters_must_be_decodable() {
        let errs = errors(
            "interface U { id: string }\naction a(ctx: string, u: U, when: Date, _weft_x: string, ok: number[]) {}\n",
        );
        assert!(
            errs.iter()
                .any(|e| e.starts_with("`ctx` is reserved in actions")),
            "{errs:?}"
        );
        assert!(
            errs.iter()
                .any(|e| e.starts_with("action parameter `u: U` cannot be decoded")),
            "{errs:?}"
        );
        assert!(
            errs.iter()
                .any(|e| e.starts_with("action parameter `when: Date`")),
            "{errs:?}"
        );
        assert!(
            errs.iter()
                .any(|e| e.contains("`_weft_x`: names starting `_weft` are reserved")),
            "{errs:?}"
        );
        assert_eq!(errs.len(), 4, "{errs:?}");
        assert!(errors("action a(x: string) {}\naction a(y: number) {}\n")
            .iter()
            .any(|e| e == "`a` is defined more than once"));
    }

    #[test]
    fn island_code_may_call_same_file_actions_only() {
        let src = "import { other } from \"./x.ts\"\naction save(n: number) {}\ncomponent C() {\n  client signal n = 0\n  client function go() { save(n); other() }\n  view { <button @click={go}>{n}</button> }\n}\n";
        let errs = errors(src);
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert!(
            errs[0].starts_with("`other` is not available in the browser"),
            "{errs:?}"
        );
    }

    #[test]
    fn client_declarations_use_only_browser_names() {
        let errs = errors("import { db } from \"./db.ts\"\naction save() {}\nserver const k = 1\nclient const A = 2\nclient function f() { return db.x + k + A }\nclient function g() { save() }\n");
        let names: Vec<&str> = errs
            .iter()
            .map(|e| e.split('`').nth(1).unwrap_or(""))
            .collect();
        assert_eq!(names, ["db", "k", "save"], "{errs:?}");
        assert!(
            errors("component C() {\n  server signal x = 1\n  view { <p>{x}</p> }\n}\n").is_empty()
        );
    }

    #[test]
    fn locals_of_module_functions_are_not_module_names() {
        let src = "export function fill(v: number) { const pct = v * 100; return pct }\n\
                   client function grow(el: HTMLElement) { const pct = 5; el.style.width = `${pct}%` }\n\
                   component C() { view { <p use:grow>{fill(1)}</p> } }\n";
        assert!(errors(src).is_empty(), "{:?}", errors(src));
    }

    #[test]
    fn client_const_may_span_lines() {
        let src = "client const tip =\n  \"a b\" +\n  \" c\"\nclient function f() { return tip }\n\
                   component C() { client function g() { f() }\n view { <button @click={g}>x</button> } }\n";
        assert!(errors(src).is_empty(), "{:?}", errors(src));
    }

    #[test]
    fn stores_are_server_names() {
        assert!(errors(
            "store app hits = 0\ncomponent C() {\n  function bump() { hits.value = hits.value + 1 }\n  view { <button type=\"button\" @click={bump}>{hits.value}</button> }\n}\n"
        )
        .is_empty());
        let errs = errors(
            "store session cart: string[] = []\ncomponent C() {\n  client function f() { return cart.value.length }\n  view { <p>{f()}</p> }\n}\n",
        );
        assert!(errs.iter().any(|e| e.contains("`cart`")), "{errs:?}");
        let dup = errors("store app x = 1\nstore session x = 2\n");
        assert!(
            dup.iter().any(|e| e.contains("defined more than once")),
            "{dup:?}"
        );
    }

    #[test]
    fn uses_bounds_the_inferred_capabilities() {
        let src = concat!(
            "import { readFile } from \"node:fs/promises\"\n",
            "function load(u: string) { return fetch(u) }\n",
            "model Note { id: string\n  @read(true)\n  @write(true)\n}\n",
            "component Feed() uses db {\n",
            "  signal n = Note\n",
            "  function go() { load(\"/x\") }\n",
            "  view { <button type=\"button\" @click={go}>x</button> }\n}\n",
            "action read(p: string) uses db { return readFile(p) }\n",
            "action who() uses none { return ctx.session }\n",
            "action ok() uses auth, fs { await readFile(\"/a\"); return ctx.session }\n",
        );
        let errs = errors(src);
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(
            errs[0]
                .contains("`Feed` is declared `uses db` but `load` uses `net` (through `fetch`)"),
            "{errs:?}"
        );
        assert!(
            errs[1].contains("`read` is declared `uses db` but `readFile` uses `fs`"),
            "{errs:?}"
        );
        assert!(
            errs[2].contains("`who` is declared `uses none` but `ctx.session` uses `auth`"),
            "{errs:?}"
        );
        let d = diags(src);
        let at = d
            .iter()
            .find(|d| d.message.contains("`load`"))
            .unwrap()
            .span
            .start;
        assert_eq!(&src[at..at + 4], "load");
    }

    #[test]
    fn uses_clauses_are_validated_and_actions_are_entry_points() {
        let errs = errors("component A() uses disk { view { <p /> } }\n");
        assert!(errs[0].contains("unknown capability `disk`"), "{errs:?}");
        let errs = errors("component A() uses none, db { view { <p /> } }\n");
        assert!(
            errs[0].contains("`uses none` cannot be combined"),
            "{errs:?}"
        );
        assert!(errors(concat!(
            "action ping() uses net { await fetch(\"/x\") }\n",
            "component A() uses none {\n  view { <form action={ping}><button>Go</button></form> }\n}\n",
        ))
        .is_empty());
    }

    #[test]
    fn style_blocks_are_checked() {
        assert!(errors(
            "component A(c: string) {\n  view { <p /> }\n  style { p { color: {c} } }\n}\n"
        )
        .is_empty());
        let errs = errors("component A() {\n  view { <p /> }\n  style { p { color: {nope} } @import \"x.css\"; }\n}\n");
        assert!(
            errs.iter().any(|e| e.contains("unknown name `nope`")),
            "{errs:?}"
        );
        assert!(
            errs.iter()
                .any(|e| e.contains("`@import` is not supported")),
            "{errs:?}"
        );
        let errs = errors("component A() {\n  client signal c = \"red\"\n  view { <p /> }\n  style { p { color: {c} } }\n}\n");
        assert!(
            errs.iter()
                .any(|e| e.contains("a style value is evaluated on the server")),
            "{errs:?}"
        );
    }

    #[test]
    fn shared_fields_are_checked() {
        let ok = concat!(
            "component A(n: { body: string, title: string }) {\n  view { <div>",
            "<textarea :bind.shared={n.body} aria-label=\"b\"></textarea>",
            "<input type=\"text\" :bind.shared={n.title} aria-label=\"t\" />",
            "</div> }\n}\n"
        );
        assert!(errors(ok).is_empty(), "{:?}", errors(ok));
        let bad = |view: &str| errors(&format!("component A(n: {{ body: string }}) {{\n  view {{ {view} }}\n}}\n"));
        let errs = bad("<div :bind.shared={n.body}>x</div>");
        assert!(errs.iter().any(|e| e.contains("goes on a `<textarea>`")), "{errs:?}");
        let errs = bad("<input type=\"checkbox\" :bind.shared={n.body} aria-label=\"x\" />");
        assert!(errs.iter().any(|e| e.contains("goes on a `<textarea>`")), "{errs:?}");
        let errs = bad("<textarea :bind.shared={n.body} aria-label=\"x\">hi</textarea>");
        assert!(errs.iter().any(|e| e.contains("a shared `<textarea>` is empty")), "{errs:?}");
        let errs = bad("<input :bind.shared={n.body} value=\"x\" aria-label=\"x\" />");
        assert!(errs.iter().any(|e| e.contains("no `value` of its own")), "{errs:?}");
        let errs = bad("<textarea :bind.shared={n} aria-label=\"x\"></textarea>");
        assert!(errs.iter().any(|e| e.contains("takes a row's field")), "{errs:?}");
        assert_eq!(shared_target("a?.b"), Some(("a".into(), "b".into())));
        assert_eq!(shared_target("x.y.z"), Some(("x.y".into(), "z".into())));
        assert_eq!(shared_target("x."), None);
    }

    #[test]
    fn rest_props_and_spreads_are_checked() {
        let ok = concat!(
            "component B(variant?: string, ...attrs: Attrs) {\n  view { <button {...attrs}>x</button> }\n}\n",
            "component A(o: Record<string, string>) {\n",
            "  view { <div><B id=\"x\" aria-label=\"y\" variant=\"v\" /><B {...o} /></div> }\n}\n",
        );
        assert!(errors(ok).is_empty(), "{:?}", errors(ok));
        let errs = errors("component A() {\n  client signal c = {}\n  view { <p {...c} /> }\n}\n");
        assert!(errs.iter().any(|e| e.contains("{...spread}")), "{errs:?}");
        let errs = errors("action go(...xs: string[]) { }\n");
        assert!(
            errs.iter()
                .any(|e| e.contains("rest parameters are for components")),
            "{errs:?}"
        );
        let errs =
            errors("component A(h: string) {\n  view { <iframe srcdoc={h} title=\"t\" /> }\n}\n");
        assert!(
            errs.iter().any(|e| e.contains("`srcdoc` takes HTML")),
            "{errs:?}"
        );
        assert!(errors(
            "component A() {\n  view { <iframe srcdoc=\"<p>hi</p>\" title=\"t\" /> }\n}\n"
        )
        .is_empty());
        let srcdoc = |sandbox: &str| {
            errors(&format!(
                "component A(h: string, s: string) {{\n  view {{ <iframe {sandbox} srcdoc={{h}} title=\"t\" /> }}\n}}\n"
            ))
            .iter()
            .any(|e| e.contains("`srcdoc` takes HTML"))
        };
        assert!(!srcdoc("sandbox"), "a bare sandbox blocks scripts");
        assert!(!srcdoc("sandbox=\"allow-popups allow-same-origin\""));
        assert!(srcdoc("sandbox=\"allow-forms ALLOW-SCRIPTS\""));
        assert!(
            srcdoc("sandbox={s}"),
            "a dynamic sandbox could allow scripts"
        );
        assert!(
            srcdoc("sandbox {...{}}"),
            "a spread could replace the sandbox"
        );
        assert!(
            srcdoc("sandbox sandbox=\"allow-scripts\""),
            "two sandboxes are not trusted"
        );
    }
}
