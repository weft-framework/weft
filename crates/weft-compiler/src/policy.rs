use std::collections::HashSet;

use crate::lexer::tokenize;
use crate::token::{Keyword, Token, TokenKind};

pub fn compile_policy(predicate: &str, fields: &HashSet<String>) -> Option<String> {
    let (tokens, diags) = tokenize(predicate);
    if !diags.is_empty() {
        return None;
    }
    let tokens: Vec<Token> = tokens
        .into_iter()
        .filter(|t| t.kind != TokenKind::Eof)
        .collect();
    let mut p = P {
        toks: &tokens,
        i: 0,
        fields,
    };
    let e = p.or()?;
    if p.i != tokens.len() {
        return None;
    }
    Some(e)
}

struct P<'a> {
    toks: &'a [Token],
    i: usize,
    fields: &'a HashSet<String>,
}

impl P<'_> {
    fn peek(&self, k: usize) -> Option<&TokenKind> {
        self.toks.get(self.i + k).map(|t| &t.kind)
    }

    fn adjacent(&self, k: usize) -> bool {
        match (self.toks.get(self.i + k), self.toks.get(self.i + k + 1)) {
            (Some(a), Some(b)) => a.span.end == b.span.start,
            _ => false,
        }
    }

    fn or(&mut self) -> Option<String> {
        let mut parts = vec![self.and()?];
        while self.peek(0) == Some(&TokenKind::PipePipe) {
            self.i += 1;
            parts.push(self.and()?);
        }
        Some(join("or", parts))
    }

    fn and(&mut self) -> Option<String> {
        let mut parts = vec![self.unary()?];
        while self.peek(0) == Some(&TokenKind::AmpAmp) {
            self.i += 1;
            parts.push(self.unary()?);
        }
        Some(join("and", parts))
    }

    fn unary(&mut self) -> Option<String> {
        match self.peek(0)? {
            TokenKind::Bang => {
                self.i += 1;
                Some(format!("{{ not: {} }}", self.unary()?))
            }
            TokenKind::LParen => {
                self.i += 1;
                let e = self.or()?;
                if self.peek(0) != Some(&TokenKind::RParen) {
                    return None;
                }
                self.i += 1;
                Some(e)
            }
            _ => self.compare(),
        }
    }

    fn compare(&mut self) -> Option<String> {
        let l = self.operand()?;
        let Some(op) = self.op() else {
            return Some(format!("{{ truthy: {l} }}"));
        };
        let r = self.operand()?;
        Some(format!("{{ cmp: \"{op}\", l: {l}, r: {r} }}"))
    }

    fn op(&mut self) -> Option<&'static str> {
        let (op, len) = match self.peek(0)? {
            TokenKind::EqEq | TokenKind::EqEqEq => ("==", 1),
            TokenKind::Bang
                if self.adjacent(0)
                    && matches!(self.peek(1), Some(TokenKind::Eq | TokenKind::EqEq)) =>
            {
                ("!=", 2)
            }
            TokenKind::Lt if self.adjacent(0) && self.peek(1) == Some(&TokenKind::Eq) => ("<=", 2),
            TokenKind::Gt if self.adjacent(0) && self.peek(1) == Some(&TokenKind::Eq) => (">=", 2),
            TokenKind::Lt => ("<", 1),
            TokenKind::Gt => (">", 1),
            _ => return None,
        };
        self.i += len;
        Some(op)
    }

    fn operand(&mut self) -> Option<String> {
        let tok = self.peek(0)?.clone();
        self.i += 1;
        match tok {
            TokenKind::Ident(root) => {
                let kind = if root == "actor" {
                    "actor"
                } else if self.fields.contains(&root) {
                    "field"
                } else {
                    return None;
                };
                let mut path: Vec<String> = if kind == "field" {
                    vec![root]
                } else {
                    Vec::new()
                };
                while self.peek(0) == Some(&TokenKind::Dot) {
                    match self.peek(1) {
                        Some(TokenKind::Ident(name)) => {
                            path.push(name.clone());
                            self.i += 2;
                        }
                        _ => return None,
                    }
                }
                let list: Vec<String> = path.iter().map(|s| format!("\"{s}\"")).collect();
                Some(format!("{{ {kind}: [{}] }}", list.join(", ")))
            }
            TokenKind::Str(raw) => {
                if raw.contains('\\') || raw.contains('\n') {
                    return None;
                }
                Some(format!("{{ value: \"{}\" }}", raw.replace('"', "\\\"")))
            }
            TokenKind::Number(raw) => {
                let n: f64 = raw.replace('_', "").parse().ok()?;
                n.is_finite().then(|| format!("{{ value: {n} }}"))
            }
            TokenKind::Keyword(Keyword::True) => Some("{ value: true }".into()),
            TokenKind::Keyword(Keyword::False) => Some("{ value: false }".into()),
            TokenKind::Keyword(Keyword::Null | Keyword::Undefined) => {
                Some("{ value: null }".into())
            }
            _ => None,
        }
    }
}

fn join(op: &str, mut parts: Vec<String>) -> String {
    if parts.len() == 1 {
        parts.pop().unwrap_or_default()
    } else {
        format!("{{ {op}: [{}] }}", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> HashSet<String> {
        ["owner", "status", "amount", "public"]
            .into_iter()
            .map(String::from)
            .collect()
    }

    #[test]
    fn ownership_compiles() {
        assert_eq!(
            compile_policy("actor.id == owner.id", &fields()).as_deref(),
            Some("{ cmp: \"==\", l: { actor: [\"id\"] }, r: { field: [\"owner\", \"id\"] } }")
        );
    }

    #[test]
    fn boolean_structure_and_operators() {
        let out = compile_policy(
            "public || (actor.role === \"admin\" && !(status != 'draft')) || amount <= 10",
            &fields(),
        )
        .unwrap();
        assert_eq!(
            out,
            "{ or: [{ truthy: { field: [\"public\"] } }, { and: [{ cmp: \"==\", l: { actor: [\"role\"] }, r: { value: \"admin\" } }, { not: { cmp: \"!=\", l: { field: [\"status\"] }, r: { value: \"draft\" } } }] }, { cmp: \"<=\", l: { field: [\"amount\"] }, r: { value: 10 } }] }"
        );
    }

    #[test]
    fn outside_the_subset_is_none() {
        for p in [
            "actor.ids.includes(owner)",
            "amount + 1 > 2",
            "other == 1",
            "actor.id == owner.id ? 1 : 0",
            "status == \"a\\\"b\"",
        ] {
            assert_eq!(compile_policy(p, &fields()), None, "{p}");
        }
    }
}
