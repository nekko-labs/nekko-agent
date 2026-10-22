//! Every binary value on the wire is base64url without padding.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode(text: &str) -> Result<Vec<u8>, crate::Error> {
    URL_SAFE_NO_PAD.decode(text).map_err(|_| crate::Error::Malformed)
}
