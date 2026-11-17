use crate::token::Span;

#[derive(Clone, Debug, PartialEq)]
pub struct SourceFile {
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Component(Component),
    Model(Model),
    Actor(ActorDecl),
    Action(Action),
    Placed(Placed),
    Store(StoreDecl),
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoreDecl {
    pub name: String,
    pub session: bool,
    pub ty: Option<String>,
    pub init: String,
    pub init_offset: usize,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Placed {
    pub client: bool,
    pub name: String,
    pub names: Vec<String>,
    pub import: Option<String>,
    pub source: String,
    pub offset: usize,
    pub span: Span,
}

impl Item {
    pub fn span(&self) -> Span {
        match self {
            Item::Component(c) => c.span,
            Item::Model(m) => m.span,
            Item::Actor(a) => a.span,
            Item::Action(a) => a.span,
            Item::Placed(p) => p.span,
            Item::Store(s) => s.span,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    pub name: String,
    pub job: bool,
    pub uses: Option<Uses>,
    pub params: Vec<Param>,
    pub ret: Option<String>,
    pub body: String,
    pub body_offset: usize,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Uses {
    pub caps: Vec<(String, Span)>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActorDecl {
    pub ty: String,
    pub ty_offset: usize,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub name: String,
    pub fields: Vec<Field>,
    pub policies: Vec<Policy>,
    pub body: Span,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub name: String,
    pub ty: String,
    pub attrs: Vec<FieldAttr>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldAttr {
    pub name: String,
    pub arg: Option<(String, usize)>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub kind: PolicyKind,
    pub predicate: String,
    pub span: Span,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyKind {
    Read,
    Write,
    Residency,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Component {
    pub name: String,
    pub uses: Option<Uses>,
    pub type_params: Option<String>,
    pub params: Vec<Param>,
    pub reactives: Vec<Reactive>,
    pub functions: Vec<LocalFn>,
    pub lifecycle: Vec<Lifecycle>,
    pub view: View,
    pub style: Option<StyleBlock>,
    pub body: Span,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StyleBlock {
    pub css: String,
    pub offset: usize,
    pub span: Span,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleKind {
    Mount,
    Destroy,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Lifecycle {
    pub kind: LifecycleKind,
    pub client: bool,
    pub expr: String,
    pub comments: Comments,
    pub span: Span,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Comments {
    pub leading: Vec<String>,
    pub trailing: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalFn {
    pub name: String,
    pub client: bool,
    pub source: String,
    pub comments: Comments,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reactive {
    pub kind: ReactiveKind,
    pub client: bool,
    pub name: String,
    pub expr: String,
    pub comments: Comments,
    pub span: Span,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReactiveKind {
    Signal,
    Derived,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Param {
    pub name: String,
    pub ty: String,
    pub optional: bool,
    pub rest: bool,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub nodes: Vec<Node>,
    pub comments: Comments,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Element(Element),
    Text(Text),
    Interp(Interp),
    If(IfBlock),
    Each(EachBlock),
    Await(AwaitBlock),
}

impl Node {
    pub fn is_whitespace(&self) -> bool {
        matches!(self, Node::Text(t) if t.value.trim().is_empty())
    }

    pub fn blocks(&self) -> Vec<&[Node]> {
        match self {
            Node::If(b) => {
                let mut v: Vec<&[Node]> = b.arms.iter().map(|a| a.body.as_slice()).collect();
                if let Some(e) = &b.else_body {
                    v.push(e);
                }
                v
            }
            Node::Each(b) => vec![&b.body],
            Node::Await(b) => {
                let mut v: Vec<&[Node]> = vec![&b.pending];
                if let Some(t) = &b.then {
                    v.push(&t.body);
                }
                if let Some(c) = &b.catch {
                    v.push(&c.body);
                }
                v
            }
            Node::Element(_) | Node::Text(_) | Node::Interp(_) => Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AwaitBlock {
    pub expr: String,
    pub pending: Vec<Node>,
    pub then: Option<AwaitBranch>,
    pub catch: Option<AwaitBranch>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AwaitBranch {
    pub binding: Option<String>,
    pub body: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IfBlock {
    pub arms: Vec<IfArm>,
    pub else_body: Option<Vec<Node>>,
    pub span: Span,
    pub can: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IfArm {
    pub cond: String,
    pub body: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EachBlock {
    pub expr: String,
    pub item: String,
    pub index: Option<String>,
    pub key: Option<String>,
    pub body: Vec<Node>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<Attr>,
    pub children: Vec<Node>,
    pub self_closing: bool,
    pub span: Span,
}

impl Element {
    pub fn slot(&self) -> Option<Result<&str, ()>> {
        let attr = self
            .attrs
            .iter()
            .find(|a| a.kind == AttrKind::Plain && a.name == "slot")?;
        Some(match &attr.value {
            Some(AttrValue::Str(s)) => Ok(s.as_str()),
            _ => Err(()),
        })
    }
}

pub struct Slots<'a> {
    pub named: Vec<(&'a str, &'a Element)>,
    pub rest: Vec<&'a Node>,
}

impl<'a> Slots<'a> {
    pub fn of(children: &'a [Node]) -> Self {
        let mut named = Vec::new();
        let mut rest = Vec::new();
        for n in children {
            match n {
                Node::Element(e) => match e.slot() {
                    Some(Ok(name)) => named.push((name, e)),
                    _ => rest.push(n),
                },
                _ => rest.push(n),
            }
        }
        while rest.first().is_some_and(|n| n.is_whitespace()) {
            rest.remove(0);
        }
        while rest.last().is_some_and(|n| n.is_whitespace()) {
            rest.pop();
        }
        Slots { named, rest }
    }

    pub fn names(&self) -> Vec<&'a str> {
        let mut out: Vec<&str> = Vec::new();
        for (n, _) in &self.named {
            if !out.contains(n) {
                out.push(n);
            }
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Attr {
    pub kind: AttrKind,
    pub name: String,
    pub value: Option<AttrValue>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AttrKind {
    Plain,
    Event,
    Bind,
    Spread,
    Use,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AttrValue {
    Str(String),
    Expr(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Text {
    pub value: String,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Interp {
    pub expr: String,
    pub span: Span,
}
