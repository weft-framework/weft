use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use weft_compiler::sourcemap::original;

use crate::project::{compile_tree_mapped, plain_canonical, Unit};

const TSCONFIG: &str = r#"{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
"#;

const ACTOR_PROBE_FILE: &str = "__weft_actor_probe.ts";
const ACTOR_PROBE: &str = "import type { Actor } from \"@weft-framework/data\";\n\
type IsAny<T> = 0 extends 1 & T ? true : false;\n\
export const typed: IsAny<Actor> = false;\n";

fn take_actor_probe(diags: &mut Vec<TscDiag>) -> bool {
    let before = diags.len();
    diags.retain(|d| !d.file.ends_with(ACTOR_PROBE_FILE));
    diags.len() < before
}

fn capability_message(d: &TscDiag, generated: &str) -> Option<String> {
    if d.code != "TS2344" {
        return None;
    }
    let line = generated.lines().nth(d.line.checked_sub(1)? as usize)?;
    if !line.contains("WeftWithin<") {
        return None;
    }
    let caps = |s: &str| -> String {
        s.split('|')
            .map(|c| c.trim().trim_matches('"'))
            .filter(|c| !c.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let msg = d.message.lines().next()?;
    let got = msg.strip_prefix("Type '")?.split("' does not").next()?;
    let bound = msg.split("constraint '").nth(1)?.trim_end_matches("'.");
    let bound = if bound == "never" {
        "none".to_string()
    } else {
        caps(bound)
    };
    Some(format!(
        "this reference brings in capability `{}` (from another file), outside `uses {bound}`",
        caps(got)
    ))
}

#[derive(Debug, PartialEq)]
pub struct TscDiag {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub severity: String,
    pub code: String,
    pub message: String,
}

pub fn parse_tsc(out: &str) -> Vec<TscDiag> {
    let mut diags: Vec<TscDiag> = Vec::new();
    for line in out.lines() {
        if line.starts_with(char::is_whitespace) {
            if let Some(last) = diags.last_mut() {
                last.message.push('\n');
                last.message.push_str(line.trim_end());
            }
            continue;
        }
        let Some(open) = line.find('(') else { continue };
        let Some(close) = line[open..].find("): ").map(|i| open + i) else {
            continue;
        };
        let mut pos = line[open + 1..close].split(',');
        let (Some(Ok(l)), Some(Ok(c))) = (
            pos.next().map(str::parse::<u32>),
            pos.next().map(str::parse::<u32>),
        ) else {
            continue;
        };
        let rest = &line[close + 3..];
        let Some((head, message)) = rest.split_once(": ") else {
            continue;
        };
        let Some((severity, code)) = head.split_once(' ') else {
            continue;
        };
        diags.push(TscDiag {
            file: line[..open].to_string(),
            line: l,
            col: c,
            severity: severity.to_string(),
            code: code.to_string(),
            message: message.to_string(),
        });
    }
    diags
}

fn find_tsc(root: &Path) -> Option<PathBuf> {
    root.ancestors()
        .map(|d| d.join("node_modules/typescript/bin/tsc"))
        .find(|p| p.is_file())
}

const NO_TYPESCRIPT: &str =
    "TypeScript not found; run `npm install -D typescript` in the project for type checking";

pub fn find_typescript(root: &Path) -> Result<PathBuf, String> {
    find_tsc(root)
        .and_then(|tsc| Some(tsc.parent()?.parent()?.to_path_buf()))
        .ok_or_else(|| NO_TYPESCRIPT.to_string())
}

pub fn prepare_compiled(root: &Path, work: &str) -> Result<(PathBuf, PathBuf), String> {
    let src = source_dir(root);
    let out = root.join(".weft").join(work);
    if !out.join("tsconfig.json").is_file() {
        compile_tree_mapped(&src, &out).map_err(|e| e.to_string())?;
        fs::write(out.join("tsconfig.json"), TSCONFIG).map_err(|e| e.to_string())?;
    }
    Ok((src, out))
}

fn map_back(units: &[Unit], out: &Path, src: &Path, d: &TscDiag) -> (PathBuf, u32, u32) {
    let gen = out.join(&d.file);
    let same = |a: &Path, b: &Path| match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    };
    if let Some(u) = units.iter().find(|u| same(&u.ts, &gen)) {
        return match original(&u.maps, d.line - 1, d.col - 1) {
            Some((l, c)) => (u.wx.clone(), l + 1, c + 1),
            None => (u.wx.clone(), 1, 1),
        };
    }
    let rel = gen.strip_prefix(out).map(Path::to_path_buf).unwrap_or(gen);
    (src.join(rel), d.line, d.col)
}

#[derive(Debug)]
pub struct ProjectDiag {
    pub file: PathBuf,
    pub line: u32,
    pub col: u32,
    pub error: bool,
    pub message: String,
    pub code: String,
}

pub enum TypeCheck {
    FrontEndFailed,
    Done {
        diags: Vec<ProjectDiag>,
        actor_untyped: bool,
    },
}

pub fn source_dir(root: &Path) -> PathBuf {
    if root.join("src").is_dir() {
        root.join("src")
    } else {
        root.to_path_buf()
    }
}

pub fn check_types(root: &Path, work: &str) -> Result<TypeCheck, String> {
    let src = source_dir(root);
    let out = root.join(".weft").join(work);
    let _ = fs::remove_dir_all(&out);
    let (ok, units) = compile_tree_mapped(&src, &out).map_err(|e| e.to_string())?;
    fs::write(out.join("tsconfig.json"), TSCONFIG).map_err(|e| e.to_string())?;
    if !ok {
        return Ok(TypeCheck::FrontEndFailed);
    }
    let tsc = find_tsc(root).ok_or(NO_TYPESCRIPT)?;
    let has_models = units
        .iter()
        .any(|u| fs::read_to_string(&u.ts).is_ok_and(|t| t.contains("defineModel")));
    if has_models {
        fs::write(out.join(ACTOR_PROBE_FILE), ACTOR_PROBE).map_err(|e| e.to_string())?;
    }
    let run = Command::new("node")
        .arg(&tsc)
        .args(["-p", "tsconfig.json", "--pretty", "false"])
        .current_dir(&out)
        .output()
        .map_err(|e| format!("cannot run node: {e}"))?;
    let text = String::from_utf8_lossy(&run.stdout);
    let mut raw = parse_tsc(&text);
    let actor_untyped = take_actor_probe(&mut raw);
    if raw.is_empty() && !actor_untyped && !run.status.success() {
        return Err(format!("{text}{}", String::from_utf8_lossy(&run.stderr)));
    }
    let diags = raw
        .iter()
        .map(|d| {
            let (file, line, col) = map_back(&units, &out, &src, d);
            let generated = fs::read_to_string(out.join(&d.file)).unwrap_or_default();
            ProjectDiag {
                file,
                line,
                col,
                error: d.severity == "error",
                message: capability_message(d, &generated).unwrap_or_else(|| d.message.clone()),
                code: d.code.clone(),
            }
        })
        .collect();
    Ok(TypeCheck::Done {
        diags,
        actor_untyped,
    })
}

pub fn cmd_check_project(dir: &Path) -> ExitCode {
    let root = match plain_canonical(dir) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("weft check: cannot open '{}': {e}", dir.display());
            return ExitCode::FAILURE;
        }
    };
    let (diags, actor_untyped) = match check_types(&root, "check") {
        Ok(TypeCheck::Done {
            diags,
            actor_untyped,
        }) => (diags, actor_untyped),
        Ok(TypeCheck::FrontEndFailed) => return ExitCode::FAILURE,
        Err(e) => {
            eprintln!("weft check: {e}");
            return ExitCode::FAILURE;
        }
    };
    if actor_untyped {
        eprintln!(
            "weft check: warning: `actor` is untyped (any), so `@read`/`@write` \
             predicates are not checked against it; declare it in a .wx file, \
             e.g. `actor User`"
        );
    }
    let mut diags = diags;
    diags.extend(crate::i18n::report(&root));
    diags.extend(crate::links::report(&root));
    diags.extend(crate::actions::report(&root));
    let mut errors = false;
    for d in &diags {
        let shown = d.file.strip_prefix(&root).unwrap_or(&d.file);
        errors |= d.error;
        eprintln!(
            "{}:{}:{}: {}: {} ({})",
            shown.display().to_string().replace('\\', "/"),
            d.line,
            d.col,
            if d.error { "error" } else { "warning" },
            d.message,
            d.code
        );
    }
    if errors {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tsc_output() {
        let out = concat!(
            "pages/index.ts(12,40): error TS2339: Property 'nmae' does not exist on type 'User'.\n",
            "lib/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n",
            "  Extra detail line.\n",
            "noise without a position\n",
        );
        let d = parse_tsc(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].file, "pages/index.ts");
        assert_eq!((d[0].line, d[0].col), (12, 40));
        assert_eq!(d[0].code, "TS2339");
        assert!(d[1].message.ends_with("\n  Extra detail line."));
    }

    #[test]
    fn actor_probe_is_a_warning_not_an_error() {
        let out = concat!(
            "__weft_actor_probe.ts(3,14): error TS2322: Type 'false' is not assignable to type 'true'.\n",
            "pages/index.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        );
        let mut d = parse_tsc(out);
        assert!(take_actor_probe(&mut d));
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].file, "pages/index.ts");
        assert!(!take_actor_probe(&mut d));
    }

    #[test]
    fn capability_bounds_are_explained() {
        let d = TscDiag {
            file: "Page.ts".into(),
            line: 2,
            col: 60,
            severity: "error".into(),
            code: "TS2344".into(),
            message: "Type '\"fs\" | \"net\"' does not satisfy the constraint 'never'.".into(),
        };
        let gen = "x\nexport type __weftUses_Page_0 = WeftWithin<never, EffectOf<typeof __weftM0, \"Card\">>;\n";
        assert_eq!(
            capability_message(&d, gen).as_deref(),
            Some("this reference brings in capability `fs, net` (from another file), outside `uses none`")
        );
        assert_eq!(
            capability_message(&d, "x\nconst a: number = 1;\n"),
            None,
            "other TS2344s are left alone"
        );
    }
}
