mod markup;
mod text;

use std::fmt;

use weft_compiler::ast::{Component, Item, SourceFile};
use weft_compiler::{parse, Diagnostic, Severity};

pub use markup::WIDTH;
use text::{column, reindent, tidy_header, Block};

#[derive(Debug)]
pub enum Error {
    Syntax(Vec<Diagnostic>),
    Unsafe(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Syntax(d) => write!(f, "{} syntax error(s); fix them first", d.len()),
            Error::Unsafe(why) => write!(
                f,
                "formatting would {why}; the file was left unchanged (please report this)"
            ),
        }
    }
}

impl std::error::Error for Error {}

pub fn format(src_in: &str) -> Result<String, Error> {
    let src = src_in
        .strip_prefix('\u{feff}')
        .unwrap_or(src_in)
        .replace("\r\n", "\n");
    let (file, diags) = parse(&src);
    let errors: Vec<Diagnostic> = diags
        .into_iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    if !errors.is_empty() {
        return Err(Error::Syntax(errors));
    }
    let out = render(&src, &file);
    verify(&src, &file, &out)?;
    let crlf = src_in
        .find('\n')
        .is_some_and(|i| src_in[..i].ends_with('\r'));
    Ok(if crlf { out.replace('\n', "\r\n") } else { out })
}

fn verify(src: &str, file: &SourceFile, out: &str) -> Result<(), Error> {
    let strip = |s: &str| -> String { s.chars().filter(|c| !is_ws(*c)).collect() };
    if strip(src) != strip(out) {
        return Err(Error::Unsafe("change more than whitespace"));
    }
    let (again, diags) = parse(out);
    if diags.iter().any(|d| d.severity == Severity::Error) {
        return Err(Error::Unsafe("introduce a syntax error"));
    }
    if shape(file) != shape(&again) {
        return Err(Error::Unsafe("change the syntax tree"));
    }
    Ok(())
}

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

fn shape(file: &SourceFile) -> String {
    let debug = format!("{file:?}");
    let mut out = String::with_capacity(debug.len());
    let mut it = debug.chars().peekable();
    while let Some(c) = it.next() {
        if c == '"' {
            let mut s = String::new();
            loop {
                match it.next() {
                    None | Some('"') => break,
                    Some('\\') => match it.next() {
                        Some('n' | 't' | 'r') => s.push(' '),
                        Some(e) => {
                            s.push('\\');
                            s.push(e);
                        }
                        None => break,
                    },
                    Some(ch) => s.push(ch),
                }
            }
            out.push('"');
            out.push_str(&s.split_ascii_whitespace().collect::<Vec<_>>().join(" "));
            out.push('"');
        } else if c.is_ascii_digit() {
            while it.peek().is_some_and(char::is_ascii_digit) {
                it.next();
            }
            out.push('#');
        } else {
            out.push(c);
        }
    }
    out
}

fn render(src: &str, file: &SourceFile) -> String {
    let mut out = String::new();
    let mut pos = 0;
    for (n, item) in file.items.iter().enumerate() {
        let span = item.span();
        gap(&mut out, &src[pos..span.start], n == 0);
        out.push_str(&format_item(src, item));
        pos = span.end;
    }
    if file.items.is_empty() {
        out.push_str(&reindent(&format!("\n{src}"), 0, 0).render());
        return out;
    }
    let rest = &src[pos..];
    let (tail, more) = rest.split_once('\n').unwrap_or((rest, ""));
    push_tail(&mut out, tail);
    let block = reindent(&format!("\n{more}"), 0, 0);
    out.push('\n');
    if !block.is_empty() {
        if block.lead_blank || more.starts_with('\n') {
            out.push('\n');
        }
        out.push_str(&block.render());
    }
    out
}

fn push_tail(out: &mut String, tail: &str) {
    let tail = tail.trim_matches(is_ws);
    if !tail.is_empty() {
        out.push(' ');
        out.push_str(tail);
    }
}

fn gap(out: &mut String, g: &str, first: bool) {
    let rest = if first {
        format!("\n{g}")
    } else {
        match g.split_once('\n') {
            None => {
                out.push_str(if g.trim_matches(is_ws).is_empty() && !g.is_empty() {
                    " "
                } else {
                    g
                });
                return;
            }
            Some((tail, rest)) => {
                push_tail(out, tail);
                format!("\n{rest}")
            }
        }
    };
    let cut = rest.rfind('\n').unwrap_or(0) + 1;
    let (middle, head) = rest.split_at(cut);
    let block = reindent(middle, 0, 0);
    if !first {
        out.push('\n');
        let blank = block.is_empty() && middle.matches('\n').count() >= 2;
        if block.lead_blank || blank {
            out.push('\n');
        }
    }
    out.push_str(&block.render());
    if !block.is_empty() && block.trail_blank {
        out.push('\n');
    }
    let head = head.trim_matches(is_ws);
    if !head.is_empty() {
        out.push_str(head);
        out.push(' ');
    }
}

fn format_item(src: &str, item: &Item) -> String {
    match item {
        Item::Component(c) => format_component(src, c),
        Item::Model(m) => braced(src, m.span.start, m.body.start, m.body.end),
        Item::Action(a) => {
            let start = a.body_offset;
            if src.as_bytes().get(start.wrapping_sub(1)) != Some(&b'{') {
                return src[a.span.start..a.span.end].to_string();
            }
            braced(src, a.span.start, start, start + a.body.len())
        }
        Item::Store(_) | Item::Placed(_) | Item::Actor(_) => {
            let span = item.span();
            let text = &src[span.start..span.end];
            declaration(text)
                .unwrap_or_else(|| reindent(text, column(src, span.start), 0).lines.join("\n"))
        }
    }
}

fn declaration(text: &str) -> Option<String> {
    let (first, rest) = text.split_once('\n')?;
    let (middle, last) = rest.rsplit_once('\n')?;
    let first = first.trim_end_matches(is_ws);
    let last = last.trim_matches(is_ws);
    if !first.ends_with('{') || !last.starts_with('}') || first.contains('`') || last.contains('`')
    {
        return None;
    }
    let body = reindent(&format!("\n{middle}\n"), 0, 2);
    Some(format!("{first}\n{}{last}", body.render()))
}

fn braced(src: &str, start: usize, body_start: usize, body_end: usize) -> String {
    let mut out = tidy_header(&src[start..body_start - 1]);
    out.push_str(" {");
    let body = reindent(&src[body_start..body_end], column(src, body_start), 2);
    if body.is_empty() {
        out.push('}');
    } else {
        out.push('\n');
        out.push_str(&body.render());
        out.push('}');
    }
    out
}

fn format_component(src: &str, c: &Component) -> String {
    let verbatim = || src[c.span.start..c.span.end].to_string();
    let view_brace = c.view.span.start - 1;
    let Some(kw) = src[c.body.start..view_brace].rfind("view") else {
        return verbatim();
    };
    let kw = c.body.start + kw;
    if !src[kw + 4..view_brace].trim_matches(is_ws).is_empty() {
        return verbatim();
    }
    let mut out = tidy_header(&src[c.span.start..c.body.start - 1]);
    out.push_str(" {\n");

    let members: Block = reindent(&src[c.body.start..kw], column(src, c.body.start), 2);
    out.push_str(&members.render());
    if !members.is_empty() && members.trail_blank {
        out.push('\n');
    }

    let body = &src[c.view.span.start..c.view.span.end];
    out.push_str("  view {");
    out.push_str(&markup::layout(body, 2).unwrap_or_else(|| body.to_string()));
    out.push('}');

    let after_start = c.view.span.end + 1;
    let after = reindent(&src[after_start..c.body.end], column(src, after_start), 2);
    if !after.is_empty() {
        out.push('\n');
        if after.lead_blank {
            out.push('\n');
        }
        out.push_str(&after.lines.join("\n"));
    }
    out.push_str("\n}");
    out
}

#[cfg(test)]
mod tests;
