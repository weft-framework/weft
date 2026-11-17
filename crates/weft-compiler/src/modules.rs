use crate::lexer::tokenize;
use crate::token::{Keyword, TokenKind};

pub fn rewrite_wx_imports(src: &str) -> String {
    let (tokens, _) = tokenize(src);
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0;
    for (i, tok) in tokens.iter().enumerate() {
        let TokenKind::Str(value) = &tok.kind else {
            continue;
        };
        if !(value.starts_with("./") || value.starts_with("../")) || !value.ends_with(".wx") {
            continue;
        }
        let prev = i.checked_sub(1).map(|j| &tokens[j].kind);
        let in_import = match prev {
            Some(TokenKind::Keyword(Keyword::From | Keyword::Import)) => true,
            Some(TokenKind::LParen) => matches!(
                i.checked_sub(2).map(|j| &tokens[j].kind),
                Some(TokenKind::Keyword(Keyword::Import))
            ),
            _ => false,
        };
        if !in_import {
            continue;
        }
        let ext = tok.span.end - 1 - ".wx".len();
        out.push_str(&src[cursor..ext]);
        out.push_str(".ts");
        cursor = tok.span.end - 1;
    }
    out.push_str(&src[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::rewrite_wx_imports;

    #[test]
    fn rewrites_relative_wx_specifiers_in_import_position() {
        let src = "import { A } from \"./A.wx\";\nexport { B } from '../c/B.wx';\nimport \"./side.wx\";\nconst m = import(\"./lazy.wx\");\n";
        assert_eq!(
            rewrite_wx_imports(src),
            "import { A } from \"./A.ts\";\nexport { B } from '../c/B.ts';\nimport \"./side.ts\";\nconst m = import(\"./lazy.ts\");\n"
        );
    }

    #[test]
    fn leaves_packages_and_other_strings_alone() {
        let src = "import x from \"pkg.wx\";\nconst s = \"./not-an-import.wx\";\nf(\"./a.wx\");\n";
        assert_eq!(rewrite_wx_imports(src), src);
    }
}
