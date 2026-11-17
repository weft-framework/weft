use std::time::Instant;

use weft_compiler::{check, lower_client_with_map, lower_with_map, parse, tokenize};

#[path = "../tests/gen/mod.rs"]
mod gen;

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    let src = gen::source(n);
    let t = Instant::now();
    let _ = tokenize(&src);
    eprintln!("tokenize      {:?}", t.elapsed());
    let t = Instant::now();
    let (file, _) = parse(&src);
    eprintln!("parse         {:?}", t.elapsed());
    let t = Instant::now();
    let _ = check(&src, &file);
    eprintln!("check         {:?}", t.elapsed());
    let t = Instant::now();
    let _ = lower_with_map(&src, &file);
    eprintln!("lower+map     {:?}", t.elapsed());
    let t = Instant::now();
    let _ = lower_client_with_map(&src, &file);
    eprintln!("client+map    {:?}", t.elapsed());
}
