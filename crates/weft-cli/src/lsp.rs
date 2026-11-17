use std::io::{self, BufReader};
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use weft_lsp::{Options, TsPrepare, TsProject, TypeChecker, TypeDiag};

use crate::project::plain_canonical;
use crate::types::{check_types, find_typescript, prepare_compiled, TypeCheck};

const WORK: &str = "lsp";

fn type_check(root: &Path) -> Result<Vec<TypeDiag>, String> {
    let root = plain_canonical(root).map_err(|e| e.to_string())?;
    match check_types(&root, WORK)? {
        TypeCheck::FrontEndFailed => Ok(Vec::new()),
        TypeCheck::Done { diags, .. } => Ok(diags
            .into_iter()
            .map(|d| TypeDiag {
                file: d.file,
                line: d.line,
                col: d.col,
                error: d.error,
                message: d.message,
                code: d.code,
            })
            .collect()),
    }
}

fn prepare_ts(root: &Path) -> Result<TsProject, String> {
    let root = plain_canonical(root).map_err(|e| e.to_string())?;
    let typescript = find_typescript(&root)?;
    let (src, out) = prepare_compiled(&root, WORK)?;
    Ok(TsProject {
        src,
        out,
        typescript,
    })
}

pub fn cmd_lsp() -> ExitCode {
    let checker: TypeChecker = Arc::new(type_check);
    let ts: TsPrepare = Arc::new(prepare_ts);
    let opts = Options {
        type_check: Some(checker),
        ts: Some(ts),
    };
    match weft_lsp::serve(BufReader::new(io::stdin()), io::stdout(), opts) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("weft lsp: {e}");
            ExitCode::FAILURE
        }
    }
}
