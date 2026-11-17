export interface Group {
  title: string;
  note: string;
  names: string[];
}

export const groups: Group[] = [
  {
    title: "Only in Weft",
    note: "Live components: they use the page's connection to the server.",
    names: ["presence-stack", "editing-now", "live-table", "live-stat", "server-form", "share-link", "audit-timeline", "activity-feed"],
  },
  {
    title: "Forms and inputs",
    note: "Fields, choices and pickers, styled from your theme.",
    names: ["button", "button-group", "input", "input-group", "input-otp", "textarea", "rich-text-editor", "label", "field", "form", "stepper", "checkbox", "radio-group", "switch", "slider", "select", "native-select", "combobox", "calendar", "date-picker", "toggle", "toggle-group"],
  },
  {
    title: "Overlays",
    note: "Opened from markup, closed with Escape, focus returned.",
    names: ["dialog", "alert-dialog", "sheet", "drawer", "popover", "hover-card", "tooltip", "dropdown-menu", "context-menu", "command", "sonner"],
  },
  {
    title: "Navigation",
    note: "Ways around the site.",
    names: ["navigation-menu", "menubar", "breadcrumb", "pagination", "tabs", "sidebar"],
  },
  {
    title: "Display",
    note: "Showing content and data.",
    names: ["card", "table", "data-table", "chart", "badge", "avatar", "item", "kbd", "qr-code", "typography", "empty", "carousel", "aspect-ratio"],
  },
  {
    title: "Feedback and layout",
    note: "Status, loading and structure.",
    names: ["alert", "progress", "skeleton", "spinner", "separator", "scroll-area", "resizable", "accordion", "collapsible"],
  },
];

export function title(name: string): string {
  return name
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
