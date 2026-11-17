use std::borrow::Cow;

use crate::ast::{
    Attr, AttrKind, AttrValue, AwaitBlock, AwaitBranch, EachBlock, Element, IfArm, IfBlock, Interp,
    Node, Text,
};
use crate::diagnostics::Diagnostic;
use crate::lexer::is_ident_continue;
use crate::token::Span;

struct MarkupParser<'a> {
    chars: Cow<'a, [(usize, char)]>,
    pos: usize,
    base: usize,
    len: usize,
    stop_at_brace: bool,
    diags: Vec<Diagnostic>,
}

pub const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

const RAW_TEXT_ELEMENTS: &[&str] = &["script", "style"];

const ESCAPABLE_RAW_TEXT_ELEMENTS: &[&str] = &["textarea", "title"];

pub fn parse(slice: &str, base: usize) -> (Vec<Node>, Vec<Diagnostic>) {
    let mut p = new_parser(slice, base, false);
    let nodes = p.parse_nodes(None);
    (nodes, p.diags)
}

pub fn parse_view_body(src: &str, start: usize) -> (Vec<Node>, usize, Vec<Diagnostic>) {
    let chars: Vec<(usize, char)> = src.char_indices().collect();
    let at = chars.partition_point(|&(o, _)| o < start);
    parse_view_body_in(&chars, at, src.len())
}

pub(crate) fn parse_view_body_in(
    chars: &[(usize, char)],
    at: usize,
    len: usize,
) -> (Vec<Node>, usize, Vec<Diagnostic>) {
    let mut p = MarkupParser {
        chars: Cow::Borrowed(chars),
        pos: at,
        base: 0,
        len,
        stop_at_brace: true,
        diags: Vec::new(),
    };
    let nodes = p.parse_nodes(None);
    let brace = p.offset();
    if p.peek() != Some('}') {
        p.diags.push(Diagnostic::error(
            "unterminated `view` block, expected '}'",
            Span::new(brace, brace),
        ));
    }
    (nodes, brace, p.diags)
}

fn new_parser(slice: &str, base: usize, stop_at_brace: bool) -> MarkupParser<'static> {
    MarkupParser {
        chars: Cow::Owned(slice.char_indices().collect()),
        pos: 0,
        base,
        len: slice.len(),
        stop_at_brace,
        diags: Vec::new(),
    }
}

impl MarkupParser<'_> {

    fn offset(&self) -> usize {
        self.base
            + self
                .chars
                .get(self.pos)
                .map(|&(o, _)| o)
                .unwrap_or(self.len)
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).map(|&(_, c)| c)
    }

    fn peek_at(&self, n: usize) -> Option<char> {
        self.chars.get(self.pos + n).map(|&(_, c)| c)
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn at_close_tag(&self) -> bool {
        self.peek() == Some('<') && self.peek_at(1) == Some('/')
    }

    fn parse_nodes(&mut self, parent: Option<&str>) -> Vec<Node> {
        let stop_rbrace = self.stop_at_brace && parent.is_none();
        let mut nodes = Vec::new();
        loop {
            match self.peek() {
                None => {
                    if let Some(tag) = parent {
                        self.diags.push(Diagnostic::error(
                            format!("unclosed element <{tag}>"),
                            Span::new(self.offset(), self.offset()),
                        ));
                    }
                    break;
                }
                Some('}') if stop_rbrace => break,
                Some('<') if self.peek_at(1) == Some('/') && self.closing_void() => {}
                Some('<') if self.peek_at(1) == Some('/') => break,
                Some('<') if self.peek_at(1) == Some('!') => {
                    if let Some(node) = self.parse_bang() {
                        nodes.push(node);
                    }
                }
                Some('<') => {
                    if let Some(el) = self.parse_element() {
                        nodes.push(Node::Element(el));
                    }
                }
                Some('{') if matches!(self.brace_lead(), Some(':') | Some('/')) => break,
                Some('{') if self.brace_lead() == Some('#') => {
                    if let Some(block) = self.parse_block() {
                        nodes.push(block);
                    }
                }
                Some('{') => nodes.push(Node::Interp(self.parse_interp())),
                Some(_) => {
                    if let Some(text) = self.parse_text(stop_rbrace) {
                        nodes.push(Node::Text(text));
                    }
                }
            }
        }
        nodes
    }

    fn parse_text(&mut self, stop_rbrace: bool) -> Option<Text> {
        let start = self.offset();
        let mut value = String::new();
        while let Some(c) = self.peek() {
            if c == '<' || c == '{' || (stop_rbrace && c == '}') {
                break;
            }
            value.push(c);
            self.bump();
        }
        if value.is_empty() {
            None
        } else {
            Some(Text {
                value,
                span: Span::new(start, self.offset()),
            })
        }
    }

    fn parse_interp(&mut self) -> Interp {
        let start = self.offset();
        self.bump();
        let expr = self.read_balanced_braces();
        Interp {
            expr: expr.trim().to_string(),
            span: Span::new(start, self.offset()),
        }
    }

    fn read_balanced_braces(&mut self) -> String {
        let mut depth = 1;
        let mut out = String::new();
        while let Some(c) = self.bump() {
            match c {
                '{' => {
                    depth += 1;
                    out.push(c);
                }
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(c);
                }
                '"' | '\'' | '`' => {
                    out.push(c);
                    self.read_string_body(c, &mut out);
                }
                _ => out.push(c),
            }
        }
        if depth != 0 {
            self.diags.push(Diagnostic::error(
                "unterminated interpolation, expected '}'",
                Span::new(self.offset(), self.offset()),
            ));
        }
        out
    }

    fn read_string_body(&mut self, quote: char, out: &mut String) {
        while let Some(c) = self.bump() {
            out.push(c);
            match c {
                '\\' => {
                    if let Some(e) = self.bump() {
                        out.push(e);
                    }
                }
                _ if c == quote => break,
                _ => {}
            }
        }
    }

    fn brace_lead(&self) -> Option<char> {
        let mut i = self.pos + 1;
        while let Some(&(_, c)) = self.chars.get(i) {
            if c.is_whitespace() {
                i += 1;
            } else {
                return Some(c);
            }
        }
        None
    }

    fn parse_block(&mut self) -> Option<Node> {
        let start = self.offset();
        self.bump();
        let inner = self.read_balanced_braces();
        let inner = inner.trim();
        let Some(body_src) = inner.strip_prefix('#') else {
            self.diags.push(Diagnostic::error(
                "expected a block keyword after '{#'",
                Span::new(start, self.offset()),
            ));
            return None;
        };
        let (word, header) = split_first_word(body_src);
        match word {
            "if" => self.parse_if_block(start, header),
            "each" => self.parse_each_block(start, header),
            "await" => self.parse_await_block(start, header),
            "can" => self.parse_can_block(start, header),
            other => {
                self.diags.push(Diagnostic::error(
                    format!("unknown block '#{other}' (expected '#if', '#each', '#await' or '#can')"),
                    Span::new(start, self.offset()),
                ));
                None
            }
        }
    }

    fn parse_if_block(&mut self, start: usize, cond: &str) -> Option<Node> {
        if cond.is_empty() {
            self.diags.push(Diagnostic::error(
                "'{#if}' needs a condition",
                Span::new(start, self.offset()),
            ));
        }
        let mut arms = Vec::new();
        let mut cond = cond.to_string();
        let mut else_body = None;
        loop {
            let body = self.parse_block_body();
            arms.push(IfArm {
                cond: std::mem::take(&mut cond),
                body,
            });
            let ctrl = self.read_control("{:else} or {/if}")?;
            let ctrl = ctrl.trim();
            if ctrl == "/if" {
                break;
            }
            let Some(rest) = ctrl.strip_prefix(':') else {
                self.diags.push(Diagnostic::error(
                    format!("expected '{{:else}}' or '{{/if}}', found '{{{ctrl}}}'"),
                    Span::new(start, self.offset()),
                ));
                return None;
            };
            let (word, tail) = split_first_word(rest);
            if word != "else" {
                self.diags.push(Diagnostic::error(
                    "expected '{:else}' or '{:else if ...}'",
                    Span::new(start, self.offset()),
                ));
                return None;
            }
            let (tail_word, tail_rest) = split_first_word(tail);
            if tail.is_empty() {
                else_body = Some(self.parse_block_body());
                let end = self.read_control("{/if}")?;
                if end.trim() != "/if" {
                    self.diags.push(Diagnostic::error(
                        "expected '{/if}' after the else branch",
                        Span::new(start, self.offset()),
                    ));
                    return None;
                }
                break;
            } else if tail_word == "if" {
                cond = tail_rest.trim().to_string();
            } else {
                self.diags.push(Diagnostic::error(
                    "expected '{:else}' or '{:else if ...}'",
                    Span::new(start, self.offset()),
                ));
                return None;
            }
        }
        Some(Node::If(IfBlock {
            arms,
            else_body,
            span: Span::new(start, self.offset()),
            can: None,
        }))
    }

    fn parse_can_block(&mut self, start: usize, header: &str) -> Option<Node> {
        let header = header.trim();
        let parsed = header
            .split_once('(')
            .and_then(|(verb, rest)| Some((verb.trim(), rest.strip_suffix(')')?.trim())));
        let (verb, row) = match parsed {
            Some((verb @ ("read" | "write"), row)) if !row.is_empty() => (verb.to_string(), row.to_string()),
            _ => {
                self.diags.push(Diagnostic::error(
                    "'{#can}' takes `read(row)` or `write(row)`: `{#can write(task)}`",
                    Span::new(start, self.offset()),
                ));
                return None;
            }
        };
        let body = self.parse_block_body();
        let ctrl = self.read_control("{:else} or {/can}")?;
        let mut else_body = None;
        match ctrl.trim() {
            "/can" => {}
            ":else" => {
                else_body = Some(self.parse_block_body());
                let end = self.read_control("{/can}")?;
                if end.trim() != "/can" {
                    self.diags.push(Diagnostic::error(
                        "expected '{/can}' after the else branch",
                        Span::new(start, self.offset()),
                    ));
                    return None;
                }
            }
            other => {
                self.diags.push(Diagnostic::error(
                    format!("expected '{{:else}}' or '{{/can}}', found '{{{other}}}' ('{{#can}}' has no '{{:else if}}')"),
                    Span::new(start, self.offset()),
                ));
                return None;
            }
        }
        Some(Node::If(IfBlock {
            arms: vec![IfArm { cond: row, body }],
            else_body,
            span: Span::new(start, self.offset()),
            can: Some(verb),
        }))
    }

    fn parse_await_block(&mut self, start: usize, expr: &str) -> Option<Node> {
        if expr.is_empty() {
            self.diags.push(Diagnostic::error(
                "'{#await}' needs an expression",
                Span::new(start, self.offset()),
            ));
            return None;
        }
        let pending = self.parse_block_body();
        let mut then = None;
        let mut catch = None;
        loop {
            let ctrl = self.read_control("{:then}, {:catch} or {/await}")?;
            let ctrl = ctrl.trim();
            if ctrl == "/await" {
                break;
            }
            let (word, binding) = split_first_word(ctrl.strip_prefix(':').unwrap_or(""));
            let binding = binding.trim();
            if !binding.is_empty() && !crate::lexer::is_ident(binding) {
                self.diags.push(Diagnostic::error(
                    format!("'{{:{word}}}' binds a single name, found '{binding}'"),
                    Span::new(start, self.offset()),
                ));
                return None;
            }
            let branch = AwaitBranch {
                binding: (!binding.is_empty()).then(|| binding.to_string()),
                body: self.parse_block_body(),
            };
            match word {
                "then" if then.is_none() && catch.is_none() => then = Some(branch),
                "catch" if catch.is_none() => catch = Some(branch),
                _ => {
                    self.diags.push(Diagnostic::error(
                        format!(
                            "unexpected '{{{ctrl}}}' in '{{#await}}' \
                             (expected '{{:then}}', then '{{:catch}}', then '{{/await}}')"
                        ),
                        Span::new(start, self.offset()),
                    ));
                    return None;
                }
            }
        }
        Some(Node::Await(AwaitBlock {
            expr: expr.to_string(),
            pending,
            then,
            catch,
            span: Span::new(start, self.offset()),
        }))
    }

    fn parse_each_block(&mut self, start: usize, header: &str) -> Option<Node> {
        let Some(as_pos) = header.rfind(" as ") else {
            self.diags.push(Diagnostic::error(
                "'{#each}' needs '... as item'",
                Span::new(start, self.offset()),
            ));
            return None;
        };
        let expr = header[..as_pos].trim().to_string();
        let mut binding = header[as_pos + 4..].trim();
        let mut key = None;
        if let Some(open) = binding.find('(') {
            let k = binding[open..].trim();
            match k.strip_prefix('(').and_then(|k| k.strip_suffix(')')) {
                Some(inner) if !inner.trim().is_empty() => {
                    key = Some(inner.trim().to_string());
                    binding = binding[..open].trim();
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "'{#each}' key must be a parenthesised expression: `as item (item.id)`",
                        Span::new(start, self.offset()),
                    ));
                    return None;
                }
            }
        }
        let mut parts = binding.splitn(2, ',');
        let item = parts.next().unwrap_or("").trim().to_string();
        let index = parts
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if expr.is_empty() || item.is_empty() {
            self.diags.push(Diagnostic::error(
                "'{#each}' needs an expression and an item name",
                Span::new(start, self.offset()),
            ));
            return None;
        }
        let body = self.parse_block_body();
        let end = self.read_control("{/each}")?;
        if end.trim() != "/each" {
            self.diags.push(Diagnostic::error(
                "expected '{/each}' to close the each block",
                Span::new(start, self.offset()),
            ));
            return None;
        }
        Some(Node::Each(EachBlock {
            expr,
            item,
            index,
            key,
            body,
            span: Span::new(start, self.offset()),
        }))
    }

    fn parse_block_body(&mut self) -> Vec<Node> {
        self.parse_nodes(None)
    }

    fn read_control(&mut self, expected: &str) -> Option<String> {
        if self.peek() != Some('{') {
            self.diags.push(Diagnostic::error(
                format!("unterminated block, expected '{expected}'"),
                Span::new(self.offset(), self.offset()),
            ));
            return None;
        }
        self.bump();
        Some(self.read_balanced_braces())
    }

    fn starts_with_ci(&self, s: &str) -> bool {
        let mut i = 0;
        for want in s.chars() {
            match self.peek_at(i) {
                Some(c) if c.eq_ignore_ascii_case(&want) => i += 1,
                _ => return false,
            }
        }
        true
    }

    fn at_end_tag_of(&self, name: &str) -> bool {
        self.starts_with_ci("</")
            && self.starts_with_ci(&format!("</{name}"))
            && matches!(
                self.peek_at(2 + name.chars().count()),
                Some('>' | '/') | Some(' ' | '\t' | '\n' | '\r' | '\u{c}') | None
            )
    }

    fn closing_void(&mut self) -> bool {
        let start = self.offset();
        let save = self.pos;
        self.bump();
        self.bump();
        let name = self.read_name().to_ascii_lowercase();
        if !VOID_ELEMENTS.contains(&name.as_str()) {
            self.pos = save;
            return false;
        }
        self.skip_ws();
        if self.peek() == Some('>') {
            self.bump();
        }
        self.diags.push(Diagnostic::error(
            format!("<{name}> is a void element and has no closing tag"),
            Span::new(start, self.offset()),
        ));
        true
    }

    fn parse_bang(&mut self) -> Option<Node> {
        let start = self.offset();
        if self.starts_with_ci("<!--") {
            for _ in 0..4 {
                self.bump();
            }
            loop {
                if self.starts_with_ci("-->") {
                    for _ in 0..3 {
                        self.bump();
                    }
                    return None;
                }
                if self.peek().is_none() {
                    self.diags.push(Diagnostic::error(
                        "unterminated HTML comment (expected '-->')",
                        Span::new(start, self.offset()),
                    ));
                    return None;
                }
                if self.offset() == start + 4 && self.starts_with_ci(">") {
                    self.bump();
                    return None;
                }
                if self.offset() == start + 4 && self.starts_with_ci("->") {
                    self.bump();
                    self.bump();
                    return None;
                }
                self.bump();
            }
        }
        if self.starts_with_ci("<!doctype") {
            let mut decl = String::new();
            while let Some(c) = self.bump() {
                if c == '>' {
                    break;
                }
                decl.push(c);
            }
            let rest = decl["<!doctype".len()..].trim();
            if !rest.eq_ignore_ascii_case("html") {
                self.diags.push(Diagnostic::error(
                    format!("unsupported doctype '{rest}' (only `<!doctype html>` is valid HTML)"),
                    Span::new(start, self.offset()),
                ));
                return None;
            }
            return Some(Node::Text(Text {
                value: "<!DOCTYPE html>".to_string(),
                span: Span::new(start, self.offset()),
            }));
        }
        while let Some(c) = self.bump() {
            if c == '>' {
                break;
            }
        }
        self.diags.push(Diagnostic::error(
            "unsupported markup declaration (expected '<!-- ... -->' or '<!doctype html>')",
            Span::new(start, self.offset()),
        ));
        None
    }

    fn parse_raw_text(&mut self, name: &str) -> Vec<Node> {
        let start = self.offset();
        let mut value = String::new();
        while self.peek().is_some() && !self.at_end_tag_of(name) {
            value.push(self.bump().unwrap());
        }
        if value.is_empty() {
            Vec::new()
        } else {
            vec![Node::Text(Text {
                value,
                span: Span::new(start, self.offset()),
            })]
        }
    }

    fn parse_rcdata(&mut self, name: &str) -> Vec<Node> {
        let mut nodes = Vec::new();
        let mut start = self.offset();
        let mut value = String::new();
        loop {
            let end = self.peek().is_none() || self.at_end_tag_of(name);
            if end || self.peek() == Some('{') {
                if !value.is_empty() {
                    nodes.push(Node::Text(Text {
                        value: std::mem::take(&mut value),
                        span: Span::new(start, self.offset()),
                    }));
                }
                if end {
                    break;
                }
                if matches!(self.brace_lead(), Some('#' | ':' | '/')) {
                    let at = self.offset();
                    self.bump();
                    self.read_balanced_braces();
                    self.diags.push(Diagnostic::error(
                        format!("blocks are not allowed inside <{name}> (its content is text)"),
                        Span::new(at, self.offset()),
                    ));
                } else {
                    nodes.push(Node::Interp(self.parse_interp()));
                }
                start = self.offset();
            } else {
                value.push(self.bump().unwrap());
            }
        }
        nodes
    }

    fn parse_element(&mut self) -> Option<Element> {
        let start = self.offset();
        self.bump();
        let name = self.read_name();
        if name.is_empty() {
            self.diags.push(Diagnostic::error(
                "expected element name after '<'",
                Span::new(start, self.offset()),
            ));
            return None;
        }

        let mut attrs = Vec::new();
        loop {
            self.skip_ws();
            match self.peek() {
                Some('>') => {
                    self.bump();
                    break;
                }
                Some('/') if self.peek_at(1) == Some('>') => {
                    self.bump();
                    self.bump();
                    return Some(Element {
                        name,
                        attrs,
                        children: Vec::new(),
                        self_closing: true,
                        span: Span::new(start, self.offset()),
                    });
                }
                None => {
                    self.diags.push(Diagnostic::error(
                        format!("unterminated opening tag <{name}>"),
                        Span::new(start, self.offset()),
                    ));
                    return None;
                }
                _ => {
                    if self.parse_attr().map(|a| attrs.push(a)).is_none() {
                        self.bump();
                    }
                }
            }
        }

        let lower = name.to_ascii_lowercase();
        if VOID_ELEMENTS.contains(&lower.as_str()) {
            return Some(Element {
                name,
                attrs,
                children: Vec::new(),
                self_closing: true,
                span: Span::new(start, self.offset()),
            });
        }
        let raw = RAW_TEXT_ELEMENTS.contains(&lower.as_str());
        let rcdata = ESCAPABLE_RAW_TEXT_ELEMENTS.contains(&lower.as_str());
        let children = if raw {
            self.parse_raw_text(&lower)
        } else if rcdata {
            self.parse_rcdata(&lower)
        } else {
            self.parse_nodes(Some(&name))
        };
        if (raw || rcdata) && self.peek().is_none() {
            self.diags.push(Diagnostic::error(
                format!("unclosed element <{name}>"),
                Span::new(start, self.offset()),
            ));
        }
        if self.at_close_tag() {
            self.bump();
            self.bump();
            let close = self.read_name();
            self.skip_ws();
            if self.peek() == Some('>') {
                self.bump();
            }
            let same = if crate::lower::is_component_name(&name) {
                close == name
            } else {
                close.eq_ignore_ascii_case(&name)
            };
            if !same {
                self.diags.push(Diagnostic::error(
                    format!("mismatched closing tag: expected </{name}>, found </{close}>"),
                    Span::new(start, self.offset()),
                ));
            }
        }

        Some(Element {
            name,
            attrs,
            children,
            self_closing: false,
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_attr(&mut self) -> Option<Attr> {
        let start = self.offset();
        if self.peek() == Some('{') {
            self.bump();
            let inner = self.read_balanced_braces();
            let expr = inner.trim();
            let Some(spread) = expr.strip_prefix("...") else {
                self.diags.push(Diagnostic::error(
                    "only `{...object}` may stand alone in a tag (an attribute needs a name: `name={value}`)",
                    Span::new(start, self.offset()),
                ));
                return Some(Attr {
                    kind: AttrKind::Spread,
                    name: String::new(),
                    value: None,
                    span: Span::new(start, self.offset()),
                });
            };
            return Some(Attr {
                kind: AttrKind::Spread,
                name: String::new(),
                value: Some(AttrValue::Expr(spread.trim().to_string())),
                span: Span::new(start, self.offset()),
            });
        }
        let mut kind = match self.peek() {
            Some('@') => {
                self.bump();
                AttrKind::Event
            }
            Some(':') => {
                self.bump();
                AttrKind::Bind
            }
            _ => AttrKind::Plain,
        };
        let mut name = self.read_name();
        if name.is_empty() {
            return None;
        }
        if kind == AttrKind::Plain {
            if let Some(f) = name.strip_prefix("use:") {
                name = f.to_string();
                kind = AttrKind::Use;
            }
        }
        while kind == AttrKind::Event && self.peek() == Some('(') {
            name.push_str(&self.read_paren_group());
            name.push_str(&self.read_name());
        }
        self.skip_ws();
        let value = if self.peek() == Some('=') {
            self.bump();
            self.skip_ws();
            match self.peek() {
                Some('"') | Some('\'') => Some(AttrValue::Str(self.read_quoted())),
                Some('{') => {
                    self.bump();
                    Some(AttrValue::Expr(
                        self.read_balanced_braces().trim().to_string(),
                    ))
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        format!("expected a value after '{name}='"),
                        Span::new(start, self.offset()),
                    ));
                    None
                }
            }
        } else {
            None
        };
        Some(Attr {
            kind,
            name,
            value,
            span: Span::new(start, self.offset()),
        })
    }

    fn read_paren_group(&mut self) -> String {
        let mut out = String::new();
        let mut depth = 0usize;
        let mut quote: Option<char> = None;
        while let Some(c) = self.peek() {
            if quote.is_none() && depth > 0 && (c == '>' || c == '\n') {
                break;
            }
            self.bump();
            out.push(c);
            match quote {
                Some(_) if c == '\\' => {
                    if let Some(n) = self.bump() {
                        out.push(n);
                    }
                }
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None => match c {
                    '"' | '\'' => quote = Some(c),
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                },
            }
        }
        out
    }

    fn read_quoted(&mut self) -> String {
        let quote = self.bump().unwrap_or('"');
        let mut out = String::new();
        while let Some(c) = self.bump() {
            if c == quote {
                break;
            }
            out.push(c);
        }
        out
    }

    fn read_name(&mut self) -> String {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            if is_ident_continue(c) || c == '-' || c == '.' || c == ':' {
                out.push(c);
                self.bump();
            } else {
                break;
            }
        }
        out
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.bump();
        }
    }
}

fn split_first_word(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], s[i..].trim_start()),
        None => (s, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(src: &str) -> Vec<Node> {
        let (nodes, diags) = parse(src, 0);
        assert!(diags.is_empty(), "{src}: {diags:?}");
        nodes
    }

    #[test]
    fn can_block_parses_a_verb_a_row_and_an_else() {
        let nodes = parse_ok("{#can write(task)}<button>Edit</button>{:else}<p>read only</p>{/can}");
        let Node::If(b) = &nodes[0] else { panic!("{nodes:?}") };
        assert_eq!(b.can.as_deref(), Some("write"));
        assert_eq!(b.arms.len(), 1);
        assert_eq!(b.arms[0].cond, "task");
        assert!(b.else_body.is_some());
        let nodes = parse_ok("{#can read( rows[0] )}<a>x</a>{/can}");
        let Node::If(b) = &nodes[0] else { panic!() };
        assert_eq!((b.can.as_deref(), b.arms[0].cond.as_str(), b.else_body.is_none()), (Some("read"), "rows[0]", true));
        for bad in [
            "{#can task}x{/can}",
            "{#can delete(task)}x{/can}",
            "{#can write()}x{/can}",
            "{#can write(task)}x{:else if y}z{/can}",
            "{#can write(task)}x{/if}",
        ] {
            let (_, diags) = parse(bad, 0);
            assert!(!diags.is_empty(), "{bad} should not parse");
        }
    }

    #[test]
    fn html_content_models() {
        let nodes = parse_ok("<p>a<br>b<input value=\"x\">c</p>");
        let Node::Element(p) = &nodes[0] else {
            panic!()
        };
        assert_eq!(p.children.len(), 5, "{p:?}");

        let nodes = parse_ok("<style>a > b { color: red }</style><script>if (a<b) {}</SCRIPT>");
        let Node::Element(s) = &nodes[0] else {
            panic!()
        };
        assert!(matches!(&s.children[..], [Node::Text(t)] if t.value == "a > b { color: red }"));
        let Node::Element(s) = &nodes[1] else {
            panic!()
        };
        assert!(matches!(&s.children[..], [Node::Text(t)] if t.value == "if (a<b) {}"));

        let nodes = parse_ok("<textarea>a <b> {x}</textarea><title>{t} - site</title>");
        let Node::Element(ta) = &nodes[0] else {
            panic!()
        };
        assert!(
            matches!(&ta.children[..], [Node::Text(t), Node::Interp(i)] if t.value == "a <b> " && i.expr == "x")
        );

        let nodes = parse_ok("<!doctype HTML><!-- a {b} <c> --><p>x</p><!---->");
        assert!(matches!(&nodes[0], Node::Text(t) if t.value == "<!DOCTYPE html>"));
        assert!(matches!(&nodes[1], Node::Element(e) if e.name == "p"));
        assert_eq!(nodes.len(), 2);

        for bad in [
            "<p><!-- open</p>",
            "<!doctype xhtml>",
            "<![CDATA[x]]>",
            "<p>a</br></p>",
            "<style>x",
            "<textarea>{#if a}x{/if}</textarea>",
        ] {
            let (_, diags) = parse(bad, 0);
            assert!(!diags.is_empty(), "{bad} should not parse cleanly");
        }
    }
}
