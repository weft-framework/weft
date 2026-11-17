pub const MARK: char = match char::from_u32(0xFDD0) {
    Some(c) => c,
    None => panic!("U+FDD0 is a valid char"),
};

pub const MARK_END: char = match char::from_u32(0xFDD1) {
    Some(c) => c,
    None => panic!("U+FDD1 is a valid char"),
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mapping {
    pub gen_line: u32,
    pub gen_col: u32,
    pub src_line: u32,
    pub src_col: u32,
}

fn line_starts(src: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

pub fn strip(marked: &str, src: &str) -> (String, Vec<Mapping>) {
    let starts = line_starts(src);
    let mut out = String::with_capacity(marked.len());
    let mut maps: Vec<Mapping> = Vec::new();
    let (mut line, mut col) = (0u32, 0u32);
    let mut chars = marked.chars();
    while let Some(c) = chars.next() {
        if c == MARK {
            let mut digits = String::new();
            for d in chars.by_ref() {
                if d == MARK_END {
                    break;
                }
                digits.push(d);
            }
            let Ok(offset) = digits.parse::<usize>() else {
                continue;
            };
            let offset = offset.min(src.len());
            let src_line = starts.partition_point(|&s| s <= offset) - 1;
            let Some(prefix) = src.get(starts[src_line]..offset) else {
                continue;
            };
            let m = Mapping {
                gen_line: line,
                gen_col: col,
                src_line: src_line as u32,
                src_col: utf16_len(prefix),
            };
            match maps.last_mut() {
                Some(last) if last.gen_line == line && last.gen_col == col => *last = m,
                _ => maps.push(m),
            }
            continue;
        }
        out.push(c);
        if c == '\n' {
            line += 1;
            col = 0;
        } else {
            col += c.len_utf16() as u32;
        }
    }
    (out, maps)
}

pub fn original(maps: &[Mapping], line: u32, col: u32) -> Option<(u32, u32)> {
    let i = maps.partition_point(|m| (m.gen_line, m.gen_col) <= (line, col));
    let m = maps.get(i.checked_sub(1)?)?;
    if m.gen_line == line {
        Some((m.src_line, m.src_col + (col - m.gen_col)))
    } else {
        Some((m.src_line, m.src_col))
    }
}

pub fn generated(maps: &[Mapping], line: u32, col: u32) -> Vec<(u32, u32)> {
    let mut found: Vec<(u32, u32, u32)> = Vec::new();
    for (i, m) in maps.iter().enumerate() {
        if m.src_line != line || m.src_col > col {
            continue;
        }
        let delta = col - m.src_col;
        let fits = match maps.get(i + 1) {
            Some(n) if n.gen_line == m.gen_line => m.gen_col + delta < n.gen_col || delta == 0,
            _ => true,
        };
        if fits {
            found.push((delta, m.gen_line, m.gen_col + delta));
        }
    }
    found.sort_by_key(|&(d, _, _)| d);
    found.into_iter().map(|(_, l, c)| (l, c)).collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn vlq(mut v: i64, out: &mut String) {
    let mut n: u64 = if v < 0 {
        v = -v;
        ((v as u64) << 1) | 1
    } else {
        (v as u64) << 1
    };
    loop {
        let mut digit = (n & 31) as usize;
        n >>= 5;
        if n > 0 {
            digit |= 32;
        }
        out.push(B64[digit] as char);
        if n == 0 {
            break;
        }
    }
}

pub fn encode(maps: &[Mapping]) -> String {
    let mut out = String::new();
    let (mut line, mut prev_col) = (0u32, 0i64);
    let (mut prev_src_line, mut prev_src_col) = (0i64, 0i64);
    let mut first_in_line = true;
    for m in maps {
        while line < m.gen_line {
            out.push(';');
            line += 1;
            prev_col = 0;
            first_in_line = true;
        }
        if !first_in_line {
            out.push(',');
        }
        first_in_line = false;
        vlq(m.gen_col as i64 - prev_col, &mut out);
        vlq(0, &mut out);
        vlq(m.src_line as i64 - prev_src_line, &mut out);
        vlq(m.src_col as i64 - prev_src_col, &mut out);
        prev_col = m.gen_col as i64;
        prev_src_line = m.src_line as i64;
        prev_src_col = m.src_col as i64;
    }
    out
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push('\\');
                out.push('u');
                out.push_str(&format!("{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn to_json(maps: &[Mapping], file: &str, source: &str, content: &str) -> String {
    format!(
        "{{\"version\":3,\"file\":{},\"sources\":[{}],\"sourcesContent\":[{}],\"names\":[],\"mappings\":{}}}",
        json_str(file),
        json_str(source),
        json_str(content),
        json_str(&encode(maps)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(at: usize) -> String {
        format!("{MARK}{at}{MARK_END}")
    }

    #[test]
    fn strip_records_positions_and_removes_marks() {
        let src = "ab\ncdé\nf";
        let marked = format!("x{}AB\n  {}CD{}F", mark(0), mark(3), mark(8));
        let (out, maps) = strip(&marked, src);
        assert_eq!(out, "xAB\n  CDF");
        assert_eq!(
            maps,
            vec![
                Mapping {
                    gen_line: 0,
                    gen_col: 1,
                    src_line: 0,
                    src_col: 0
                },
                Mapping {
                    gen_line: 1,
                    gen_col: 2,
                    src_line: 1,
                    src_col: 0
                },
                Mapping {
                    gen_line: 1,
                    gen_col: 4,
                    src_line: 2,
                    src_col: 0
                },
            ]
        );
        assert_eq!(original(&maps, 0, 2), Some((0, 1)));
        assert_eq!(original(&maps, 1, 3), Some((1, 1)));
        assert_eq!(original(&maps, 0, 0), None);
        assert_eq!(generated(&maps, 0, 1), vec![(0, 2)]);
        assert_eq!(generated(&maps, 1, 1), vec![(1, 3)]);
        assert_eq!(generated(&maps, 1, 2), vec![]);
        assert_eq!(generated(&maps, 2, 0), vec![(1, 4)]);
    }

    #[test]
    fn vlq_matches_the_reference_encoding() {
        let mut s = String::new();
        for v in [0, 1, -1, 15, 16, -16, 1000] {
            vlq(v, &mut s);
            s.push(' ');
        }
        assert_eq!(s, "A C D e gB hB w+B ");
        let maps = [
            Mapping {
                gen_line: 0,
                gen_col: 0,
                src_line: 0,
                src_col: 0,
            },
            Mapping {
                gen_line: 0,
                gen_col: 4,
                src_line: 1,
                src_col: 2,
            },
            Mapping {
                gen_line: 2,
                gen_col: 1,
                src_line: 1,
                src_col: 0,
            },
        ];
        assert_eq!(encode(&maps), "AAAA,IACE;;CAAF");
        let json = to_json(&maps, "a.ts", "a.wx", "x\"\n");
        assert!(json.contains("\"sourcesContent\":[\"x\\\"\\n\"]"), "{json}");
    }
}
