# @weft-framework/cli

The `weft` command for [Weft](https://github.com/weft-framework/weft) projects: the `.wx` compiler, the dev server,
the formatter and the language server your editor talks to.

It's written in Rust and comes prebuilt, so you don't need a Rust toolchain. npm installs only the binary for
your machine:

| Platform | Package |
|----------|---------|
| Windows x64 / ARM64 | `@weft-framework/cli-win32-x64`, `@weft-framework/cli-win32-arm64` |
| macOS Intel / Apple Silicon | `@weft-framework/cli-darwin-x64`, `@weft-framework/cli-darwin-arm64` |
| Linux x64 / ARM64 (static, works on Alpine too) | `@weft-framework/cli-linux-x64`, `@weft-framework/cli-linux-arm64` |

Projects made with `npm create @weft-framework` already depend on it. To add it to an existing one:

```sh
npm install --save-dev @weft-framework/cli
npx weft help
```

If your platform isn't in the list, build the binary yourself and point `WEFT_BIN` at it:

```sh
cargo install --git https://github.com/weft-framework/weft weft-cli
```

MIT licensed.
