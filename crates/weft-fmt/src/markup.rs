use weft_compiler::lexer::is_ident_continue;
use weft_compiler::markup::VOID_ELEMENTS;

pub const WIDTH: usize = 100;

const VERBATIM: &[&str] = &["pre", "textarea", "script", "style", "title"];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Open,
    Close,
    BlockOpen,
    BlockMid,
    BlockClose,
    Atom,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Ws {
    None,
    Space,
    Lines(usize),
}

#[derive(Debug)]
struct Tag {
    name: String,
    attrs: Vec<String>,
    self_closing: bool,
    rest: String,
}

#[derive(Debug)]
struct Chunk {
    kind: Kind,
    ws: Ws,
    text: String,
    tag: Option<Tag>,
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

struct Scan<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
}

impl<'a> Scan<'a> {
    fn at(&self, lit: &str) -> bool {
        self.s[self.i..].starts_with(lit)
    }

    fn at_ci(&self, lit: &str) -> bool {
        self.b.len() >= self.i + lit.len()
            && self.b[self.i..self.i + lit.len()].eq_ignore_ascii_case(lit.as_bytes())
    }

    fn ws(&mut self) -> Ws {
        let start = self.i;
        while self.i < self.b.len() && is_ws(self.b[self.i]) {
            self.i += 1;
        }
        if self.i == start {
            return Ws::None;
        }
        match self.s[start..self.i].matches('\n').count() {
            0 => Ws::Space,
            n => Ws::Lines(n),
        }
    }

    fn name(&mut self) -> &'a str {
        let start = self.i;
        while let Some(c) = self.s[self.i..].chars().next() {
            if is_ident_continue(c) || matches!(c, '-' | '.' | ':') {
                self.i += c.len_utf8();
            } else {
                break;
            }
        }
        &self.s[start..self.i]
    }

    fn braces(&mut self) -> Option<()> {
        let mut depth = 1;
        while self.i < self.b.len() {
            let c = self.b[self.i];
            self.i += 1;
            match c {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(());
                    }
                }
                q @ (b'"' | b'\'' | b'`') => {
                    while self.i < self.b.len() {
                        let d = self.b[self.i];
                        self.i += 1;
                        if d == b'\\' {
                            self.i += 1;
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

    fn parens(&mut self) {
        let mut depth = 0usize;
        let mut quote: Option<u8> = None;
        while self.i < self.b.len() {
            let c = self.b[self.i];
            if quote.is_none() && depth > 0 && (c == b'>' || c == b'\n') {
                break;
            }
            self.i += 1;
            match quote {
                Some(_) if c == b'\\' => self.i += 1,
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None => match c {
                    b'"' | b'\'' => quote = Some(c),
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                },
            }
        }
    }

    fn attr(&mut self) -> Option<String> {
        let start = self.i;
        let event = self.b[self.i] == b'@';
        if event || self.b[self.i] == b':' {
            self.i += 1;
        }
        if self.name().is_empty() {
            return None;
        }
        while event && self.b.get(self.i) == Some(&b'(') {
            self.parens();
            self.name();
        }
        let name = &self.s[start..self.i];
        let save = self.i;
        self.ws();
        if self.b.get(self.i) != Some(&b'=') {
            self.i = save;
            return Some(name.to_string());
        }
        self.i += 1;
        self.ws();
        let vstart = self.i;
        match self.b.get(self.i)? {
            q @ (b'"' | b'\'') => {
                let q = *q;
                self.i += 1;
                let end = self.s[self.i..].find(q as char)?;
                self.i += end + 1;
            }
            b'{' => {
                self.i += 1;
                self.braces()?;
            }
            _ => return None,
        }
        Some(format!("{name}={}", &self.s[vstart..self.i]))
    }

    fn tag(&mut self) -> Option<(Kind, Tag)> {
        self.i += 1;
        let name = self.name().to_string();
        if name.is_empty() {
            return None;
        }
        let mut attrs = Vec::new();
        let self_closing;
        loop {
            self.ws();
            if self.at("/>") {
                self.i += 2;
                self_closing = true;
                break;
            }
            match self.b.get(self.i)? {
                b'>' => {
                    self.i += 1;
                    self_closing = false;
                    break;
                }
                _ => attrs.push(self.attr()?),
            }
        }
        let lower = name.to_ascii_lowercase();
        let mut tag = Tag {
            name,
            attrs,
            self_closing,
            rest: String::new(),
        };
        if self_closing || VOID_ELEMENTS.contains(&lower.as_str()) {
            return Some((Kind::Atom, tag));
        }
        if VERBATIM.contains(&lower.as_str()) {
            let start = self.i;
            let close = format!("</{lower}");
            loop {
                if self.i >= self.b.len() {
                    return None;
                }
                if self.at_ci(&close)
                    && self
                        .b
                        .get(self.i + close.len())
                        .map_or(true, |&c| c == b'>' || c == b'/' || is_ws(c))
                {
                    break;
                }
                self.i += 1;
            }
            let end = self.s[self.i..].find('>')? + self.i + 1;
            tag.rest = self.s[start..end].to_string();
            self.i = end;
            return Some((Kind::Atom, tag));
        }
        Some((Kind::Open, tag))
    }

    fn chunk(&mut self, ws: Ws) -> Option<Chunk> {
        let start = self.i;
        let plain = |kind, text: &str| Chunk {
            kind,
            ws,
            text: text.to_string(),
            tag: None,
        };
        if self.at("<!--") {
            let end = if self.at("<!-->") {
                start + 5
            } else if self.at("<!--->") {
                start + 6
            } else {
                self.s[start + 4..].find("-->")? + start + 7
            };
            self.i = end;
            return Some(plain(Kind::Atom, &self.s[start..end]));
        }
        if self.at("<!") {
            self.i = self.s[start..].find('>')? + start + 1;
            return Some(plain(Kind::Atom, &self.s[start..self.i]));
        }
        if self.at("</") {
            self.i += 2;
            let name = self.name();
            self.ws();
            if self.b.get(self.i) != Some(&b'>') {
                return None;
            }
            self.i += 1;
            return Some(plain(Kind::Close, &format!("</{name}>")));
        }
        if self.at("<") {
            let (kind, tag) = self.tag()?;
            return Some(Chunk {
                kind,
                ws,
                text: String::new(),
                tag: Some(tag),
            });
        }
        if self.at("{") {
            self.i += 1;
            self.braces()?;
            let src = &self.s[start..self.i];
            let inner = src[1..src.len() - 1].trim();
            let kind = match inner.as_bytes().first() {
                Some(b'#') => Kind::BlockOpen,
                Some(b':') => Kind::BlockMid,
                Some(b'/') => Kind::BlockClose,
                _ => Kind::Atom,
            };
            let text = if src.contains('\n') {
                src.to_string()
            } else {
                format!("{{{inner}}}")
            };
            return Some(plain(kind, &text));
        }
        while self.i < self.b.len()
            && !is_ws(self.b[self.i])
            && !matches!(self.b[self.i], b'<' | b'{')
        {
            self.i += 1;
        }
        Some(plain(Kind::Atom, &self.s[start..self.i]))
    }
}

fn indent(depth: usize) -> String {
    "  ".repeat(depth)
}

fn column(out: &str) -> usize {
    out[out.rfind('\n').map_or(0, |i| i + 1)..].chars().count()
}

fn render_tag(tag: &Tag, depth: usize, col: usize) -> String {
    let end = if tag.self_closing { "/>" } else { ">" };
    let mut one = format!("<{}", tag.name);
    for a in &tag.attrs {
        one.push(' ');
        one.push_str(a);
    }
    if tag.self_closing {
        one.push(' ');
    }
    one.push_str(end);
    let multiline = tag.attrs.iter().any(|a| a.contains('\n'));
    let out = if multiline || (tag.attrs.len() >= 2 && col + one.chars().count() > WIDTH) {
        let mut s = format!("<{}", tag.name);
        for a in &tag.attrs {
            s.push('\n');
            s.push_str(&indent(depth + 1));
            s.push_str(a);
        }
        s.push('\n');
        s.push_str(&indent(depth));
        s.push_str(end);
        s
    } else {
        one
    };
    out + &tag.rest
}

pub fn layout(body: &str, depth: usize) -> Option<String> {
    let mut scan = Scan {
        s: body,
        b: body.as_bytes(),
        i: 0,
    };
    let mut chunks = Vec::new();
    let trailing = loop {
        let ws = scan.ws();
        if scan.i >= body.len() {
            break ws;
        }
        chunks.push(scan.chunk(ws)?);
    };

    let mut out = String::new();
    let mut level = depth;
    let mut prev: Option<Kind> = None;
    for c in &chunks {
        let closer = matches!(c.kind, Kind::Close | Kind::BlockClose | Kind::BlockMid);
        let d = if closer {
            level.saturating_sub(1)
        } else {
            level
        };
        match c.ws {
            Ws::None => {}
            Ws::Space => out.push(' '),
            Ws::Lines(n) => {
                let opener = matches!(
                    prev,
                    None | Some(Kind::Open | Kind::BlockOpen | Kind::BlockMid)
                );
                out.push('\n');
                if n >= 2 && !opener && !closer {
                    out.push('\n');
                }
                out.push_str(&indent(d));
            }
        }
        match &c.tag {
            Some(tag) => {
                let col = column(&out);
                out.push_str(&render_tag(tag, d, col));
            }
            None => out.push_str(&c.text),
        }
        match c.kind {
            Kind::Open | Kind::BlockOpen => level += 1,
            Kind::Close | Kind::BlockClose => level = level.saturating_sub(1),
            _ => {}
        }
        prev = Some(c.kind);
    }
    match trailing {
        Ws::None => {}
        Ws::Space => out.push(' '),
        Ws::Lines(_) => {
            out.push('\n');
            out.push_str(&indent(depth.saturating_sub(1)));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::layout;

    #[test]
    fn nests_by_depth() {
        let src = "\n<ul>\n<li>{a}</li>\n        <li>b</li>\n</ul>\n";
        assert_eq!(
            layout(src, 2).unwrap(),
            "\n    <ul>\n      <li>{a}</li>\n      <li>b</li>\n    </ul>\n  "
        );
    }

    #[test]
    fn blocks_indent_their_arms() {
        let src = "\n{#if  x }\n<p>a</p>\n{:else}\n<p>b</p>\n{/if}\n";
        assert_eq!(
            layout(src, 1).unwrap(),
            "\n  {#if  x}\n    <p>a</p>\n  {:else}\n    <p>b</p>\n  {/if}\n"
        );
    }

    #[test]
    fn touching_chunks_still_touch_and_spaces_stay_spaces() {
        let src = "<p>a<b>b</b>   c {x}</p>";
        assert_eq!(layout(src, 0).unwrap(), "<p>a<b>b</b> c {x}</p>");
    }

    #[test]
    fn long_tags_break_one_attribute_per_line() {
        let attrs = (0..8)
            .map(|i| format!("data-attribute-{i}=\"value\""))
            .collect::<Vec<_>>();
        let src = format!("\n<input {} />\n", attrs.join(" "));
        let out = layout(&src, 1).unwrap();
        assert!(
            out.starts_with("\n  <input\n    data-attribute-0=\"value\"\n"),
            "{out}"
        );
        assert!(out.ends_with("data-attribute-7=\"value\"\n  />\n"), "{out}");
        assert_eq!(layout(&out, 1).unwrap(), out);
    }

    #[test]
    fn whitespace_sensitive_elements_are_verbatim() {
        let src = "\n<pre>  a\n     b </pre>\n   <p  class = \"x\">y</p>";
        assert_eq!(
            layout(src, 1).unwrap(),
            "\n  <pre>  a\n     b </pre>\n  <p class=\"x\">y</p>"
        );
    }

    #[test]
    fn comments_are_kept() {
        let src = "\n<!-- a\n  b -->\n<p/>\n";
        assert_eq!(layout(src, 1).unwrap(), "\n  <!-- a\n  b -->\n  <p />\n");
    }
}
