use std::rc::Rc;

use crate::ast::{Component, Item, ReactiveKind, SourceFile};
use crate::lower::{
    client_names, collect_binds, lifecycle_members, locate, mark_str, push_lifecycle, rewrite_at,
    rewrite_fn, with_map, Scope,
};

pub fn is_island(c: &Component) -> bool {
    c.reactives.iter().any(|r| r.client)
        || c.functions.iter().any(|f| f.client)
        || c.lifecycle.iter().any(|h| h.client)
        || !crate::lower::collect_uses(&c.view.nodes).is_empty()
}

pub(crate) fn island_key(c: &Component) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in format!("{c:?}").bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{}.{:08x}", c.name, (h >> 32) as u32 ^ h as u32)
}

pub fn lower_client(file: &SourceFile) -> Option<String> {
    let islands: Vec<&Component> = file
        .items
        .iter()
        .filter_map(|it| match it {
            Item::Component(c) if is_island(c) => Some(c),
            _ => None,
        })
        .collect();
    if islands.is_empty() {
        return None;
    }
    let client_src: Vec<&str> = islands
        .iter()
        .flat_map(|c| {
            let f = c
                .functions
                .iter()
                .filter(|f| f.client)
                .map(|f| f.source.as_str());
            let r = c
                .reactives
                .iter()
                .filter(|r| r.client)
                .map(|r| r.expr.as_str());
            let h = c
                .lifecycle
                .iter()
                .filter(|h| h.client)
                .map(|h| h.expr.as_str());
            f.chain(r).chain(h)
        })
        .collect();
    let actions: Vec<&crate::ast::Action> = file
        .items
        .iter()
        .filter_map(|it| match it {
            Item::Action(a) if !a.job => Some(a),
            _ => None,
        })
        .filter(|a| {
            let one: std::collections::HashSet<String> = [a.name.clone()].into();
            client_src
                .iter()
                .any(|s| crate::lower::refs_client(s, &one))
        })
        .collect();
    let mut out = String::from(
        "// The browser half of this file's islands (generated; client code only).\n\
         import { defineIsland, signal, derived",
    );
    out.push_str(if actions.is_empty() {
        " } from \"@weft-framework/runtime\";\n"
    } else {
        ", clientAction } from \"@weft-framework/runtime\";\n"
    });
    for a in &actions {
        out.push_str(&client_action_stub(a));
    }
    for it in &file.items {
        if let Item::Placed(p) = it {
            if p.client {
                out.push_str(&crate::lower::placed_source(p));
                out.push('\n');
            }
        }
    }
    for c in &islands {
        out.push('\n');
        lower_island(c, &mut out);
    }
    let entries: Vec<String> = islands
        .iter()
        .map(|c| format!("\"{}\": {}", island_key(c), c.name))
        .collect();
    out.push_str(&format!(
        "\nexport const islands = {{ {} }};\n",
        entries.join(", ")
    ));
    Some(out)
}

pub fn lower_client_with_map(
    src: &str,
    file: &SourceFile,
) -> Option<(String, Vec<crate::sourcemap::Mapping>)> {
    lower_client(file)?;
    Some(with_map(src, || lower_client(file).unwrap_or_default()))
}

fn client_action_stub(a: &crate::ast::Action) -> String {
    let names: Vec<String> = a.params.iter().map(|p| format!("\"{}\"", p.name)).collect();
    let sig: Vec<String> = a
        .params
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if !p.optional {
                format!("{}: {}", p.name, p.ty)
            } else if a.params[i..].iter().all(|q| q.optional) {
                format!("{}?: {}", p.name, p.ty)
            } else {
                format!("{}: {} | undefined", p.name, p.ty)
            }
        })
        .collect();
    let ret = a
        .ret
        .as_ref()
        .map_or("unknown".to_string(), |r| format!("Awaited<{r}>"));
    format!(
        "{}const {} = clientAction(\"{}\", [{}]) as ({}) => Promise<{ret}>;\n",
        mark_str(a.span.start),
        a.name,
        a.name,
        names.join(", "),
        sig.join(", ")
    )
}

fn lower_island(c: &Component, out: &mut String) {
    let client = client_names(c);
    let mut binds = Vec::new();
    collect_binds(&c.view.nodes, &client, &mut binds);
    let scope = Scope {
        css: None,
        sigs: c
            .reactives
            .iter()
            .filter(|r| r.client)
            .map(|r| r.name.clone())
            .collect(),
        props: Default::default(),
        defaults: Default::default(),
        client: Rc::new(client),
        binds: Rc::new(Vec::new()),
        uses: Rc::new(Vec::new()),
        use_key: "".into(),
    };
    out.push_str(&mark_str(c.span.start));
    out.push_str(&format!(
        "export const {name} = defineIsland(\"{key}\", () => {{\n",
        name = c.name,
        key = island_key(c)
    ));
    let mut members: Vec<(usize, String)> = Vec::new();
    let mut hooks = Vec::new();
    let (mounts, destroys) = lifecycle_members(c, true, &scope, &mut hooks);
    members.extend(hooks.into_iter().map(|(at, _, decl)| (at, decl)));
    for r in c.reactives.iter().filter(|r| r.client) {
        let init = rewrite_at(&r.expr, &scope, locate(r.span, &r.expr));
        let at = mark_str(r.span.start);
        members.push((
            r.span.start,
            match r.kind {
                ReactiveKind::Signal => format!("{at}const {} = signal({init});", r.name),
                ReactiveKind::Derived => {
                    format!("{at}const {} = derived(() => {init});", r.name)
                }
            },
        ));
    }
    for f in c.functions.iter().filter(|f| f.client) {
        members.push((
            f.span.start,
            rewrite_fn(&f.source, &scope, locate(f.span, &f.source)),
        ));
    }
    members.sort_by_key(|m| m.0);
    for (_, decl) in members {
        out.push_str("  ");
        out.push_str(&decl);
        out.push('\n');
    }

    let fns: Vec<&str> = c
        .functions
        .iter()
        .filter(|f| f.client)
        .map(|f| f.name.as_str())
        .collect();
    out.push_str("  return {\n    fns: {");
    if !fns.is_empty() {
        out.push_str(&format!(" {} ", fns.join(", ")));
    }
    out.push_str("},\n");
    push_lifecycle(&mounts, &destroys, &mut *out);
    out.push_str("    binds: [");
    for (i, (expr, span)) in binds.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str("() => (");
        out.push_str(&rewrite_at(expr, &scope, locate(*span, expr)));
        out.push(')');
    }
    out.push_str("],\n");
    let uses = crate::lower::collect_uses(&c.view.nodes);
    if !uses.is_empty() {
        out.push_str("    uses: [");
        for (i, a) in uses.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            out.push('[');
            out.push_str(&a.name);
            if let Some(crate::ast::AttrValue::Expr(x)) = &a.value {
                if crate::lower::refs_client(x, &scope.client) {
                    out.push_str(", () => (");
                    out.push_str(&rewrite_at(x, &scope, locate(a.span, x)));
                    out.push(')');
                }
            }
            out.push(']');
        }
        out.push_str("],\n");
    }
    let sigs: Vec<&str> = c
        .reactives
        .iter()
        .filter(|r| r.client && r.kind == ReactiveKind::Signal)
        .map(|r| r.name.as_str())
        .collect();
    let values: Vec<String> = sigs.iter().map(|s| format!("{s}.value")).collect();
    out.push_str(&format!("    snapshot: () => [{}],\n", values.join(", ")));
    out.push_str("    restore: (v: unknown[]) => {");
    for (i, s) in sigs.iter().enumerate() {
        out.push_str(&format!(" {s}.value = v[{i}] as typeof {s}.value;"));
    }
    out.push_str(" },\n  };\n});\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    const SRC: &str = "component Toggle(title: string) {\n  client signal open = false\n  client derived label = open ? \"Hide\" : \"Show\"\n  signal count = 0\n  client function toggle() { open = !open }\n  function inc() { count = count + 1 }\n  view {\n    <section>\n      <h2>{title}</h2>\n      <button @click={toggle} aria-expanded={open}>{label}</button>\n      <p hidden={!open}>{count} <button @click={inc}>+</button></p>\n    </section>\n  }\n}\n";

    #[test]
    fn server_module_marks_client_bindings() {
        let (file, diags) = parse(SRC);
        assert!(diags.is_empty(), "{diags:?}");
        let checks = crate::check::check(SRC, &file);
        assert!(checks.is_empty(), "{checks:?}");
        let out = crate::lower::lower(SRC, &file);
        assert!(out.contains("const open = signal(false);"), "{out}");
        assert!(
            !out.contains("function toggle"),
            "client code stays out:\n{out}"
        );
        assert!(out.contains("handlers: { inc },"), "{out}");
        let (file, _) = parse(SRC);
        let Item::Component(c) = &file.items[0] else {
            panic!("a component")
        };
        let key = island_key(c);
        assert!(
            key.starts_with("Toggle.") && key.len() == "Toggle.".len() + 8,
            "{key}"
        );
        assert!(
            out.contains(&format!("}}, {{ island: \"{key}\" }});")),
            "{out}"
        );
        assert!(
            out.contains(
                "<button data-weft-do-click=\"toggle\"${((__v) => __v == null ? \"\" : ` aria-expanded=\"${escapeAttr(__v)}\"`)(open.value)} \
                 data-weft-ca=\"aria-expanded=0\"><weft-t data-weft-t=\"1\">${escapeHtml(label.value)}</weft-t></button>"
            ),
            "{out}"
        );
        assert!(
            out.contains("${(!open.value) ? \" hidden\" : \"\"} data-weft-ca=\"hidden?=2\">"),
            "{out}"
        );
        assert!(
            out.contains("<h2>${escapeHtml(props.title)}</h2>"),
            "server text: {out}"
        );
    }

    #[test]
    fn browser_module_has_only_client_code() {
        let (file, _) = parse(SRC);
        let out = lower_client(&file).unwrap();
        let Item::Component(c) = &file.items[0] else {
            panic!("a component")
        };
        let key = island_key(c);
        assert!(
            out.contains(&format!(
                "export const Toggle = defineIsland(\"{key}\", () => {{"
            )),
            "{out}"
        );
        assert!(
            out.contains(&format!("export const islands = {{ \"{key}\": Toggle }};")),
            "{out}"
        );
        let (other, _) = parse(&SRC.replace("Hide", "Close"));
        let Item::Component(c2) = &other.items[0] else {
            panic!("a component")
        };
        assert_ne!(island_key(c2), key);
        assert!(out.contains("const open = signal(false);"), "{out}");
        assert!(
            out.contains("const label = derived(() => open.value ? \"Hide\" : \"Show\");"),
            "{out}"
        );
        assert!(
            out.contains("function toggle() { open.value = !open.value }"),
            "{out}"
        );
        assert!(out.contains("fns: { toggle },"), "{out}");
        assert!(
            out.contains("binds: [() => (open.value), () => (label.value), () => (!open.value)],"),
            "{out}"
        );
        assert!(out.contains("snapshot: () => [open.value],"), "{out}");
        assert!(
            !out.contains("count") && !out.contains("title"),
            "server names leaked:\n{out}"
        );
        let plain = "component P() { view { <p/> } }";
        assert!(lower_client(&parse(plain).0).is_none());
    }

    #[test]
    fn lifecycle_hooks_lower_per_side() {
        let src = "component Clock() {\n  signal now = 0\n  client signal ticks = 0\n  // tick\n  onMount(() => {\n    const t = setInterval(() => { now = now + 1 }, 1000)\n    return () => clearInterval(t)\n  });\n  onDestroy(() => console.log(now))\n  client onMount(() => { ticks = ticks + 1 })\n  view { <p>{now} {ticks}</p> }\n}\n";
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(crate::check::check(src, &file).is_empty());
        let server = crate::lower::lower(src, &file);
        assert!(server.contains("  // tick\n  const __mount0 = () => {\n    const t = setInterval(() => { now.value = now.value + 1 }, 1000)"), "{server}");
        assert!(
            server.contains("const __destroy0 = () => console.log(now.value);"),
            "{server}"
        );
        assert!(
            server.contains("    mount: [__mount0],\n    destroy: [__destroy0],\n"),
            "{server}"
        );
        assert!(!server.contains("ticks.value + 1"), "client hook stays out");
        let client = lower_client(&file).unwrap();
        assert!(
            client.contains("const __mount0 = () => { ticks.value = ticks.value + 1 };"),
            "{client}"
        );
        assert!(client.contains("    mount: [__mount0],\n"), "{client}");
        assert!(
            !client.contains("destroy") && !client.contains("now.value"),
            "{client}"
        );

        let only = "component A() {\n  client onMount(() => console.log(1))\n  view { <p/> }\n}";
        assert!(lower_client(&parse(only).0).is_some());
        let (_, d) = parse("component A() {\n  onMount()\n  view { <p/> }\n}");
        assert!(d[0].message.starts_with("expected a function"), "{d:?}");
    }

    #[test]
    fn use_attachments_lower_to_markers_and_uses() {
        let src = "client import { autofocus } from \"./focus.js\"\ncomponent Menu(hint: string) {\n  client signal open = false\n  client function trap(el: HTMLElement, on: boolean) { if (on) el.focus() }\n  client function tip(el: HTMLElement, text: string) { el.title = text }\n  view {\n    <div use:trap={open} use:tip={hint}><input use:autofocus /></div>\n  }\n}\ncomponent Plain() {\n  client function mark(el: HTMLElement) { el.dataset.on = \"1\" }\n  view { <p use:mark use:mark=\"x\">hi</p> }\n}\n";
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        let checks = crate::check::check(src, &file);
        assert!(
            checks.iter().all(|d| d.severity != crate::Severity::Error),
            "{checks:?}"
        );
        let Item::Component(menu) = &file.items[1] else {
            panic!("a component")
        };
        let key = island_key(menu);
        let server = crate::lower::lower(src, &file);
        assert!(
            server.contains(&format!(
                "<div data-weft-use=\"${{escapeAttr(JSON.stringify([\"{key}\", [0], [1, (props.hint)]]))}}\">"
            )),
            "{server}"
        );
        assert!(
            server.contains(&format!(
                "<input data-weft-use=\"${{escapeAttr(JSON.stringify([\"{key}\", [2]]))}}\" />"
            )),
            "{server}"
        );
        assert!(
            !server.contains("use:") && !server.contains("el.focus"),
            "{server}"
        );
        assert!(
            server.contains("[0], [1, \"x\"]"),
            "a static value: {server}"
        );
        let client = lower_client(&file).unwrap();
        assert!(
            client.contains("    uses: [[trap, () => (open.value)], [tip], [autofocus]],\n"),
            "{client}"
        );
        assert!(client.contains("    uses: [[mark], [mark]],\n"), "{client}");
        assert!(
            !client.contains("hint"),
            "server values stay on the server: {client}"
        );
        assert!(server.contains("{ island: \"Plain."), "{server}");
    }

    #[test]
    fn use_attachments_are_checked() {
        for (src, msg) in [
            (
                "component A() {\n  function f(el: HTMLElement) {}\n  view { <p use:f /> }\n}",
                "`f` runs on the server",
            ),
            (
                "component A() {\n  view { <p use:nope /> }\n}",
                "`nope` is not declared here",
            ),
            (
                "component A() {\n  client signal s = 1\n  view { <p use:s /> }\n}",
                "needs a function that runs in the browser",
            ),
            (
                "component B() { view { <p/> } }\ncomponent A() {\n  client function f(el: HTMLElement) {}\n  view { <B use:f /> }\n}",
                "attaches to an HTML element",
            ),
            (
                "component A(secret: string) {\n  client signal s = 1\n  client function f(el: HTMLElement, v: unknown) {}\n  view { <p use:f={s + secret} /> }\n}",
                "where `secret` does not exist",
            ),
        ] {
            let (file, diags) = parse(src);
            assert!(diags.is_empty(), "{src}: {diags:?}");
            let checks = crate::check::check(src, &file);
            assert!(
                checks.iter().any(|d| d.message.contains(msg)),
                "{src}: {checks:?}"
            );
        }
    }

    #[test]
    fn browser_module_maps_back() {
        let (file, _) = parse(SRC);
        let (out, maps) = lower_client_with_map(SRC, &file).unwrap();
        assert_eq!(
            Some(out),
            lower_client(&file),
            "same text with or without maps"
        );
        assert!(!maps.is_empty());
    }

    #[test]
    fn island_actions_become_typed_stubs() {
        let src = "action save(a?: string, b: number): Promise<string> { return \"secret\" + a }\naction unused(x: string) {}\ncomponent C() {\n  client signal n = 0\n  client function go() { save(undefined, n).then((s) => { n = s.length }) }\n  view { <button @click={go}>{n}</button> }\n}\n";
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        let out = lower_client(&file).unwrap();
        assert!(
            out.contains("import { defineIsland, signal, derived, clientAction } from"),
            "{out}"
        );
        assert!(
            out.contains("const save = clientAction(\"save\", [\"a\", \"b\"]) as (a: string | undefined, b: number) => Promise<Awaited<Promise<string>>>;"),
            "{out}"
        );
        assert!(
            !out.contains("secret"),
            "the body stays on the server: {out}"
        );
        assert!(
            !out.contains("unused"),
            "only called actions are stubbed: {out}"
        );
    }

    #[test]
    fn client_import_reaches_the_browser_module() {
        let src = "client import confetti from \"canvas-confetti\"\nclient import { format as fmt, addDays } from 'date-fns';\nclient import * as z from \"zod\"\ncomponent C() {\n  client signal day = fmt(addDays(0, 1), \"P\")\n  client function party() { confetti(); z.string() }\n  view { <button @click={party}>{day}</button> }\n}\n";
        let (file, diags) = crate::parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        let names: Vec<Vec<String>> = file
            .items
            .iter()
            .filter_map(|it| match it {
                Item::Placed(p) => Some(p.names.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(names, [vec!["confetti"], vec!["fmt", "addDays"], vec!["z"]]);
        let errors: Vec<_> = crate::check(src, &file)
            .into_iter()
            .filter(|d| d.severity == crate::Severity::Error)
            .collect();
        assert!(errors.is_empty(), "{errors:?}");
        let client = lower_client(&file).expect("an island");
        for line in [
            "client import confetti",
            "import confetti from \"canvas-confetti\"",
            "import { format as fmt, addDays } from 'date-fns';",
            "import * as z from \"zod\"",
        ] {
            assert_eq!(
                client.contains(line),
                !line.starts_with("client"),
                "{line}:\n{client}"
            );
        }
        let server = crate::lower(src, &file);
        assert!(
            server.contains("import { format as fmt, addDays } from 'date-fns';"),
            "{server}"
        );
    }

    #[test]
    fn bad_client_imports_are_reported() {
        for (src, msg) in [
            ("client import \"side-effect\"\n", "expected `client import"),
            (
                "client import type { T } from \"x\"\n",
                "expected `client import",
            ),
            (
                "client import { A } from \"./A.wx\"\n",
                "cannot be a `client import`",
            ),
        ] {
            let (_, diags) = crate::parse(src);
            assert!(
                diags.iter().any(|d| d.message.contains(msg)),
                "{src}: {diags:?}"
            );
        }
    }

    #[test]
    fn placed_declarations_go_to_their_side() {
        let src = "import { db } from \"./db.ts\"\nclient const STEP = 5 // per click\nclient function money(c: number) {\n  return (c / 100).toFixed(2)\n}\nserver const key = db.key;\nconst client = 1\ncomponent C() {\n  client signal n = 0\n  server signal hits = 0\n  client derived label = money(n * STEP)\n  client function add() { n = n + STEP }\n  view { <button @click={add}>{label}</button><p>{key}{hits}</p> }\n}\n";
        let (file, diags) = parse(src);
        assert!(diags.is_empty(), "{diags:?}");
        let placed: Vec<(bool, &str)> = file
            .items
            .iter()
            .filter_map(|it| match it {
                Item::Placed(p) => Some((p.client, p.source.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            placed,
            [
                (true, "const STEP = 5"),
                (
                    true,
                    "function money(c: number) {\n  return (c / 100).toFixed(2)\n}"
                ),
                (false, "const key = db.key;"),
            ],
            "`const client = 1` stays plain code"
        );
        assert!(crate::check::check(src, &file).is_empty());
        let browser = lower_client(&file).unwrap();
        assert!(
            browser.contains("const STEP = 5\nfunction money(c: number) {"),
            "{browser}"
        );
        assert!(
            !browser.contains("db"),
            "server code is not shipped: {browser}"
        );
        let server = crate::lower::lower(src, &file);
        assert!(server.contains("const STEP = 5"), "{server}");
        assert!(server.contains("const key = db.key;"), "{server}");
        assert!(!server.contains("server const"), "{server}");
    }
}
