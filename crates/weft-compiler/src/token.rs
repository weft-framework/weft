#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub fn len(&self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

impl Token {
    pub fn new(kind: TokenKind, span: Span) -> Self {
        Self { kind, span }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keyword {
    Let,
    Const,
    Var,
    Function,
    Return,
    If,
    Else,
    For,
    While,
    Import,
    Export,
    From,
    Type,
    Interface,
    Class,
    Extends,
    New,
    Async,
    Await,
    True,
    False,
    Null,
    Undefined,

    Component,
    View,
    Model,
    Signal,
    Derived,
    Permission,
    Server,
    Client,
    Action,
    Store,
}

impl Keyword {
    pub fn from_ident(s: &str) -> Option<Keyword> {
        use Keyword::*;
        Some(match s {
            "let" => Let,
            "const" => Const,
            "var" => Var,
            "function" => Function,
            "return" => Return,
            "if" => If,
            "else" => Else,
            "for" => For,
            "while" => While,
            "import" => Import,
            "export" => Export,
            "from" => From,
            "type" => Type,
            "interface" => Interface,
            "class" => Class,
            "extends" => Extends,
            "new" => New,
            "async" => Async,
            "await" => Await,
            "true" => True,
            "false" => False,
            "null" => Null,
            "undefined" => Undefined,
            "component" => Component,
            "view" => View,
            "model" => Model,
            "signal" => Signal,
            "derived" => Derived,
            "permission" => Permission,
            "server" => Server,
            "client" => Client,
            "action" => Action,
            "store" => Store,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Ident(String),
    Keyword(Keyword),
    Number(String),
    Str(String),
    Template(String),

    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Lt,
    Gt,
    Eq,
    EqEq,
    EqEqEq,
    FatArrow,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Comma,
    Dot,
    DotDotDot,
    Colon,
    Semicolon,
    Question,
    At,
    Amp,
    AmpAmp,
    Pipe,
    PipePipe,
    Bang,

    Eof,
}
