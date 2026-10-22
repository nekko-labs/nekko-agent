//! A chat read without its transcript.
//!
//! Most readers of a chat want a few of its own fields (its execution mode,
//! whether it is linked to a spec, what the user changed mid-turn) and never
//! look at `messages`, which is nearly all of a long chat's bytes and, in an
//! image chat, megabytes of pictures. Parsing the file into a [`Value`] builds
//! every message only to drop it; this skips over the transcript instead.

use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

/// A chat's fields but its transcript, in the order the file has them.
#[derive(Debug, Default)]
pub struct Meta {
    pub fields: Map<String, Value>,
    /// The file has a `messages` key holding an array (its contents unread).
    pub messages_array: bool,
}

impl Meta {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }

    /// The fields as a chat object without `messages`.
    pub fn into_value(self) -> Value {
        Value::Object(self.fields)
    }
}

/// Whether a value is an array, its contents skipped.
struct IsArray(bool);

impl<'de> Deserialize<'de> for IsArray {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(true)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(false)
            }
            fn visit_bool<E>(self, _: bool) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_str<E>(self, _: &str) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_unit<E>(self) -> Result<bool, E> {
                Ok(false)
            }
        }
        d.deserialize_any(V).map(IsArray)
    }
}

impl<'de> Deserialize<'de> for Meta {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Meta;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a chat object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Meta, A::Error> {
                let mut meta = Meta::default();
                while let Some(key) = map.next_key::<String>()? {
                    if key == "messages" {
                        meta.messages_array = map.next_value::<IsArray>()?.0;
                    } else {
                        let value: Value = map.next_value()?;
                        meta.fields.insert(key, value);
                    }
                }
                Ok(meta)
            }
        }
        d.deserialize_map(V)
    }
}

/// A chat's file as [`Meta`], or `None` when it is not a JSON object.
pub fn parse(bytes: &[u8]) -> Option<Meta> {
    serde_json::from_slice(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_every_field_but_the_transcript_in_order() {
        let chat = json!({ "id": "s_a", "title": "T", "messages": [{ "id": "m", "images": ["data:x"] }], "queue": [{ "text": "q" }], "executionMode": null });
        let meta = parse(chat.to_string().as_bytes()).unwrap();
        assert!(meta.messages_array);
        assert_eq!(meta.fields.keys().collect::<Vec<_>>(), ["id", "title", "queue", "executionMode"]);
        assert_eq!(meta.get("executionMode"), Some(&Value::Null));
        assert_eq!(meta.get("queue"), chat.get("queue"));
        assert!(!parse(br#"{"id":"s","messages":{"a":[1]}}"#).unwrap().messages_array);
        assert!(!parse(br#"{"id":"s"}"#).unwrap().messages_array);
        assert!(parse(b"[1]").is_none() && parse(b"{ half").is_none());
    }
}
