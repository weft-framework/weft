pub const DOM_EVENTS: &[&str] = &[
    "click",
    "dblclick",
    "input",
    "change",
    "submit",
    "keydown",
    "keyup",
    "focusin",
    "focusout",
    "pointerdown",
    "pointerup",
];

pub const TRIGGERS: &[&str] = &["load", "visible", "every"];

const KEY_EVENTS: &[&str] = &["keydown", "keyup"];
const POINTER_EVENTS: &[&str] = &["click", "dblclick", "pointerdown", "pointerup"];

pub const COMMON_MODS: &[&str] = &[
    "debounce",
    "throttle",
    "once",
    "prevent",
    "passive",
    "stop",
    "self",
    "confirm",
    "optimistic",
];
const SYSTEM_KEYS: &[&str] = &["ctrl", "shift", "alt", "meta"];
const KEY_NAMES: &[(&str, &str)] = &[
    ("enter", "Enter"),
    ("esc", "Escape"),
    ("escape", "Escape"),
    ("space", "Space"),
    ("tab", "Tab"),
    ("up", "ArrowUp"),
    ("down", "ArrowDown"),
    ("left", "ArrowLeft"),
    ("right", "ArrowRight"),
    ("delete", "Delete"),
    ("backspace", "Backspace"),
    ("home", "Home"),
    ("end", "End"),
    ("pageup", "PageUp"),
    ("pagedown", "PageDown"),
];

pub const DEFAULT_WAIT_MS: u64 = 300;

#[derive(Clone, Debug, PartialEq)]
pub struct Modifier<'a> {
    pub name: &'a str,
    pub arg: Option<&'a str>,
    pub at: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventSpec<'a> {
    pub event: &'a str,
    pub event_arg: Option<&'a str>,
    pub mods: Vec<Modifier<'a>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    pub message: String,
    pub at: usize,
    pub len: usize,
    pub warning: bool,
}

impl Problem {
    fn error(message: impl Into<String>, at: usize, len: usize) -> Self {
        Self {
            message: message.into(),
            at,
            len,
            warning: false,
        }
    }
}

pub fn parse(name: &str) -> Result<EventSpec<'_>, Problem> {
    let mut segs: Vec<Modifier> = Vec::new();
    let b = name.as_bytes();
    let mut i = 0;
    loop {
        let start = i;
        while i < b.len() && b[i] != b'.' && b[i] != b'(' {
            i += 1;
        }
        let seg = &name[start..i];
        if seg.is_empty() {
            return Err(Problem::error(
                format!("empty segment in `@{name}`"),
                start,
                1,
            ));
        }
        let mut arg = None;
        if i < b.len() && b[i] == b'(' {
            let open = i;
            let close = matching_paren(b, open).ok_or_else(|| {
                Problem::error(
                    format!("unclosed `(` in `@{name}`"),
                    open,
                    name.len() - open,
                )
            })?;
            arg = Some(name[open + 1..close].trim());
            i = close + 1;
        }
        segs.push(Modifier {
            name: seg,
            arg,
            at: start,
        });
        if i >= b.len() {
            break;
        }
        if b[i] != b'.' {
            return Err(Problem::error(
                format!("expected `.` after `)` in `@{name}`"),
                i,
                1,
            ));
        }
        i += 1;
    }
    let first = segs.remove(0);
    Ok(EventSpec {
        event: first.name,
        event_arg: first.arg,
        mods: segs,
    })
}

fn matching_paren(b: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 1;
                } else if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

pub fn duration_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, scale) = if let Some(n) = s.strip_suffix("ms") {
        (n, 1.0)
    } else if let Some(n) = s.strip_suffix('s') {
        (n, 1000.0)
    } else if let Some(n) = s.strip_suffix('m') {
        (n, 60_000.0)
    } else {
        (s, 1.0)
    };
    if num.is_empty() || !num.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return None;
    }
    let v: f64 = num.parse().ok()?;
    let ms = (v * scale).round();
    if !(1.0..=86_400_000.0).contains(&ms) {
        return None;
    }
    Some(ms as u64)
}

pub fn string_literal(s: &str) -> Option<String> {
    let s = s.trim();
    let q = s.chars().next()?;
    if !(q == '"' || q == '\'') || s.len() < 2 || !s.ends_with(q) {
        return None;
    }
    let body = &s[1..s.len() - 1];
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next()? {
                'n' => out.push('\n'),
                other => out.push(other),
            }
        } else if c == q {
            return None;
        } else {
            out.push(c);
        }
    }
    Some(out)
}

pub(crate) fn is_ident(s: &str) -> bool {
    let mut c = s.chars();
    c.next()
        .is_some_and(|f| f.is_alphabetic() || f == '_' || f == '$')
        && c.all(|x| x.is_alphanumeric() || x == '_' || x == '$')
}

fn key_filter(name: &str) -> Option<&'static str> {
    KEY_NAMES.iter().find(|(n, _)| *n == name).map(|(_, k)| *k)
}

fn char_key(name: &str) -> bool {
    name.len() == 1
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

pub fn validate(spec: &EventSpec) -> Vec<Problem> {
    let mut out = Vec::new();
    let ev = spec.event;
    let trigger = TRIGGERS.contains(&ev);
    if !trigger && !DOM_EVENTS.contains(&ev) {
        let s = crate::html::suggest(ev, DOM_EVENTS.iter().chain(TRIGGERS).copied());
        let hint = s.map_or(String::new(), |s| format!(" (did you mean `@{s}`?)"));
        out.push(Problem::error(
            format!(
                "`@{ev}` is not an event Weft delivers{hint}; events: {}; triggers: {}",
                DOM_EVENTS.join(", "),
                TRIGGERS.join(", ")
            ),
            0,
            ev.len(),
        ));
        return out;
    }
    match (ev, spec.event_arg) {
        ("every", None) => out.push(Problem::error(
            "`@every` needs an interval: `@every(5s)`",
            0,
            ev.len(),
        )),
        ("every", Some(a)) => match duration_ms(a) {
            None => out.push(Problem::error(
                format!("`{a}` is not a duration (`500ms`, `5s`, `1m`)"),
                ev.len() + 1,
                a.len().max(1),
            )),
            Some(ms) if ms < 1000 => out.push(Problem {
                message: format!(
                    "`@every({a})` polls the server more than once a second; \
                     consider sync (live updates) instead"
                ),
                at: 0,
                len: ev.len(),
                warning: true,
            }),
            Some(_) => {}
        },
        (_, Some(_)) => out.push(Problem::error(
            format!("`@{ev}` takes no argument"),
            ev.len(),
            1,
        )),
        _ => {}
    }

    let is_key = KEY_EVENTS.contains(&ev);
    let is_pointer = POINTER_EVENTS.contains(&ev);
    let mut seen: Vec<&str> = Vec::new();
    for m in &spec.mods {
        let len = m.name.len();
        let bad = |msg: String| Problem::error(msg, m.at, len);
        if seen.contains(&m.name) {
            out.push(bad(format!("`.{}` is repeated", m.name)));
            continue;
        }
        seen.push(m.name);
        let common = COMMON_MODS.contains(&m.name);
        let system = SYSTEM_KEYS.contains(&m.name);
        let key = key_filter(m.name).is_some() || char_key(m.name);
        if trigger {
            if !matches!(m.name, "once" | "confirm") || (ev == "every" && m.name == "once") {
                out.push(bad(format!("`.{}` does not apply to `@{ev}`", m.name)));
                continue;
            }
        } else if !common && !system && !key {
            let all = COMMON_MODS
                .iter()
                .chain(SYSTEM_KEYS)
                .copied()
                .chain(KEY_NAMES.iter().map(|(n, _)| *n));
            let s = crate::html::suggest(m.name, all);
            let hint = s.map_or(String::new(), |s| format!(" (did you mean `.{s}`?)"));
            out.push(bad(format!("unknown event modifier `.{}`{hint}", m.name)));
            continue;
        } else if key && !is_key {
            out.push(bad(format!(
                "key filter `.{}` only applies to `@keydown` / `@keyup`",
                m.name
            )));
            continue;
        } else if system && !(is_key || is_pointer) {
            out.push(bad(format!(
                "`.{}` only applies to key and pointer events",
                m.name
            )));
            continue;
        }
        match (m.name, m.arg) {
            ("debounce" | "throttle", Some(a)) if duration_ms(a).is_none() => {
                out.push(Problem::error(
                    format!("`{a}` is not a duration (`300ms`, `1s`)"),
                    m.at + len + 1,
                    a.len().max(1),
                ));
            }
            ("debounce" | "throttle", _) => {}
            ("confirm", None) => out.push(bad(
                "`.confirm` needs a message: `.confirm(\"Delete this?\")`".to_string(),
            )),
            ("confirm", Some(a))
                if a.trim().is_empty() =>
            {
                out.push(Problem::error(
                "the `.confirm` message is a string or an expression such as `t(\"delete.confirm\")`",
                m.at + len + 1,
                a.len().max(1),
            ))
            }
            ("confirm", Some(_)) => {}
            ("optimistic", None) => out.push(bad(
                "`.optimistic` names a client function: `.optimistic(markDone)`".to_string(),
            )),
            ("optimistic", Some(a)) if !is_ident(a) => out.push(Problem::error(
                "the `.optimistic` argument must be the name of a client function",
                m.at + len + 1,
                a.len().max(1),
            )),
            ("optimistic", Some(_)) => {}
            (n, Some(_)) => out.push(bad(format!("`.{n}` takes no argument"))),
            _ => {}
        }
    }
    let has = |n: &str| seen.contains(&n);
    if has("debounce") && has("throttle") {
        out.push(Problem::error(
            "`.debounce` and `.throttle` cannot be combined",
            0,
            ev.len(),
        ));
    }
    if has("prevent") && has("passive") {
        out.push(Problem::error(
            "`.prevent` and `.passive` contradict each other",
            0,
            ev.len(),
        ));
    }
    out
}

impl EventSpec<'_> {
    pub fn encode(&self) -> String {
        let mut toks: Vec<String> = Vec::new();
        if let (Some(a), "every") = (self.event_arg, self.event) {
            toks.push(format!("every={}", duration_ms(a).unwrap_or(5000)));
        }
        for m in &self.mods {
            let tok = match m.name {
                "debounce" | "throttle" => format!(
                    "{}={}",
                    m.name,
                    m.arg.and_then(duration_ms).unwrap_or(DEFAULT_WAIT_MS)
                ),
                "confirm" => "confirm".to_string(),
                "optimistic" => continue,
                n => match key_filter(n) {
                    Some(k) => format!("key={k}"),
                    None if char_key(n) => format!("key={n}"),
                    None => n.to_string(),
                },
            };
            toks.push(tok);
        }
        toks.join(" ")
    }

    pub fn optimistic(&self) -> Option<&str> {
        self.mods
            .iter()
            .find(|m| m.name == "optimistic")
            .and_then(|m| m.arg)
    }

    pub fn confirm_expr(&self) -> Option<&str> {
        self.mods
            .iter()
            .find(|m| m.name == "confirm")
            .and_then(|m| m.arg)
            .filter(|a| string_literal(a).is_none() && !a.trim().is_empty())
    }

    pub fn confirm(&self) -> Option<String> {
        self.mods
            .iter()
            .find(|m| m.name == "confirm")
            .and_then(|m| m.arg)
            .and_then(string_literal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problems(name: &str) -> Vec<String> {
        match parse(name) {
            Err(p) => vec![p.message],
            Ok(spec) => validate(&spec).into_iter().map(|p| p.message).collect(),
        }
    }

    #[test]
    fn parses_events_modifiers_and_arguments() {
        let s = parse("click.confirm(\"Sure (really)?\").once").unwrap();
        assert_eq!(s.event, "click");
        assert_eq!(s.mods.len(), 2);
        assert_eq!(s.mods[0].arg, Some("\"Sure (really)?\""));
        assert_eq!(s.mods[1].name, "once");
        assert_eq!(s.confirm().as_deref(), Some("Sure (really)?"));
        let e = parse("every(5s)").unwrap();
        assert_eq!((e.event, e.event_arg), ("every", Some("5s")));
        assert!(parse("click..once").is_err());
        assert!(parse("click.debounce(3").is_err());
    }

    #[test]
    fn durations() {
        assert_eq!(duration_ms("300"), Some(300));
        assert_eq!(duration_ms("300ms"), Some(300));
        assert_eq!(duration_ms("1.5s"), Some(1500));
        assert_eq!(duration_ms("2m"), Some(120_000));
        assert_eq!(duration_ms("0"), None);
        assert_eq!(duration_ms("fast"), None);
        assert_eq!(duration_ms("-1s"), None);
    }

    #[test]
    fn encodes_normalised_tokens() {
        let enc = |n: &str| parse(n).unwrap().encode();
        assert_eq!(enc("click"), "");
        assert_eq!(enc("input.debounce"), "debounce=300");
        assert_eq!(enc("input.throttle(1s)"), "throttle=1000");
        assert_eq!(enc("keydown.ctrl.enter.prevent"), "ctrl key=Enter prevent");
        assert_eq!(enc("keydown.k"), "key=k");
        assert_eq!(enc("every(5s)"), "every=5000");
        assert_eq!(enc("click.confirm('x').once"), "confirm once");
    }

    #[test]
    fn valid_directives_pass() {
        for ok in [
            "click",
            "click.once.stop.prevent",
            "input.debounce(250ms)",
            "keydown.enter",
            "keyup.esc.shift",
            "click.ctrl.self",
            "submit.confirm(\"Send?\")",
            "load",
            "visible.once",
            "every(30s)",
            "every(1m).confirm('Refresh?')",
        ] {
            assert!(problems(ok).is_empty(), "{ok}: {:?}", problems(ok));
        }
    }

    #[test]
    fn invalid_directives_are_explained() {
        let first = |n: &str| problems(n).into_iter().next().unwrap_or_default();
        assert!(first("clik").contains("did you mean `@click`"));
        assert!(first("click.debouce").contains("did you mean `.debounce`"));
        assert_eq!(
            first("click.enter"),
            "key filter `.enter` only applies to `@keydown` / `@keyup`"
        );
        assert_eq!(
            first("input.ctrl"),
            "`.ctrl` only applies to key and pointer events"
        );
        assert_eq!(
            first("input.debounce(soon)"),
            "`soon` is not a duration (`300ms`, `1s`)"
        );
        assert_eq!(
            first("click.confirm"),
            "`.confirm` needs a message: `.confirm(\"Delete this?\")`"
        );
        assert_eq!(
            first("click.confirm()"),
            "the `.confirm` message is a string or an expression such as `t(\"delete.confirm\")`"
        );
        assert_eq!(first("click.once(2)"), "`.once` takes no argument");
        assert_eq!(first("click.once.once"), "`.once` is repeated");
        assert_eq!(
            first("input.debounce.throttle"),
            "`.debounce` and `.throttle` cannot be combined"
        );
        assert_eq!(
            first("click.prevent.passive"),
            "`.prevent` and `.passive` contradict each other"
        );
        assert_eq!(first("every"), "`@every` needs an interval: `@every(5s)`");
        assert_eq!(first("load(1)"), "`@load` takes no argument");
        assert_eq!(
            first("load.debounce"),
            "`.debounce` does not apply to `@load`"
        );
        assert_eq!(
            first("every(5s).once"),
            "`.once` does not apply to `@every`"
        );
        assert!(first("every(200ms)").contains("more than once a second"));
    }
}
