use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use weft_fmt::Error;

pub fn cmd_fmt(args: &[String]) -> ExitCode {
    let check = args.iter().any(|a| a == "--check");
    let paths: Vec<&String> = args.iter().filter(|a| *a != "--check").collect();
    if let Some(bad) = paths.iter().find(|a| a.starts_with("--")) {
        eprintln!(
            "weft fmt: unknown option '{bad}'\nusage: weft fmt [--check] [paths..] | weft fmt -"
        );
        return ExitCode::from(2);
    }
    if paths.len() == 1 && paths[0] == "-" {
        return stdin_to_stdout();
    }

    let mut files = Vec::new();
    let roots: Vec<PathBuf> = if paths.is_empty() {
        vec![PathBuf::from(".")]
    } else {
        paths.iter().map(PathBuf::from).collect()
    };
    for root in &roots {
        if root.is_dir() {
            if let Err(e) = collect(root, &mut files) {
                eprintln!("weft fmt: {}: {e}", root.display());
                return ExitCode::FAILURE;
            }
        } else if root.is_file() {
            files.push(root.clone());
        } else {
            eprintln!("weft fmt: {}: no such file or directory", root.display());
            return ExitCode::FAILURE;
        }
    }

    let mut failed = false;
    let mut changed = 0;
    for file in &files {
        let shown = file.display().to_string();
        let src = match fs::read_to_string(file) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("weft fmt: {shown}: {e}");
                failed = true;
                continue;
            }
        };
        match weft_fmt::format(&src) {
            Ok(out) if out == src => {}
            Ok(out) => {
                changed += 1;
                if check {
                    println!("{shown}");
                } else if let Err(e) = fs::write(file, out) {
                    eprintln!("weft fmt: {shown}: {e}");
                    failed = true;
                } else {
                    println!("formatted {shown}");
                }
            }
            Err(Error::Syntax(diags)) => {
                crate::report(&shown, &src, &diags);
                eprintln!("weft fmt: {shown}: not formatted (syntax errors)");
                failed = true;
            }
            Err(e) => {
                eprintln!("weft fmt: {shown}: {e}");
                failed = true;
            }
        }
    }
    if check && changed > 0 {
        eprintln!(
            "weft fmt: {changed} of {} file(s) need formatting",
            files.len()
        );
        return ExitCode::FAILURE;
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn stdin_to_stdout() -> ExitCode {
    let mut src = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut src) {
        eprintln!("weft fmt: <stdin>: {e}");
        return ExitCode::FAILURE;
    }
    match weft_fmt::format(&src) {
        Ok(out) => {
            let _ = io::stdout().write_all(out.as_bytes());
            ExitCode::SUCCESS
        }
        Err(Error::Syntax(diags)) => {
            crate::report("<stdin>", &src, &diags);
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("weft fmt: <stdin>: {e}");
            ExitCode::FAILURE
        }
    }
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ty = entry.file_type()?;
        if ty.is_dir() {
            if !name.starts_with('.')
                && !matches!(name.as_ref(), "node_modules" | "dist" | "target")
            {
                collect(&path, out)?;
            }
        } else if ty.is_file() && name.ends_with(".wx") {
            out.push(path);
        }
    }
    Ok(())
}
