//! JavaScript-compatible numbers and JSON text, so the port writes what `JSON.stringify` and
//! `Math.round` produce in `packages/core` (byte-identical song files and MIDI ticks).

use serde_json::Value;

/// `Math.round`: halves round towards +infinity (Rust's `f64::round` rounds them away from 0).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// `String(x)`: shortest round-trip digits, decimal notation for exponents -7 < e < 21,
/// otherwise `1.5e+21` / `1e-7`; `-0` is written as `0`, and `NaN`, `Infinity`, `-Infinity`.
pub fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if exp > -7 && exp < 21 {
        format!("{x}")
    } else if exp > 0 {
        format!("{mantissa}e+{exp}")
    } else {
        format!("{mantissa}e{exp}")
    }
}

/// `JSON.stringify(value)` (compact) or `JSON.stringify(value, null, 2)` (`pretty`).
pub fn to_js_json(value: &Value, pretty: bool) -> String {
    let mut out = String::new();
    write_value(&mut out, value, pretty, 0);
    out
}

fn write_string(out: &mut String, s: &str) {
    // serde_json escapes the same set as JSON.stringify: `"`, `\` and control characters.
    out.push_str(&serde_json::to_string(s).unwrap_or_default());
}

fn newline(out: &mut String, pretty: bool, depth: usize) {
    if pretty {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    }
}

fn write_value(out: &mut String, value: &Value, pretty: bool, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // JSON.stringify writes non-finite numbers as null.
        Value::Number(n) => match n.as_f64().filter(|x| x.is_finite()) {
            Some(x) => out.push_str(&js_number(x)),
            None => out.push_str("null"),
        },
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, pretty, depth + 1);
                write_value(out, item, pretty, depth + 1);
            }
            newline(out, pretty, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, pretty, depth + 1);
                write_string(out, k);
                out.push_str(if pretty { ": " } else { ":" });
                write_value(out, v, pretty, depth + 1);
            }
            newline(out, pretty, depth);
            out.push('}');
        }
    }
}

/// A JSON number from an `f64` (kept as a float so `js_number` formats it).
pub(crate) fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rounds_like_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(624999.5), 625000.0);
    }

    #[test]
    fn formats_numbers_like_javascript() {
        let cases = [
            (96.0, "96"),
            (0.25, "0.25"),
            (-0.0, "0"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (-2.5e-8, "-2.5e-8"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number(x), want, "{x}");
        }
    }

    #[test]
    fn stringifies_like_json_stringify() {
        let v = json!({"a": [1, 2.5, {"b": []}], "c": {}, "d": "q\"\n"});
        assert_eq!(
            to_js_json(&v, false),
            r#"{"a":[1,2.5,{"b":[]}],"c":{},"d":"q\"\n"}"#
        );
        assert_eq!(
            to_js_json(&v, true),
            "{\n  \"a\": [\n    1,\n    2.5,\n    {\n      \"b\": []\n    }\n  ],\n  \"c\": {},\n  \"d\": \"q\\\"\\n\"\n}"
        );
    }
}
