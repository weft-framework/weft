use std::time::{Duration, Instant};

use weft_compiler::{check, lower_client_with_map, lower_with_map, parse, tokenize};

mod gen;
use gen::source;

fn pipeline(src: &str) -> usize {
    let tokens = tokenize(src).0.len();
    let (file, diags) = parse(src);
    let checked = check(src, &file).len();
    let (server, _) = lower_with_map(src, &file);
    let client = lower_client_with_map(src, &file).map_or(0, |(js, _)| js.len());
    tokens + diags.len() + checked + server.len() + client
}

fn time(src: &str, runs: usize) -> Duration {
    let mut all: Vec<Duration> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            std::hint::black_box(pipeline(std::hint::black_box(src)));
            t.elapsed()
        })
        .collect();
    all.sort();
    all[runs / 2]
}

fn throughput(label: &str, src: &str, took: Duration) {
    let mb = src.len() as f64 / 1_048_576.0;
    eprintln!(
        "{label}: {:.2} MB, {} lines in {:?} ({:.1} MB/s)",
        mb,
        src.lines().count(),
        took,
        mb / took.as_secs_f64().max(1e-9)
    );
}

#[test]
fn generated_source_compiles_cleanly() {
    let src = source(3);
    let (file, diags) = parse(&src);
    assert!(diags.is_empty(), "parse: {diags:?}");
    let errors: Vec<_> = check(&src, &file)
        .into_iter()
        .filter(|d| d.severity == weft_compiler::Severity::Error)
        .collect();
    assert!(errors.is_empty(), "check: {errors:?}");
    let (server, _) = lower_with_map(&src, &file);
    assert!(server.contains("defineComponent(\"List2\""), "{server}");
    assert!(
        lower_client_with_map(&src, &file).is_some(),
        "the islands lower"
    );
}

#[test]
fn cost_grows_linearly_with_input() {
    let small = source(100);
    let large = source(400);
    pipeline(&small);
    let a = time(&small, 5);
    let b = time(&large, 5);
    throughput("small", &small, a);
    throughput("large", &large, b);
    let ratio = b.as_secs_f64() / a.as_secs_f64().max(1e-9);
    assert!(
        ratio < 9.0,
        "4x the input took {ratio:.1}x the time ({a:?} -> {b:?})"
    );
}

#[test]
fn large_file_stays_inside_the_budget() {
    let src = source(500);
    let took = time(&src, 3);
    throughput("budget", &src, took);
    let budget = Duration::from_secs(if cfg!(debug_assertions) { 5 } else { 1 });
    assert!(took < budget, "{took:?} over the {budget:?} budget");
}

#[test]
fn pathological_inputs_finish_quickly() {
    let budget = Duration::from_secs(if cfg!(debug_assertions) { 3 } else { 1 });
    let cases: Vec<(&str, String)> = vec![
        ("deep nesting", {
            let depth = 400;
            format!(
                "component Deep() {{ view {{ {}x{} }} }}\n",
                "<div>".repeat(depth),
                "</div>".repeat(depth)
            )
        }),
        ("long expression", {
            let terms: Vec<String> = (0..20_000).map(|i| format!("a{i}")).collect();
            format!(
                "component Long(a0: number) {{ view {{ <p>{{{}}}</p> }} }}\n",
                terms.join(" + ")
            )
        }),
        ("long text", {
            format!(
                "component Text() {{ view {{ <p title=\"{}\">{}</p> }} }}\n",
                "t".repeat(200_000),
                "word ".repeat(200_000)
            )
        }),
        ("many errors", {
            (0..2_000)
                .map(|i| format!("component E{i}() {{ view {{ <div><span>x</div> }} }}\n"))
                .collect()
        }),
        ("truncated", source(50)[..source(50).len() / 2].to_string()),
    ];
    for (label, src) in cases {
        let took = time(&src, 1);
        throughput(label, &src, took);
        assert!(
            took < budget,
            "{label}: {took:?} over the {budget:?} budget"
        );
    }
}
