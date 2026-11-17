pub const GLOBAL_ATTRS: &[&str] = &[
    "accesskey",
    "autocapitalize",
    "autocorrect",
    "autofocus",
    "class",
    "contenteditable",
    "dir",
    "draggable",
    "enterkeyhint",
    "hidden",
    "id",
    "inert",
    "inputmode",
    "is",
    "itemid",
    "itemprop",
    "itemref",
    "itemscope",
    "itemtype",
    "lang",
    "nonce",
    "popover",
    "role",
    "slot",
    "spellcheck",
    "style",
    "tabindex",
    "title",
    "translate",
    "writingsuggestions",
    "xml:lang",
    "xml:space",
];

pub fn element_attrs(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "a" => &[
            "href",
            "target",
            "download",
            "ping",
            "rel",
            "hreflang",
            "type",
            "referrerpolicy",
        ],
        "area" => &[
            "alt",
            "coords",
            "shape",
            "href",
            "target",
            "download",
            "ping",
            "rel",
            "referrerpolicy",
        ],
        "audio" => &[
            "src",
            "crossorigin",
            "preload",
            "autoplay",
            "loop",
            "muted",
            "controls",
        ],
        "base" => &["href", "target"],
        "blockquote" | "q" => &["cite"],
        "button" => &[
            "disabled",
            "form",
            "formaction",
            "formenctype",
            "formmethod",
            "formnovalidate",
            "formtarget",
            "name",
            "popovertarget",
            "popovertargetaction",
            "type",
            "value",
            "command",
            "commandfor",
        ],
        "canvas" => &["width", "height"],
        "col" | "colgroup" => &["span"],
        "data" => &["value"],
        "del" | "ins" => &["cite", "datetime"],
        "details" => &["open", "name"],
        "dialog" => &["open", "closedby"],
        "embed" => &["src", "type", "width", "height"],
        "fieldset" => &["disabled", "form", "name"],
        "form" => &[
            "accept-charset",
            "action",
            "autocomplete",
            "enctype",
            "method",
            "name",
            "novalidate",
            "target",
            "rel",
        ],
        "html" => &["xmlns"],
        "iframe" => &[
            "src",
            "srcdoc",
            "name",
            "sandbox",
            "allow",
            "allowfullscreen",
            "width",
            "height",
            "referrerpolicy",
            "loading",
        ],
        "img" => &[
            "alt",
            "src",
            "srcset",
            "sizes",
            "crossorigin",
            "usemap",
            "ismap",
            "width",
            "height",
            "referrerpolicy",
            "decoding",
            "loading",
            "fetchpriority",
        ],
        "input" => &[
            "accept",
            "alt",
            "autocomplete",
            "checked",
            "dirname",
            "disabled",
            "form",
            "formaction",
            "formenctype",
            "formmethod",
            "formnovalidate",
            "formtarget",
            "height",
            "list",
            "max",
            "maxlength",
            "min",
            "minlength",
            "multiple",
            "name",
            "pattern",
            "placeholder",
            "popovertarget",
            "popovertargetaction",
            "readonly",
            "required",
            "size",
            "src",
            "step",
            "type",
            "value",
            "width",
            "capture",
        ],
        "label" => &["for"],
        "li" => &["value"],
        "link" => &[
            "href",
            "crossorigin",
            "rel",
            "as",
            "media",
            "hreflang",
            "type",
            "sizes",
            "imagesrcset",
            "imagesizes",
            "referrerpolicy",
            "integrity",
            "blocking",
            "color",
            "disabled",
            "fetchpriority",
        ],
        "map" => &["name"],
        "meta" => &["name", "http-equiv", "content", "charset", "media"],
        "meter" => &["value", "min", "max", "low", "high", "optimum"],
        "object" => &["data", "type", "name", "form", "width", "height"],
        "ol" => &["reversed", "start", "type"],
        "optgroup" => &["disabled", "label"],
        "option" => &["disabled", "label", "selected", "value"],
        "output" => &["for", "form", "name"],
        "progress" => &["value", "max"],
        "script" => &[
            "src",
            "type",
            "nomodule",
            "async",
            "defer",
            "crossorigin",
            "integrity",
            "referrerpolicy",
            "blocking",
            "fetchpriority",
        ],
        "select" => &[
            "autocomplete",
            "disabled",
            "form",
            "multiple",
            "name",
            "required",
            "size",
        ],
        "slot" => &["name"],
        "source" => &["type", "media", "src", "srcset", "sizes", "width", "height"],
        "style" => &["media", "blocking"],
        "td" => &["colspan", "rowspan", "headers"],
        "th" => &["colspan", "rowspan", "headers", "scope", "abbr"],
        "template" => &[
            "shadowrootmode",
            "shadowrootdelegatesfocus",
            "shadowrootclonable",
            "shadowrootserializable",
        ],
        "textarea" => &[
            "autocomplete",
            "cols",
            "dirname",
            "disabled",
            "form",
            "maxlength",
            "minlength",
            "name",
            "placeholder",
            "readonly",
            "required",
            "rows",
            "wrap",
        ],
        "time" => &["datetime"],
        "track" => &["default", "kind", "label", "src", "srclang"],
        "video" => &[
            "src",
            "crossorigin",
            "poster",
            "preload",
            "autoplay",
            "playsinline",
            "loop",
            "muted",
            "controls",
            "width",
            "height",
        ],
        "abbr" | "address" | "article" | "aside" | "b" | "bdi" | "bdo" | "body" | "br"
        | "caption" | "cite" | "code" | "datalist" | "dd" | "dfn" | "div" | "dl" | "dt" | "em"
        | "figcaption" | "figure" | "footer" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "head"
        | "header" | "hgroup" | "hr" | "i" | "kbd" | "legend" | "main" | "mark" | "menu"
        | "nav" | "noscript" | "p" | "picture" | "pre" | "rp" | "rt" | "ruby" | "s" | "samp"
        | "search" | "section" | "small" | "span" | "strong" | "sub" | "summary" | "sup"
        | "table" | "tbody" | "tfoot" | "thead" | "title" | "tr" | "u" | "ul" | "var" | "wbr" => {
            &[]
        }
        _ => return None,
    })
}

pub const ARIA_ATTRS: &[&str] = &[
    "aria-activedescendant",
    "aria-atomic",
    "aria-autocomplete",
    "aria-braillelabel",
    "aria-brailleroledescription",
    "aria-busy",
    "aria-checked",
    "aria-colcount",
    "aria-colindex",
    "aria-colindextext",
    "aria-colspan",
    "aria-controls",
    "aria-current",
    "aria-describedby",
    "aria-description",
    "aria-details",
    "aria-disabled",
    "aria-dropeffect",
    "aria-errormessage",
    "aria-expanded",
    "aria-flowto",
    "aria-grabbed",
    "aria-haspopup",
    "aria-hidden",
    "aria-invalid",
    "aria-keyshortcuts",
    "aria-label",
    "aria-labelledby",
    "aria-level",
    "aria-live",
    "aria-modal",
    "aria-multiline",
    "aria-multiselectable",
    "aria-orientation",
    "aria-owns",
    "aria-placeholder",
    "aria-posinset",
    "aria-pressed",
    "aria-readonly",
    "aria-relevant",
    "aria-required",
    "aria-roledescription",
    "aria-rowcount",
    "aria-rowindex",
    "aria-rowindextext",
    "aria-rowspan",
    "aria-selected",
    "aria-setsize",
    "aria-sort",
    "aria-valuemax",
    "aria-valuemin",
    "aria-valuenow",
    "aria-valuetext",
];

pub const ARIA_ROLES: &[&str] = &[
    "alert",
    "alertdialog",
    "application",
    "article",
    "banner",
    "blockquote",
    "button",
    "caption",
    "cell",
    "checkbox",
    "code",
    "columnheader",
    "combobox",
    "comment",
    "complementary",
    "contentinfo",
    "definition",
    "deletion",
    "dialog",
    "directory",
    "document",
    "emphasis",
    "feed",
    "figure",
    "form",
    "generic",
    "grid",
    "gridcell",
    "group",
    "heading",
    "image",
    "img",
    "insertion",
    "link",
    "list",
    "listbox",
    "listitem",
    "log",
    "main",
    "mark",
    "marquee",
    "math",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "meter",
    "navigation",
    "none",
    "note",
    "option",
    "paragraph",
    "presentation",
    "progressbar",
    "radio",
    "radiogroup",
    "region",
    "row",
    "rowgroup",
    "rowheader",
    "scrollbar",
    "search",
    "searchbox",
    "separator",
    "slider",
    "spinbutton",
    "status",
    "strong",
    "subscript",
    "suggestion",
    "superscript",
    "switch",
    "tab",
    "table",
    "tablist",
    "tabpanel",
    "term",
    "textbox",
    "time",
    "timer",
    "toolbar",
    "tooltip",
    "tree",
    "treegrid",
    "treeitem",
];

#[derive(Debug, PartialEq, Eq)]
pub enum AttrVerdict {
    Ok,
    Unknown,
    UnknownAria,
    InlineHandler,
    Reserved,
}

pub fn classify_attr(el: &str, attr: &str) -> Option<AttrVerdict> {
    let own = element_attrs(el)?;
    let a = attr.to_ascii_lowercase();
    Some(
        if a.starts_with("data-weft-")
            && !matches!(
                a.as_str(),
                "data-weft-message"
                    | "data-weft-own"
                    | "data-weft-empty"
                    | "data-weft-ignore"
                    | "data-weft-toaster"
                    | "data-weft-point-on"
            )
        {
            AttrVerdict::Reserved
        } else if a.starts_with("data-") {
            AttrVerdict::Ok
        } else if a.starts_with("aria-") {
            if ARIA_ATTRS.contains(&a.as_str()) {
                AttrVerdict::Ok
            } else {
                AttrVerdict::UnknownAria
            }
        } else if a.len() > 2 && a.starts_with("on") {
            AttrVerdict::InlineHandler
        } else if GLOBAL_ATTRS.contains(&a.as_str()) || own.contains(&a.as_str()) {
            AttrVerdict::Ok
        } else {
            AttrVerdict::Unknown
        },
    )
}

pub fn suggest<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut best: Option<(usize, &str)> = None;
    for c in candidates {
        let d = distance(name, c);
        if d <= 2 && best.map_or(true, |(bd, _)| d < bd) {
            best = Some((d, c));
        }
    }
    best.map(|(_, c)| c)
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let sub = prev[j] + usize::from(ca != *cb);
            cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_attributes() {
        assert_eq!(classify_attr("a", "href"), Some(AttrVerdict::Ok));
        assert_eq!(classify_attr("div", "class"), Some(AttrVerdict::Ok));
        assert_eq!(classify_attr("div", "data-id"), Some(AttrVerdict::Ok));
        assert_eq!(classify_attr("div", "aria-label"), Some(AttrVerdict::Ok));
        assert_eq!(classify_attr("div", "href"), Some(AttrVerdict::Unknown));
        assert_eq!(
            classify_attr("div", "aria-lable"),
            Some(AttrVerdict::UnknownAria)
        );
        assert_eq!(
            classify_attr("button", "onClick"),
            Some(AttrVerdict::InlineHandler)
        );
        assert_eq!(
            classify_attr("p", "data-weft-on-click"),
            Some(AttrVerdict::Reserved)
        );
        assert_eq!(classify_attr("circle", "cx"), None);
        assert_eq!(suggest("hreff", ["href", "target"]), Some("href"));
        assert_eq!(
            suggest("aria-lable", ARIA_ATTRS.iter().copied()),
            Some("aria-label")
        );
        assert_eq!(suggest("zzzzzz", ["href"]), None);
    }
}
