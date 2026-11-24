use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use weft_compiler::{lower_client_with_map, lower_with_map, rewrite_wx_imports, sourcemap};

use crate::front_end;

const TEMPLATE: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../templates/app/package.json"),
    ),
    (".gitignore", include_str!("../templates/app/gitignore")),
    (
        "public/favicon.svg",
        include_str!("../templates/app/public/favicon.svg"),
    ),
    (
        "public/robots.txt",
        include_str!("../templates/app/public/robots.txt"),
    ),
    (
        "public/styles.css",
        include_str!("../templates/app/public/styles.css"),
    ),
    (
        "src/index.html",
        include_str!("../templates/app/src/index.html"),
    ),
    (
        "src/lib/site.ts",
        include_str!("../templates/app/src/lib/site.ts"),
    ),
    (
        "src/lib/posts.ts",
        include_str!("../templates/app/src/lib/posts.ts"),
    ),
    (
        "src/components/Nav.wx",
        include_str!("../templates/app/src/components/Nav.wx"),
    ),
    (
        "src/components/Counter.wx",
        include_str!("../templates/app/src/components/Counter.wx"),
    ),
    (
        "src/pages/_layout.wx",
        include_str!("../templates/app/src/pages/_layout.wx"),
    ),
    (
        "src/pages/_404.wx",
        include_str!("../templates/app/src/pages/_404.wx"),
    ),
    (
        "src/pages/index.wx",
        include_str!("../templates/app/src/pages/index.wx"),
    ),
    (
        "src/pages/about.wx",
        include_str!("../templates/app/src/pages/about.wx"),
    ),
    (
        "src/pages/blog/index.wx",
        include_str!("../templates/app/src/pages/blog/index.wx"),
    ),
    (
        "src/pages/blog/[slug].wx",
        include_str!("../templates/app/src/pages/blog/[slug].wx"),
    ),
    ("README.md", include_str!("../templates/app/README.md")),
];

const WELCOME: &[(&str, &str)] = &[
    (
        "README.md",
        include_str!("../templates/welcome/README.md"),
    ),
    (
        ".gitignore",
        include_str!("../templates/welcome/gitignore"),
    ),
    (
        "package.json",
        include_str!("../templates/welcome/package.json"),
    ),
    (
        "public/favicon.svg",
        include_str!("../templates/welcome/public/favicon.svg"),
    ),
    (
        "public/robots.txt",
        include_str!("../templates/welcome/public/robots.txt"),
    ),
    (
        "src/access.ts",
        include_str!("../templates/welcome/src/access.ts"),
    ),
    (
        "src/app.css",
        include_str!("../templates/welcome/src/app.css"),
    ),
    (
        "src/auth.ts",
        include_str!("../templates/welcome/src/auth.ts"),
    ),
    (
        "src/components/AppShell.wx",
        include_str!("../templates/welcome/src/components/AppShell.wx"),
    ),
    (
        "src/components/AuthShell.wx",
        include_str!("../templates/welcome/src/components/AuthShell.wx"),
    ),
    (
        "src/components/CodeBlock.wx",
        include_str!("../templates/welcome/src/components/CodeBlock.wx"),
    ),
    (
        "src/components/Icon.wx",
        include_str!("../templates/welcome/src/components/Icon.wx"),
    ),
    (
        "src/components/Logo.wx",
        include_str!("../templates/welcome/src/components/Logo.wx"),
    ),
    (
        "src/components/NavBar.wx",
        include_str!("../templates/welcome/src/components/NavBar.wx"),
    ),
    (
        "src/components/ThemeSwitch.wx",
        include_str!("../templates/welcome/src/components/ThemeSwitch.wx"),
    ),
    (
        "src/components/Weave.wx",
        include_str!("../templates/welcome/src/components/Weave.wx"),
    ),
    (
        "src/index.html",
        include_str!("../templates/welcome/src/index.html"),
    ),
    (
        "src/lib/accounts.ts",
        include_str!("../templates/welcome/src/lib/accounts.ts"),
    ),
    (
        "src/lib/catalog.ts",
        include_str!("../templates/welcome/src/lib/catalog.ts"),
    ),
    (
        "src/lib/chat.ts",
        include_str!("../templates/welcome/src/lib/chat.ts"),
    ),
    (
        "src/lib/db.ts",
        include_str!("../templates/welcome/src/lib/db.ts"),
    ),
    (
        "src/lib/env.ts",
        include_str!("../templates/welcome/src/lib/env.ts"),
    ),
    (
        "src/lib/guest.ts",
        include_str!("../templates/welcome/src/lib/guest.ts"),
    ),
    (
        "src/lib/icons.ts",
        include_str!("../templates/welcome/src/lib/icons.ts"),
    ),
    (
        "src/lib/jobs.ts",
        include_str!("../templates/welcome/src/lib/jobs.ts"),
    ),
    (
        "src/lib/mail.ts",
        include_str!("../templates/welcome/src/lib/mail.ts"),
    ),
    (
        "src/emails/confirm-account.wx",
        include_str!("../templates/welcome/src/emails/confirm-account.wx"),
    ),
    (
        "src/lib/notes.ts",
        include_str!("../templates/welcome/src/lib/notes.ts"),
    ),
    (
        "src/lib/notify.ts",
        include_str!("../templates/welcome/src/lib/notify.ts"),
    ),
    (
        "src/lib/presence.ts",
        include_str!("../templates/welcome/src/lib/presence.ts"),
    ),
    (
        "src/lib/rooms.ts",
        include_str!("../templates/welcome/src/lib/rooms.ts"),
    ),
    (
        "src/lib/signin.ts",
        include_str!("../templates/welcome/src/lib/signin.ts"),
    ),
    (
        "src/lib/tasks.ts",
        include_str!("../templates/welcome/src/lib/tasks.ts"),
    ),
    (
        "src/lib/users.ts",
        include_str!("../templates/welcome/src/lib/users.ts"),
    ),
    (
        "src/lib/weave.ts",
        include_str!("../templates/welcome/src/lib/weave.ts"),
    ),
    (
        "src/lib/workspaces.ts",
        include_str!("../templates/welcome/src/lib/workspaces.ts"),
    ),
    (
        "src/models/app.ts",
        include_str!("../templates/welcome/src/models/app.ts"),
    ),
    (
        "src/pages/_404.wx",
        include_str!("../templates/welcome/src/pages/_404.wx"),
    ),
    (
        "src/pages/_layout.wx",
        include_str!("../templates/welcome/src/pages/_layout.wx"),
    ),
    (
        "src/pages/api/tasks/export.ts",
        include_str!("../templates/welcome/src/pages/api/tasks/export.ts"),
    ),
    (
        "src/pages/app/account/email.wx",
        include_str!("../templates/welcome/src/pages/app/account/email.wx"),
    ),
    (
        "src/pages/app/account/index.wx",
        include_str!("../templates/welcome/src/pages/app/account/index.wx"),
    ),
    (
        "src/pages/app/chat.wx",
        include_str!("../templates/welcome/src/pages/app/chat.wx"),
    ),
    (
        "src/pages/app/inbox.wx",
        include_str!("../templates/welcome/src/pages/app/inbox.wx"),
    ),
    (
        "src/pages/app/index.wx",
        include_str!("../templates/welcome/src/pages/app/index.wx"),
    ),
    (
        "src/pages/app/notes/[id].wx",
        include_str!("../templates/welcome/src/pages/app/notes/[id].wx"),
    ),
    (
        "src/pages/app/notes/index.wx",
        include_str!("../templates/welcome/src/pages/app/notes/index.wx"),
    ),
    (
        "src/pages/app/rooms.wx",
        include_str!("../templates/welcome/src/pages/app/rooms.wx"),
    ),
    (
        "src/pages/app/settings.wx",
        include_str!("../templates/welcome/src/pages/app/settings.wx"),
    ),
    (
        "src/pages/app/tasks/[id].wx",
        include_str!("../templates/welcome/src/pages/app/tasks/[id].wx"),
    ),
    (
        "src/pages/app/tasks/data.wx",
        include_str!("../templates/welcome/src/pages/app/tasks/data.wx"),
    ),
    (
        "src/pages/app/tasks/index.wx",
        include_str!("../templates/welcome/src/pages/app/tasks/index.wx"),
    ),
    (
        "src/pages/app/tasks/trash.wx",
        include_str!("../templates/welcome/src/pages/app/tasks/trash.wx"),
    ),
    (
        "src/pages/app/team.wx",
        include_str!("../templates/welcome/src/pages/app/team.wx"),
    ),
    (
        "src/pages/app/welcome.wx",
        include_str!("../templates/welcome/src/pages/app/welcome.wx"),
    ),
    (
        "src/pages/components.wx",
        include_str!("../templates/welcome/src/pages/components.wx"),
    ),
    (
        "src/pages/forgot-password.wx",
        include_str!("../templates/welcome/src/pages/forgot-password.wx"),
    ),
    (
        "src/pages/index.wx",
        include_str!("../templates/welcome/src/pages/index.wx"),
    ),
    (
        "src/pages/invite.wx",
        include_str!("../templates/welcome/src/pages/invite.wx"),
    ),
    (
        "src/pages/reset-password.wx",
        include_str!("../templates/welcome/src/pages/reset-password.wx"),
    ),
    (
        "src/pages/shared/[id].wx",
        include_str!("../templates/welcome/src/pages/shared/[id].wx"),
    ),
    (
        "src/pages/sign-in/confirm.wx",
        include_str!("../templates/welcome/src/pages/sign-in/confirm.wx"),
    ),
    (
        "src/pages/sign-in/index.wx",
        include_str!("../templates/welcome/src/pages/sign-in/index.wx"),
    ),
    (
        "src/pages/sign-in/two-factor.wx",
        include_str!("../templates/welcome/src/pages/sign-in/two-factor.wx"),
    ),
    (
        "src/pages/sign-up/confirm.wx",
        include_str!("../templates/welcome/src/pages/sign-up/confirm.wx"),
    ),
    (
        "src/pages/sign-up/index.wx",
        include_str!("../templates/welcome/src/pages/sign-up/index.wx"),
    ),
    (
        "src/shared.ts",
        include_str!("../templates/welcome/src/shared.ts"),
    ),
    (
        "src/live.ts",
        include_str!("../templates/welcome/src/live.ts"),
    ),
    (
        "src/theme.ts",
        include_str!("../templates/welcome/src/theme.ts"),
    ),
    (
        "weft.config.ts",
        include_str!("../templates/welcome/weft.config.ts"),
    ),
];

pub fn cmd_compile(args: &[String]) -> ExitCode {
    let mut src: Option<&str> = None;
    let mut out: Option<&str> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" | "-o" => out = it.next().map(String::as_str),
            s if src.is_none() && !s.starts_with('-') => src = Some(s),
            s => {
                eprintln!("weft compile: unexpected argument '{s}'");
                return ExitCode::FAILURE;
            }
        }
    }
    let (Some(src), Some(out)) = (src, out) else {
        eprintln!("weft compile: usage: weft compile <dir> --out <dir>");
        return ExitCode::FAILURE;
    };
    match compile_tree(Path::new(src), Path::new(out)) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("weft compile: {e}");
            ExitCode::FAILURE
        }
    }
}

pub fn compile_tree(src: &Path, out: &Path) -> io::Result<bool> {
    compile_tree_mapped(src, out).map(|(ok, _)| ok)
}

pub struct Unit {
    pub ts: PathBuf,
    pub wx: PathBuf,
    pub maps: Vec<sourcemap::Mapping>,
}

pub fn compile_tree_mapped(src: &Path, out: &Path) -> io::Result<(bool, Vec<Unit>)> {
    let mut units = Vec::new();
    let mut files = Vec::new();
    walk(src, &mut files)?;
    files.sort();
    let mut ok = true;
    for file in files {
        let rel = file.strip_prefix(src).unwrap_or(&file);
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
        let mut dest = out.join(rel);
        if ext == "wx" {
            dest.set_extension("ts");
        }
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
        }
        let text = match ext {
            "wx" => {
                let source = fs::read_to_string(&file)?;
                let shown = file.display().to_string();
                let Some(parsed) = front_end(&shown, &source) else {
                    ok = false;
                    continue;
                };
                let (ts, maps) = lower_with_map(&source, &parsed);
                let mut text = rewrite_wx_imports(&ts);
                let name = dest
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("out.ts");
                let map_name = format!("{name}.map");
                let from = dest.parent().unwrap_or(out);
                let json = sourcemap::to_json(&maps, name, &relative(from, &file), &source);
                fs::write(dest.with_file_name(&map_name), json)?;
                units.push(Unit {
                    ts: dest.clone(),
                    wx: file.clone(),
                    maps,
                });
                let client_dest = dest.with_extension("client.ts");
                match lower_client_with_map(&source, &parsed) {
                    Some((client, cmaps)) => {
                        let cname = format!("{}.client.ts", name.trim_end_matches(".ts"));
                        let cmap = format!("{cname}.map");
                        let json =
                            sourcemap::to_json(&cmaps, &cname, &relative(from, &file), &source);
                        fs::write(dest.with_file_name(&cmap), json)?;
                        fs::write(
                            &client_dest,
                            format!("{client}//# sourceMappingURL={cmap}\n"),
                        )?;
                        units.push(Unit {
                            ts: client_dest,
                            wx: file.clone(),
                            maps: cmaps,
                        });
                    }
                    None => {
                        if client_dest.exists() {
                            fs::remove_file(&client_dest)?;
                        }
                    }
                }
                if !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&format!("//# sourceMappingURL={map_name}\n"));
                text
            }
            "ts" | "mts" | "js" | "mjs" => rewrite_wx_imports(&fs::read_to_string(&file)?),
            _ => continue,
        };
        fs::write(&dest, text)?;
    }
    Ok((ok, units))
}

fn relative(from: &Path, to: &Path) -> String {
    let abs = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (from, to) = (abs(from), abs(to));
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    if common == 0 {
        return to
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    }
    let mut parts: Vec<String> = vec!["..".to_string(); a.len() - common];
    parts.extend(
        b[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

pub fn enter_dir(parent: &Path, name: &str) -> bool {
    if name == "node_modules" {
        return false;
    }
    if !name.starts_with('.') {
        return true;
    }
    name == ".well-known" && parent.file_name().is_some_and(|n| n == "pages")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ty = entry.file_type()?;
        if ty.is_dir() {
            if enter_dir(dir, &name) {
                walk(&path, out)?;
            }
        } else if ty.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

pub fn cmd_new(args: &[String]) -> ExitCode {
    let mut dir: Option<&str> = None;
    let mut tailwind = false;
    let mut minimal = false;
    for a in args {
        match a.as_str() {
            "--tailwind" => tailwind = true,
            "--minimal" => minimal = true,
            s if dir.is_none() && !s.starts_with('-') => dir = Some(s),
            s => {
                eprintln!("weft new: unexpected argument '{s}'");
                return ExitCode::FAILURE;
            }
        }
    }
    let Some(dir) = dir else {
        eprintln!("weft new: usage: weft new <dir> [--minimal [--tailwind]]");
        return ExitCode::FAILURE;
    };
    if tailwind && !minimal {
        eprintln!(
            "weft new: --tailwind applies to --minimal (the default starter already uses Tailwind)"
        );
        return ExitCode::FAILURE;
    }
    let root = Path::new(dir);
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !valid_package_name(&name) {
        eprintln!(
            "weft new: '{name}' is not a valid package name (lowercase letters, digits, '-', '_', '.')"
        );
        return ExitCode::FAILURE;
    }
    if root.exists()
        && fs::read_dir(root)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        eprintln!("weft new: '{dir}' exists and is not empty");
        return ExitCode::FAILURE;
    }
    if let Err(e) = scaffold(root, &name, Starter { tailwind, minimal }) {
        eprintln!("weft new: {e}");
        return ExitCode::FAILURE;
    }
    println!("Created {name} in {dir}\n\nNext:\n  cd {dir}\n  npm install\n  npm run dev");
    ExitCode::SUCCESS
}

#[derive(Clone, Copy, Default)]
pub struct Starter {
    pub minimal: bool,
    pub tailwind: bool,
}

const TAILWIND_CSS: &str = concat!(
    "@import \"tailwindcss\";\n",
    "\n",
    "/* Design tokens: every --color-*, --font-*, --radius-* here is also a\n",
    "   utility (bg-accent, font-sans, rounded-card). */\n",
    "@theme {\n",
    "  --color-ink: #1d2433;\n",
    "  --color-paper: #f8f7f4;\n",
    "  --color-muted: #5d6475;\n",
    "  --color-line: #dedbd2;\n",
    "  --color-accent: #2c5d8f;\n",
    "  --font-sans: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n",
    "}\n",
    "\n",
    "/* The starter's styles, under the utilities. */\n",
    "@layer base {\n",
    include_str!("../templates/app/public/styles.css"),
    "}\n",
);

const TAILWIND_DEPS: &str =
    "  \"devDependencies\": {\n    \"@tailwindcss/node\": \"^4.3.5\",\n    \"tailwindcss\": \"^4.3.5\",\n";

pub fn scaffold(root: &Path, name: &str, starter: Starter) -> io::Result<()> {
    if !starter.minimal {
        for (path, contents) in WELCOME {
            let dest = root.join(path);
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir)?;
            }
            fs::write(dest, contents.replace("{{name}}", name))?;
        }
        let names: Vec<String> = crate::add::COMPONENTS
            .iter()
            .map(|(n, _)| n.to_string())
            .collect();
        crate::add::add(root, &names, false).map_err(io::Error::other)?;
        return Ok(());
    }
    for (path, contents) in TEMPLATE {
        let mut text = contents.replace("{{name}}", name);
        if starter.tailwind {
            match *path {
                "public/styles.css" => continue,
                "src/index.html" => {
                    text = text.replace("    <link rel=\"stylesheet\" href=\"/styles.css\">\n", "")
                }
                "package.json" => text = text.replace("  \"devDependencies\": {\n", TAILWIND_DEPS),
                _ => {}
            }
        }
        let dest = root.join(path);
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(dest, text)?;
    }
    if starter.tailwind {
        let mut css = TAILWIND_CSS.to_string();
        for token in ["ink", "paper", "muted", "line", "accent"] {
            let decl = format!("  --{token}: ");
            if let Some(at) = css
                .find("@layer base {\n:root {")
                .and_then(|base| css[base..].find(&decl).map(|i| base + i))
            {
                let end = at + css[at..].find(';').unwrap_or(0);
                css.replace_range(at..end, &format!("{decl}var(--color-{token})"));
            }
        }
        fs::write(root.join("src/app.css"), css)?;
    }
    Ok(())
}

fn valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 214
        && !name.starts_with(['.', '_'])
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
}

pub fn cmd_dev(args: &[String]) -> ExitCode {
    run_server_script("dev", "dev.ts", args)
}

pub fn cmd_build(args: &[String]) -> ExitCode {
    run_server_script("build", "build.ts", args)
}

pub fn cmd_migrate(args: &[String]) -> ExitCode {
    run_server_script("migrate", "migrate.ts", args)
}

pub fn cmd_explain(args: &[String]) -> ExitCode {
    run_server_script("explain", "explain.ts", args)
}

pub fn cmd_rules(args: &[String]) -> ExitCode {
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("diff"), Some(rev)) if !rev.starts_with('-') => {
            let mut rest = vec![format!("--ref={rev}")];
            rest.extend(args[2..].iter().cloned());
            run_server_script("rules diff", "rules-diff.ts", &rest)
        }
        _ => {
            eprintln!("weft rules: expected `diff <ref> [dir]`");
            ExitCode::FAILURE
        }
    }
}

pub fn cmd_test(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        Some("rules") => run_server_script("test rules", "rules-test.ts", &args[1..]),
        _ => {
            eprintln!("weft test: expected `rules`");
            ExitCode::FAILURE
        }
    }
}

pub fn cmd_db(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        Some("seed") => run_server_script("db seed", "seed.ts", &args[1..]),
        Some("reset") => {
            let mut rest = vec!["--reset".to_string()];
            rest.extend(args[1..].iter().cloned());
            run_server_script("db reset", "seed.ts", &rest)
        }
        Some(sub @ ("backup" | "backups" | "restore")) => {
            let command = if sub == "backups" { "list" } else { sub };
            let mut rest = vec![format!("--command={command}")];
            rest.extend(args[1..].iter().cloned());
            run_server_script(&format!("db {sub}"), "db-backup.ts", &rest)
        }
        _ => {
            eprintln!("weft db: expected `seed`, `reset`, `backup`, `backups` or `restore`");
            ExitCode::FAILURE
        }
    }
}

pub fn cmd_preview(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        Some(sub @ ("up" | "list" | "down")) => {
            let mut rest = vec![format!("--command={sub}")];
            rest.extend(args[1..].iter().cloned());
            run_server_script(&format!("preview {sub}"), "preview.ts", &rest)
        }
        _ => {
            eprintln!("weft preview: expected `up --branch <name>`, `list` or `down --branch <name>`");
            ExitCode::FAILURE
        }
    }
}

pub fn cmd_replay(args: &[String]) -> ExitCode {
    let Some(file) = args.first().filter(|a| !a.starts_with('-')) else {
        eprintln!("weft replay: which recording? weft replay <file> [dir] [--url http://127.0.0.1:3000] [--test out.test.mjs]");
        return ExitCode::FAILURE;
    };
    let file = match plain_canonical(Path::new(file)) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("weft replay: cannot open '{file}': {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut rest = vec![format!("--file={}", file.display())];
    rest.extend(args[1..].iter().cloned());
    run_server_script("replay", "replay.ts", &rest)
}

pub fn cmd_data(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        Some(sub @ ("export" | "erase")) => {
            let mut rest = vec![format!("--command={sub}")];
            rest.extend(args[1..].iter().cloned());
            run_server_script(&format!("data {sub}"), "personal-data.ts", &rest)
        }
        _ => {
            eprintln!("weft data: expected `export` or `erase`");
            ExitCode::FAILURE
        }
    }
}

const FLAGS: [&str; 5] = ["--dry-run", "--allow-destructive", "--reset", "--yes", "--fail-on-widen"];

fn run_server_script(name: &str, script_file: &str, args: &[String]) -> ExitCode {
    let mut dir = ".";
    let mut rest: Vec<&String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a.starts_with('-') {
            rest.push(a);
            if !a.contains('=') && !FLAGS.contains(&a.as_str()) {
                rest.extend(it.next());
            }
        } else {
            dir = a;
        }
    }
    let root = match plain_canonical(Path::new(dir)) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("weft {name}: cannot open '{dir}': {e}");
            return ExitCode::FAILURE;
        }
    };
    let Some(script) = find_server_script(&root, script_file) else {
        eprintln!("weft {name}: @weft-framework/server not found; run `npm install` in the project");
        return ExitCode::FAILURE;
    };
    let supervise = name == "dev";
    loop {
        let mut cmd = Command::new("node");
        cmd.arg("--experimental-strip-types")
            .arg("--disable-warning=ExperimentalWarning")
            .arg(&script)
            .arg(&root)
            .args(&rest);
        if let Ok(exe) = std::env::current_exe() {
            cmd.env("WEFT_BIN", exe);
        }
        if supervise {
            cmd.env("WEFT_DEV_RESTART", "1");
        }
        match cmd.status() {
            Ok(s) if supervise && s.code() == Some(DEV_RESTART_CODE) => continue,
            Ok(s) if s.success() => return ExitCode::SUCCESS,
            Ok(_) => return ExitCode::FAILURE,
            Err(e) => {
                eprintln!("weft {name}: cannot run node: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
}

const DEV_RESTART_CODE: i32 = 75;

pub(crate) fn plain_canonical(dir: &Path) -> io::Result<PathBuf> {
    let p = fs::canonicalize(dir)?;
    Ok(match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(plain) if plain.as_bytes().get(1) == Some(&b':') => PathBuf::from(plain),
        _ => p,
    })
}

fn find_server_script(root: &Path, script_file: &str) -> Option<PathBuf> {
    let compiled = Path::new(script_file).with_extension("js");
    root.ancestors()
        .flat_map(|d| {
            let pkg = d.join("node_modules/@weft-framework/server");
            [
                pkg.join("dist").join(&compiled),
                pkg.join("src").join(script_file),
            ]
        })
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("weft-cli-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn well_known_pages_are_compiled_other_dot_dirs_are_not() {
        assert!(enter_dir(Path::new("src/pages"), ".well-known"));
        assert!(!enter_dir(Path::new("src/lib"), ".well-known"));
        assert!(!enter_dir(Path::new("src/pages/blog"), ".well-known"));
        assert!(!enter_dir(Path::new("src/pages"), ".git"));
        assert!(!enter_dir(Path::new("src"), "node_modules"));
        assert!(enter_dir(Path::new("src/pages"), "blog"));
        let dir = temp_dir("well-known");
        fs::create_dir_all(dir.join("src/pages/.well-known")).unwrap();
        fs::create_dir_all(dir.join("src/pages/.cache")).unwrap();
        fs::write(dir.join("src/pages/.well-known/security.txt.ts"), "export function GET() { return new Response(\"x\"); }
").unwrap();
        fs::write(dir.join("src/pages/.cache/junk.ts"), "export const x = 1;
").unwrap();
        let out = dir.join("out");
        assert!(compile_tree(&dir.join("src"), &out).unwrap());
        assert!(out.join("pages/.well-known/security.txt.ts").is_file());
        assert!(!out.join("pages/.cache").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn package_names() {
        assert!(valid_package_name("my-app"));
        assert!(valid_package_name("app2.web_x"));
        assert!(!valid_package_name("My-App"));
        assert!(!valid_package_name(".hidden"));
        assert!(!valid_package_name(""));
        assert!(!valid_package_name("a b"));
    }

    #[test]
    fn scaffolded_project_compiles_cleanly() {
        let dir = temp_dir("new");
        scaffold(
            &dir,
            "demo-app",
            Starter {
                minimal: true,
                ..Starter::default()
            },
        )
        .unwrap();
        assert!(fs::read_to_string(dir.join("package.json"))
            .unwrap()
            .contains("\"name\": \"demo-app\""));
        assert!(dir.join(".gitignore").is_file());
        assert!(dir.join("src/pages/blog/[slug].wx").is_file());

        let out = dir.join(".weft/out");
        assert!(compile_tree(&dir.join("src"), &out).unwrap());
        let layout = fs::read_to_string(out.join("pages/_layout.ts")).unwrap();
        assert!(layout.contains("import { Nav } from \"../components/Nav.ts\";"));
        assert!(layout.contains("export const Layout = defineComponent("));
        assert!(out.join("lib/posts.ts").is_file());
        assert!(out.join("pages/blog/[slug].ts").is_file());
        assert!(
            !out.join("index.html").exists(),
            "only modules are compiled"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn default_starter_is_the_workspace_app_with_every_component() {
        let dir = temp_dir("new-welcome");
        scaffold(&dir, "team-app", Starter::default()).unwrap();
        let pkg = fs::read_to_string(dir.join("package.json")).unwrap();
        assert!(pkg.contains("\"name\": \"team-app\""), "{pkg}");
        let layout = fs::read_to_string(dir.join("src/pages/_layout.wx")).unwrap();
        assert!(layout.contains("%s | team-app"), "{layout}");
        assert!(dir.join(".gitignore").is_file());
        for (n, _) in crate::add::COMPONENTS {
            assert!(
                dir.join(format!("src/components/ui/{n}.wx")).is_file(),
                "{n}"
            );
        }
        let theme = fs::read_to_string(dir.join("src/theme.ts")).unwrap();
        assert_eq!(
            theme,
            include_str!("../templates/welcome/src/theme.ts"),
            "the starter's theme is kept"
        );

        let out = dir.join(".weft/out");
        assert!(compile_tree(&dir.join("src"), &out).unwrap());
        assert!(out.join("pages/app/tasks/[id].ts").is_file());
        assert!(out.join("pages/app/account/index.ts").is_file());
        assert!(out.join("pages/shared/[id].ts").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tailwind_starter_moves_styles_into_app_css() {
        let dir = temp_dir("new-tw");
        scaffold(
            &dir,
            "tw-app",
            Starter {
                minimal: true,
                tailwind: true,
            },
        )
        .unwrap();
        let css = fs::read_to_string(dir.join("src/app.css")).unwrap();
        assert!(css.starts_with("@import \"tailwindcss\";"));
        assert!(css.contains("@layer base {\n:root {"), "{css}");
        assert!(css.contains("  --accent: var(--color-accent);"), "{css}");
        assert!(css.contains("  --color-accent: #2c5d8f;"), "{css}");
        assert!(!dir.join("public/styles.css").exists());
        let shell = fs::read_to_string(dir.join("src/index.html")).unwrap();
        assert!(!shell.contains("styles.css"), "{shell}");
        let pkg = fs::read_to_string(dir.join("package.json")).unwrap();
        assert!(pkg.contains("\"tailwindcss\": \"^4.3.5\""), "{pkg}");
        assert!(pkg.contains("},\n  \"engines\""), "{pkg}");
        assert_eq!(pkg.matches("\"devDependencies\"").count(), 1, "{pkg}");
        assert!(pkg.contains("\"@weft-framework/cli\": \"^0.0.6\""), "{pkg}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compile_reports_errors_but_keeps_going() {
        let dir = temp_dir("err");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(
            dir.join("src/Bad.wx"),
            "component Bad() { view { <p>{nope}</p> } }",
        )
        .unwrap();
        fs::write(
            dir.join("src/Good.wx"),
            "component Good() { view { <p>ok</p> } }",
        )
        .unwrap();
        let out = dir.join("out");
        assert!(!compile_tree(&dir.join("src"), &out).unwrap());
        assert!(out.join("Good.ts").is_file());
        assert!(!out.join("Bad.ts").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn server_scripts_are_found_compiled_or_as_sources() {
        let dir = temp_dir("scripts");
        let app = dir.join("app");
        fs::create_dir_all(&app).unwrap();
        assert_eq!(find_server_script(&app, "dev.ts"), None);
        let src = dir.join("node_modules/@weft-framework/server/src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("dev.ts"), "").unwrap();
        assert_eq!(find_server_script(&app, "dev.ts"), Some(src.join("dev.ts")));
        let dist = dir.join("node_modules/@weft-framework/server/dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("dev.js"), "").unwrap();
        assert_eq!(
            find_server_script(&app, "dev.ts"),
            Some(dist.join("dev.js"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
