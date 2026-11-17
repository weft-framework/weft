use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16,
}

pub struct LineIndex<'a> {
    text: &'a str,
    starts: Vec<usize>,
    enc: Encoding,
}

impl<'a> LineIndex<'a> {
    pub fn new(text: &'a str, enc: Encoding) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        LineIndex { text, starts, enc }
    }

    fn line_text(&self, line: usize) -> &'a str {
        let start = self.starts[line];
        let end = self.starts.get(line + 1).map_or(self.text.len(), |e| e - 1);
        self.text[start..end].trim_end_matches('\r')
    }

    pub fn position(&self, offset: usize) -> (u32, u32) {
        let offset = offset.min(self.text.len());
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        let before = &self.text[self.starts[line]..offset];
        let col = match self.enc {
            Encoding::Utf8 => before.len(),
            Encoding::Utf16 => before.encode_utf16().count(),
        };
        (line as u32, col as u32)
    }

    pub fn offset(&self, line: u32, character: u32) -> usize {
        let Some(&start) = self.starts.get(line as usize) else {
            return self.text.len();
        };
        let text = self.line_text(line as usize);
        let mut units = 0usize;
        for (i, c) in text.char_indices() {
            if units >= character as usize {
                return start + i;
            }
            units += match self.enc {
                Encoding::Utf8 => c.len_utf8(),
                Encoding::Utf16 => c.len_utf16(),
            };
        }
        start + text.len()
    }
}

pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let decoded = percent_decode(rest)?;
    if cfg!(windows) {
        let p = decoded.strip_prefix('/').unwrap_or(&decoded);
        Some(PathBuf::from(p.replace('/', "\\")))
    } else {
        Some(PathBuf::from(decoded))
    }
}

pub fn path_to_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    let mut out = String::from("file://");
    if !s.starts_with('/') {
        out.push('/');
    }
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn path_key(path: &Path) -> String {
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

pub fn relative_to(path: &Path, base: &Path) -> Option<PathBuf> {
    let norm = |p: &Path| {
        let p = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let s = p.to_string_lossy().replace('\\', "/");
        s.strip_prefix("//?/").unwrap_or(&s).to_string()
    };
    let (p, b) = (norm(path), norm(base));
    let b = b.trim_end_matches('/');
    let head = p.get(..b.len())?;
    let same = if cfg!(windows) {
        head.eq_ignore_ascii_case(b)
    } else {
        head == b
    };
    let rest = p[b.len()..].strip_prefix('/')?;
    (same && !rest.is_empty()).then(|| PathBuf::from(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_columns() {
        let text = "a\nx😀y\r\nz";
        let ix = LineIndex::new(text, Encoding::Utf16);
        let y = text.find('y').unwrap();
        assert_eq!(ix.position(y), (1, 3));
        assert_eq!(ix.offset(1, 3), y);
        assert_eq!(
            ix.offset(1, 99),
            text.find('\r').unwrap(),
            "clamped to the line"
        );
        assert_eq!(ix.offset(9, 0), text.len());
        let ix8 = LineIndex::new(text, Encoding::Utf8);
        assert_eq!(ix8.position(y), (1, 5));
    }

    #[test]
    fn uris_round_trip() {
        let p = if cfg!(windows) {
            PathBuf::from("c:\\Mobile Phone\\a b.wx")
        } else {
            PathBuf::from("/home/u/a b.wx")
        };
        let uri = path_to_uri(&p);
        assert!(uri.contains("a%20b.wx"), "{uri}");
        assert_eq!(uri_to_path(&uri).unwrap(), p);
        if cfg!(windows) {
            assert_eq!(
                uri_to_path("file:///e%3A/x/A.wx").unwrap(),
                PathBuf::from("e:\\x\\A.wx")
            );
        }
    }
}
