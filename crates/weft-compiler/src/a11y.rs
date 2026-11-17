use std::collections::HashSet;

use crate::ast::{AttrKind, AttrValue, Element, Node};
use crate::diagnostics::Diagnostic;
use crate::lower::is_component_name;
use crate::token::Span;

pub fn lint(nodes: &[Node]) -> Vec<Diagnostic> {
    let mut ids = HashSet::new();
    let mut fors = Vec::new();
    collect_ids(nodes, &mut ids, &mut fors);
    let mut cx = Lint {
        ids,
        labelled: fors.iter().map(|(f, _)| f.clone()).collect(),
        diags: Vec::new(),
    };
    for (target, span) in &fors {
        if !cx.ids.contains(target) {
            cx.warn(
                format!("`<label for=\"{target}\">` names no element with that `id` in this view"),
                *span,
            );
        }
    }
    cx.nodes(nodes, Ctx::default());
    cx.diags
}

#[derive(Clone, Copy, Default)]
struct Ctx {
    in_form: bool,
    in_label: bool,
}

struct Lint {
    ids: HashSet<String>,
    labelled: HashSet<String>,
    diags: Vec<Diagnostic>,
}

fn attr<'e>(e: &'e Element, name: &str) -> Option<Option<&'e str>> {
    e.attrs
        .iter()
        .find(|a| {
            matches!(a.kind, AttrKind::Plain | AttrKind::Bind) && a.name.eq_ignore_ascii_case(name)
        })
        .map(|a| match &a.value {
            Some(AttrValue::Str(s)) => Some(s.as_str()),
            None => Some(""),
            Some(AttrValue::Expr(_)) => None,
        })
}

fn has_event(e: &Element, event: &str) -> bool {
    e.attrs.iter().any(|a| {
        a.kind == AttrKind::Event
            && crate::events::parse(&a.name).map_or(a.name.as_str(), |s| s.event) == event
    })
}

fn named_by_attr(e: &Element) -> bool {
    e.attrs.iter().any(|a| a.kind == AttrKind::Spread)
        || ["aria-label", "aria-labelledby", "title"]
            .iter()
            .any(|n| attr(e, n).is_some_and(|v| v.is_none_or_nonempty()))
}

trait NonEmpty {
    fn is_none_or_nonempty(&self) -> bool;
}

impl NonEmpty for Option<&str> {
    fn is_none_or_nonempty(&self) -> bool {
        self.map_or(true, |s| !s.trim().is_empty())
    }
}

fn has_text(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::Text(t) => !t.value.trim().is_empty(),
        Node::Interp(_) => true,
        Node::Element(e) if is_component_name(&e.name) => true,
        Node::Element(e) if e.name == "img" => {
            attr(e, "alt").is_some_and(|v| v.is_none_or_nonempty())
        }
        Node::Element(e) => named_by_attr(e) || has_text(&e.children),
        _ => n.blocks().into_iter().any(has_text),
    })
}

fn collect_ids(nodes: &[Node], ids: &mut HashSet<String>, fors: &mut Vec<(String, Span)>) {
    for n in nodes {
        match n {
            Node::Element(e) => {
                if let Some(Some(id)) = attr(e, "id") {
                    ids.insert(id.to_string());
                }
                if e.name == "label" {
                    if let Some(Some(target)) = attr(e, "for") {
                        fors.push((target.to_string(), e.span));
                    }
                }
                collect_ids(&e.children, ids, fors);
            }
            _ => {
                for b in n.blocks() {
                    collect_ids(b, ids, fors);
                }
            }
        }
    }
}

impl Lint {
    fn warn(&mut self, msg: String, span: Span) {
        self.diags.push(Diagnostic::warning(msg, span));
    }

    fn nodes(&mut self, nodes: &[Node], cx: Ctx) {
        for n in nodes {
            match n {
                Node::Element(e) if !is_component_name(&e.name) => self.element(e, cx),
                Node::Element(e) => self.nodes(&e.children, cx),
                _ => {
                    for b in n.blocks() {
                        self.nodes(b, cx);
                    }
                }
            }
        }
    }

    fn element(&mut self, e: &Element, cx: Ctx) {
        let name = e.name.to_ascii_lowercase();
        let input_type = attr(e, "type").flatten().map(|t| t.to_ascii_lowercase());

        let needs_alt = name == "img"
            || name == "area"
            || (name == "input" && input_type.as_deref() == Some("image"));
        if needs_alt && attr(e, "alt").is_none() && !named_by_attr(e) {
            self.warn(
                format!(
                    "<{}> needs an `alt` text (use `alt=\"\"` if it is decorative)",
                    e.name
                ),
                e.span,
            );
        }

        let field = match name.as_str() {
            "select" | "textarea" => true,
            "input" => !matches!(
                input_type.as_deref(),
                Some("hidden" | "submit" | "reset" | "button" | "image")
            ),
            _ => false,
        };
        if field && !cx.in_label && !named_by_attr(e) {
            let by_for = match attr(e, "id") {
                Some(Some(id)) => self.labelled.contains(id),
                Some(None) => true,
                None => false,
            };
            if !by_for {
                self.warn(
                    format!(
                        "<{}> has no label: wrap it in <label>, point a `<label for>` at its \
                         `id`, or give it `aria-label`",
                        e.name
                    ),
                    e.span,
                );
            }
        }

        let link = name == "a" && attr(e, "href").is_some();
        if (name == "button" || link) && !named_by_attr(e) && !has_text(&e.children) {
            self.warn(
                format!(
                    "<{}> has no accessible name: give it text content or `aria-label`",
                    e.name
                ),
                e.span,
            );
        }

        if name == "button" && cx.in_form && attr(e, "type").is_none() && has_event(e, "click") {
            self.warn(
                "a <button> with `@click` inside a <form> also submits the form; \
                 add `type=\"button\"` (or `type=\"submit\"` if that is intended)"
                    .to_string(),
                e.span,
            );
        }

        let interactive = matches!(
            name.as_str(),
            "button" | "input" | "select" | "textarea" | "option" | "summary" | "label" | "details"
        ) || link;
        if has_event(e, "click")
            && !interactive
            && (attr(e, "role").is_none() || attr(e, "tabindex").is_none())
        {
            self.warn(
                format!(
                    "`@click` on <{}> cannot be reached from the keyboard; use a <button>, \
                     or add `role` and `tabindex=\"0\"` and handle `@keydown` too",
                    e.name
                ),
                e.span,
            );
        }

        let inner = Ctx {
            in_form: cx.in_form || name == "form",
            in_label: cx.in_label || name == "label",
        };
        self.nodes(&e.children, inner);
    }
}

#[cfg(test)]
mod tests {
    fn lint(view: &str) -> Vec<String> {
        let src = format!("component C(u: string) {{ view {{ {view} }} }}");
        let (file, diags) = crate::parser::parse(&src);
        assert!(diags.is_empty(), "{diags:?}");
        let crate::ast::Item::Component(c) = &file.items[0] else {
            panic!()
        };
        super::lint(&c.view.nodes)
            .into_iter()
            .map(|d| d.message)
            .collect()
    }

    #[test]
    fn accessible_markup_is_clean() {
        let out = lint(concat!(
            "<img src=\"a.png\" alt=\"\" /><img src=\"b.png\" alt={u} />",
            "<label>Name <input name=\"n\" /></label>",
            "<label for=\"e\">Email</label><input id=\"e\" type=\"email\" />",
            "<input type=\"hidden\" name=\"t\" /><input aria-label=\"Search\" />",
            "<form><button>Add</button><button type=\"button\" @click={u}>x</button></form>",
            "<a href=\"/\">{u}</a><button aria-label=\"Close\"><svg></svg></button>",
            "<div role=\"button\" tabindex=\"0\" @click={u} @keydown={u}>ok</div>",
        ));
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn each_lint_fires() {
        let has = |view: &str, needle: &str| {
            let out = lint(view);
            assert!(out.iter().any(|m| m.contains(needle)), "{view}: {out:?}");
        };
        has("<img src=\"a.png\" />", "needs an `alt`");
        has("<input name=\"q\" />", "has no label");
        has("<textarea></textarea>", "has no label");
        has(
            "<label for=\"x\">X</label><input id=\"y\" />",
            "names no element",
        );
        has("<button></button>", "no accessible name");
        has(
            "<a href=\"/\"><img src=\"i.png\" alt=\"\" /></a>",
            "no accessible name",
        );
        has(
            "<form><button @click={u}>x</button></form>",
            "also submits the form",
        );
        has(
            "<div @click={u}>x</div>",
            "cannot be reached from the keyboard",
        );
        has("<a @click={u}>x</a>", "cannot be reached from the keyboard");
    }
}
