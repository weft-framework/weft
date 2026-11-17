export interface Post {
  slug: string;
  title: string;
  summary: string;
  body: string;
}

export const posts: Post[] = [
  {
    slug: "hello-weft",
    title: "Hello, Weft",
    summary: "What a Weft project looks like.",
    body: "Pages live in src/pages, shared components in src/components and static files in public.",
  },
  {
    slug: "live-pages",
    title: "Live pages",
    summary: "Interaction without client-side state.",
    body: "Handlers run on the server; the browser receives just the HTML that changed.",
  },
];

export function findPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}
