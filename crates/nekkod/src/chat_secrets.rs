//! Every chat's secrets (#2594), in this process's memory only: the values a
//! user gave through a chat's secret box, which that chat's commands get as
//! environment variables (`nekko_tools::Secrets`). Nothing here is written
//! anywhere, so a restart forgets them and the agent asks again.

use nekko_tools::Secrets;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Default)]
pub struct ChatSecrets {
    by_chat: Mutex<HashMap<String, Arc<Secrets>>>,
}

impl ChatSecrets {
    /// The chat's secrets, made empty on first use, shared with its running
    /// tools so a secret given mid-turn reaches the next command.
    pub fn for_chat(&self, chat_id: &str) -> Arc<Secrets> {
        let mut map = self.by_chat.lock().unwrap_or_else(PoisonError::into_inner);
        map.entry(chat_id.to_string()).or_default().clone()
    }

    /// A deleted chat's secrets go with it.
    pub fn forget(&self, chat_id: &str) {
        self.by_chat.lock().unwrap_or_else(PoisonError::into_inner).remove(chat_id);
    }

    /// `text` with the chat's secret values redacted (a no-op for a chat with none).
    pub fn redact(&self, chat_id: &str, text: &str) -> Option<String> {
        let map = self.by_chat.lock().unwrap_or_else(PoisonError::into_inner);
        let secrets = map.get(chat_id).filter(|s| !s.is_empty())?;
        let out = secrets.redact(text);
        (out != text).then_some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_per_chat_and_go_with_the_chat() {
        let all = ChatSecrets::default();
        all.for_chat("a").set("TOKEN", "value-a-123").unwrap();
        assert_eq!(all.redact("a", "x value-a-123").as_deref(), Some("x [secret TOKEN]"));
        assert_eq!(all.redact("b", "x value-a-123"), None);
        assert_eq!(all.redact("a", "nothing here"), None);
        all.forget("a");
        assert!(all.for_chat("a").is_empty());
    }
}
