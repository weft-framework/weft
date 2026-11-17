use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;
use std::process::ExitCode;

macro_rules! registry {
    ($($name:literal),* $(,)?) => {
        &[$(($name, include_str!(concat!("../registry/ui/", $name, ".wx")))),*]
    };
}

pub const COMPONENTS: &[(&str, &str)] = registry![
    "accordion",
    "activity-feed",
    "alert",
    "alert-dialog",
    "aspect-ratio",
    "audit-timeline",
    "avatar",
    "badge",
    "breadcrumb",
    "button",
    "button-group",
    "calendar",
    "card",
    "carousel",
    "chart",
    "checkbox",
    "collapsible",
    "combobox",
    "command",
    "context-menu",
    "data-table",
    "date-picker",
    "dialog",
    "drawer",
    "dropdown-menu",
    "editing-now",
    "empty",
    "field",
    "form",
    "hover-card",
    "input",
    "input-group",
    "input-otp",
    "item",
    "kbd",
    "label",
    "live-stat",
    "live-table",
    "menubar",
    "native-select",
    "navigation-menu",
    "pagination",
    "popover",
    "presence-stack",
    "progress",
    "qr-code",
    "radio-group",
    "resizable",
    "rich-text-editor",
    "scroll-area",
    "select",
    "separator",
    "server-form",
    "share-link",
    "sheet",
    "sidebar",
    "skeleton",
    "slider",
    "sonner",
    "spinner",
    "stepper",
    "switch",
    "table",
    "tabs",
    "textarea",
    "toggle",
    "toggle-group",
    "tooltip",
    "typography",
];

const UTILS: &str = include_str!("../registry/lib/utils.ts");

const THEME: &str = "// Your site's colours, radii and fonts (from weft add). The tokens become\n\
// CSS custom properties and Tailwind colours (bg-primary, text-muted-foreground,\n\
// ...); override any of them here, or add themes beside light and dark.\n\
\n\
import { shadcnTheme } from \"@weft-framework/theme\";\n\
\n\
export default shadcnTheme();\n";

const UI_PACKAGE: (&str, &str) = ("@weft-framework/ui", "^0.0.1");
const THEME_PACKAGE: (&str, &str) = ("@weft-framework/theme", "^0.0.1");
const DATA_PACKAGE: (&str, &str) = ("@weft-framework/data", "^0.0.1");

fn source(name: &str) -> Option<&'static str> {
    COMPONENTS.iter().find(|(n, _)| *n == name).map(|(_, s)| *s)
}

fn imports(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in src.lines() {
        let line = line.trim();
        if !line.starts_with("import ") {
            continue;
        }
        if let Some(i) = line.find("from \"./") {
            let rest = &line[i + 8..];
            if let Some(end) = rest.find(".wx\"") {
                out.push(rest[..end].to_string());
            }
        }
    }
    out
}

pub fn closure(names: &[String]) -> Result<Vec<String>, String> {
    let mut seen = BTreeSet::new();
    let mut stack: Vec<String> = names.to_vec();
    while let Some(n) = stack.pop() {
        let Some(src) = source(&n) else {
            return Err(format!("no component named '{n}' (run `weft add --list`)"));
        };
        if seen.insert(n.clone()) {
            stack.extend(imports(src));
        }
    }
    Ok(seen.into_iter().collect())
}

#[derive(Debug, Default, PartialEq)]
pub struct Added {
    pub written: Vec<String>,
    pub kept: Vec<String>,
    pub packages: Vec<String>,
    pub theme: bool,
}

pub fn add(root: &Path, names: &[String], overwrite: bool) -> Result<Added, String> {
    let all = closure(names)?;
    let mut done = Added::default();
    let io = |e: io::Error| e.to_string();
    let put = |rel: String, text: &str, done: &mut Added| -> Result<(), String> {
        let path = root.join(&rel);
        if path.exists() && !overwrite {
            done.kept.push(rel);
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(io)?;
        }
        fs::write(&path, text).map_err(io)?;
        done.written.push(rel);
        Ok(())
    };
    for n in &all {
        put(
            format!("src/components/ui/{n}.wx"),
            source(n).unwrap_or_default(),
            &mut done,
        )?;
    }
    put("src/lib/utils.ts".to_string(), UTILS, &mut done)?;

    let theme = root.join("src/theme.ts");
    if !theme.exists() && !root.join("src/theme.wx").exists() {
        fs::write(&theme, THEME).map_err(io)?;
        done.theme = true;
    }

    let mut wanted = vec![THEME_PACKAGE];
    if all
        .iter()
        .any(|n| source(n).unwrap_or_default().contains("from \"@weft-framework/ui\""))
    {
        wanted.push(UI_PACKAGE);
    }
    if all.iter().any(|n| {
        source(n)
            .unwrap_or_default()
            .contains("from \"@weft-framework/data\"")
    }) {
        wanted.push(DATA_PACKAGE);
    }
    let pkg = root.join("package.json");
    if let Ok(text) = fs::read_to_string(&pkg) {
        let (next, added) = with_dependencies(&text, &wanted);
        if !added.is_empty() {
            fs::write(&pkg, next).map_err(io)?;
        }
        done.packages = added;
    }
    Ok(done)
}

pub fn with_dependencies(text: &str, deps: &[(&str, &str)]) -> (String, Vec<String>) {
    let missing: Vec<&(&str, &str)> = deps
        .iter()
        .filter(|(n, _)| !text.contains(&format!("\"{n}\"")))
        .collect();
    if missing.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let names = missing.iter().map(|(n, _)| n.to_string()).collect();
    let entries: Vec<String> = missing
        .iter()
        .map(|(n, v)| format!("\"{n}\": \"{v}\""))
        .collect();
    if let Some(at) = text.find("\"dependencies\"") {
        if let Some(open) = text[at..].find('{').map(|i| at + i + 1) {
            let close = text[open..].find('}').map(|i| open + i).unwrap_or(open);
            let empty = text[open..close].trim().is_empty();
            let indent = text[open..]
                .lines()
                .nth(1)
                .map(|l| l.len() - l.trim_start().len())
                .filter(|_| !empty)
                .unwrap_or(4);
            let pad = " ".repeat(indent);
            let mut insert = String::new();
            for (i, e) in entries.iter().enumerate() {
                insert.push_str(&format!("\n{pad}{e}"));
                if i + 1 < entries.len() || !empty {
                    insert.push(',');
                }
            }
            if empty {
                insert.push_str(&format!("\n{}", " ".repeat(indent.saturating_sub(2))));
                return (
                    format!("{}{}{}", &text[..open], insert, &text[close..]),
                    names,
                );
            }
            return (
                format!("{}{}{}", &text[..open], insert, &text[open..]),
                names,
            );
        }
    }
    let open = text.find('{').map(|i| i + 1).unwrap_or(0);
    let body = entries
        .iter()
        .map(|e| format!("    {e}"))
        .collect::<Vec<_>>()
        .join(",\n");
    (
        format!(
            "{}\n  \"dependencies\": {{\n{body}\n  }},{}",
            &text[..open],
            &text[open..]
        ),
        names,
    )
}

pub fn cmd_add(args: &[String]) -> ExitCode {
    let mut names = Vec::new();
    let mut overwrite = false;
    let mut all = false;
    let mut dir = ".".to_string();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--overwrite" => overwrite = true,
            "--all" => all = true,
            "--list" => {
                for (n, src) in COMPONENTS {
                    let deps = imports(src);
                    if deps.is_empty() {
                        println!("{n}");
                    } else {
                        println!("{n}  (with {})", deps.join(", "));
                    }
                }
                return ExitCode::SUCCESS;
            }
            "--dir" => match it.next() {
                Some(d) => dir = d.clone(),
                None => {
                    eprintln!("weft add: --dir needs a directory");
                    return ExitCode::FAILURE;
                }
            },
            s if s.starts_with('-') => {
                eprintln!("weft add: unknown option '{s}'");
                return ExitCode::FAILURE;
            }
            s => names.push(s.to_string()),
        }
    }
    if all {
        names = COMPONENTS.iter().map(|(n, _)| n.to_string()).collect();
    }
    if names.is_empty() {
        eprintln!("weft add: usage: weft add <component..> [--overwrite] [--dir <project>] | --all | --list");
        return ExitCode::FAILURE;
    }
    let root = Path::new(&dir);
    if !root.join("src").is_dir() {
        eprintln!(
            "weft add: '{dir}' has no src/ directory; run it in a Weft project (or pass --dir)"
        );
        return ExitCode::FAILURE;
    }
    match add(root, &names, overwrite) {
        Ok(done) => {
            for f in &done.written {
                println!("  added {f}");
            }
            for f in &done.kept {
                println!("  kept  {f} (exists; --overwrite replaces it)");
            }
            if done.theme {
                println!("  added src/theme.ts (the shadcn tokens; edit to make them yours)");
            }
            if !done.packages.is_empty() {
                println!(
                    "\nAdded {} to package.json; run `npm install`.",
                    done.packages.join(", ")
                );
            }
            let pkg = fs::read_to_string(root.join("package.json")).unwrap_or_default();
            if !pkg.contains("\"tailwindcss\"") {
                println!(
                    "\nThe components are styled with Tailwind: add `tailwindcss` and \
                     `@tailwindcss/node` to devDependencies and `@import \"tailwindcss\";` \
                     to src/app.css (`weft new --tailwind` sets this up)."
                );
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("weft add: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registry_file_is_listed() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("registry/ui");
        let mut on_disk: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| {
                e.ok()?
                    .file_name()
                    .to_str()?
                    .strip_suffix(".wx")
                    .map(String::from)
            })
            .collect();
        on_disk.sort();
        let mut listed: Vec<String> = COMPONENTS.iter().map(|(n, _)| n.to_string()).collect();
        listed.sort();
        assert_eq!(on_disk, listed);
    }

    #[test]
    fn every_registry_file_parses_and_checks_clean() {
        for (name, src) in COMPONENTS {
            let (file, mut diags) = weft_compiler::parse(src);
            diags.extend(weft_compiler::check(src, &file));
            assert!(
                diags.is_empty(),
                "{name}.wx: {:?}",
                diags.iter().map(|d| &d.message).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn dependencies_come_from_imports() {
        let got = closure(&["alert-dialog".to_string()]).unwrap();
        assert_eq!(got, ["alert-dialog", "button", "dialog"]);
        assert!(closure(&["nope".to_string()])
            .unwrap_err()
            .contains("no component named 'nope'"));
        let picker = closure(&["date-picker".to_string()]).unwrap();
        assert_eq!(picker, ["button", "calendar", "date-picker", "popover"]);
    }

    #[test]
    fn package_json_gains_missing_dependencies() {
        let pkg = "{\n  \"name\": \"x\",\n  \"dependencies\": {\n    \"@weft-framework/server\": \"^0.0.1\"\n  }\n}\n";
        let (next, added) =
            with_dependencies(pkg, &[UI_PACKAGE, THEME_PACKAGE, ("@weft-framework/server", "^0")]);
        assert_eq!(added, ["@weft-framework/ui", "@weft-framework/theme"]);
        assert_eq!(
            next,
            "{\n  \"name\": \"x\",\n  \"dependencies\": {\n    \"@weft-framework/ui\": \"^0.0.1\",\n    \"@weft-framework/theme\": \"^0.0.1\",\n    \"@weft-framework/server\": \"^0.0.1\"\n  }\n}\n"
        );
        let (same, none) = with_dependencies(&next, &[UI_PACKAGE]);
        assert_eq!((same.as_str(), none.len()), (next.as_str(), 0));
        let (fresh, _) = with_dependencies("{\n  \"name\": \"x\"\n}\n", &[UI_PACKAGE]);
        assert!(
            fresh.contains("\"dependencies\": {\n    \"@weft-framework/ui\": \"^0.0.1\"\n  },"),
            "{fresh}"
        );
        let (empty, _) = with_dependencies("{\n  \"dependencies\": {}\n}\n", &[UI_PACKAGE]);
        assert!(
            empty.contains("\"dependencies\": {\n    \"@weft-framework/ui\": \"^0.0.1\"\n  }"),
            "{empty}"
        );
    }

    #[test]
    fn add_writes_components_utils_theme_and_keeps_edits() {
        let root = std::env::temp_dir().join(format!("weft-add-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("package.json"),
            "{\n  \"dependencies\": {\n    \"@weft-framework/server\": \"^0.0.1\"\n  }\n}\n",
        )
        .unwrap();
        let done = add(&root, &["dialog".to_string()], false).unwrap();
        assert_eq!(
            done.written,
            [
                "src/components/ui/button.wx",
                "src/components/ui/dialog.wx",
                "src/lib/utils.ts"
            ]
        );
        assert!(done.theme && done.packages == ["@weft-framework/theme", "@weft-framework/ui"]);
        assert!(fs::read_to_string(root.join("src/theme.ts"))
            .unwrap()
            .contains("shadcnTheme()"));

        fs::write(root.join("src/components/ui/button.wx"), "// mine").unwrap();
        let again = add(&root, &["button".to_string()], false).unwrap();
        assert!(again.written.is_empty() && !again.theme && again.packages.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("src/components/ui/button.wx")).unwrap(),
            "// mine"
        );
        let forced = add(&root, &["button".to_string()], true).unwrap();
        assert_eq!(
            forced.written,
            ["src/components/ui/button.wx", "src/lib/utils.ts"]
        );
        let _ = fs::remove_dir_all(&root);
    }
}
