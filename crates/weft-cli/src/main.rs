mod add;
mod doctor;
mod fmt;
mod i18n;
mod links;
mod lsp;
mod project;
mod types;

use std::process::ExitCode;

use weft_compiler::ast::SourceFile;
use weft_compiler::{check, line_col, lower, lower_client, parse, tokenize, Severity};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("tokens") => cmd_tokens(args.get(1)),
        Some("parse") => cmd_parse(args.get(1)),
        Some("check") => cmd_check(args.get(1)),
        Some("emit") => cmd_emit(&args[1..]),
        Some("compile") => project::cmd_compile(&args[1..]),
        Some("fmt") => fmt::cmd_fmt(&args[1..]),
        Some("new") => project::cmd_new(&args[1..]),
        Some("add") => add::cmd_add(&args[1..]),
        Some("doctor") => doctor::cmd_doctor(&args[1..]),
        Some("dev") => project::cmd_dev(&args[1..]),
        Some("build") => project::cmd_build(&args[1..]),
        Some("migrate") => project::cmd_migrate(&args[1..]),
        Some("explain") => project::cmd_explain(&args[1..]),
        Some("test") => project::cmd_test(&args[1..]),
        Some("rules") => project::cmd_rules(&args[1..]),
        Some("db") => project::cmd_db(&args[1..]),
        Some("preview") => project::cmd_preview(&args[1..]),
        Some("data") => project::cmd_data(&args[1..]),
        Some("replay") => project::cmd_replay(&args[1..]),
        Some("lsp") => lsp::cmd_lsp(),
        Some("version") | Some("--version") | Some("-V") => {
            println!("weft {VERSION}");
            ExitCode::SUCCESS
        }
        Some("help") | Some("--help") | Some("-h") | None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("weft: unknown command '{other}'\n");
            print_usage();
            ExitCode::FAILURE
        }
    }
}

fn print_usage() {
    println!(
        "weft {VERSION}\n\n\
         Usage:\n\
         \x20 weft tokens <file.wx>   Lex a file and print its token stream\n\
         \x20 weft check <file.wx>    Parse and check a file\n\
         \x20 weft check <dir>        Check a project, including types (tsc)\n\
         \x20 weft emit <file.wx>     Check a file and print the TypeScript\n\
         \x20 weft emit --client <file.wx>\n\
         \x20                         Print the browser module of its islands\n\
         \x20 weft parse <file.wx>    Parse a file and print its AST\n\
         \x20 weft compile <dir> --out <dir>\n\
         \x20                         Compile a source tree to TypeScript\n\
         \x20 weft fmt [--check] [paths..]\n\
         \x20                         Format .wx files (- for stdin to stdout)\n\
         \x20 weft new <dir> [--minimal [--tailwind]]\n\
         \x20                         Create a project: the component tour, or a small blog\n\
         \x20 weft add <names..> [--overwrite] | --all | --list\n\
         \x20                         Copy UI components into the project (src/components/ui)\n\
         \x20 weft doctor [dir]       Check the project and this machine are set up\n\
         \x20 weft dev [dir]          Run the development server for a project\n\
         \x20 weft build [dir] [--out dist]\n\
         \x20                         Build for production (node dist/server.mjs)\n\
         \x20 weft migrate [dir] [--dry-run] [--allow-destructive]\n\
         \x20                         Migrate the project's database to its models\n\
         \x20 weft explain [dir] [--tenant <id>]\n\
         \x20                         Show what the data rules and roles allow\n\
         \x20 weft test rules [dir] [--runs <n>] [--seed <n>] [--model <name>]\n\
         \x20                         Fuzz the data rules: no read or write gets past them\n\
         \x20 weft rules diff <ref> [dir] [--fail-on-widen]\n\
         \x20                         What access a change to the rules widens or narrows\n\
         \x20 weft preview up --branch <name> [dir] [--url <pattern>] [--port <n>] [--reset]\n\
         \x20                         Run the branch as a preview with its own database\n\
         \x20 weft preview list [dir] | down --branch <name> [dir]\n\
         \x20 weft db seed [dir]      Fill the database from src/seed.ts\n\
         \x20 weft db reset [dir] --yes\n\
         \x20                         Delete the database, then seed it\n\
         \x20 weft db backup [dir] | backups [dir]\n\
         \x20                         Back up the database, or list the backups\n\
         \x20 weft db restore [dir] --name <file> --yes\n\
         \x20                         Replace the database with a backup (server stopped)\n\
         \x20 weft data export [dir] --key <id> [--model User] [--out file.json]\n\
         \x20                         Export one person's data, following @ref fields\n\
         \x20 weft data erase [dir] --key <id> [--model User] (--dry-run | --yes)\n\
         \x20                         Erase one person's data: delete what they own, unlink the rest\n\
         \x20 weft replay <file> [dir] [--url <origin>] [--cookie name=value] [--test out.test.mjs]\n\
         \x20                         Replay a dev-overlay recording (values redacted); --test writes a test\n\
         \x20 weft lsp               Run the language server on stdio (for editors)\n\
         \x20 weft version           Print the toolchain version\n\
         \x20 weft help               Show this message"
    );
}

fn read_source(path: Option<&String>, cmd: &str) -> Result<(String, String), ()> {
    let Some(path) = path else {
        eprintln!("weft {cmd}: expected a file path");
        return Err(());
    };
    match std::fs::read_to_string(path) {
        Ok(s) => Ok((path.clone(), s)),
        Err(e) => {
            eprintln!("weft: cannot read '{path}': {e}");
            Err(())
        }
    }
}

pub(crate) fn report(path: &str, src: &str, diags: &[weft_compiler::Diagnostic]) -> bool {
    for d in diags {
        let (line, col) = line_col(src, d.span.start);
        let label = match d.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        eprintln!("{path}:{line}:{col}: {label}: {}", d.message);
    }
    diags.iter().any(|d| d.severity == Severity::Error)
}

fn cmd_parse(path: Option<&String>) -> ExitCode {
    let Ok((path, src)) = read_source(path, "parse") else {
        return ExitCode::FAILURE;
    };
    let (file, diags) = parse(&src);
    println!("{file:#?}");
    if report(&path, &src, &diags) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

pub(crate) fn front_end(path: &str, src: &str) -> Option<SourceFile> {
    let (file, mut diags) = parse(src);
    if !diags.iter().any(|d| d.severity == Severity::Error) {
        diags.extend(check(src, &file));
    }
    if report(path, src, &diags) {
        None
    } else {
        Some(file)
    }
}

fn cmd_check(path: Option<&String>) -> ExitCode {
    if let Some(dir) = path.filter(|p| std::path::Path::new(p).is_dir()) {
        return types::cmd_check_project(std::path::Path::new(dir));
    }
    let Ok((path, src)) = read_source(path, "check") else {
        return ExitCode::FAILURE;
    };
    match front_end(&path, &src) {
        Some(_) => ExitCode::SUCCESS,
        None => ExitCode::FAILURE,
    }
}

fn cmd_emit(args: &[String]) -> ExitCode {
    let client = args.first().is_some_and(|a| a == "--client");
    let path = args.get(usize::from(client));
    let Ok((path, src)) = read_source(path, "emit") else {
        return ExitCode::FAILURE;
    };
    let Some(file) = front_end(&path, &src) else {
        return ExitCode::FAILURE;
    };
    if client {
        print!("{}", lower_client(&file).unwrap_or_default());
    } else {
        print!("{}", lower(&src, &file));
    }
    ExitCode::SUCCESS
}

fn cmd_tokens(path: Option<&String>) -> ExitCode {
    let Some(path) = path else {
        eprintln!("weft tokens: expected a file path");
        return ExitCode::FAILURE;
    };
    let src = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("weft: cannot read '{path}': {e}");
            return ExitCode::FAILURE;
        }
    };
    let (tokens, diagnostics) = tokenize(&src);
    for tok in &tokens {
        let (line, col) = line_col(&src, tok.span.start);
        println!("{line}:{col}\t{:?}", tok.kind);
    }
    for d in &diagnostics {
        let (line, col) = line_col(&src, d.span.start);
        let label = match d.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        eprintln!("{path}:{line}:{col}: {label}: {}", d.message);
    }
    if diagnostics.iter().any(|d| d.severity == Severity::Error) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
