export const site = {
  name: "Weft",
  description: "A web framework where the server renders, the browser patches, and the data layer decides who sees what.",
  repo: "https://github.com/weft-framework/weft",
};

export const create = `npm create @weft-framework my-app
cd my-app
npm install
npm run dev`;

export const model = `model Invoice {
  owner: User
  amount: Money
  @read(actor == owner)
}

component InvoiceRow(invoice: Invoice) {
  view {
    <tr><td>{invoice.amount}</td></tr>
  }
}`;

export const counter = `component Counter(start: number) {
  signal count = start

  function increment() {
    count = count + 1
  }

  view {
    <button @click={increment}>Clicked {count} times</button>
  }
}`;

export const add = `npx weft add button card dialog`;

export const build = `npm run build
node dist/server.mjs`;

export const layout = `src/
  pages/          one file per route: about.wx is /about
    _layout.wx    wraps every page in its folder
    _404.wx       anything that matches nothing
    blog/[slug].wx
    api/          files that return a Response
  models/         your data, with its read and write rules
  components/
public/           served exactly as it is
weft.config.ts    port, session secret, site URL`;

export const source = `git clone https://github.com/weft-framework/weft.git
cd weft
cargo build --workspace
npm install
npm test`;
