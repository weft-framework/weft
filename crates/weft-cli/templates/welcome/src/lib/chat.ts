import { defineChat } from "@weft-framework/core/chat";
import { access } from "../access.ts";

export const chat = defineChat({
  allow: (from, to) => access.tenantsOf(from).some((t) => access.allows(from, "chat.use", t.id) && access.allows(to, "chat.use", t.id)),
  editMinutes: 15,
});
