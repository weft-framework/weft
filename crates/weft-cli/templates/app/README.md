# {{name}}

A [Weft](https://github.com/weft-framework/weft) application.

## Develop

```sh
npm install
npm run dev
```

The development server compiles `src/`, serves the app at
<http://localhost:3000> and reloads open pages when a file changes.

## Layout

| Path | Purpose |
| --- | --- |
| `src/pages/` | Routes. `index.wx` is `/`, `about.wx` is `/about`, `blog/[slug].wx` matches `/blog/<anything>`, `docs/[...path].wx` matches any depth. |
| `src/pages/_layout.wx` | Wraps every page in its directory and below; receives the page as `children`. |
| `src/pages/_404.wx` | Shown with status 404 for unknown paths and `notFound()`. |
| `src/components/` | Shared components, imported with `import { Nav } from "../components/Nav.wx"`. |
| `src/lib/` | Plain TypeScript used by pages and components. |
| `src/index.html` | The document shell. `<!--weft:head-->` and `<!--weft:body-->` mark where the page goes. |
| `public/` | Static files served at `/` (`public/robots.txt` is `/robots.txt`). |

## Pages

A page file declares one component, plus optional exports:

```ts
export const meta = { title: "About", description: "..." };   // or meta(ctx, data)
export async function load(ctx) { return { post } }           // props for the page
component Page(post: Post) { view { <h1>{post.title}</h1> } }
```

`load` may return `notFound()` or `redirect("/elsewhere")` from
`@weft-framework/server`.
