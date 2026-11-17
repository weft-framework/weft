use std::io::{self, BufRead, Write};

use serde_json::Value;

const MAX_MESSAGE: usize = 64 << 20;

pub fn read(input: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }
    let length = length.unwrap_or(0);
    if length > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut body = vec![0; length];
    input.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn write(output: &mut impl Write, msg: &Value) -> io::Result<()> {
    let body = serde_json::to_string(msg)?;
    write!(output, "Content-Length: {}\r\n\r\n{body}", body.len())?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write(&mut buf, &json!({"jsonrpc": "2.0", "id": 1, "method": "x"})).unwrap();
        write(&mut buf, &json!({"jsonrpc": "2.0", "method": "é"})).unwrap();
        let mut r = io::Cursor::new(buf);
        assert_eq!(read(&mut r).unwrap().unwrap()["id"], 1);
        assert_eq!(read(&mut r).unwrap().unwrap()["method"], "é");
        assert!(read(&mut r).unwrap().is_none());
    }
}
