import { translation } from "@weft-framework/i18n";
import type en from "./en.ts";

export default translation<typeof en>()({
  title: "Nákupy",
  cart: {
    items: "{count, plural, =0 {Košík je prázdný} one {# položka v košíku} few {# položky v košíku} other {# položek v košíku}}",
    add: "Přidat",
  },
});
