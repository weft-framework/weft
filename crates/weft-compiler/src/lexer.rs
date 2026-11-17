use crate::diagnostics::Diagnostic;
use crate::token::{Keyword, Span, Token, TokenKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    pub span: Span,
    pub block: bool,
    pub own_line: bool,
    pub blank_before: bool,
}

pub struct Lexer<'a> {
    src: &'a str,
    chars: Vec<(usize, char)>,
    pos: usize,
    diagnostics: Vec<Diagnostic>,
    comments: Vec<Comment>,
}

impl<'a> Lexer<'a> {
    pub fn new(src: &'a str) -> Self {
        Self {
            src,
            chars: src.char_indices().collect(),
            pos: 0,
            diagnostics: Vec::new(),
            comments: Vec::new(),
        }
    }

    pub fn run(self) -> (Vec<Token>, Vec<Diagnostic>) {
        let (tokens, _, diags) = self.run_with_comments();
        (tokens, diags)
    }

    pub fn run_with_comments(mut self) -> (Vec<Token>, Vec<Comment>, Vec<Diagnostic>) {
        let mut tokens = Vec::new();
        loop {
            self.skip_trivia();
            let start = self.offset();
            let Some(ch) = self.peek() else {
                tokens.push(Token::new(TokenKind::Eof, Span::new(start, start)));
                break;
            };
            let kind = if is_ident_start(ch) || (ch == '\\' && self.peek2() == Some('u')) {
                self.lex_ident_or_keyword()
            } else if ch.is_ascii_digit() {
                self.lex_number()
            } else if ch == '"' || ch == '\'' {
                self.lex_string(ch)
            } else if ch == '`' {
                self.lex_template()
            } else {
                self.lex_punct(ch)
            };
            let span = Span::new(start, self.offset());
            if let Some(kind) = kind {
                tokens.push(Token::new(kind, span));
            }
        }
        (tokens, self.comments, self.diagnostics)
    }

    fn note_comment(&mut self, start: usize, block: bool) {
        let before = &self.src[..start];
        let line = &before[before.rfind('\n').map_or(0, |i| i + 1)..];
        let gap_start = self
            .comments
            .last()
            .map_or(0, |c| c.span.end)
            .max(before.trim_end().len());
        let gap = &self.src[gap_start..start];
        let preceded = !before.trim().is_empty();
        self.comments.push(Comment {
            span: Span::new(start, self.offset()),
            block,
            own_line: line.trim().is_empty(),
            blank_before: preceded && gap.matches('\n').count() >= 2,
        });
    }

    fn offset(&self) -> usize {
        match self.chars.get(self.pos) {
            Some(&(off, _)) => off,
            None => self.src.len(),
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).map(|&(_, c)| c)
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.pos + 1).map(|&(_, c)| c)
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn eat(&mut self, want: char) -> bool {
        if self.peek() == Some(want) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn skip_trivia(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => {
                    self.bump();
                }
                Some('/') if self.peek2() == Some('/') => {
                    let start = self.offset();
                    while let Some(c) = self.peek() {
                        if c == '\n' {
                            break;
                        }
                        self.bump();
                    }
                    self.note_comment(start, false);
                }
                Some('/') if self.peek2() == Some('*') => {
                    let start = self.offset();
                    self.bump();
                    self.bump();
                    loop {
                        match self.bump() {
                            Some('*') if self.peek() == Some('/') => {
                                self.bump();
                                break;
                            }
                            Some(_) => {}
                            None => {
                                self.diagnostics.push(Diagnostic::error(
                                    "unterminated block comment",
                                    Span::new(start, self.offset()),
                                ));
                                break;
                            }
                        }
                    }
                    self.note_comment(start, true);
                }
                _ => break,
            }
        }
    }

    fn lex_ident_or_keyword(&mut self) -> Option<TokenKind> {
        let mut text = String::new();
        let mut escaped = false;
        loop {
            match self.peek() {
                Some('\\') if self.peek2() == Some('u') => {
                    let start = self.offset();
                    escaped = true;
                    match self.lex_unicode_escape() {
                        Some(c)
                            if (text.is_empty() && is_ident_start(c))
                                || (!text.is_empty() && is_ident_continue(c)) =>
                        {
                            text.push(c);
                        }
                        _ => {
                            self.diagnostics.push(Diagnostic::error(
                                "invalid escape in identifier",
                                Span::new(start, self.offset()),
                            ));
                        }
                    }
                }
                Some(c) if (text.is_empty() && is_ident_start(c)) || is_ident_continue(c) => {
                    text.push(c);
                    self.bump();
                }
                _ => break,
            }
        }
        if text.is_empty() {
            return None;
        }
        Some(match Keyword::from_ident(&text) {
            Some(kw) if !escaped => TokenKind::Keyword(kw),
            _ => TokenKind::Ident(text),
        })
    }

    fn lex_unicode_escape(&mut self) -> Option<char> {
        self.bump();
        self.bump();
        let mut digits = String::new();
        if self.eat('{') {
            while let Some(c) = self.peek() {
                if c == '}' {
                    break;
                }
                if !c.is_ascii_hexdigit() || digits.len() >= 6 {
                    return None;
                }
                digits.push(c);
                self.bump();
            }
            if !self.eat('}') || digits.is_empty() {
                return None;
            }
        } else {
            for _ in 0..4 {
                match self.peek() {
                    Some(c) if c.is_ascii_hexdigit() => {
                        digits.push(c);
                        self.bump();
                    }
                    _ => return None,
                }
            }
        }
        u32::from_str_radix(&digits, 16)
            .ok()
            .and_then(char::from_u32)
    }

    fn lex_number(&mut self) -> Option<TokenKind> {
        let start = self.pos;
        if self.peek() == Some('0') {
            if let Some(p) = self.peek2() {
                if matches!(p, 'x' | 'X' | 'b' | 'B' | 'o' | 'O') {
                    self.bump();
                    self.bump();
                    while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == '_') {
                        self.bump();
                    }
                    return Some(self.slice_number(start));
                }
            }
        }
        self.eat_digits();
        if self.peek() == Some('.') && matches!(self.peek2(), Some(c) if c.is_ascii_digit()) {
            self.bump();
            self.eat_digits();
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.bump();
            if matches!(self.peek(), Some('+' | '-')) {
                self.bump();
            }
            self.eat_digits();
        }
        Some(self.slice_number(start))
    }

    fn eat_digits(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == '_') {
            self.bump();
        }
    }

    fn slice_number(&self, start: usize) -> TokenKind {
        let text: String = self.chars[start..self.pos]
            .iter()
            .map(|&(_, c)| c)
            .collect();
        TokenKind::Number(text)
    }

    fn lex_string(&mut self, quote: char) -> Option<TokenKind> {
        let open = self.offset();
        self.bump();
        let body_start = self.pos;
        loop {
            match self.bump() {
                Some('\\') => {
                    self.bump();
                }
                Some(c) if c == quote => break,
                Some('\n') | None => {
                    self.diagnostics.push(Diagnostic::error(
                        "unterminated string literal",
                        Span::new(open, self.offset()),
                    ));
                    break;
                }
                Some(_) => {}
            }
        }
        let end = if self.pos > body_start {
            self.pos - 1
        } else {
            body_start
        };
        let text: String = self.chars[body_start..end]
            .iter()
            .map(|&(_, c)| c)
            .collect();
        Some(TokenKind::Str(text))
    }

    fn lex_template(&mut self) -> Option<TokenKind> {
        let open = self.offset();
        let body = open + 1;
        let (close, _) = scan_template(self.src.as_bytes(), body);
        let end = match close {
            Some(close) => close,
            None => {
                self.diagnostics.push(Diagnostic::error(
                    "unterminated template literal",
                    Span::new(open, self.src.len()),
                ));
                self.src.len()
            }
        };
        let stop = close.map_or(self.src.len(), |c| c + 1);
        while self.pos < self.chars.len() && self.chars[self.pos].0 < stop {
            self.pos += 1;
        }
        Some(TokenKind::Template(self.src[body..end].to_string()))
    }

    fn lex_punct(&mut self, ch: char) -> Option<TokenKind> {
        use TokenKind::*;
        let kind = match ch {
            '(' => {
                self.bump();
                LParen
            }
            ')' => {
                self.bump();
                RParen
            }
            '{' => {
                self.bump();
                LBrace
            }
            '}' => {
                self.bump();
                RBrace
            }
            '[' => {
                self.bump();
                LBracket
            }
            ']' => {
                self.bump();
                RBracket
            }
            '<' => {
                self.bump();
                Lt
            }
            '>' => {
                self.bump();
                Gt
            }
            '=' => {
                self.bump();
                if self.eat('=') {
                    if self.eat('=') {
                        EqEqEq
                    } else {
                        EqEq
                    }
                } else if self.eat('>') {
                    FatArrow
                } else {
                    Eq
                }
            }
            '+' => {
                self.bump();
                Plus
            }
            '-' => {
                self.bump();
                Minus
            }
            '*' => {
                self.bump();
                Star
            }
            '/' => {
                self.bump();
                Slash
            }
            '%' => {
                self.bump();
                Percent
            }
            ',' => {
                self.bump();
                Comma
            }
            '.' => {
                self.bump();
                if self.peek() == Some('.') && self.peek2() == Some('.') {
                    self.bump();
                    self.bump();
                    DotDotDot
                } else {
                    Dot
                }
            }
            ':' => {
                self.bump();
                Colon
            }
            ';' => {
                self.bump();
                Semicolon
            }
            '?' => {
                self.bump();
                Question
            }
            '@' => {
                self.bump();
                At
            }
            '&' => {
                self.bump();
                if self.eat('&') {
                    AmpAmp
                } else {
                    Amp
                }
            }
            '|' => {
                self.bump();
                if self.eat('|') {
                    PipePipe
                } else {
                    Pipe
                }
            }
            '!' => {
                self.bump();
                Bang
            }
            other => {
                let start = self.offset();
                self.bump();
                self.diagnostics.push(Diagnostic::error(
                    format!("unexpected character '{other}'"),
                    Span::new(start, self.offset()),
                ));
                return None;
            }
        };
        Some(kind)
    }
}

pub fn tokenize_with_comments(src: &str) -> (Vec<Token>, Vec<Comment>, Vec<Diagnostic>) {
    Lexer::new(src).run_with_comments()
}

pub fn tokenize(src: &str) -> (Vec<Token>, Vec<Diagnostic>) {
    Lexer::new(src).run()
}

pub fn scan_template(s: &[u8], mut i: usize) -> (Option<usize>, Vec<std::ops::Range<usize>>) {
    let mut subs = Vec::new();
    while i < s.len() {
        match s[i] {
            b'\\' => i += 2,
            b'`' => return (Some(i), subs),
            b'$' if s.get(i + 1) == Some(&b'{') => {
                let start = i + 2;
                match scan_substitution(s, start) {
                    Some(end) => {
                        subs.push(start..end);
                        i = end + 1;
                    }
                    None => return (None, subs),
                }
            }
            _ => i += 1,
        }
    }
    (None, subs)
}

fn scan_substitution(s: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 0usize;
    while i < s.len() {
        match s[i] {
            b'{' => depth += 1,
            b'}' if depth == 0 => return Some(i),
            b'}' => depth -= 1,
            q @ (b'\'' | b'"') => {
                i += 1;
                while i < s.len() && s[i] != q {
                    if s[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'`' => i = scan_template(s, i + 1).0?,
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
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

pub fn is_ident_start(c: char) -> bool {
    c == '_' || c == '$' || unicode_ident::is_xid_start(c)
}

pub fn is_ident_continue(c: char) -> bool {
    c == '$' || c == '\u{200C}' || c == '\u{200D}' || unicode_ident::is_xid_continue(c)
}

pub fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next().is_some_and(is_ident_start) && cs.all(is_ident_continue)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<TokenKind> {
        let (toks, diags) = tokenize(src);
        assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");
        toks.into_iter().map(|t| t.kind).collect()
    }

    #[test]
    fn keywords_and_idents() {
        let k = kinds("component Greeting name");
        assert_eq!(
            k,
            vec![
                TokenKind::Keyword(Keyword::Component),
                TokenKind::Ident("Greeting".into()),
                TokenKind::Ident("name".into()),
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn punctuation_multichar() {
        let k = kinds("=> === == = ... && || .");
        assert_eq!(
            k,
            vec![
                TokenKind::FatArrow,
                TokenKind::EqEqEq,
                TokenKind::EqEq,
                TokenKind::Eq,
                TokenKind::DotDotDot,
                TokenKind::AmpAmp,
                TokenKind::PipePipe,
                TokenKind::Dot,
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn numbers() {
        let k = kinds("0 42 3.14 0xFF 1e10 1_000");
        assert_eq!(
            k,
            vec![
                TokenKind::Number("0".into()),
                TokenKind::Number("42".into()),
                TokenKind::Number("3.14".into()),
                TokenKind::Number("0xFF".into()),
                TokenKind::Number("1e10".into()),
                TokenKind::Number("1_000".into()),
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn strings_and_templates() {
        let k = kinds(r#" "hi" 'yo' `tmpl` "esc\"aped" "#);
        assert_eq!(
            k,
            vec![
                TokenKind::Str("hi".into()),
                TokenKind::Str("yo".into()),
                TokenKind::Template("tmpl".into()),
                TokenKind::Str(r#"esc\"aped"#.into()),
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn templates_nest_through_substitutions() {
        let src = "`a ${ `b ${c} }` + \"}`\" /* ` */ } d` x";
        let (toks, diags) = tokenize(src);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(
            matches!(&toks[0].kind, TokenKind::Template(t) if t.ends_with(" d")),
            "{toks:?}"
        );
        assert!(
            matches!(&toks[1].kind, TokenKind::Ident(x) if x == "x"),
            "{toks:?}"
        );
        let (close, subs) = scan_template(src.as_bytes(), 1);
        assert_eq!(close, Some(src.len() - 3));
        assert_eq!(subs.len(), 1);
        assert_eq!(&src[subs[0].clone()], " `b ${c} }` + \"}`\" /* ` */ ");
        let (_, diags) = tokenize("`a ${b");
        assert!(!diags.is_empty());
    }

    #[test]
    fn comments_are_skipped() {
        let k = kinds("a // line\n b /* block */ c");
        assert_eq!(
            k,
            vec![
                TokenKind::Ident("a".into()),
                TokenKind::Ident("b".into()),
                TokenKind::Ident("c".into()),
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn view_block_lexes_as_punctuation() {
        let k = kinds("view { <h1>{name}</h1> }");
        assert_eq!(
            k,
            vec![
                TokenKind::Keyword(Keyword::View),
                TokenKind::LBrace,
                TokenKind::Lt,
                TokenKind::Ident("h1".into()),
                TokenKind::Gt,
                TokenKind::LBrace,
                TokenKind::Ident("name".into()),
                TokenKind::RBrace,
                TokenKind::Lt,
                TokenKind::Slash,
                TokenKind::Ident("h1".into()),
                TokenKind::Gt,
                TokenKind::RBrace,
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn unicode_identifiers() {
        let k = kinds("café Ωmega ñ_1 $x ಠ_ಠ 名前 x\u{200D}y");
        let names: Vec<_> = k
            .iter()
            .filter_map(|t| match t {
                TokenKind::Ident(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            names,
            ["café", "Ωmega", "ñ_1", "$x", "ಠ_ಠ", "名前", "x\u{200D}y"]
        );
    }

    #[test]
    fn escaped_identifiers_decode_and_are_never_keywords() {
        let k = kinds(r"caf\u00e9 \u{63}omponent \u0061b");
        assert_eq!(
            k,
            vec![
                TokenKind::Ident("café".into()),
                TokenKind::Ident("component".into()),
                TokenKind::Ident("ab".into()),
                TokenKind::Eof,
            ]
        );
        let (_, diags) = tokenize(r"a\u0020b \u{110000} \u12");
        assert_eq!(diags.len(), 3, "{diags:?}");
        assert!(is_ident("a1\u{301}") && !is_ident("1a") && !is_ident("\u{301}a"));
    }

    #[test]
    fn comments_are_kept_as_trivia() {
        let src = "// head\na; // tail\n\n/* doc\n */\nb /* in */ c\n// \"x\" `y`";
        let (toks, comments, diags) = tokenize_with_comments(src);
        assert!(diags.is_empty());
        assert_eq!(toks.len(), 5, "a ; b c eof");
        let got: Vec<_> = comments
            .iter()
            .map(|c| {
                (
                    &src[c.span.start..c.span.end],
                    c.block,
                    c.own_line,
                    c.blank_before,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("// head", false, true, false),
                ("// tail", false, false, false),
                ("/* doc\n */", true, true, true),
                ("/* in */", true, false, false),
                ("// \"x\" `y`", false, true, false),
            ]
        );
        let (_, comments, _) = tokenize_with_comments("'// no' \"/* no */\" `// no`");
        assert!(comments.is_empty());
    }

    #[test]
    fn unterminated_string_reports() {
        let (_toks, diags) = tokenize("\"oops");
        assert_eq!(diags.len(), 1);
    }
}
