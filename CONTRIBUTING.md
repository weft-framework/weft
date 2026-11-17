# Contributing

Patches, bug reports and questions are welcome. Weft is pre-1.0 and the
internals still shift week to week, so for anything larger than a fix, open an
issue first and we can talk about direction before you write the code.

## Building and testing

The Rust side needs a recent stable Rust:

```sh
cargo build --workspace
cargo test --workspace
```

The TypeScript packages run on Node 22.6+ with type stripping and are not part
of the Rust workspace:

```sh
npm install
npm run typecheck
npm test
```

The compiler's performance test is part of `cargo test`: it runs the whole
pipeline over generated files and fails if a pass goes quadratic or a large
file gets slow. The benchmarks under `bench/` measure served pages (TTFB,
throughput, JavaScript shipped, memory per live page) with `npm run bench`;
compare runs made the same way, before and after a change.

## Code style

- **Rust**: `cargo fmt` and `cargo clippy` stay clean. The compiler is
  hand-written and light on dependencies on purpose. Add a crate when it earns
  its place, not before.
- **`.wx`**: format with `weft fmt`. There is no Prettier config; the sources
  are hand-wrapped and the formatter keeps them that way.
- The codebase is deliberately comment-light. Reach for a name that explains
  itself before a comment, and when a comment is needed, say why, not what.
- Tests travel with the code. A lexer, parser or lowering change lands with its
  unit tests in the same module.

## Keep a change to one layer

Pull requests that stay inside one layer, the compiler, the runtime, the server
or the data package, are easy to review and easy to revert. Cross-cutting
changes are neither; split them when you can.

## Commits

Imperative mood ("Fix pool scoping on nested queries"), small and focused, with
the reason in the body when it is not obvious from the diff.

## License

By contributing you agree that your work is licensed under the MIT License that
covers this project.
