use std::ops::Range;

use weft_compiler::lexer::scan_template;

const TAB: usize = 2;

#[derive(Debug, Default)]
pub struct Block {
    pub lines: Vec<String>,
    pub lead_blank: bool,
    pub trail_blank: bool,
}

impl Block {
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        for l in &self.lines {
            out.push_str(l);
            out.push('\n');
        }
        out
    }
}

pub fn template_ranges(src: &str) -> Option<Vec<Range<usize>>> {
    let s = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            b'/' if s.get(i + 1) == Some(&b'/') => {
                while i < s.len() && s[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if s.get(i + 1) == Some(&b'*') => {
                let end = src[i + 2..].find("*/")?;
                i += 2 + end + 1;
            }
            b'/' if regex_may_start(&s[..i]) => {
                i += 1;
                let mut class = false;
                loop {
                    match s.get(i) {
                        None | Some(b'\n') => return None,
                        Some(b'\\') => i += 1,
                        Some(b'[') => class = true,
                        Some(b']') => class = false,
                        Some(b'/') if !class => break,
                        Some(_) => {}
                    }
                    i += 1;
                }
            }
            q @ (b'\'' | b'"') => {
                i += 1;
                loop {
                    match s.get(i) {
                        None | Some(b'\n') => return None,
                        Some(b'\\') => i += 2,
                        Some(&c) if c == q => break,
                        Some(_) => i += 1,
                    }
                }
            }
            b'`' => {
                let end = scan_template(s, i + 1).0?;
                out.push(i + 1..end);
                i = end;
            }
            _ => {}
        }
        i += 1;
    }
    Some(out)
}

fn regex_may_start(before: &[u8]) -> bool {
    let end = before.iter().rposition(|c| !c.is_ascii_whitespace());
    let Some(end) = end else { return true };
    let c = before[end];
    if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' {
        let start = before[..=end]
            .iter()
            .rposition(|c| !(c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$'))
            .map_or(0, |p| p + 1);
        let word = &before[start..=end];
        return matches!(
            word,
            b"return" | b"typeof" | b"instanceof" | b"in" | b"of" | b"new" | b"delete" | b"void" | b"throw"
                | b"case" | b"do" | b"else" | b"yield" | b"await"
        );
    }
    !matches!(c, b')' | b']' | b'}' | b'"' | b'\'' | b'`')
}

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\x0c')
}

fn indent_width(line: &str) -> usize {
    line.chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { TAB } else { 1 })
        .sum()
}

pub fn reindent(text: &str, first_col: usize, base: usize) -> Block {
    let protected = template_ranges(text);
    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut at = 0;
    for l in text.split('\n') {
        lines.push((at, l));
        at += l.len() + 1;
    }
    let inside = |off: usize| match &protected {
        Some(rs) => rs.iter().any(|r| off > r.start && off <= r.end),
        None => off > 0,
    };
    let width = |i: usize, l: &str| {
        let w = indent_width(l);
        if i == 0 {
            w + first_col
        } else {
            w
        }
    };
    let min = lines
        .iter()
        .enumerate()
        .filter(|(_, (off, l))| !inside(*off) && !l.trim_matches(is_ws).is_empty())
        .map(|(i, (_, l))| width(i, l))
        .min()
        .unwrap_or(0);

    let last = lines.iter().rposition(|(_, l)| !l.trim_matches(is_ws).is_empty());
    let mut block = Block::default();
    let mut blank = false;
    let mut seen = false;
    for (i, (off, l)) in lines.iter().enumerate() {
        if last.is_some_and(|last| i > last) {
            break;
        }
        if inside(*off) {
            if blank && seen {
                block.lines.push(String::new());
            }
            blank = false;
            seen = true;
            block.lines.push(l.trim_end_matches('\r').to_string());
            continue;
        }
        let t = l.trim_matches(is_ws);
        if t.is_empty() {
            blank |= i > 0;
            continue;
        }
        if blank {
            if seen {
                block.lines.push(String::new());
            } else {
                block.lead_blank = true;
            }
        }
        blank = false;
        seen = true;
        let pad = base + width(i, l) - min;
        block
            .lines
            .push(format!("{}{}", " ".repeat(pad), l.trim_matches(is_ws)));
    }
    if seen {
        let tail: Vec<&str> = text
            .rsplit('\n')
            .take_while(|l| l.trim_matches(is_ws).is_empty())
            .collect();
        block.trail_blank = tail.len() >= 2;
    }
    block
}

pub fn tidy_header(src: &str) -> String {
    let src = src.trim_matches(|c| is_ws(c) || c == '\n');
    if src.contains('\n') || src.contains("//") || src.contains("/*") || src.contains('`') {
        return src.to_string();
    }
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut space = false;
    let mut escape = false;
    for c in src.chars() {
        if let Some(q) = quote {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        if c == ' ' || c == '\t' {
            space = true;
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
        }
        out.push(c);
    }
    out
}

pub fn column(src: &str, at: usize) -> usize {
    let line_start = src[..at].rfind('\n').map_or(0, |i| i + 1);
    src[line_start..at]
        .chars()
        .map(|c| if c == '\t' { TAB } else { 1 })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shifts_as_a_block() {
        let b = reindent("\n      a {\n        b\n      }\n", 0, 2);
        assert_eq!(b.lines, ["  a {", "    b", "  }"]);
        assert!(!b.lead_blank && !b.trail_blank);
    }

    #[test]
    fn blank_lines_collapse_and_edges_are_reported() {
        let b = reindent("\n\n  a\n\n\n\n  b\n\n  ", 0, 0);
        assert_eq!(b.lines, ["a", "", "b"]);
        assert!(b.lead_blank && b.trail_blank);
    }

    #[test]
    fn first_line_counts_from_its_column() {
        let b = reindent("f() {\n    x\n  }", 2, 0);
        assert_eq!(b.lines, ["f() {", "  x", "}"]);
    }

    #[test]
    fn template_literal_lines_are_untouched() {
        let src = "  const s = `a\n      b   \n`\n  x";
        let b = reindent(src, 0, 0);
        assert_eq!(b.lines, ["const s = `a", "      b   ", "`", "x"]);
    }

    #[test]
    fn unsure_scans_keep_the_lines() {
        let b = reindent("  if (a) /'/.test(s)\n      b\n\n  ", 0, 0);
        assert_eq!(b.lines, ["if (a) /'/.test(s)", "      b"]);
        assert!(b.trail_blank);
    }

    #[test]
    fn regular_expressions_are_skipped() {
        let src = "  const r = /[\"`/]/g\n    x = `a\n  b`";
        assert_eq!(template_ranges(src.trim_start()).map(|r| r.len()), Some(1));
        let b = reindent(src, 0, 0);
        assert_eq!(b.lines, ["const r = /[\"`/]/g", "  x = `a", "  b`"]);
        assert_eq!(template_ranges("a / b / `c`").map(|r| r.len()), Some(1));
    }

    #[test]
    fn headers_collapse_outside_strings() {
        assert_eq!(
            tidy_header("component  A(x:  \"a  b\")  "),
            "component A(x: \"a  b\")"
        );
        assert_eq!(tidy_header("action a(\n x)"), "action a(\n x)");
    }
}
