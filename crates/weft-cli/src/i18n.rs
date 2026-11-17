use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::types::{source_dir, ProjectDiag};

#[derive(Debug, Clone)]
pub struct Entry {
    pub key: String,
    pub text: String,
    pub offset: usize,
}

#[derive(Debug)]
pub struct CatalogFile {
    pub path: PathBuf,
    pub source: String,
    pub entries: Vec<Entry>,
}

struct Reader<'a> {
    s: &'a [u8],
    src: &'a str,
    i: usize,
}

impl<'a> Reader<'a> {
    fn skip(&mut self) {
        loop {
            while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
                self.i += 1;
            }
            if self.src[self.i..].starts_with("//") {
                while self.i < self.s.len() && self.s[self.i] != b'\n' {
                    self.i += 1;
                }
            } else if self.src[self.i..].starts_with("/*") {
                match self.src[self.i + 2..].find("*/") {
                    Some(end) => self.i += end + 4,
                    None => self.i = self.s.len(),
                }
            } else {
                return;
            }
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip();
        self.s.get(self.i).copied()
    }

    fn string(&mut self) -> Result<String, (usize, String)> {
        let quote = self.s[self.i];
        let start = self.i;
        self.i += 1;
        let mut out = String::new();
        let rest = &self.src[self.i..];
        let mut chars = rest.char_indices();
        while let Some((at, c)) = chars.next() {
            if c == quote as char {
                self.i += at + 1;
                return Ok(out);
            }
            if quote == b'`' && c == '$' && rest[at + 1..].starts_with('{') {
                return Err((
                    start,
                    "a template literal with ${} is not a fixed message".into(),
                ));
            }
            if c == '\n' && quote != b'`' {
                break;
            }
            if c == '\\' {
                let Some((_, e)) = chars.next() else { break };
                match e {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    '0' => out.push('\0'),
                    'u' => {
                        let tail: String = chars.clone().map(|(_, c)| c).take(12).collect();
                        let (hex, used) = if let Some(body) = tail.strip_prefix('{') {
                            let end = body.find('}').unwrap_or(0);
                            (body[..end].to_string(), end + 2)
                        } else {
                            (tail.chars().take(4).collect::<String>(), 4)
                        };
                        if let Some(ch) =
                            u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32)
                        {
                            out.push(ch);
                        }
                        for _ in 0..used {
                            chars.next();
                        }
                    }
                    '\n' => {}
                    other => out.push(other),
                }
                continue;
            }
            out.push(c);
        }
        Err((start, "unterminated string".into()))
    }

    fn key(&mut self) -> Result<String, (usize, String)> {
        match self.peek() {
            Some(b'"') | Some(b'\'') => self.string(),
            Some(c) if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' => {
                let start = self.i;
                while self.i < self.s.len()
                    && (self.s[self.i].is_ascii_alphanumeric()
                        || self.s[self.i] == b'_'
                        || self.s[self.i] == b'$')
                {
                    self.i += 1;
                }
                Ok(self.src[start..self.i].to_string())
            }
            _ => Err((self.i, "expected a key".into())),
        }
    }

    fn object(&mut self, prefix: &str, out: &mut Vec<Entry>) -> Result<(), (usize, String)> {
        self.i += 1;
        loop {
            match self.peek() {
                Some(b'}') => {
                    self.i += 1;
                    return Ok(());
                }
                None => return Err((self.i, "unterminated object".into())),
                _ => {}
            }
            let name = self.key()?;
            let key = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}.{name}")
            };
            if self.peek() != Some(b':') {
                return Err((self.i, "expected `:`".into()));
            }
            self.i += 1;
            match self.peek() {
                Some(b'{') => self.object(&key, out)?,
                Some(b'"') | Some(b'\'') | Some(b'`') => {
                    let offset = self.i;
                    let text = self.string()?;
                    out.push(Entry { key, text, offset });
                }
                _ => {
                    return Err((
                        self.i,
                        "only string messages and nested groups can be checked here".into(),
                    ))
                }
            }
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {}
                _ => return Err((self.i, "expected `,` or `}`".into())),
            }
        }
    }
}

pub fn read_catalog(source: &str, json: bool) -> Result<Vec<Entry>, (usize, String)> {
    let start = if json {
        source.find('{')
    } else {
        source
            .find("export default")
            .and_then(|at| source[at..].find('{').map(|b| at + b))
    }
    .ok_or((0, "no `export default { ... }` catalog found".to_string()))?;
    let mut r = Reader {
        s: source.as_bytes(),
        src: source,
        i: start,
    };
    let mut out = Vec::new();
    r.object("", &mut out)?;
    Ok(out)
}

pub fn icu_arguments(message: &str) -> Result<BTreeMap<String, &'static str>, (usize, String)> {
    let chars: Vec<char> = message.chars().collect();
    let mut p = Icu {
        c: &chars,
        i: 0,
        args: BTreeMap::new(),
    };
    p.message(false, true)?;
    Ok(p.args)
}

struct Icu<'a> {
    c: &'a [char],
    i: usize,
    args: BTreeMap<String, &'static str>,
}

impl Icu<'_> {
    fn ws(&mut self) {
        while self.i < self.c.len() && self.c[self.i].is_whitespace() {
            self.i += 1;
        }
    }

    fn word(&mut self) -> String {
        self.ws();
        let start = self.i;
        while self.i < self.c.len()
            && !self.c[self.i].is_whitespace()
            && !matches!(self.c[self.i], ',' | '{' | '}')
        {
            self.i += 1;
        }
        self.c[start..self.i].iter().collect()
    }

    fn expect(&mut self, ch: char) -> Result<(), (usize, String)> {
        self.ws();
        if self.c.get(self.i) != Some(&ch) {
            return Err((self.i, format!("expected \"{ch}\"")));
        }
        self.i += 1;
        Ok(())
    }

    fn put(&mut self, name: String, kind: &'static str) {
        let was = self.args.get(&name).copied();
        if was.is_none() || was == Some("any") {
            self.args.insert(name, kind);
        }
    }

    fn message(&mut self, in_plural: bool, top: bool) -> Result<(), (usize, String)> {
        while self.i < self.c.len() {
            let ch = self.c[self.i];
            if ch == '\'' {
                let next = self.c.get(self.i + 1).copied();
                if next == Some('\'') {
                    self.i += 2;
                } else if matches!(next, Some('{') | Some('}') | Some('|'))
                    || (next == Some('#') && in_plural)
                {
                    self.i += 1;
                    while self.i < self.c.len() {
                        if self.c[self.i] == '\'' {
                            if self.c.get(self.i + 1) == Some(&'\'') {
                                self.i += 2;
                                continue;
                            }
                            self.i += 1;
                            break;
                        }
                        self.i += 1;
                    }
                } else {
                    self.i += 1;
                }
            } else if ch == '{' {
                self.argument()?;
            } else if ch == '}' {
                if top {
                    return Err((self.i, "unmatched \"}\"".into()));
                }
                return Ok(());
            } else {
                self.i += 1;
            }
        }
        Ok(())
    }

    fn argument(&mut self) -> Result<(), (usize, String)> {
        let open = self.i;
        self.i += 1;
        let name = self.word();
        let ok = name
            .chars()
            .next()
            .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '$');
        if !ok {
            return Err((open + 1, format!("bad argument name \"{name}\"")));
        }
        self.ws();
        if self.c.get(self.i) == Some(&'}') {
            self.i += 1;
            self.put(name, "any");
            return Ok(());
        }
        self.expect(',')?;
        let kind = self.word();
        self.ws();
        match kind.as_str() {
            "plural" | "selectordinal" | "select" => {
                self.expect(',')?;
                let plural = kind != "select";
                self.put(name, if plural { "number" } else { "select" });
                if plural {
                    self.ws();
                    let rest: String = self.c[self.i..].iter().take(16).collect();
                    if let Some(tail) = rest.strip_prefix("offset:") {
                        let digits = tail.trim_start();
                        let skipped = tail.len() - digits.len();
                        let n = digits.chars().take_while(char::is_ascii_digit).count();
                        if n == 0 {
                            return Err((self.i, "bad offset".into()));
                        }
                        self.i += 7 + skipped + n;
                    }
                }
                self.options(plural)
            }
            "number" | "date" | "time" => {
                if self.c.get(self.i) == Some(&',') {
                    while self.i < self.c.len() && self.c[self.i] != '}' {
                        self.i += 1;
                    }
                }
                self.expect('}')?;
                self.put(name, if kind == "number" { "number" } else { "date" });
                Ok(())
            }
            other => Err((self.i, format!("unknown argument type \"{other}\""))),
        }
    }

    fn options(&mut self, plural: bool) -> Result<(), (usize, String)> {
        let mut seen = BTreeSet::new();
        loop {
            self.ws();
            match self.c.get(self.i) {
                None => return Err((self.i, "unterminated argument".into())),
                Some('}') => {
                    self.i += 1;
                    break;
                }
                _ => {}
            }
            let at = self.i;
            let key = self.word();
            if key.is_empty() {
                return Err((self.i, "expected an option".into()));
            }
            let exact = key
                .strip_prefix('=')
                .is_some_and(|n| !n.is_empty() && n.parse::<f64>().is_ok());
            if plural
                && !exact
                && !matches!(
                    key.as_str(),
                    "zero" | "one" | "two" | "few" | "many" | "other"
                )
            {
                return Err((at, format!("bad plural option \"{key}\"")));
            }
            if !seen.insert(key.clone()) {
                return Err((at, format!("duplicate option \"{key}\"")));
            }
            self.expect('{')?;
            self.message(plural, false)?;
            self.expect('}')?;
        }
        if !seen.contains("other") {
            return Err((self.i, "an \"other\" option is required".into()));
        }
        Ok(())
    }
}

fn position(source: &str, offset: usize) -> (u32, u32) {
    let before = &source[..offset.min(source.len())];
    let line = before.matches('\n').count() as u32 + 1;
    let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) as u32 + 1;
    (line, col)
}

fn default_locale(src: &Path) -> Option<String> {
    let text = fs::read_to_string(src.join("i18n.ts")).ok()?;
    let at = text.find("defaultLocale")?;
    let rest = text[at + "defaultLocale".len()..]
        .trim_start()
        .strip_prefix(':')?
        .trim_start();
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let body = &rest[1..];
    Some(body[..body.find(quote)?].to_string())
}

fn catalog_files(locales: &Path) -> BTreeMap<(String, String), PathBuf> {
    let mut out = BTreeMap::new();
    let is_catalog = |p: &Path| {
        matches!(
            p.extension().and_then(|e| e.to_str()),
            Some("ts") | Some("json")
        )
    };
    let Ok(dir) = fs::read_dir(locales) else {
        return out;
    };
    for entry in dir.flatten() {
        let path = entry.path();
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if path.is_dir() {
            let Ok(sub) = fs::read_dir(&path) else {
                continue;
            };
            for e in sub.flatten() {
                let p = e.path();
                if p.is_file() && is_catalog(&p) {
                    let name = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    out.insert((name, stem.clone()), p);
                }
            }
        } else if is_catalog(&path) && !stem.ends_with(".d") {
            out.insert((String::new(), stem), path);
        }
    }
    out
}

fn diag(
    file: &Path,
    source: &str,
    offset: usize,
    error: bool,
    message: String,
    code: &str,
) -> ProjectDiag {
    let (line, col) = position(source, offset);
    ProjectDiag {
        file: file.to_path_buf(),
        line,
        col,
        error,
        message,
        code: code.to_string(),
    }
}

fn args_text(args: &BTreeMap<String, &'static str>) -> String {
    if args.is_empty() {
        "no arguments".to_string()
    } else {
        args.keys()
            .map(|k| format!("{{{k}}}"))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn report(root: &Path) -> Vec<ProjectDiag> {
    let src = source_dir(root);
    let files = catalog_files(&src.join("locales"));
    if files.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut read: BTreeMap<(String, String), CatalogFile> = BTreeMap::new();
    for ((name, locale), path) in files {
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let json = path.extension().is_some_and(|e| e == "json");
        match read_catalog(&source, json) {
            Ok(entries) => {
                for e in &entries {
                    if let Err((at, why)) = icu_arguments(&e.text) {
                        out.push(diag(
                            &path,
                            &source,
                            e.offset,
                            true,
                            format!("i18n: \"{}\" is not a valid ICU message: {why} (at character {at})", e.key),
                            "i18n-syntax",
                        ));
                    }
                }
                read.insert(
                    (name, locale),
                    CatalogFile {
                        path,
                        source,
                        entries,
                    },
                );
            }
            Err((at, why)) => out.push(diag(
                &path,
                &source,
                at,
                false,
                format!("i18n: this catalog is not checked: {why}"),
                "i18n-unread",
            )),
        }
    }
    let locales: BTreeSet<String> = read.keys().map(|(_, l)| l.clone()).collect();
    let Some(base) =
        default_locale(&src).or_else(|| locales.contains("en").then(|| "en".to_string()))
    else {
        return out;
    };
    let names: BTreeSet<String> = read.keys().map(|(n, _)| n.clone()).collect();
    for name in names {
        let Some(def) = read.get(&(name.clone(), base.clone())) else {
            continue;
        };
        let want: BTreeMap<&str, &Entry> =
            def.entries.iter().map(|e| (e.key.as_str(), e)).collect();
        for locale in &locales {
            if *locale == base {
                continue;
            }
            let label = if name.is_empty() {
                locale.clone()
            } else {
                format!("{locale}/{name}")
            };
            let Some(file) = read.get(&(name.clone(), locale.clone())) else {
                continue;
            };
            let have: BTreeMap<&str, &Entry> =
                file.entries.iter().map(|e| (e.key.as_str(), e)).collect();
            let missing: Vec<&str> = want
                .keys()
                .filter(|k| !have.contains_key(*k))
                .copied()
                .collect();
            if !missing.is_empty() {
                let shown: Vec<&str> = missing.iter().take(10).copied().collect();
                let more = if missing.len() > 10 {
                    format!(" and {} more", missing.len() - 10)
                } else {
                    String::new()
                };
                out.push(diag(
                    &file.path,
                    &file.source,
                    0,
                    false,
                    format!(
                        "i18n: {label} has no translation for {} of {} {base} keys ({} shown in {base}): {}{more}",
                        missing.len(),
                        want.len(),
                        if missing.len() == 1 { "it is" } else { "they are" },
                        shown.join(", ")
                    ),
                    "i18n-missing",
                ));
            }
            for e in &file.entries {
                match want.get(e.key.as_str()) {
                    None => out.push(diag(
                        &file.path,
                        &file.source,
                        e.offset,
                        false,
                        format!(
                            "i18n: \"{}\" is not in the {base} catalog (stale or misspelled)",
                            e.key
                        ),
                        "i18n-stale",
                    )),
                    Some(d) => {
                        let (Ok(a), Ok(b)) = (icu_arguments(&d.text), icu_arguments(&e.text))
                        else {
                            continue;
                        };
                        let ka: Vec<&String> = a.keys().collect();
                        let kb: Vec<&String> = b.keys().collect();
                        if ka != kb {
                            out.push(diag(
                                &file.path,
                                &file.source,
                                e.offset,
                                false,
                                format!(
                                    "i18n: \"{}\" takes {} in {base} but {} here",
                                    e.key,
                                    args_text(&a),
                                    args_text(&b)
                                ),
                                "i18n-arguments",
                            ));
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_documented_catalog_forms() {
        let src = r#"import { messages } from "@weft/i18n";
// comment { not a catalog }
export default messages({
  nav: { home: "Home", 'about-us': 'About \'us\'' }, /* block */
  cart: {
    items: `{count, plural, one {# item} other {# items}}`,
  },
  esc: "aá\u{1F600}\n",
});
"#;
        let e = read_catalog(src, false).unwrap();
        let keys: Vec<&str> = e.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["nav.home", "nav.about-us", "cart.items", "esc"]);
        assert_eq!(e[1].text, "About 'us'");
        assert_eq!(e[3].text, "a\u{e1}\u{1F600}\n");
        assert_eq!(&src[e[0].offset..e[0].offset + 6], "\"Home\"");
        let t = read_catalog(
            "import type en from './en.ts';\nexport default translation<typeof en>()({ a: 'x' });",
            false,
        )
        .unwrap();
        assert_eq!(t[0].key, "a");
        assert!(read_catalog("export default { a: `x ${y}` }", false).is_err());
        assert!(read_catalog("export default { a: make() }", false).is_err());
        assert_eq!(
            read_catalog(r#"{ "a": { "b": "c" } }"#, true).unwrap()[0].key,
            "a.b"
        );
    }

    #[test]
    fn icu_arguments_and_errors_match_the_runtime() {
        let a = icu_arguments("{a} {n, plural, offset:1 =0 {x} other {# {b}}} {d, date, short} {s, select, x {} other {}}")
            .unwrap();
        assert_eq!(
            a.into_iter().collect::<Vec<_>>(),
            [
                ("a", "any"),
                ("b", "any"),
                ("d", "date"),
                ("n", "number"),
                ("s", "select")
            ]
            .map(|(k, v)| (k.to_string(), v))
        );
        assert!(icu_arguments("It''s '{quoted}'").unwrap().is_empty());
        for (bad, why) in [
            ("Hello {name", "expected"),
            ("{n, plural, one {x}}", "\"other\" option is required"),
            ("{n, plural, lots {x} other {y}}", "bad plural option"),
            ("{n, frob}", "unknown argument type"),
            ("oops }", "unmatched"),
            ("{1x}", "bad argument name"),
        ] {
            let err = icu_arguments(bad).unwrap_err();
            assert!(err.1.contains(why), "{bad}: {err:?}");
        }
    }

    #[test]
    fn report_lists_missing_stale_mismatched_and_broken_messages() {
        let dir = std::env::temp_dir().join(format!("weft-i18n-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/locales/cs")).unwrap();
        fs::create_dir_all(dir.join("src/locales/en")).unwrap();
        fs::write(
            dir.join("src/i18n.ts"),
            "export const i18n = defineI18n({ defaultLocale: \"en\" });",
        )
        .unwrap();
        fs::write(
            dir.join("src/locales/en.ts"),
            "export default messages({ a: \"A\", b: \"Hi {name}\", c: \"C\" });",
        )
        .unwrap();
        fs::write(
            dir.join("src/locales/cs.ts"),
            "export default translation<typeof en>()({\n  b: \"Ahoj\",\n  old: \"x\",\n  a: \"{n, plural, one {x}}\",\n});",
        )
        .unwrap();
        fs::write(
            dir.join("src/locales/en/checkout.ts"),
            "export default messages({ pay: \"Pay\" });",
        )
        .unwrap();
        fs::write(
            dir.join("src/locales/cs/checkout.ts"),
            "export default messages({ pay: \"Zaplatit\" });",
        )
        .unwrap();
        let r = report(&dir);
        let codes: Vec<(&str, u32)> = r.iter().map(|d| (d.code.as_str(), d.line)).collect();
        assert!(codes.contains(&("i18n-syntax", 4)), "{r:#?}");
        assert!(codes.contains(&("i18n-stale", 3)), "{r:#?}");
        assert!(codes.contains(&("i18n-arguments", 2)), "{r:#?}");
        let missing: Vec<&ProjectDiag> = r.iter().filter(|d| d.code == "i18n-missing").collect();
        assert_eq!(missing.len(), 1, "{r:#?}");
        assert!(
            missing[0]
                .message
                .contains("cs has no translation for 1 of 3 en keys"),
            "{}",
            missing[0].message
        );
        assert!(
            missing[0].message.ends_with(": c"),
            "{}",
            missing[0].message
        );
        assert!(r
            .iter()
            .filter(|d| d.error)
            .all(|d| d.code == "i18n-syntax"));
        assert!(
            !r.iter().any(|d| d.file.ends_with("checkout.ts")),
            "the route catalog is complete"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
