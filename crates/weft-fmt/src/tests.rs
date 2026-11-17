use std::fs;
use std::path::{Path, PathBuf};

use super::{format, Error};

fn fmt(src: &str) -> String {
    match format(src) {
        Ok(out) => out,
        Err(e) => panic!("{e}: {e:?}"),
    }
}

fn stable(src: &str) -> String {
    let once = fmt(src);
    assert_eq!(fmt(&once), once, "not idempotent");
    once
}

#[test]
fn lays_out_a_messy_file() {
    let src = "// header\nimport { x } from \"./x.ts\"   \n\n\n\n   component   Counter( start: number )   {\n      signal count = start\n        // bump it\n      function inc() {\n        count += 1\n      }\n\n      view {\n   <div class=\"counter\">\n   <button @click={inc}>+</button>\n        <span>{ count }</span>\n   </div>\n      }\n   style {\n     .counter { display: flex }\n   }\n   }\nmodel Note {\ntitle: string\n  @read(true)\n}";
    let want = "// header
import { x } from \"./x.ts\"

component Counter( start: number ) {
  signal count = start
    // bump it
  function inc() {
    count += 1
  }

  view {
    <div class=\"counter\">
      <button @click={inc}>+</button>
      <span>{count}</span>
    </div>
  }
  style {
    .counter { display: flex }
  }
}
model Note {
  title: string
    @read(true)
}
";
    assert_eq!(stable(src), want);
}

#[test]
fn keeps_every_comment() {
    let src = "/* a */ component A() { // b\n  // c\n  view { <!-- d -->\n<p>x</p> } // e\n  /* f */ }\n// g\nmodel M { // h\n  n: string // i\n}\n";
    let out = stable(src);
    for c in [
        "/* a */",
        "// b",
        "// c",
        "<!-- d -->",
        "// e",
        "/* f */",
        "// g",
        "// h",
        "// i",
    ] {
        assert!(out.contains(c), "lost {c}:\n{out}");
    }
}

#[test]
fn template_literals_and_pre_keep_their_whitespace() {
    let src = "component A() {\n      signal s = `x\n   y  `\n      view {\n<pre>\n  a   b\n</pre>\n}\n}\n";
    let out = stable(src);
    assert!(out.contains("signal s = `x\n   y  `"), "{out}");
    assert!(out.contains("<pre>\n  a   b\n</pre>"), "{out}");
}

#[test]
fn actions_stores_and_placed_code() {
    let src = "action  add(title: string)   {\n        await save(title)\n}\nstore app   visits = 0\nclient function money(c: number) {\n      return c / 100\n    }\n";
    let out = stable(src);
    assert_eq!(
        out,
        "action add(title: string) {\n  await save(title)\n}\nstore app   visits = 0\nclient function money(c: number) {\n  return c / 100\n}\n"
    );
}

#[test]
fn blank_lines_between_items_are_kept_once() {
    let out = stable("component A() { view {} }\n\n\n\ncomponent B() { view {} }\n\n\n");
    assert_eq!(
        out,
        "component A() {\n  view {}\n}\n\ncomponent B() {\n  view {}\n}\n"
    );
}

#[test]
fn quotes_in_a_regular_expression_are_not_strings() {
    let src = "const EMAIL = /^[^\\s@\"]+@[^\\s@\"]+$/;\n\naction invite(address: string) {\n  return EMAIL.test(address)\n}\n";
    assert_eq!(stable(src), src);
    let slash = "const R = /[/\"]/g;\n\n\naction a() {\n  return \"x\".replace(R, \"\")\n}\n";
    assert_eq!(stable(slash), "const R = /[/\"]/g;\n\naction a() {\n  return \"x\".replace(R, \"\")\n}\n");
}

#[test]
fn blank_lines_stay_put_when_the_scan_is_unsure() {
    let src = "export function ok(s: string) {\n  if (s) /\"/.test(s)\n}\n\naction a() {\n  return 1\n}\n";
    stable(src);
}

#[test]
fn line_endings_follow_the_file() {
    let out = stable("component A() {\r\n view {\r\n<p>x</p>\r\n}\r\n}\r\n");
    assert_eq!(
        out,
        "component A() {\r\n  view {\r\n    <p>x</p>\r\n  }\r\n}\r\n"
    );
    assert_eq!(fmt("const a = 1\n"), "const a = 1\n");
}

#[test]
fn syntax_errors_are_not_formatted() {
    assert!(matches!(
        format("component A() { view { <p> } }"),
        Err(Error::Syntax(_))
    ));
}

#[test]
fn plain_typescript_only() {
    assert_eq!(
        stable("  const a = 1   \n\n\n\n  export {}"),
        "const a = 1\n\nexport {}\n"
    );
    assert_eq!(fmt(""), "");
}

fn wx_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if !name.starts_with('.')
                && !matches!(name.as_str(), "node_modules" | "target" | "dist")
            {
                wx_files(&p, out);
            }
        } else if name.ends_with(".wx") {
            out.push(p);
        }
    }
}

#[test]
fn repository_sources_format_and_are_stable() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for dir in ["examples", "crates/weft-cli/templates"] {
        wx_files(&root.join(dir), &mut files);
    }
    assert!(files.len() >= 7, "found {files:?}");
    for f in files {
        let src = fs::read_to_string(&f).unwrap();
        let out = format(&src).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        assert_eq!(format(&out).unwrap(), out, "{} is not stable", f.display());
    }
}
