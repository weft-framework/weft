// Clippy flags thread_local! statics that already use `const { }`.
#![allow(clippy::missing_const_for_thread_local)]

pub mod a11y;
pub mod ast;
pub mod check;
pub mod css;
pub mod diagnostics;
pub mod effects;
pub mod events;
pub mod html;
pub mod island;
pub mod lexer;
pub mod lower;
pub mod markup;
pub mod modules;
pub mod parser;
pub mod policy;
pub mod sourcemap;
pub mod token;

pub use check::check;
pub use diagnostics::{line_col, Diagnostic, Severity};
pub use island::{lower_client, lower_client_with_map};
pub use lexer::{tokenize, Lexer};
pub use lower::{lower, lower_with_map};
pub use modules::rewrite_wx_imports;
pub use parser::parse;
pub use policy::compile_policy;
pub use token::{Keyword, Span, Token, TokenKind};
