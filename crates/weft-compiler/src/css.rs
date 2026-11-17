use crate::diagnostics::Diagnostic;
use crate::token::Span;

#[derive(Clone, Debug, PartialEq)]
pub struct Compiled {
    pub class: String,
    pub css: String,
    pub vars: Vec<(String, usize)>,
}

pub fn scope_class(component: &str, css: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in component.bytes().chain([0]).chain(css.bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    let mut n = (h >> 32) as u32;
    let mut s = Vec::new();
    loop {
        let d = (n % 36) as u8;
        s.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    format!("w-{}", String::from_utf8(s).expect("ascii"))
}

pub fn compile(component: &str, css: &str, base: usize) -> (Compiled, Vec<Diagnostic>) {
    let class = scope_class(component, css);
    let mut cx = Cx {
        src: css,
        base,
        pos: 0,
        class: class.clone(),
        vars: Vec::new(),
        diags: Vec::new(),
    };
    let mut out = String::new();
    cx.rules(&mut out, false);
    let css = out.trim().replace("</", "<\\/");
    (
        Compiled {
            class,
            css,
            vars: cx.vars,
        },
        cx.diags,
    )
}

struct Cx<'a> {
    src: &'a str,
    base: usize,
    pos: usize,
    class: String,
    vars: Vec<(String, usize)>,
    diags: Vec<Diagnostic>,
}

impl Cx<'_> {
    fn peek(&self) -> Option<u8> {
        self.src.as_bytes().get(self.pos).copied()
    }

    fn at(&self, s: &str) -> bool {
        self.src[self.pos..].starts_with(s)
    }

    fn error(&mut self, msg: impl Into<String>, from: usize, to: usize) {
        self.diags.push(Diagnostic::error(
            msg,
            Span::new(self.base + from, self.base + to.max(from + 1)),
        ));
    }

    fn trivia(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_ascii_whitespace() => self.pos += 1,
                _ if self.at("/*") => {
                    self.pos = self.src[self.pos + 2..]
                        .find("*/")
                        .map_or(self.src.len(), |i| self.pos + 2 + i + 2);
                }
                _ => break,
            }
        }
    }

    fn string(&mut self, out: &mut String) {
        let q = self.src.as_bytes()[self.pos];
        let start = self.pos;
        self.pos += 1;
        while let Some(c) = self.peek() {
            self.pos += 1;
            if c == b'\\' {
                self.pos += 1;
            } else if c == q {
                break;
            }
        }
        self.pos = self.pos.min(self.src.len());
        out.push_str(&self.src[start..self.pos]);
    }

    fn rules(&mut self, out: &mut String, nested: bool) {
        loop {
            self.trivia();
            match self.peek() {
                None => {
                    if nested {
                        self.error(
                            "unclosed `{` in style",
                            self.pos.saturating_sub(1),
                            self.pos,
                        );
                    }
                    return;
                }
                Some(b'}') if nested => {
                    self.pos += 1;
                    return;
                }
                Some(b'}') => {
                    self.error("unmatched `}` in style", self.pos, self.pos + 1);
                    self.pos += 1;
                }
                Some(b'@') => self.at_rule(out),
                Some(_) => self.rule(out),
            }
        }
    }

    fn prelude(&mut self) -> String {
        let mut out = String::new();
        let mut depth = 0i32;
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' => {
                    self.string(&mut out);
                    continue;
                }
                b'/' if self.at("/*") => {
                    self.trivia();
                    out.push(' ');
                    continue;
                }
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b'{' | b';' | b'}' if depth <= 0 => break,
                _ => {}
            }
            if c.is_ascii_whitespace() {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
                self.pos += 1;
                continue;
            }
            let ch = self.src[self.pos..].chars().next().expect("in bounds");
            out.push(ch);
            self.pos += ch.len_utf8();
        }
        out.trim().to_string()
    }

    fn at_rule(&mut self, out: &mut String) {
        let start = self.pos;
        let prelude = self.prelude();
        let name: String = prelude[1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        let lower = name.to_ascii_lowercase();
        let lower = lower
            .trim_start_matches("-webkit-")
            .trim_start_matches("-moz-");
        match self.peek() {
            Some(b';') | None | Some(b'}') => {
                if self.peek() == Some(b';') {
                    self.pos += 1;
                }
                if lower == "import" {
                    self.error(
                        "`@import` is not supported in component styles; they are bundled \
                         into one stylesheet (put shared CSS in a component or the shell)",
                        start,
                        self.pos,
                    );
                    return;
                }
                out.push_str(&prelude);
                out.push(';');
            }
            Some(_) => {
                self.pos += 1;
                match lower {
                    "media" | "supports" | "container" | "layer" | "scope" | "variant" => {
                        out.push_str(&prelude);
                        out.push('{');
                        self.rules(out, true);
                        out.push('}');
                    }
                    _ => {
                        out.push_str(&prelude);
                        out.push('{');
                        self.verbatim_block(out);
                        out.push('}');
                    }
                }
            }
        }
    }

    fn verbatim_block(&mut self, out: &mut String) {
        let mut depth = 1i32;
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' => {
                    self.string(out);
                    continue;
                }
                b'/' if self.at("/*") => {
                    self.trivia();
                    out.push(' ');
                    continue;
                }
                b'{' => depth += 1,
                b'}' => {
                    let t = out.trim_end().len();
                    out.truncate(t);
                    depth -= 1;
                    if depth == 0 {
                        self.pos += 1;
                        return;
                    }
                }
                _ => {}
            }
            let ch = self.src[self.pos..].chars().next().expect("in bounds");
            if ch.is_ascii_whitespace() {
                if !out.ends_with([' ', '{', ';', '}']) {
                    out.push(' ');
                }
            } else {
                out.push(ch);
            }
            self.pos += ch.len_utf8();
        }
        self.error(
            "unclosed `{` in style",
            self.src.len().saturating_sub(1),
            self.src.len(),
        );
    }

    fn rule(&mut self, out: &mut String) {
        let start = self.pos;
        let selector = self.prelude();
        if self.peek() != Some(b'{') {
            self.error("expected `{` after a selector", start, self.pos);
            if self.peek() == Some(b';') {
                self.pos += 1;
            }
            return;
        }
        self.pos += 1;
        match self.scope_list(&selector) {
            Ok(s) => out.push_str(&s),
            Err(msg) => self.error(msg, start, start + selector.len()),
        }
        out.push('{');
        self.declarations(out);
        out.push('}');
    }

    fn declarations(&mut self, out: &mut String) {
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' => {
                    self.string(out);
                    continue;
                }
                b'/' if self.at("/*") => {
                    self.trivia();
                    continue;
                }
                b'}' => {
                    self.pos += 1;
                    let t = out.trim_end().len();
                    out.truncate(t);
                    return;
                }
                b'{' => {
                    let decl = out.rfind([';', '{', '}']).map_or(0, |i| i + 1);
                    if out[decl..].trim_start().starts_with('@') {
                        let t = out.trim_end().len();
                        out.truncate(t);
                        self.pos += 1;
                        out.push('{');
                        self.declarations(out);
                        out.push('}');
                    } else {
                        self.interpolation(out);
                    }
                    continue;
                }
                _ => {}
            }
            let ch = self.src[self.pos..].chars().next().expect("in bounds");
            if ch.is_ascii_whitespace() {
                if !out.ends_with([' ', '{', ';', ':']) {
                    out.push(' ');
                }
            } else {
                out.push(ch);
            }
            self.pos += ch.len_utf8();
        }
        self.error(
            "unclosed `{` in style",
            self.src.len().saturating_sub(1),
            self.src.len(),
        );
    }

    fn interpolation(&mut self, out: &mut String) {
        let open = self.pos;
        self.pos += 1;
        let mut depth = 1i32;
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' | b'`' => {
                    let mut sink = String::new();
                    self.string(&mut sink);
                    continue;
                }
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
        let inner = &self.src[open + 1..self.pos.min(self.src.len())];
        self.pos = (self.pos + 1).min(self.src.len());
        let expr = inner.trim();
        if expr.is_empty() {
            self.error(
                "empty `{}` in style (rules cannot be nested; write flat selectors)",
                open,
                self.pos,
            );
            return;
        }
        let decl = out[out.rfind([';', '{']).map_or(0, |i| i + 1)..].trim_start();
        let name_len = decl
            .bytes()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_')
            .count();
        let in_value = name_len > 0 && decl[name_len..].trim_start().starts_with(':');
        let declarations = expr.contains(['{', ';']) || (expr.contains(':') && !expr.contains('?'));
        if !in_value || declarations {
            self.error(
                "a nested rule is not supported in style; write flat selectors \
                 (`{expr}` interpolates a value)",
                open,
                self.pos,
            );
            return;
        }
        let lead = inner.len() - inner.trim_start().len();
        let n = match self.vars.iter().position(|(e, _)| e == expr) {
            Some(n) => n,
            None => {
                self.vars
                    .push((expr.to_string(), self.base + open + 1 + lead));
                self.vars.len() - 1
            }
        };
        out.push_str(&format!("var(--{}-{n})", self.class));
    }

    fn scope_list(&self, list: &str) -> Result<String, String> {
        let parts = split_top(list, b',');
        let mut out = Vec::new();
        for p in parts {
            let p = p.trim();
            if p.is_empty() {
                return Err("empty selector in a selector list".into());
            }
            out.push(self.scope_complex(p)?);
        }
        Ok(out.join(","))
    }

    fn scope_complex(&self, sel: &str) -> Result<String, String> {
        if let Some(inner) = global_arg(sel) {
            return Ok(inner.trim().to_string());
        }
        let b = sel.as_bytes();
        let mut out = String::new();
        let mut depth = 0i32;
        let mut cur = String::new();
        let mut i = 0;
        let flush = |cur: &mut String, out: &mut String| -> Result<(), String> {
            if !cur.is_empty() {
                out.push_str(&self.scope_compound(cur)?);
                cur.clear();
            }
            Ok(())
        };
        while i < b.len() {
            let c = b[i];
            match c {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b'"' | b'\'' => {
                    let end = sel[i + 1..]
                        .find(c as char)
                        .map_or(sel.len(), |j| i + 1 + j + 1);
                    cur.push_str(&sel[i..end]);
                    i = end;
                    continue;
                }
                _ => {}
            }
            if depth == 0 && (c == b' ' || c == b'>' || c == b'+' || c == b'~') {
                flush(&mut cur, &mut out)?;
                let mut comb = String::new();
                while i < b.len() && matches!(b[i], b' ' | b'>' | b'+' | b'~') {
                    if b[i] != b' ' {
                        comb.push(b[i] as char);
                    }
                    i += 1;
                }
                out.push_str(if comb.is_empty() { " " } else { &comb });
                continue;
            }
            let ch = sel[i..].chars().next().expect("in bounds");
            cur.push(ch);
            i += ch.len_utf8();
        }
        flush(&mut cur, &mut out)?;
        Ok(out)
    }

    fn scope_compound(&self, c: &str) -> Result<String, String> {
        if let Some(inner) = global_arg(c) {
            return Ok(inner.trim().to_string());
        }
        if c.contains(":global(") {
            return Err("`:global(..)` must be a whole compound selector (`.a :global(.b)`) or the whole selector".into());
        }
        if c.contains('&') {
            return Err("CSS nesting (`&`) is not supported in style; write flat selectors".into());
        }
        let b = c.as_bytes();
        let mut depth = 0i32;
        let mut cut = c.len();
        for i in 0..b.len() {
            match b[i] {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b':' if depth == 0 => {
                    let rest = c[i..].to_ascii_lowercase();
                    if rest.starts_with("::")
                        || [":before", ":after", ":first-line", ":first-letter"]
                            .iter()
                            .any(|p| rest.starts_with(p))
                    {
                        cut = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        Ok(format!("{}:where(.{}){}", &c[..cut], self.class, &c[cut..]))
    }
}

fn global_arg(s: &str) -> Option<&str> {
    let inner = s.strip_prefix(":global(")?.strip_suffix(')')?;
    let mut depth = 0i32;
    for c in inner.bytes() {
        match c {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
            }
            _ => {}
        }
    }
    (depth == 0).then_some(inner)
}

fn split_top(s: &str, sep: u8) -> Vec<&str> {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            c if c == sep && depth == 0 => {
                parts.push(&s[last..i]);
                last = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&s[last.min(s.len())..]);
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn css(src: &str) -> (String, Vec<String>) {
        let (c, d) = compile("Card", src, 0);
        let css = c.css.replace(&c.class, "S");
        (css, d.into_iter().map(|d| d.message).collect())
    }

    #[test]
    fn selectors_are_scoped_per_compound_before_pseudo_elements() {
        let (out, errs) = css(".card p > a:hover::after, h1 + h2 ~ *:not(.x) { color: red; }");
        assert!(errs.is_empty(), "{errs:?}");
        assert_eq!(
            out,
            ".card:where(.S) p:where(.S)>a:hover:where(.S)::after,h1:where(.S)+h2:where(.S)~*:not(.x):where(.S){color:red;}"
        );
    }

    #[test]
    fn global_media_and_verbatim_at_rules() {
        let (out, errs) = css(concat!(
            ":global(body) { margin: 0 }\n",
            ".a :global(.theme-dark) b { x: y }\n",
            "@media (min-width: 600px) { .a { x: y } }\n",
            "@keyframes spin { from { rotate: 0 } to { rotate: 1turn } }\n",
            "/* note */ a[href^=\"http:\"] { x: \"}\" }\n",
        ));
        assert!(errs.is_empty(), "{errs:?}");
        assert!(out.contains("body{margin:0}"), "{out}");
        assert!(
            out.contains(".a:where(.S) .theme-dark b:where(.S){x:y}"),
            "{out}"
        );
        assert!(
            out.contains("@media (min-width: 600px){.a:where(.S){x:y}}"),
            "{out}"
        );
        assert!(
            out.contains("@keyframes spin{from {rotate: 0}to {rotate: 1turn}}"),
            "{out}"
        );
        assert!(
            out.contains("a[href^=\"http:\"]:where(.S){x:\"}\"}"),
            "{out}"
        );
        assert!(!out.contains("note"), "comments are dropped: {out}");
    }

    #[test]
    fn tailwind_directives_pass_through_scoped() {
        let (out, errs) = css(concat!(
            ".btn { @apply px-4 py-2 rounded; color: theme(--color-red-500) }\n",
            "@variant md { .btn { @apply text-lg } }\n",
            ".tab { @variant hover { color: {accent}; @variant dark { x: y } } }\n",
        ));
        assert!(errs.is_empty(), "{errs:?}");
        assert!(
            out.contains(".btn:where(.S){@apply px-4 py-2 rounded;color:theme(--color-red-500)}"),
            "{out}"
        );
        assert!(
            out.contains("@variant md{.btn:where(.S){@apply text-lg}}"),
            "{out}"
        );
        assert!(
            out.contains(".tab:where(.S){@variant hover{color:var(--S-0);@variant dark{x:y}}}"),
            "{out}"
        );
    }

    #[test]
    fn interpolations_become_custom_properties() {
        let (c, d) = compile(
            "Card",
            "p { color: {accent}; border: 1px solid { props.edge } }",
            10,
        );
        assert!(d.is_empty(), "{d:?}");
        assert_eq!(c.vars.len(), 2);
        assert_eq!(c.vars[0], ("accent".to_string(), 10 + 12));
        assert_eq!(c.vars[1].0, "props.edge");
        assert!(
            c.css.contains(&format!("color:var(--{}-0);", c.class)),
            "{}",
            c.css
        );
        assert!(
            c.css.contains(&format!("1px solid var(--{}-1)", c.class)),
            "{}",
            c.css
        );
    }

    #[test]
    fn repeated_interpolations_share_a_property() {
        let (c, d) = compile(
            "Card",
            "p { color: {hue} } a { fill: {hue}; x: {other} }",
            0,
        );
        assert!(d.is_empty(), "{d:?}");
        assert_eq!(c.vars.len(), 2, "{:?}", c.vars);
        assert_eq!(
            c.css.matches(&format!("var(--{}-0)", c.class)).count(),
            2,
            "{}",
            c.css
        );
        assert!(
            c.css.contains(&format!("x:var(--{}-1)", c.class)),
            "{}",
            c.css
        );
    }

    #[test]
    fn unsupported_forms_are_reported() {
        let (_, e) = css("@import url(x.css);");
        assert!(e[0].contains("`@import` is not supported"), "{e:?}");
        let (_, e) = css(".a { &:hover { x: y } }");
        assert!(e[0].contains("nested rule"), "{e:?}");
        let (_, e) = css(".a:global(.b) { x: y }");
        assert!(e[0].contains("whole compound"), "{e:?}");
        let (_, e) = css(".a { x: y ");
        assert!(e[0].contains("unclosed"), "{e:?}");
    }

    #[test]
    fn output_is_safe_inside_a_style_element() {
        let (c, _) = compile("Card", "a::after { content: \"</style><script>\" }", 0);
        assert!(!c.css.contains("</"), "{}", c.css);
    }

    #[test]
    fn scope_class_is_stable_and_distinct() {
        assert_eq!(scope_class("A", "p{}"), scope_class("A", "p{}"));
        assert_ne!(scope_class("A", "p{}"), scope_class("B", "p{}"));
        assert!(scope_class("A", "").starts_with("w-"));
    }
}
