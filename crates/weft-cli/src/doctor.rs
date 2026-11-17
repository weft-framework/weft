use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use serde_json::Value;

use crate::project::plain_canonical;

const NODE_MIN: (u32, u32) = (22, 6);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub level: Level,
    pub text: String,
    pub fix: Option<String>,
}

fn ok(text: impl Into<String>) -> Finding {
    Finding {
        level: Level::Ok,
        text: text.into(),
        fix: None,
    }
}
fn warn(text: impl Into<String>, fix: impl Into<String>) -> Finding {
    Finding {
        level: Level::Warn,
        text: text.into(),
        fix: Some(fix.into()),
    }
}
fn error(text: impl Into<String>, fix: impl Into<String>) -> Finding {
    Finding {
        level: Level::Error,
        text: text.into(),
        fix: Some(fix.into()),
    }
}

pub fn cmd_doctor(args: &[String]) -> ExitCode {
    let dir = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(String::as_str)
        .unwrap_or(".");
    let root = match plain_canonical(Path::new(dir)) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("weft doctor: cannot open '{dir}': {e}");
            return ExitCode::FAILURE;
        }
    };
    let node = Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let findings = diagnose(&root, node.as_deref(), env!("CARGO_PKG_VERSION"));
    println!("weft doctor  {}\n", root.display());
    for f in &findings {
        let tag = match f.level {
            Level::Ok => "ok   ",
            Level::Warn => "warn ",
            Level::Error => "error",
        };
        println!("  {tag}  {}", f.text);
        if let Some(fix) = &f.fix {
            println!("         -> {fix}");
        }
    }
    let errors = findings.iter().filter(|f| f.level == Level::Error).count();
    let warnings = findings.iter().filter(|f| f.level == Level::Warn).count();
    println!("\n{errors} error(s), {warnings} warning(s)");
    if errors > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

pub fn diagnose(root: &Path, node: Option<&str>, toolchain: &str) -> Vec<Finding> {
    let mut out = vec![ok(format!("weft toolchain {toolchain}"))];
    out.push(check_node(node));

    let pkg_path = root.join("package.json");
    let pkg: Option<Value> = match fs::read_to_string(&pkg_path) {
        Err(_) => {
            out.push(error(
                "no package.json",
                "run `weft doctor` in the project directory, or create one with `weft new`",
            ));
            None
        }
        Ok(text) => match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                out.push(error(
                    format!("package.json is not valid JSON: {e}"),
                    "fix the file",
                ));
                None
            }
        },
    };
    if root.join("src/pages").is_dir() {
        out.push(ok("src/pages found"));
    } else {
        out.push(error(
            "no src/pages directory",
            "pages live in src/pages (src/pages/index.wx is `/`)",
        ));
    }
    if let Some(pkg) = &pkg {
        out.extend(check_packages(root, pkg, toolchain));
    }
    if resolve(root, "typescript").is_some() {
        out.push(ok("typescript installed"));
    } else {
        out.push(warn(
            "typescript not installed: `weft check` cannot check types",
            "npm install -D typescript",
        ));
    }
    out.extend(check_tailwind(root));
    out.extend(check_postcss(root));
    out.extend(check_i18n(root));
    out.extend(check_secrets(root));
    out
}

fn check_node(node: Option<&str>) -> Finding {
    let Some(v) = node else {
        return error("node not found on PATH", "install Node.js 22.6 or newer");
    };
    let mut parts = v
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or(0));
    let have = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    if have >= NODE_MIN {
        ok(format!("node {v}"))
    } else {
        error(
            format!("node {v} is too old: weft runs TypeScript with type stripping"),
            format!("install Node.js {}.{} or newer", NODE_MIN.0, NODE_MIN.1),
        )
    }
}

fn resolve(root: &Path, name: &str) -> Option<PathBuf> {
    root.ancestors()
        .map(|d| d.join("node_modules").join(name))
        .find(|p| p.join("package.json").is_file())
}

fn installed_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

fn dependencies(pkg: &Value) -> Vec<String> {
    let mut names: Vec<String> = ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|k| pkg.get(k)?.as_object())
        .flat_map(|o| o.keys().cloned())
        .collect();
    names.sort();
    names.dedup();
    names
}

fn check_packages(root: &Path, pkg: &Value, toolchain: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    let deps = dependencies(pkg);
    let weft: Vec<&String> = deps.iter().filter(|d| d.starts_with("@weft/")).collect();
    if !weft.iter().any(|d| *d == "@weft/server") {
        out.push(error(
            "@weft/server is not a dependency",
            "npm install @weft/server @weft/runtime",
        ));
    }
    let mut versions: Vec<(String, String)> = Vec::new();
    for name in weft {
        match resolve(root, name).and_then(|d| installed_version(&d)) {
            Some(v) => versions.push((name.clone(), v)),
            None => out.push(error(
                format!("{name} is in package.json but not installed"),
                "npm install",
            )),
        }
    }
    let mut distinct: Vec<&str> = versions.iter().map(|(_, v)| v.as_str()).collect();
    distinct.sort();
    distinct.dedup();
    if distinct.len() > 1 {
        let list = versions
            .iter()
            .map(|(n, v)| format!("{n} {v}"))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(warn(
            format!("@weft packages of different versions: {list}"),
            "install the same version of every @weft package",
        ));
    } else if let Some(v) = distinct.first() {
        if *v == toolchain {
            out.push(ok(format!("{} @weft package(s) at {v}", versions.len())));
        } else {
            out.push(warn(
                format!("@weft packages are {v}, the weft toolchain is {toolchain}"),
                "use the same version of the CLI and the packages",
            ));
        }
    }
    out
}

fn check_tailwind(root: &Path) -> Vec<Finding> {
    let Ok(css) = fs::read_to_string(root.join("src/app.css")) else {
        return Vec::new();
    };
    let uses = css.lines().any(|l| {
        let l = l.trim_start();
        l.starts_with("@import \"tailwindcss")
            || l.starts_with("@import 'tailwindcss")
            || l.starts_with("@tailwind ")
    });
    if !uses {
        return Vec::new();
    }
    let missing: Vec<&str> = ["tailwindcss", "@tailwindcss/node"]
        .into_iter()
        .filter(|n| resolve(root, n).is_none())
        .collect();
    if missing.is_empty() {
        vec![ok("tailwind installed (src/app.css imports it)")]
    } else {
        vec![error(
            format!(
                "src/app.css imports Tailwind but {} is not installed",
                missing.join(" and ")
            ),
            "npm install -D tailwindcss @tailwindcss/node",
        )]
    }
}

fn check_postcss(root: &Path) -> Vec<Finding> {
    let Some(config) = [
        "postcss.config.js",
        "postcss.config.mjs",
        "postcss.config.cjs",
    ]
    .into_iter()
    .find(|n| root.join(n).is_file()) else {
        return Vec::new();
    };
    if resolve(root, "postcss").is_some() {
        vec![ok(format!(
            "postcss installed ({config} runs over the stylesheets)"
        ))]
    } else {
        vec![error(
            format!("{config} found but postcss is not installed"),
            "npm install -D postcss",
        )]
    }
}

fn check_i18n(root: &Path) -> Vec<Finding> {
    if !root.join("src/locales").is_dir() {
        return Vec::new();
    }
    let config = ["src/i18n.ts", "src/i18n.wx"]
        .iter()
        .any(|p| root.join(p).is_file());
    let mut out = Vec::new();
    if !config {
        out.push(warn(
            "src/locales exists but there is no src/i18n.ts",
            "define the locales there with defineI18n from @weft/i18n",
        ));
    }
    if resolve(root, "@weft/i18n").is_none() {
        out.push(warn(
            "src/locales exists but @weft/i18n is not installed",
            "npm install @weft/i18n",
        ));
    }
    if out.is_empty() {
        out.push(ok("translations: src/i18n.ts and @weft/i18n found"));
    }
    out
}

fn literal_secret(config: &str) -> bool {
    config.lines().any(|l| {
        let l = l.trim_start();
        if l.starts_with("//") || l.starts_with('*') {
            return false;
        }
        let Some(i) = l.find("secret") else {
            return false;
        };
        let rest = l[i + "secret".len()..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            return false;
        };
        matches!(rest.trim_start().chars().next(), Some('"' | '\'' | '`'))
    })
}

fn ignores_env(gitignore: &str) -> bool {
    gitignore.lines().map(str::trim).any(|l| {
        matches!(
            l,
            ".env" | "/.env" | ".env*" | "/.env*" | "*.env" | ".env.*"
        )
    }) && !gitignore
        .lines()
        .any(|l| matches!(l.trim(), "!.env" | "!/.env"))
}

fn check_secrets(root: &Path) -> Vec<Finding> {
    let mut out = Vec::new();
    for name in ["weft.config.ts", "weft.config.js", "weft.config.mjs"] {
        if let Ok(text) = fs::read_to_string(root.join(name)) {
            if literal_secret(&text) {
                out.push(warn(
                    format!("{name} has the session secret written in it"),
                    "read it from the environment: secret: process.env.WEFT_SECRET, set in .env",
                ));
            }
        }
    }
    if root.join(".env").is_file() {
        let in_git = root.ancestors().any(|d| d.join(".git").exists());
        let ignored = fs::read_to_string(root.join(".gitignore"))
            .map(|t| ignores_env(&t))
            .unwrap_or(false);
        if !ignored {
            let why = if in_git {
                "git will commit it"
            } else {
                "a repository would commit it"
            };
            out.push(warn(
                format!(".env is not in .gitignore: {why}"),
                "add a line `.env` to .gitignore",
            ));
        } else {
            out.push(ok(".env is ignored by git"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("weft-doctor-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn put(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    fn levels(f: &[Finding], level: Level) -> Vec<String> {
        f.iter()
            .filter(|x| x.level == level)
            .map(|x| x.text.clone())
            .collect()
    }

    #[test]
    fn node_versions() {
        assert_eq!(check_node(Some("v22.6.0")).level, Level::Ok);
        assert_eq!(check_node(Some("v24.1.0")).level, Level::Ok);
        assert_eq!(check_node(Some("v22.5.1")).level, Level::Error);
        assert_eq!(check_node(Some("v20.11.0")).level, Level::Error);
        assert_eq!(check_node(None).level, Level::Error);
    }

    #[test]
    fn healthy_project_has_no_errors() {
        let root = scratch("ok");
        put(
            &root,
            "package.json",
            r#"{"dependencies":{"@weft/server":"^0.0.1","@weft/runtime":"^0.0.1"}}"#,
        );
        put(&root, "src/pages/index.wx", "");
        put(
            &root,
            "node_modules/@weft/server/package.json",
            r#"{"version":"0.0.1"}"#,
        );
        put(
            &root,
            "node_modules/@weft/runtime/package.json",
            r#"{"version":"0.0.1"}"#,
        );
        put(
            &root,
            "node_modules/typescript/package.json",
            r#"{"version":"5.9.0"}"#,
        );
        let f = diagnose(&root, Some("v22.12.0"), "0.0.1");
        assert!(levels(&f, Level::Error).is_empty(), "{f:?}");
        assert!(levels(&f, Level::Warn).is_empty(), "{f:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reports_what_is_wrong() {
        let root = scratch("bad");
        put(
            &root,
            "package.json",
            r#"{"dependencies":{"@weft/server":"^0.0.1","@weft/runtime":"^0.0.1","@weft/ui":"^0.0.1"}}"#,
        );
        put(
            &root,
            "node_modules/@weft/server/package.json",
            r#"{"version":"0.0.2"}"#,
        );
        put(
            &root,
            "node_modules/@weft/runtime/package.json",
            r#"{"version":"0.0.1"}"#,
        );
        put(&root, "src/app.css", "@import \"tailwindcss\";\n");
        put(&root, "src/locales/en.ts", "export default {}");
        put(
            &root,
            "weft.config.ts",
            "export default {\n  secret: \"hunter2-hunter2\",\n};\n",
        );
        put(&root, ".env", "WEFT_SECRET=x\n");
        put(&root, ".gitignore", "node_modules\n");
        put(
            &root,
            "postcss.config.js",
            "export default { plugins: {} };\n",
        );
        let f = diagnose(&root, Some("v22.12.0"), "0.0.1");
        let errors = levels(&f, Level::Error);
        let warns = levels(&f, Level::Warn);
        assert!(
            errors.iter().any(|e| e.contains("no src/pages")),
            "{errors:?}"
        );
        assert!(
            errors
                .iter()
                .any(|e| e.contains("@weft/ui is in package.json but not installed")),
            "{errors:?}"
        );
        assert!(errors.iter().any(|e| e.contains("Tailwind")), "{errors:?}");
        assert!(
            errors
                .iter()
                .any(|e| e.contains("postcss is not installed")),
            "{errors:?}"
        );
        assert!(
            warns.iter().any(|w| w.contains("different versions")),
            "{warns:?}"
        );
        assert!(warns.iter().any(|w| w.contains("typescript")), "{warns:?}");
        assert!(
            warns.iter().any(|w| w.contains("no src/i18n.ts")),
            "{warns:?}"
        );
        assert!(
            warns.iter().any(|w| w.contains("secret written")),
            "{warns:?}"
        );
        assert!(
            warns
                .iter()
                .any(|w| w.contains(".env is not in .gitignore")),
            "{warns:?}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn secret_and_gitignore_rules() {
        assert!(literal_secret("  secret: 'abc',"));
        assert!(literal_secret("export default { secret: `x` }"));
        assert!(!literal_secret("  secret: process.env.WEFT_SECRET,"));
        assert!(!literal_secret("  // secret: \"old\""));
        assert!(ignores_env("node_modules\n.env\n"));
        assert!(ignores_env("/.env*\n"));
        assert!(!ignores_env(".env.example\n"));
        assert!(!ignores_env(".env\n!.env\n"));
    }
}
