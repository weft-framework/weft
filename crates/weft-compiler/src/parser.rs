use crate::ast::{
    ActorDecl, Comments, Component, Field, FieldAttr, Item, Lifecycle, LifecycleKind, LocalFn,
    Model, Param, Policy, PolicyKind, Reactive, ReactiveKind, SourceFile, View,
};

const BODY_EXPECTED: &str =
    "expected `signal`, `derived`, `function`, `onMount`, `onDestroy`, `style` or `view`";
use crate::diagnostics::Diagnostic;
use crate::lexer::{is_ident_continue, is_ident_start, tokenize};
use crate::markup;
use crate::token::{Span, TokenKind};

pub fn parse(src: &str) -> (SourceFile, Vec<Diagnostic>) {
    let mut p = Parser {
        src,
        chars: src.char_indices().collect(),
        pos: 0,
        len: src.len(),
        diags: Vec::new(),
        comments: Vec::new(),
    };
    let items = p.parse_file();
    (SourceFile { items }, p.diags)
}

struct Parser<'a> {
    src: &'a str,
    chars: Vec<(usize, char)>,
    pos: usize,
    len: usize,
    diags: Vec<Diagnostic>,
    comments: Vec<String>,
}

impl<'a> Parser<'a> {

    fn offset(&self) -> usize {
        self.chars
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

    fn seek_to(&mut self, byte: usize) {
        while self.pos < self.chars.len() && self.chars[self.pos].0 < byte {
            self.pos += 1;
        }
    }

    fn error(&mut self, msg: impl Into<String>) {
        let off = self.offset();
        self.diags.push(Diagnostic::error(msg, Span::new(off, off)));
    }

    fn expect(&mut self, c: char, what: &str) -> bool {
        if self.peek() == Some(c) {
            self.bump();
            true
        } else {
            self.error(format!("expected {what}"));
            false
        }
    }

    fn skip_trivia(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => {
                    self.bump();
                }
                Some('/') if matches!(self.peek_at(1), Some('/' | '*')) => {
                    let start = self.offset();
                    self.skip_comment();
                    let text = self.src[start..self.offset()].trim_end().to_string();
                    self.comments.push(text);
                }
                _ => break,
            }
        }
    }

    fn skip_comment(&mut self) {
        self.bump();
        if self.bump() == Some('/') {
            while let Some(c) = self.peek() {
                if c == '\n' {
                    break;
                }
                self.bump();
            }
        } else {
            while let Some(c) = self.bump() {
                if c == '*' && self.peek() == Some('/') {
                    self.bump();
                    break;
                }
            }
        }
    }

    fn take_comments(&mut self) -> Vec<String> {
        std::mem::take(&mut self.comments)
    }

    fn trailing_comment(&mut self) -> Option<String> {
        let mut i = 0;
        while matches!(self.peek_at(i), Some(' ' | '\t')) {
            i += 1;
        }
        if self.peek_at(i) != Some('/') || !matches!(self.peek_at(i + 1), Some('/' | '*')) {
            return None;
        }
        let save = self.pos;
        for _ in 0..i {
            self.bump();
        }
        let start = self.offset();
        self.skip_comment();
        let text = &self.src[start..self.offset()];
        if text.starts_with("/*") && text.contains('\n') {
            self.pos = save;
            return None;
        }
        Some(text.trim_end().to_string())
    }

    fn read_ident(&mut self) -> String {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            if is_ident_continue(c) {
                out.push(c);
                self.bump();
            } else {
                break;
            }
        }
        out
    }

    fn skip_string(&mut self) {
        let Some(quote) = self.bump() else { return };
        while let Some(c) = self.bump() {
            if c == '\\' {
                self.bump();
            } else if c == quote {
                break;
            }
        }
    }

    fn regex_starts_here(&self) -> bool {
        if self.peek() != Some('/') || matches!(self.peek_at(1), Some('/' | '*')) {
            return false;
        }
        let mut i = self.pos;
        while i > 0 {
            i -= 1;
            let c = self.chars[i].1;
            if c.is_whitespace() {
                continue;
            }
            if is_ident_continue(c) {
                let end = i + 1;
                let mut k = i;
                while k > 0 && is_ident_continue(self.chars[k - 1].1) {
                    k -= 1;
                }
                let word: String = self.chars[k..end].iter().map(|&(_, c)| c).collect();
                return matches!(
                    word.as_str(),
                    "return" | "typeof" | "case" | "in" | "of" | "delete" | "void" | "throw" | "new" | "else" | "do"
                        | "yield" | "await" | "instanceof"
                );
            }
            return !matches!(c, ')' | ']' | '}' | '"' | '\'' | '`');
        }
        true
    }

    fn skip_regex(&mut self) {
        self.bump();
        let mut class = false;
        while let Some(c) = self.bump() {
            match c {
                '\\' => {
                    self.bump();
                }
                '[' => class = true,
                ']' => class = false,
                '/' if !class => break,
                '\n' => break,
                _ => {}
            }
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_alphabetic()) {
            self.bump();
        }
    }

    fn parse_file(&mut self) -> Vec<Item> {
        let mut items = Vec::new();
        loop {
            self.skip_trivia();
            match self.peek() {
                None => break,
                Some(c) if is_ident_start(c) => {
                    let kw_start = self.offset();
                    let word = self.read_ident();
                    match word.as_str() {
                        "component"
                            if self.item_follows(kw_start, '(')
                                || self.item_follows(kw_start, '<') =>
                        {
                            if let Some(c) = self.parse_component(kw_start) {
                                items.push(Item::Component(c));
                            }
                        }
                        "model" if self.item_follows(kw_start, '{') => {
                            if let Some(m) = self.parse_model(kw_start) {
                                items.push(Item::Model(m));
                            }
                        }
                        "actor" if self.actor_follows(kw_start) => {
                            if let Some(a) = self.parse_actor(kw_start) {
                                items.push(Item::Actor(a));
                            }
                        }
                        "client" | "server" if self.placed_follows(kw_start) => {
                            if let Some(p) = self.parse_placed(kw_start, word == "client") {
                                items.push(Item::Placed(p));
                            }
                        }
                        "store" if self.store_follows(kw_start) => {
                            if let Some(st) = self.parse_store(kw_start) {
                                items.push(Item::Store(st));
                            }
                        }
                        "action" if self.item_follows(kw_start, '(') => {
                            if let Some(a) = self.parse_action(kw_start, false) {
                                items.push(Item::Action(a));
                            }
                        }
                        "job" if self.item_follows(kw_start, '(') => {
                            if let Some(a) = self.parse_action(kw_start, true) {
                                items.push(Item::Action(a));
                            }
                        }
                        _ => {}
                    }
                }
                Some('"') | Some('\'') | Some('`') => self.skip_string(),
                Some('/') if self.regex_starts_here() => self.skip_regex(),
                Some(_) => {
                    self.bump();
                }
            }
        }
        items
    }

    fn item_follows(&self, kw_start: usize, open: char) -> bool {
        let before = self.src[..kw_start].trim_end_matches([' ', '\t']);
        if before.ends_with('.') {
            return false;
        }
        let rest = self.src[self.offset()..].trim_start();
        let name_len = rest
            .char_indices()
            .find(|&(i, c)| {
                !(if i == 0 {
                    is_ident_start(c)
                } else {
                    is_ident_continue(c)
                })
            })
            .map_or(rest.len(), |(i, _)| i);
        name_len > 0 && rest[name_len..].trim_start().starts_with(open)
    }

    fn actor_follows(&self, kw_start: usize) -> bool {
        let before = self.src[..kw_start].trim_end_matches([' ', '\t']);
        if !(before.is_empty() || before.ends_with(['\n', ';', '}'])) {
            return false;
        }
        let after = &self.src[self.offset()..];
        let rest = after.trim_start_matches([' ', '\t']);
        if rest.len() == after.len() && !rest.starts_with('{') {
            return false;
        }
        let word: String = rest.chars().take_while(|&c| is_ident_continue(c)).collect();
        match rest.chars().next() {
            Some('{') => true,
            Some(c) if is_ident_start(c) => {
                !matches!(word.as_str(), "in" | "instanceof" | "as" | "satisfies")
            }
            _ => false,
        }
    }

    fn parse_actor(&mut self, start: usize) -> Option<ActorDecl> {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.bump();
        }
        let ty_start = self.offset();
        if !self.read_to_statement_end(true) {
            self.error("unbalanced brackets in the actor type");
            return None;
        }
        let ty = self.src[ty_start..self.offset()].trim_end().to_string();
        if self.peek() == Some(';') {
            self.bump();
        }
        Some(ActorDecl {
            ty,
            ty_offset: ty_start,
            span: Span::new(start, self.offset()),
        })
    }

    fn read_to_statement_end(&mut self, angles: bool) -> bool {
        let mut depth = 0i32;
        loop {
            match self.peek() {
                None => break,
                Some('"' | '\'' | '`') => self.skip_string(),
                Some('/') if self.peek_at(1) == Some('/') && depth == 0 => break,
                Some('/') if matches!(self.peek_at(1), Some('/' | '*')) => self.skip_comment(),
                Some('=') if self.peek_at(1) == Some('>') => {
                    self.bump();
                    self.bump();
                }
                Some('\n' | ';') if depth == 0 => break,
                Some('(' | '[' | '{') => {
                    depth += 1;
                    self.bump();
                }
                Some('<') if angles => {
                    depth += 1;
                    self.bump();
                }
                Some(')' | ']' | '}') => {
                    depth -= 1;
                    self.bump();
                }
                Some('>') if angles => {
                    depth -= 1;
                    self.bump();
                }
                Some(_) => {
                    self.bump();
                }
            }
        }
        depth <= 0
    }

    fn store_follows(&self, kw_start: usize) -> bool {
        let before = self.src[..kw_start].trim_end_matches([' ', '\t']);
        if !(before.is_empty() || before.ends_with(['\n', ';', '}'])) {
            return false;
        }
        let after = &self.src[self.offset()..];
        let rest = after.trim_start_matches([' ', '\t']);
        if rest.len() == after.len() {
            return false;
        }
        let scope: String = rest.chars().take_while(|&c| is_ident_continue(c)).collect();
        let tail = &rest[scope.len()..];
        let name = tail.trim_start_matches([' ', '\t']);
        name.len() < tail.len() && name.starts_with(is_ident_start) && !scope.is_empty()
    }

    fn parse_store(&mut self, start: usize) -> Option<crate::ast::StoreDecl> {
        self.skip_trivia();
        let scope = self.read_ident();
        let session = match scope.as_str() {
            "app" => false,
            "session" => true,
            _ => {
                self.error(format!(
                    "unknown store scope `{scope}`; use `store app` (one value for the app) or `store session` (one per visitor)"
                ));
                return None;
            }
        };
        self.skip_trivia();
        let name = self.read_ident();
        self.skip_trivia();
        let ty = if self.peek() == Some(':') {
            self.bump();
            let at = self.offset();
            let mut depth = 0i32;
            loop {
                match self.peek() {
                    None => break,
                    Some('\n') if depth == 0 => break,
                    Some('=') if self.peek_at(1) == Some('>') => {
                        self.bump();
                        self.bump();
                    }
                    Some('=') if depth == 0 => break,
                    Some('(' | '[' | '{' | '<') => {
                        depth += 1;
                        self.bump();
                    }
                    Some(')' | ']' | '}' | '>') => {
                        depth -= 1;
                        self.bump();
                    }
                    Some('"' | '\'' | '`') => self.skip_string(),
                    Some(_) => {
                        self.bump();
                    }
                }
            }
            let ty = self.src[at..self.offset()].trim().to_string();
            if ty.is_empty() {
                self.error("expected a type after `:`");
                return None;
            }
            Some(ty)
        } else {
            None
        };
        if self.peek() != Some('=') {
            self.error(format!(
                "store `{name}` needs an initial value: `store {scope} {name} = ..`"
            ));
            return None;
        }
        self.bump();
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.bump();
        }
        let init_offset = self.offset();
        if !self.read_to_statement_end(false) {
            self.error("unbalanced brackets in the initial value");
            return None;
        }
        let init = self.src[init_offset..self.offset()].trim_end().to_string();
        if self.peek() == Some(';') {
            self.bump();
        }
        if init.is_empty() {
            self.error(format!("store `{name}` needs an initial value"));
            return None;
        }
        Some(crate::ast::StoreDecl {
            name,
            session,
            ty,
            init,
            init_offset,
            span: Span::new(start, self.offset()),
        })
    }

    fn placed_follows(&self, kw_start: usize) -> bool {
        let before = self.src[..kw_start].trim_end_matches([' ', '\t']);
        if !(before.is_empty() || before.ends_with(['\n', ';', '}'])) {
            return false;
        }
        let after = &self.src[self.offset()..];
        let rest = after.trim_start_matches([' ', '\t']);
        let import = self.src[kw_start..].starts_with("client") && rest.starts_with("import ");
        rest.len() < after.len()
            && (import || ["function ", "const "].iter().any(|k| rest.starts_with(k)))
    }

    fn parse_placed(&mut self, start: usize, client: bool) -> Option<crate::ast::Placed> {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.bump();
        }
        let decl = self.offset();
        let keyword = self.read_ident();
        if keyword == "import" {
            if !self.read_to_statement_end(false) {
                self.error("unbalanced brackets in the import");
                return None;
            }
            if self.peek() == Some(';') {
                self.bump();
            }
            let source = self.src[decl..self.offset()].trim_end().to_string();
            let Some((names, spec)) = import_bindings(&source) else {
                self.diags.push(Diagnostic::error(
                    "expected `client import name from \"module\"`, `{ a, b as c }` or `* as name`",
                    Span::new(decl, self.offset()),
                ));
                return None;
            };
            if spec.ends_with(".wx") {
                self.diags.push(Diagnostic::error(
                    "a `.wx` module cannot be a `client import`; declare shared helpers there as `client`",
                    Span::new(decl, self.offset()),
                ));
                return None;
            }
            return Some(crate::ast::Placed {
                client,
                name: names[0].clone(),
                names,
                import: Some(spec),
                source,
                offset: decl,
                span: Span::new(start, self.offset()),
            });
        }
        let name = if keyword == "function" {
            self.parse_local_fn(decl)?.name
        } else {
            self.skip_trivia();
            let name = self.read_ident();
            if name.is_empty() {
                self.error("expected a name after `const`");
                return None;
            }
            loop {
                if !self.read_to_statement_end(false) {
                    self.error("unbalanced brackets in the declaration");
                    return None;
                }
                let done = self.src[decl..self.offset()].trim_end();
                let next = self.src[self.offset()..].trim_start();
                let open_end = done.ends_with([
                    '=', '+', '-', '*', '/', '%', '&', '|', '^', '?', ':', ',', '(',
                ]) && !done.ends_with("=>")
                    && !done.ends_with("++")
                    && !done.ends_with("--");
                let cont_start = next
                    .starts_with(['.', '+', '*', '/', '%', '&', '|', '^', '?', ':'])
                    && !next.starts_with("//")
                    && !next.starts_with("/*");
                if self.peek() == Some('\n') && (open_end || cont_start) {
                    self.bump();
                    continue;
                }
                break;
            }
            if self.peek() == Some(';') {
                self.bump();
            }
            name
        };
        Some(crate::ast::Placed {
            client,
            names: vec![name.clone()],
            name,
            import: None,
            source: self.src[decl..self.offset()].trim_end().to_string(),
            offset: decl,
            span: Span::new(start, self.offset()),
        })
    }

    fn at_uses(&self) -> bool {
        let rest = &self.src[self.offset()..];
        rest.starts_with("uses")
            && rest[4..].starts_with([' ', '\t', '\n', '\r'])
            && self.src[..self.offset()].ends_with([' ', '\t', '\n', '\r', ')'])
    }

    fn parse_uses(&mut self) -> Option<crate::ast::Uses> {
        if !self.at_uses() {
            return None;
        }
        let start = self.offset();
        for _ in 0..4 {
            self.bump();
        }
        let mut caps = Vec::new();
        loop {
            self.skip_trivia();
            let at = self.offset();
            let cap = self.read_ident();
            if cap.is_empty() {
                self.error("expected a capability after `uses` (db, net, fs, auth or none)");
                break;
            }
            caps.push((cap, Span::new(at, self.offset())));
            self.skip_trivia();
            if self.peek() == Some(',') {
                self.bump();
            } else {
                break;
            }
        }
        Some(crate::ast::Uses {
            caps,
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_action(&mut self, start: usize, job: bool) -> Option<crate::ast::Action> {
        self.skip_trivia();
        let name = self.read_ident();
        self.skip_trivia();
        let (params_src, params_base) = self.read_delimited('(', ')')?;
        let params = self.parse_params(&params_src, params_base);
        self.skip_trivia();
        let ret = if self.peek() == Some(':') {
            self.bump();
            let at = self.offset();
            let mut depth = 0i32;
            while let Some(c) = self.peek() {
                if depth == 0 && self.at_uses() {
                    break;
                }
                match c {
                    '{' if depth == 0 => break,
                    '<' | '(' | '[' | '{' => depth += 1,
                    '>' | ')' | ']' | '}' => depth -= 1,
                    _ => {}
                }
                self.bump();
            }
            Some(self.src[at..self.offset()].trim().to_string())
        } else {
            None
        };
        self.skip_trivia();
        let uses = self.parse_uses();
        if self.peek() != Some('{') {
            self.error(if job {
                "expected '{' to open the job body"
            } else {
                "expected '{' to open the action body"
            });
            return None;
        }
        let (body, body_offset) = self.read_delimited('{', '}')?;
        Some(crate::ast::Action {
            name,
            job,
            uses,
            params,
            ret,
            body,
            body_offset,
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_component(&mut self, start: usize) -> Option<Component> {
        self.skip_trivia();
        let name = self.read_ident();
        if name.is_empty() {
            self.error("expected component name");
            return None;
        }

        self.skip_trivia();
        let type_params = if self.peek() == Some('<') {
            let tp = self.read_type_params()?;
            if tp.trim().is_empty() {
                self.error("expected type parameters between `<` and `>`");
            }
            self.skip_trivia();
            Some(tp.trim().to_string())
        } else {
            None
        };
        let (params_src, params_base) = self.read_delimited('(', ')')?;
        let params = self.parse_params(&params_src, params_base);

        self.skip_trivia();
        let uses = self.parse_uses();
        self.skip_trivia();
        if !self.expect('{', "'{' to open the component body") {
            return None;
        }
        let body_start = self.offset();

        let mut reactives = Vec::new();
        let mut functions = Vec::new();
        let mut lifecycle = Vec::new();
        let mut style: Option<crate::ast::StyleBlock> = None;
        let view;
        loop {
            self.comments.clear();
            self.skip_trivia();
            let leading = self.take_comments();
            if !matches!(self.peek(), Some(c) if is_ident_start(c)) {
                self.error(BODY_EXPECTED);
                return None;
            }
            let mut kw_start = self.offset();
            let mut kw = self.read_ident();
            let client = kw == "client";
            if client || kw == "server" {
                let side = kw.clone();
                self.skip_trivia();
                kw_start = self.offset();
                kw = self.read_ident();
                if !matches!(
                    kw.as_str(),
                    "signal" | "derived" | "function" | "async" | "onMount" | "onDestroy"
                ) {
                    self.error(format!(
                        "expected `signal`, `derived`, `function`, `onMount` or \
                         `onDestroy` after `{side}`"
                    ));
                    return None;
                }
            }
            if kw == "async" {
                self.skip_trivia();
                if self.read_ident() != "function" {
                    self.error("expected `function` after `async`");
                    return None;
                }
                kw = String::from("function");
            }
            match kw.as_str() {
                "onMount" | "onDestroy" => {
                    let kind = if kw == "onMount" {
                        LifecycleKind::Mount
                    } else {
                        LifecycleKind::Destroy
                    };
                    self.skip_trivia();
                    let (arg, base) = self.read_delimited('(', ')')?;
                    let lead = arg.len() - arg.trim_start().len();
                    let expr = arg.trim().to_string();
                    if expr.is_empty() {
                        self.error(format!("expected a function: `{kw}(() => {{ ... }})`"));
                        return None;
                    }
                    if self.peek() == Some(';') {
                        self.bump();
                    }
                    lifecycle.push(Lifecycle {
                        kind,
                        client,
                        span: Span::new(base + lead, base + lead + expr.len()),
                        expr,
                        comments: Comments {
                            leading,
                            trailing: self.trailing_comment(),
                        },
                    });
                }
                "signal" => {
                    if let Some(mut r) = self.parse_reactive(ReactiveKind::Signal) {
                        r.client = client;
                        r.comments = Comments {
                            leading,
                            trailing: self.trailing_comment(),
                        };
                        reactives.push(r);
                    }
                }
                "derived" => {
                    if let Some(mut r) = self.parse_reactive(ReactiveKind::Derived) {
                        r.client = client;
                        r.comments = Comments {
                            leading,
                            trailing: self.trailing_comment(),
                        };
                        reactives.push(r);
                    }
                }
                "function" => {
                    if let Some(mut f) = self.parse_local_fn(kw_start) {
                        f.client = client;
                        f.comments = Comments {
                            leading,
                            trailing: self.trailing_comment(),
                        };
                        functions.push(f);
                    }
                }
                "style" if !client => {
                    let s = self.parse_style(kw_start)?;
                    self.set_style(&mut style, s);
                }
                "view" => {
                    let mut v = self.parse_view_block()?;
                    v.comments.leading = leading;
                    view = v;
                    break;
                }
                _ => {
                    self.error(BODY_EXPECTED);
                    return None;
                }
            }
        }

        self.skip_trivia();
        if self.src[self.offset()..].starts_with("style")
            && self.src[self.offset() + 5..].trim_start().starts_with('{')
        {
            let at = self.offset();
            self.read_ident();
            let s = self.parse_style(at)?;
            self.set_style(&mut style, s);
            self.skip_trivia();
        }
        let body_end = self.offset();
        self.expect('}', "'}' to close the component");
        Some(Component {
            name,
            uses,
            type_params,
            params,
            reactives,
            functions,
            lifecycle,
            view,
            style,
            body: Span::new(body_start, body_end),
            span: Span::new(start, self.offset()),
        })
    }

    fn set_style(&mut self, slot: &mut Option<crate::ast::StyleBlock>, s: crate::ast::StyleBlock) {
        if slot.is_some() {
            self.diags.push(Diagnostic::error(
                "a component has at most one `style` block",
                s.span,
            ));
        } else {
            *slot = Some(s);
        }
    }

    fn parse_style(&mut self, start: usize) -> Option<crate::ast::StyleBlock> {
        self.skip_trivia();
        if !self.expect('{', "'{' to open the style block") {
            return None;
        }
        let offset = self.offset();
        let mut depth = 1i32;
        loop {
            match self.peek() {
                None => {
                    self.error("unclosed `style` block");
                    return None;
                }
                Some(q @ ('"' | '\'')) => {
                    self.bump();
                    while let Some(c) = self.peek() {
                        self.bump();
                        if c == '\\' {
                            self.bump();
                        } else if c == q || c == '\n' {
                            break;
                        }
                    }
                }
                Some('/') if self.peek_at(1) == Some('*') => {
                    while self.peek().is_some() && !self.src[self.offset()..].starts_with("*/") {
                        self.bump();
                    }
                    self.bump();
                    self.bump();
                }
                Some('{') => {
                    depth += 1;
                    self.bump();
                }
                Some('}') => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    self.bump();
                }
                Some(_) => {
                    self.bump();
                }
            }
        }
        let css = self.src[offset..self.offset()].to_string();
        self.bump();
        Some(crate::ast::StyleBlock {
            css,
            offset,
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_local_fn(&mut self, start: usize) -> Option<LocalFn> {
        self.skip_trivia();
        let name = self.read_ident();
        if name.is_empty() {
            self.error("expected a function name");
            return None;
        }
        self.skip_trivia();
        self.read_delimited('(', ')')?;
        self.skip_trivia();
        if self.peek() == Some(':') {
            while let Some(c) = self.peek() {
                if c == '{' {
                    break;
                }
                self.bump();
            }
        }
        self.read_delimited('{', '}')?;
        let end = self.offset();
        Some(LocalFn {
            name,
            client: false,
            source: self.src[start..end].to_string(),
            comments: Comments::default(),
            span: Span::new(start, end),
        })
    }

    fn parse_view_block(&mut self) -> Option<View> {
        self.skip_trivia();
        if !self.expect('{', "'{' after `view`") {
            return None;
        }
        let body_start = self.offset();
        let (nodes, brace_off, mut mdiags) =
            markup::parse_view_body_in(&self.chars, self.pos, self.len);
        self.diags.append(&mut mdiags);
        self.seek_to(brace_off);
        let view_end = self.offset();
        self.expect('}', "'}' to close the `view` block");
        Some(View {
            nodes,
            comments: Comments::default(),
            span: Span::new(body_start, view_end),
        })
    }

    fn parse_model(&mut self, start: usize) -> Option<Model> {
        self.skip_trivia();
        let name = self.read_ident();
        if name.is_empty() {
            self.error("expected model name");
            return None;
        }

        self.skip_trivia();
        if !self.expect('{', "'{' to open the model body") {
            return None;
        }
        let body_start = self.offset();
        let body_end;

        let mut fields = Vec::new();
        let mut policies = Vec::new();
        loop {
            self.skip_trivia();
            match self.peek() {
                None => {
                    self.error("unterminated model: expected '}'");
                    return None;
                }
                Some('}') => {
                    body_end = self.offset();
                    self.bump();
                    break;
                }
                Some('@') => {
                    if let Some(p) = self.parse_policy() {
                        policies.push(p);
                    }
                }
                Some(c) if is_ident_start(c) => {
                    if let Some(f) = self.parse_field() {
                        fields.push(f);
                    }
                }
                Some(_) => {
                    self.error("expected a field, `@read`/`@write`, or '}'");
                    return None;
                }
            }
        }

        Some(Model {
            name,
            fields,
            policies,
            body: Span::new(body_start, body_end),
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_field(&mut self) -> Option<Field> {
        let start = self.offset();
        let name = self.read_ident();
        self.skip_trivia();
        if !self.expect(':', "':' and a type for the field") {
            return None;
        }
        self.skip_trivia();
        let ty = self.read_expr_to_terminator(true);
        if ty.is_empty() {
            self.error("expected a field type");
            return None;
        }
        let mut attrs = Vec::new();
        loop {
            while matches!(self.peek(), Some(' ' | '\t')) {
                self.bump();
            }
            if self.peek() != Some('@') {
                break;
            }
            let at = self.offset();
            self.bump();
            let attr = self.read_ident();
            if attr.is_empty() {
                self.error("expected an attribute name after `@`");
                return None;
            }
            let arg = if self.peek() == Some('(') {
                let (arg, base) = self.read_delimited('(', ')')?;
                let lead = arg.len() - arg.trim_start().len();
                Some((arg.trim().to_string(), base + lead))
            } else {
                None
            };
            attrs.push(FieldAttr {
                name: attr,
                arg,
                span: Span::new(at, self.offset()),
            });
        }
        if self.peek() == Some(';') {
            self.bump();
        }
        Some(Field {
            name,
            ty,
            attrs,
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_policy(&mut self) -> Option<Policy> {
        let start = self.offset();
        self.bump();
        let kind = match self.read_ident().as_str() {
            "read" => PolicyKind::Read,
            "write" => PolicyKind::Write,
            "residency" => PolicyKind::Residency,
            _ => {
                self.error("expected `@read`, `@write` or `@residency`");
                return None;
            }
        };
        self.skip_trivia();
        let (predicate, _base) = self.read_delimited('(', ')')?;
        let predicate = predicate.trim().to_string();
        if predicate.is_empty() {
            self.error("expected a predicate expression");
            return None;
        }
        Some(Policy {
            kind,
            predicate,
            span: Span::new(start, self.offset()),
        })
    }

    fn parse_reactive(&mut self, kind: ReactiveKind) -> Option<Reactive> {
        let start = self.offset();
        self.skip_trivia();
        let name = self.read_ident();
        if name.is_empty() {
            self.error("expected a name after the reactive keyword");
            return None;
        }
        self.skip_trivia();
        if !self.expect('=', "'=' and an initializer") {
            return None;
        }
        self.skip_trivia();
        let expr = self.read_expr_to_terminator(false);
        if expr.is_empty() {
            self.error("expected an initializer expression");
            return None;
        }
        Some(Reactive {
            kind,
            client: false,
            name,
            expr,
            comments: Comments::default(),
            span: Span::new(start, self.offset()),
        })
    }

    fn read_expr_to_terminator(&mut self, stop_brace: bool) -> String {
        let start = self.offset();
        let mut end = start;
        let mut depth: i32 = 0;
        loop {
            match self.peek() {
                None => break,
                Some(';') if depth == 0 => {
                    end = self.offset();
                    self.bump();
                    break;
                }
                Some('\n') if depth == 0 => {
                    end = self.offset();
                    break;
                }
                Some('}') if stop_brace && depth == 0 => {
                    end = self.offset();
                    break;
                }
                Some('@') if stop_brace && depth == 0 => break,
                Some('/') if self.peek_at(1) == Some('/') => {
                    if depth == 0 {
                        break;
                    }
                    self.skip_comment();
                }
                Some('/') if self.peek_at(1) == Some('*') => {
                    self.skip_comment();
                    if depth > 0 {
                        end = self.offset();
                    }
                }
                Some('"') | Some('\'') | Some('`') => {
                    self.skip_string();
                    end = self.offset();
                }
                Some('/') if self.regex_starts_here() => {
                    self.skip_regex();
                    end = self.offset();
                }
                Some(c) => {
                    match c {
                        '(' | '[' | '{' => depth += 1,
                        ')' | ']' | '}' => depth -= 1,
                        _ => {}
                    }
                    self.bump();
                    end = self.offset();
                }
            }
        }
        self.src[start..end].trim().to_string()
    }

    fn read_type_params(&mut self) -> Option<String> {
        self.bump();
        let start = self.offset();
        let mut depth = 0i32;
        loop {
            match self.peek() {
                None => {
                    self.error("unbalanced '<' in type parameters");
                    return None;
                }
                Some('"' | '\'' | '`') => self.skip_string(),
                Some('/') if matches!(self.peek_at(1), Some('/' | '*')) => self.skip_comment(),
                Some('=') if self.peek_at(1) == Some('>') => {
                    self.bump();
                    self.bump();
                }
                Some('<' | '(' | '[' | '{') => {
                    depth += 1;
                    self.bump();
                }
                Some('>') if depth == 0 => {
                    let end = self.offset();
                    self.bump();
                    return Some(self.src[start..end].to_string());
                }
                Some('>' | ')' | ']' | '}') => {
                    depth -= 1;
                    self.bump();
                }
                Some(_) => {
                    self.bump();
                }
            }
        }
    }

    fn read_delimited(&mut self, open: char, close: char) -> Option<(String, usize)> {
        if self.peek() != Some(open) {
            self.error(format!("expected '{open}'"));
            return None;
        }
        self.bump();
        let inner_start = self.offset();
        let mut depth = 1;
        let inner_end;
        loop {
            match self.peek() {
                None => {
                    self.error(format!("unbalanced '{open}'"));
                    return None;
                }
                Some('"') | Some('\'') | Some('`') => self.skip_string(),
                Some('/') if matches!(self.peek_at(1), Some('/' | '*')) => self.skip_comment(),
                Some('/') if self.regex_starts_here() => self.skip_regex(),
                Some(c) => {
                    if c == open {
                        depth += 1;
                    } else if c == close {
                        depth -= 1;
                        if depth == 0 {
                            inner_end = self.offset();
                            self.bump();
                            break;
                        }
                    }
                    self.bump();
                }
            }
        }
        Some((self.src[inner_start..inner_end].to_string(), inner_start))
    }

    fn parse_params(&mut self, slice: &str, base: usize) -> Vec<Param> {
        let (tokens, mut tdiags) = tokenize(slice);
        for d in &mut tdiags {
            d.span.start += base;
            d.span.end += base;
        }
        self.diags.append(&mut tdiags);

        let mut params = Vec::new();
        let mut i = 0;
        loop {
            let start = tokens[i].span.start;
            let rest = tokens[i].kind == TokenKind::DotDotDot;
            if rest {
                i += 1;
            }
            let name = match &tokens[i].kind {
                TokenKind::Eof => break,
                TokenKind::Ident(n) => n.clone(),
                _ => {
                    let span = shift(tokens[i].span, base);
                    self.diags
                        .push(Diagnostic::error("expected a parameter name", span));
                    break;
                }
            };
            if let Some(prev) = params.last().filter(|p: &&Param| p.rest) {
                self.diags.push(Diagnostic::error(
                    format!("`...{}` must be the last parameter", prev.name),
                    prev.span,
                ));
            }
            i += 1;
            let optional = tokens[i].kind == TokenKind::Question;
            if optional {
                i += 1;
            }
            if tokens[i].kind == TokenKind::Colon {
                i += 1;
            } else {
                let span = shift(tokens[i].span, base);
                self.diags.push(Diagnostic::error(
                    "expected ':' and a type for the parameter",
                    span,
                ));
            }
            let ty_start = tokens[i].span.start;
            let mut ty_end = ty_start;
            let mut depth: i32 = 0;
            loop {
                match &tokens[i].kind {
                    TokenKind::Eof => break,
                    TokenKind::Comma | TokenKind::Eq if depth == 0 => break,
                    TokenKind::LParen | TokenKind::LBracket | TokenKind::LBrace | TokenKind::Lt => {
                        depth += 1
                    }
                    TokenKind::RParen | TokenKind::RBracket | TokenKind::RBrace | TokenKind::Gt => {
                        depth -= 1
                    }
                    _ => {}
                }
                ty_end = tokens[i].span.end;
                i += 1;
            }
            let ty = slice[ty_start..ty_end].trim().to_string();
            let mut end = ty_end;
            let default = if tokens[i].kind == TokenKind::Eq {
                i += 1;
                let def_start = tokens[i].span.start;
                let mut def_end = def_start;
                let mut depth: i32 = 0;
                loop {
                    match &tokens[i].kind {
                        TokenKind::Eof => break,
                        TokenKind::Comma if depth == 0 => break,
                        TokenKind::LParen
                        | TokenKind::LBracket
                        | TokenKind::LBrace
                        | TokenKind::Lt => depth += 1,
                        TokenKind::RParen
                        | TokenKind::RBracket
                        | TokenKind::RBrace
                        | TokenKind::Gt => depth -= 1,
                        _ => {}
                    }
                    def_end = tokens[i].span.end;
                    i += 1;
                }
                end = def_end;
                Some(slice[def_start..def_end].trim().to_string())
            } else {
                None
            };
            params.push(Param {
                name,
                ty,
                optional,
                rest,
                default,
                span: shift(Span::new(start, end), base),
            });
            if tokens[i].kind == TokenKind::Comma {
                i += 1;
            }
        }
        params
    }
}

fn shift(span: Span, base: usize) -> Span {
    Span::new(span.start + base, span.end + base)
}

fn import_bindings(stmt: &str) -> Option<(Vec<String>, String)> {
    let body = stmt
        .strip_prefix("import")?
        .trim()
        .trim_end_matches(';')
        .trim_end();
    let from = body.rfind(" from ")?;
    let (clause, rest) = (body[..from].trim(), body[from + 6..].trim());
    let quote = rest.chars().next().filter(|&q| q == '"' || q == '\'')?;
    let spec = rest.strip_prefix(quote)?.strip_suffix(quote)?;
    if spec.is_empty() || spec.contains(quote) || clause.starts_with("type ") {
        return None;
    }
    let ident = |s: &str| -> Option<String> {
        let s = s.trim();
        let mut cs = s.chars();
        let ok = cs
            .next()
            .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
            && cs.all(|c| c.is_alphanumeric() || c == '_' || c == '$');
        ok.then(|| s.to_string())
    };
    let mut names = Vec::new();
    let mut part = clause;
    if !part.starts_with('{') && !part.starts_with('*') {
        let (d, more) = match part.find(',') {
            Some(i) => (&part[..i], part[i + 1..].trim()),
            None => (part, ""),
        };
        names.push(ident(d)?);
        part = more;
    }
    if let Some(ns) = part.strip_prefix('*') {
        names.push(ident(ns.trim().strip_prefix("as ")?)?);
    } else if let Some(list) = part.strip_prefix('{') {
        for item in list.strip_suffix('}')?.split(',') {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            if item.starts_with("type ") {
                return None;
            }
            let local = match item.split_once(" as ") {
                Some((_, l)) => l,
                None => item,
            };
            names.push(ident(local)?);
        }
    } else if !part.is_empty() {
        return None;
    }
    (!names.is_empty()).then(|| (names, spec.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{AttrValue, Node};

    fn parse_ok(src: &str) -> SourceFile {
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");
        file
    }

    #[test]
    fn rest_params_and_spreads_parse() {
        let f = parse_ok(
            "component B(v?: string, ...attrs: Attrs) {\n  view { <p {...attrs} id=\"x\" /> }\n}\n",
        );
        let Item::Component(c) = &f.items[0] else {
            panic!("{:?}", f.items)
        };
        assert!(!c.params[0].rest && c.params[1].rest);
        assert_eq!(
            (c.params[1].name.as_str(), c.params[1].ty.as_str()),
            ("attrs", "Attrs")
        );
        let Some(Node::Element(p)) = c.view.nodes.iter().find(|n| matches!(n, Node::Element(_)))
        else {
            panic!("{:?}", c.view.nodes)
        };
        assert_eq!(p.attrs[0].kind, crate::ast::AttrKind::Spread);
        assert_eq!(p.attrs[0].value, Some(AttrValue::Expr("attrs".into())));
        assert_eq!(p.attrs[1].name, "id");

        let (_, d) = parse("component B(...attrs: Attrs, x: string) {\n  view { <p /> }\n}\n");
        assert!(
            d.iter()
                .any(|d| d.message.contains("`...attrs` must be the last")),
            "{d:?}"
        );
        let (_, d) = parse("component A() {\n  view { <p {nope} /> }\n}\n");
        assert!(
            d.iter()
                .any(|d| d.message.contains("only `{...object}` may stand alone")),
            "{d:?}"
        );
    }

    #[test]
    fn generic_component_type_params() {
        let f = parse_ok(concat!(
            "component Table<T extends Record<string, unknown>, ",
            "K extends keyof T = keyof T, F = (row: T) => string>",
            "(rows: T[], key: K) { view { <p /> } }",
        ));
        let Item::Component(c) = &f.items[0] else {
            panic!("expected a component");
        };
        assert_eq!(c.name, "Table");
        assert_eq!(
            c.type_params.as_deref(),
            Some(
                "T extends Record<string, unknown>, K extends keyof T = keyof T, \
                 F = (row: T) => string"
            )
        );
        assert_eq!(c.params.len(), 2);
        assert_eq!(c.params[0].ty, "T[]");

        let (_, diags) = parse("component Bad<T(x: T) { view { <p /> } }");
        assert!(!diags.is_empty());
        let (_, diags) = parse("component Empty<>() { view { <p /> } }");
        assert!(diags.iter().any(|d| d.message.contains("type parameters")));
    }

    fn significant(nodes: &[Node]) -> Vec<&Node> {
        nodes
            .iter()
            .filter(|n| !matches!(n, Node::Text(t) if t.value.trim().is_empty()))
            .collect()
    }

    #[test]
    fn component_with_param_and_markup() {
        let src =
            "component Greeting(name: string) {\n  view {\n    <h1>Hello, {name}</h1>\n  }\n}\n";
        let file = parse_ok(src);
        assert_eq!(file.items.len(), 1);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        assert_eq!(c.name, "Greeting");
        assert_eq!(c.params.len(), 1);
        assert_eq!(c.params[0].name, "name");
        assert_eq!(c.params[0].ty, "string");

        let top = significant(&c.view.nodes);
        assert_eq!(top.len(), 1);
        let Node::Element(h1) = top[0] else {
            panic!("expected element, got {:?}", top[0]);
        };
        assert_eq!(h1.name, "h1");
        assert!(!h1.self_closing);
        let kids = &h1.children;
        assert_eq!(kids.len(), 2);
        assert!(matches!(&kids[0], Node::Text(t) if t.value == "Hello, "));
        assert!(matches!(&kids[1], Node::Interp(i) if i.expr == "name"));
    }

    #[test]
    fn generic_param_type_is_not_split() {
        let src = "component List(items: Array<Map<string, number>>) { view { <ul/> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        assert_eq!(c.params[0].ty, "Array<Map<string, number>>");
    }

    #[test]
    fn param_defaults_are_not_part_of_the_type() {
        let f = parse_ok(
            "component Counter(start: number = 0, step: number = 1) { view { <p/> } }\n",
        );
        let Item::Component(c) = &f.items[0] else {
            panic!("{:?}", f.items)
        };
        assert_eq!(c.params[0].ty, "number");
        assert_eq!(c.params[0].default.as_deref(), Some("0"));
        assert_eq!(c.params[1].ty, "number");
        assert_eq!(c.params[1].default.as_deref(), Some("1"));
    }

    #[test]
    fn multiple_params_and_self_closing() {
        let src = "component Card(title: string, count: number) { view { <img src=\"a.png\"/> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        assert_eq!(c.params.len(), 2);
        assert_eq!(c.params[1].name, "count");
        assert_eq!(c.params[1].ty, "number");

        let top = significant(&c.view.nodes);
        let Node::Element(img) = top[0] else {
            panic!("expected element");
        };
        assert!(img.self_closing);
        assert_eq!(img.attrs.len(), 1);
        assert_eq!(img.attrs[0].name, "src");
        assert!(matches!(&img.attrs[0].value, Some(AttrValue::Str(s)) if s == "a.png"));
    }

    #[test]
    fn attribute_expression_value() {
        let src = "component A(url: string) { view { <a href={url}>go</a> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::Element(a) = top[0] else {
            panic!("expected element");
        };
        assert!(matches!(&a.attrs[0].value, Some(AttrValue::Expr(e)) if e == "url"));
    }

    #[test]
    fn nested_elements() {
        let src = "component T() { view { <ul><li>one</li><li>two</li></ul> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::Element(ul) = top[0] else {
            panic!("expected ul");
        };
        let lis = significant(&ul.children);
        assert_eq!(lis.len(), 2);
    }

    #[test]
    fn keywords_used_as_plain_typescript_are_not_items() {
        let src =
            "const model = load();\nconst component = model.component(1);\nlet x = { model: 1 };\n";
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(file.items.is_empty());
    }

    #[test]
    fn item_spans_start_at_the_keyword() {
        let src = "// see the docs.\ncomponent A() { view { <p/> } }\n  model M { a: string }";
        let (file, _) = parse(src);
        let starts: Vec<&str> = file
            .items
            .iter()
            .map(|it| match it {
                Item::Component(c) => &src[c.span.start..c.span.start + 9],
                Item::Model(m) => &src[m.span.start..m.span.start + 5],
                Item::Actor(a) => &src[a.span.start..a.span.start + 5],
                Item::Action(a) if a.job => &src[a.span.start..a.span.start + 3],
                Item::Action(a) => &src[a.span.start..a.span.start + 6],
                Item::Placed(p) => &src[p.span.start..p.span.start + 6],
                Item::Store(s) => &src[s.span.start..s.span.start + 5],
            })
            .collect();
        assert_eq!(starts, ["component", "model"]);
    }

    #[test]
    fn local_functions_parse_with_braces_and_strings_in_body() {
        let src = "component C() {\n  signal n = 0\n  function reset(to: number): void {\n    if (to > 0) { n = to } else { log(\"}\") }\n  }\n  view { <p>{n}</p> }\n}";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        assert_eq!(c.functions.len(), 1);
        assert_eq!(c.functions[0].name, "reset");
        assert!(c.functions[0]
            .source
            .starts_with("function reset(to: number): void {"));
        assert!(c.functions[0].source.ends_with("}\n  }"));
        assert_eq!(c.reactives.len(), 1);
    }

    #[test]
    fn reactives_parse_before_view() {
        use crate::ast::ReactiveKind;
        let src = "component Counter() {\n  signal count = 0\n  derived doubled = count * 2\n  view { <p>{count}</p> }\n}";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        assert_eq!(c.reactives.len(), 2);
        assert_eq!(c.reactives[0].kind, ReactiveKind::Signal);
        assert_eq!(c.reactives[0].name, "count");
        assert_eq!(c.reactives[0].expr, "0");
        assert_eq!(c.reactives[1].kind, ReactiveKind::Derived);
        assert_eq!(c.reactives[1].name, "doubled");
        assert_eq!(c.reactives[1].expr, "count * 2");
    }

    #[test]
    fn directive_attributes_parse_with_kind() {
        use crate::ast::AttrKind;
        let src =
            "component B(url: string) { view { <a @click={go} :href={url} class=\"c\">x</a> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::Element(a) = top[0] else {
            panic!("expected element");
        };
        assert_eq!(a.attrs.len(), 3);
        assert_eq!(a.attrs[0].kind, AttrKind::Event);
        assert_eq!(a.attrs[0].name, "click");
        assert_eq!(a.attrs[1].kind, AttrKind::Bind);
        assert_eq!(a.attrs[1].name, "href");
        assert_eq!(a.attrs[2].kind, AttrKind::Plain);
        assert_eq!(a.attrs[2].name, "class");
    }

    #[test]
    fn if_block_with_else_parses() {
        use crate::ast::Node;
        let src = "component C(ok: boolean) { view { <div>{#if ok}<p>yes</p>{:else}<p>no</p>{/if}</div> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::Element(div) = top[0] else {
            panic!("expected div");
        };
        let kids = significant(&div.children);
        assert_eq!(kids.len(), 1);
        let Node::If(b) = kids[0] else {
            panic!("expected if block, got {:?}", kids[0]);
        };
        assert_eq!(b.arms.len(), 1);
        assert_eq!(b.arms[0].cond, "ok");
        assert!(b.else_body.is_some());
    }

    #[test]
    fn if_else_if_chain_parses() {
        use crate::ast::Node;
        let src =
            "component C(n: number) { view { {#if n > 0}pos{:else if n < 0}neg{:else}zero{/if} } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::If(b) = top[0] else {
            panic!("expected if block");
        };
        assert_eq!(b.arms.len(), 2);
        assert_eq!(b.arms[0].cond, "n > 0");
        assert_eq!(b.arms[1].cond, "n < 0");
        assert!(b.else_body.is_some());
    }

    #[test]
    fn each_block_with_index_parses() {
        use crate::ast::Node;
        let src = "component C(items: string[]) { view { <ul>{#each items as item, i}<li>{item}</li>{/each}</ul> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::Element(ul) = top[0] else {
            panic!("expected ul");
        };
        let kids = significant(&ul.children);
        let Node::Each(b) = kids[0] else {
            panic!("expected each block, got {:?}", kids[0]);
        };
        assert_eq!(b.expr, "items");
        assert_eq!(b.item, "item");
        assert_eq!(b.index.as_deref(), Some("i"));
    }

    #[test]
    fn regex_literals_hide_quotes_and_brackets() {
        let src = "const strip = (s: string) => s.replace(/^'/, \"\");\n\
                   const n = 10 / 2 / 5;\n\
                   component C() {\n\
                   signal pat = /[}\"]/g\n\
                   function f(s: string) { return /{'/.test(s) ? s.split(/'/) : [] }\n\
                   view { <p>{n}</p> }\n\
                   }\n\
                   action save(t: string) { if (/^'/.test(t)) return }\n";
        let file = parse_ok(src);
        assert!(matches!(file.items[0], Item::Component(_)), "component not found: {:?}", file.items);
        let Item::Component(c) = &file.items[0] else { unreachable!() };
        assert_eq!(c.reactives[0].expr, "/[}\"]/g");
        assert!(file.items.iter().any(|i| matches!(i, Item::Action(a) if a.name == "save")));
    }

    #[test]
    fn unterminated_if_block_reports() {
        let src = "component C(ok: boolean) { view { {#if ok}yes } }";
        let (_file, diags) = parse(src);
        assert!(
            diags
                .iter()
                .any(|d| d.message.contains("unterminated block")),
            "expected an unterminated-block diagnostic, got {diags:?}"
        );
    }

    #[test]
    fn backtick_in_text_is_literal() {
        let src = "component P() { view { <p>a ` b</p> } }";
        let file = parse_ok(src);
        let Item::Component(c) = &file.items[0] else {
            panic!("expected component");
        };
        let top = significant(&c.view.nodes);
        let Node::Element(p) = top[0] else {
            panic!("expected p");
        };
        assert!(matches!(&p.children[0], Node::Text(t) if t.value == "a ` b"));
    }

    #[test]
    fn mismatched_close_tag_reports() {
        let src = "component T() { view { <div>oops</span> } }";
        let (_file, diags) = parse(src);
        assert!(
            diags.iter().any(|d| d.message.contains("mismatched")),
            "expected a mismatch diagnostic, got {diags:?}"
        );
    }

    #[test]
    fn model_fields_and_policies_parse() {
        use crate::ast::PolicyKind;
        let src = "model Invoice {\n  owner: User\n  amount: Money\n  @read(actor == owner)\n  @write(actor == owner)\n}";
        let file = parse_ok(src);
        assert_eq!(file.items.len(), 1);
        let Item::Model(m) = &file.items[0] else {
            panic!("expected model, got {:?}", file.items[0]);
        };
        assert_eq!(m.name, "Invoice");
        assert_eq!(m.fields.len(), 2);
        assert_eq!(m.fields[0].name, "owner");
        assert_eq!(m.fields[0].ty, "User");
        assert_eq!(m.fields[1].name, "amount");
        assert_eq!(m.fields[1].ty, "Money");
        assert_eq!(m.policies.len(), 2);
        assert_eq!(m.policies[0].kind, PolicyKind::Read);
        assert_eq!(m.policies[0].predicate, "actor == owner");
        assert_eq!(m.policies[1].kind, PolicyKind::Write);
        assert_eq!(m.policies[1].predicate, "actor == owner");
    }

    #[test]
    fn model_field_type_closing_brace_same_line() {
        let src = "model Flag { on: boolean }";
        let file = parse_ok(src);
        let Item::Model(m) = &file.items[0] else {
            panic!("expected model");
        };
        assert_eq!(m.fields.len(), 1);
        assert_eq!(m.fields[0].ty, "boolean");
        assert!(m.policies.is_empty());
    }

    #[test]
    fn model_and_component_in_one_file() {
        let src = "model A {\n  x: number\n}\ncomponent C() { view { <p/> } }";
        let file = parse_ok(src);
        assert_eq!(file.items.len(), 2);
        assert!(matches!(&file.items[0], Item::Model(_)));
        assert!(matches!(&file.items[1], Item::Component(_)));
    }

    #[test]
    fn plain_typescript_is_skipped() {
        let src = "const greeting = `hello ${world}`;\nfunction f() { return 1; }\n";
        let file = parse_ok(src);
        assert!(file.items.is_empty());
    }

    #[test]
    fn actor_declarations_parse() {
        let src = "interface User { id: string }\nactor User\nactor {\n  id: string // who\n  role: \"a\" | \"b\"\n};\n";
        let file = parse_ok(src);
        let tys: Vec<&str> = file
            .items
            .iter()
            .map(|it| match it {
                Item::Actor(a) => a.ty.as_str(),
                _ => panic!("expected actors: {:?}", file.items),
            })
            .collect();
        assert_eq!(tys[0], "User");
        assert!(
            tys[1].starts_with('{') && tys[1].ends_with('}'),
            "{}",
            tys[1]
        );
        let Item::Actor(a) = &file.items[0] else {
            unreachable!()
        };
        assert_eq!(&src[a.ty_offset..a.ty_offset + 4], "User");
        let f = parse_ok("actor User // the signed-in user\n");
        let Item::Actor(a) = &f.items[0] else {
            panic!()
        };
        assert_eq!(a.ty, "User");
    }

    #[test]
    fn plain_code_named_actor_is_not_a_declaration() {
        for src in [
            "const actor = load();\n",
            "actor.id = 1;\n",
            "actor = other;\n",
            "f(actor)\n",
            "actor in roles;\n",
            "return x.actor\n",
            "actor\n{ block(); }\n",
        ] {
            let (file, _) = parse(src);
            assert!(file.items.is_empty(), "{src:?} -> {:?}", file.items);
        }
    }

    #[test]
    fn jobs_parse() {
        let src = "job report(day: string) {\n  return day\n}\nconst job = 1;\nqueue.job(x);\naction a() {}\n";
        let file = parse_ok(src);
        assert_eq!(file.items.len(), 2, "`const job` and `.job(` are plain code");
        let Item::Action(j) = &file.items[0] else {
            panic!("{:?}", file.items)
        };
        assert!(j.job);
        assert_eq!(j.name, "report");
        assert_eq!(j.params.len(), 1);
        let Item::Action(a) = &file.items[1] else {
            panic!("{:?}", file.items)
        };
        assert!(!a.job);
    }

    #[test]
    fn actions_parse() {
        let src = "action add(title: string, tags?: string[]): Promise<number> {\n  return { n: 1 }.n\n}\nconst action = 1;\n";
        let file = parse_ok(src);
        assert_eq!(file.items.len(), 1, "`const action` is plain code");
        let Item::Action(a) = &file.items[0] else {
            panic!("{:?}", file.items)
        };
        assert_eq!(a.name, "add");
        assert_eq!(a.params.len(), 2);
        assert!(a.params[1].optional);
        assert_eq!(a.params[1].ty, "string[]");
        assert_eq!(a.ret.as_deref(), Some("Promise<number>"));
        assert_eq!(a.body.trim(), "return { n: 1 }.n");
        assert_eq!(&src[a.body_offset..a.body_offset + 1], "\n");
    }

    #[test]
    fn stores_parse() {
        let src = "store app visits = 0\nstore session cart: Map<string, (n: number) => void> = new Map([\n  [\"a\", () => {}],\n]);\nconst store = 1\nstore.x = 2\n";
        let file = parse_ok(src);
        assert_eq!(
            file.items.len(),
            2,
            "plain `store` code is left alone: {:?}",
            file.items
        );
        let Item::Store(a) = &file.items[0] else {
            panic!("{:?}", file.items)
        };
        assert_eq!(
            (a.name.as_str(), a.session, a.ty.as_deref()),
            ("visits", false, None)
        );
        assert_eq!(a.init, "0");
        let Item::Store(b) = &file.items[1] else {
            panic!("{:?}", file.items)
        };
        assert!(b.session);
        assert_eq!(b.ty.as_deref(), Some("Map<string, (n: number) => void>"));
        assert_eq!(b.init, "new Map([\n  [\"a\", () => {}],\n])");
        assert_eq!(&src[b.init_offset..b.init_offset + 3], "new");
    }

    #[test]
    fn store_needs_a_known_scope_and_a_value() {
        let parse_err = |src: &str| {
            let (_, diags) = parse(src);
            diags
                .iter()
                .map(|d| d.message.clone())
                .collect::<Vec<_>>()
                .join("; ")
        };
        assert!(parse_err("store global x = 1\n").contains("unknown store scope `global`"));
        assert!(parse_err("store app x\n").contains("needs an initial value"));
    }

    #[test]
    fn uses_clauses_parse() {
        let file = parse_ok(concat!(
            "component Report(id: string) uses db, net {\n  view { <p /> }\n}\n",
            "action save(x: string): Promise<void> uses db { }\n",
            "action ping() uses none { }\n",
            "action plain(): number { return 1 }\n",
        ));
        let caps = |u: &Option<crate::ast::Uses>| -> Vec<String> {
            u.as_ref()
                .map(|u| u.caps.iter().map(|(c, _)| c.clone()).collect())
                .unwrap_or_default()
        };
        let Item::Component(c) = &file.items[0] else {
            panic!("{:?}", file.items)
        };
        assert_eq!(caps(&c.uses), ["db", "net"]);
        let Item::Action(a) = &file.items[1] else {
            panic!()
        };
        assert_eq!(a.ret.as_deref(), Some("Promise<void>"));
        assert_eq!(caps(&a.uses), ["db"]);
        let Item::Action(b) = &file.items[2] else {
            panic!()
        };
        assert_eq!(caps(&b.uses), ["none"]);
        let Item::Action(d) = &file.items[3] else {
            panic!()
        };
        assert!(d.uses.is_none());
        assert_eq!(d.ret.as_deref(), Some("number"));
    }

    #[test]
    fn style_blocks_parse_before_or_after_the_view() {
        let src = "component A() {\n  style { p { content: \"}\"; /* } */ } }\n  view { <p /> }\n}\ncomponent B() {\n  view { <p /> }\n  style { a { b: c } }\n}\n";
        let file = parse_ok(src);
        let Item::Component(a) = &file.items[0] else {
            panic!()
        };
        let st = a.style.as_ref().expect("style before the view");
        assert_eq!(st.css.trim(), "p { content: \"}\"; /* } */ }");
        assert_eq!(&src[st.offset..st.offset + 2], " p");
        let Item::Component(b) = &file.items[1] else {
            panic!()
        };
        assert_eq!(b.style.as_ref().unwrap().css.trim(), "a { b: c }");
        let (_, diags) = parse("component C() {\n  style { }\n  style { }\n  view { <p /> }\n}\n");
        assert!(
            diags
                .iter()
                .any(|d| d.message.contains("at most one `style`")),
            "{diags:?}"
        );
    }
}
