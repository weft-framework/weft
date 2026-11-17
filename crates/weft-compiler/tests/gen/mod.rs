pub fn component(i: usize) -> String {
    format!(
        r#"
component Stats{i}(total: number, open: number) uses none {{
  view {{
    <p class="stats">{{open}} of {{total}} open</p>
  }}
}}

component List{i}(title: string) {{
  signal items = [] as Item[]
  signal next = 1
  derived open = items.filter((t) => !t.done).length

  function add(e: WeftEvent) {{
    const name = (e.form?.name ?? "").trim()
    if (name === "") return
    items = [...items, {{ id: next, name, done: false }}]
    next = next + 1
  }}

  function toggle(id: number) {{
    items = items.map((t) => (t.id === id ? {{ ...t, done: !t.done }} : t))
  }}

  view {{
    <section class="list">
      <h2 title={{title}}>{{title}}</h2>
      <form @submit={{add}}>
        <input name="name" aria-label="Name" placeholder="Add one" />
        <button :busy>Add</button>
      </form>
      {{#if items.length == 0}}
        <p class="empty">Nothing yet.</p>
      {{:else}}
        <ul>
          {{#each items as item (item.id)}}
            <li>
              <label>
                <input type="checkbox" checked={{item.done}} @change={{toggle(item.id)}} />
                {{item.name}}
              </label>
              <a href={{"/items/" + item.id}}>open</a>
            </li>
          {{/each}}
        </ul>
      {{/if}}
      <Stats{i} total={{items.length}} open={{open}} />
    </section>
  }}

  style {{
    .list {{ padding: 1rem; border: 1px solid #ccc; }}
    .empty {{ color: #666; }}
    li label {{ display: flex; gap: 0.5rem; }}
  }}
}}

component Toggle{i}(title: string) {{
  client signal shown = false
  client derived label = shown ? "Hide" : "Show"
  client function flip() {{ shown = !shown }}
  view {{
    <div>
      <button @click={{flip}} aria-expanded={{shown}}>{{label}} {{title}}</button>
      <p hidden={{!shown}}>Details</p>
    </div>
  }}
}}
"#
    )
}

pub fn source(n: usize) -> String {
    let mut s = String::from(
        "import type { WeftEvent } from \"@weft-framework/runtime\";\n\ninterface Item {\n  id: number;\n  name: string;\n  done: boolean;\n}\n",
    );
    for i in 0..n {
        s.push_str(&component(i));
    }
    s
}
