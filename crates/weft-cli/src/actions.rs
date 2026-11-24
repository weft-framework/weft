use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use weft_compiler::ast::Item;
use weft_compiler::{line_col, parse};

use crate::types::{source_dir, ProjectDiag};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if crate::project::enter_dir(dir, &name) {
                files(&p, out);
            }
        } else if name.ends_with(".wx") {
            out.push(p);
        }
    }
}

fn shown(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn report(root: &Path) -> Vec<ProjectDiag> {
    let src = source_dir(root);
    let mut sources = Vec::new();
    files(&src, &mut sources);
    sources.sort();
    let mut seen: BTreeMap<(bool, String), Vec<(PathBuf, u32, u32)>> = BTreeMap::new();
    for file in sources {
        let Ok(source) = fs::read_to_string(&file) else {
            continue;
        };
        let (ast, _) = parse(&source);
        for item in &ast.items {
            if let Item::Action(a) = item {
                let (line, col) = line_col(&source, a.span.start);
                seen.entry((a.job, a.name.clone())).or_default().push((
                    file.clone(),
                    line as u32,
                    col as u32,
                ));
            }
        }
    }
    let mut out = Vec::new();
    for ((job, name), places) in seen {
        if places.len() < 2 {
            continue;
        }
        let kind = if job { "job" } else { "action" };
        for (i, (file, line, col)) in places.iter().enumerate() {
            let others: Vec<String> = places
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, (f, l, _))| format!("{}:{l}", shown(root, f)))
                .collect();
            out.push(ProjectDiag {
                file: file.clone(),
                line: *line,
                col: *col,
                error: true,
                message: format!(
                    "{kind} `{name}` is also defined in {}; {kind} names are app-wide, rename one",
                    others.join(", ")
                ),
                code: format!("duplicate-{kind}"),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_action_names_are_reported_in_every_file() {
        let dir = std::env::temp_dir().join(format!("weft-actions-dup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/pages/admin")).unwrap();
        fs::create_dir_all(dir.join("src/pages/team")).unwrap();
        fs::write(
            dir.join("src/pages/admin/staff.wx"),
            "action invite(email: string) { return 1 }\naction staffOnly() { return 1 }\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/pages/team/index.wx"),
            "\naction invite(email: string) { return 2 }\naction job invite() { return 3 }\n",
        )
        .unwrap();
        let diags = report(&dir);
        assert_eq!(diags.len(), 2, "{diags:?}");
        assert!(diags
            .iter()
            .all(|d| d.error && d.code == "duplicate-action"));
        let staff = diags.iter().find(|d| d.file.ends_with("staff.wx")).unwrap();
        assert_eq!(staff.line, 1);
        assert!(
            staff.message.contains("src/pages/team/index.wx:2"),
            "{}",
            staff.message
        );
        let team = diags.iter().find(|d| d.file.ends_with("index.wx")).unwrap();
        assert_eq!(team.line, 2);
        assert!(
            team.message.contains("src/pages/admin/staff.wx:1"),
            "{}",
            team.message
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
