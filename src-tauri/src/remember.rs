use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

pub const RECENT_LIMIT: usize = 10;
pub const NOTEBOOK_LIMIT: usize = 50;
pub const TEXT_LIMIT: usize = 5000;
pub const PREVIEW_CHARS: usize = 20;

const KEY_FILE: &str = "remember.key";
const DATA_FILE: &str = "remember.json";
const ENCRYPTED_DATA_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: String,
    pub text: String,
    pub order: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookEntry {
    pub id: String,
    pub text: String,
    #[serde(default, alias = "savedAtMs")]
    pub saved_order: u64,
    #[serde(default, alias = "pinnedAtMs")]
    pub pinned_order: Option<u64>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberItemPayload {
    pub id: String,
    pub text: String,
    pub preview: String,
    pub pinned: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberSnapshot {
    pub recent: Vec<RememberItemPayload>,
    pub notebook: Vec<RememberItemPayload>,
    pub error: Option<String>,
    pub recent_limit: usize,
    pub notebook_limit: usize,
    pub text_limit: usize,
    pub preview_chars: usize,
}

#[derive(Debug, Default)]
pub struct RememberState {
    pub recent: Vec<RecentEntry>,
    pub notebook: Vec<NotebookEntry>,
    pub load_error: Option<String>,
    pub clipboard_initialized: bool,
    pub last_clipboard_text: Option<String>,
    next_order: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedNotebook {
    notebook: Vec<NotebookEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedNotebookFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

pub fn load(app: &AppHandle) -> RememberState {
    let (notebook, load_error) = load_notebook(app);
    let next_order = notebook
        .iter()
        .flat_map(|entry| [Some(entry.saved_order), entry.pinned_order])
        .flatten()
        .max()
        .unwrap_or(0);
    RememberState {
        notebook,
        load_error,
        next_order,
        ..RememberState::default()
    }
}

pub fn normalize_text(text: &str) -> Option<(String, bool)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut truncated = false;
    let mut normalized = String::new();
    for (index, character) in trimmed.chars().enumerate() {
        if index >= TEXT_LIMIT {
            truncated = true;
            break;
        }
        normalized.push(character);
    }

    Some((normalized, truncated))
}

pub fn snapshot(state: &RememberState) -> RememberSnapshot {
    RememberSnapshot {
        recent: state
            .recent
            .iter()
            .map(|entry| RememberItemPayload {
                id: entry.id.clone(),
                text: entry.text.clone(),
                preview: preview_text(&entry.text),
                pinned: false,
                truncated: entry.truncated,
            })
            .collect(),
        notebook: state
            .notebook
            .iter()
            .map(|entry| RememberItemPayload {
                id: entry.id.clone(),
                text: entry.text.clone(),
                preview: preview_text(&entry.text),
                pinned: entry.pinned_order.is_some(),
                truncated: entry.truncated,
            })
            .collect(),
        error: state.load_error.clone(),
        recent_limit: RECENT_LIMIT,
        notebook_limit: NOTEBOOK_LIMIT,
        text_limit: TEXT_LIMIT,
        preview_chars: PREVIEW_CHARS,
    }
}

pub fn preview_text(text: &str) -> String {
    let mut preview = String::new();
    let mut truncated = false;
    for (index, character) in text.chars().enumerate() {
        if index >= PREVIEW_CHARS {
            truncated = true;
            break;
        }
        preview.push(character);
    }
    if truncated {
        preview.push_str("...");
    }
    preview.replace('\n', " ")
}

impl RememberState {
    pub fn push_recent(&mut self, text: String, truncated: bool) {
        self.recent.retain(|entry| entry.text != text);
        let id = self.next_id("recent");
        let order = self.next_order();
        let entry = RecentEntry {
            id,
            text,
            order,
            truncated,
        };
        self.recent.insert(0, entry);
        self.recent.truncate(RECENT_LIMIT);
    }

    pub fn entry_text(&self, source: &str, id: &str) -> Option<(String, bool)> {
        match source {
            "recent" => self
                .recent
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| (entry.text.clone(), entry.truncated)),
            "notebook" => self
                .notebook
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| (entry.text.clone(), entry.truncated)),
            _ => None,
        }
    }

    pub fn save_entry(
        &mut self,
        app: &AppHandle,
        text: String,
        truncated: bool,
    ) -> Result<(), String> {
        if self.load_error.is_some() {
            return Err("笔记本无法解密，请先重置后再继续".into());
        }

        let order = self.next_order();
        if let Some(entry) = self.notebook.iter_mut().find(|entry| entry.text == text) {
            entry.saved_order = order;
            entry.truncated = truncated;
            sort_notebook(&mut self.notebook);
            return persist_notebook(app, &self.notebook);
        }

        if self.notebook.len() >= NOTEBOOK_LIMIT {
            return Err("笔记本已经满了，请先忘记一些内容".into());
        }

        let entry = NotebookEntry {
            id: self.next_id("notebook"),
            text,
            saved_order: order,
            pinned_order: None,
            truncated,
        };
        self.notebook.push(entry);
        sort_notebook(&mut self.notebook);
        persist_notebook(app, &self.notebook)
    }

    pub fn forget_recent(&mut self, id: &str) {
        self.recent.retain(|entry| entry.id != id);
    }

    pub fn clear_recent(&mut self) {
        self.recent.clear();
    }

    pub fn forget_notebook(&mut self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.notebook.retain(|entry| entry.id != id);
        persist_notebook(app, &self.notebook)
    }

    pub fn set_notebook_pinned(
        &mut self,
        app: &AppHandle,
        id: &str,
        pinned: bool,
    ) -> Result<(), String> {
        let pinned_order = if pinned {
            Some(self.next_order())
        } else {
            None
        };
        let Some(entry) = self.notebook.iter_mut().find(|entry| entry.id == id) else {
            return Err("没有找到这条记忆".into());
        };
        entry.pinned_order = pinned_order;
        sort_notebook(&mut self.notebook);
        persist_notebook(app, &self.notebook)
    }

    pub fn reset_notebook(&mut self, app: &AppHandle) -> Result<(), String> {
        remove_notebook_files(app)?;
        self.notebook.clear();
        self.load_error = None;
        Ok(())
    }

    fn next_id(&mut self, prefix: &str) -> String {
        format!("{prefix}-{:016x}", OsRng.next_u64())
    }

    fn next_order(&mut self) -> u64 {
        self.next_order = self.next_order.saturating_add(1);
        self.next_order
    }
}

fn sort_notebook(notebook: &mut [NotebookEntry]) {
    notebook.sort_by(|left, right| {
        match (left.pinned_order, right.pinned_order) {
            (Some(left_pinned), Some(right_pinned)) => right_pinned.cmp(&left_pinned),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => right.saved_order.cmp(&left.saved_order),
        }
        .then_with(|| right.saved_order.cmp(&left.saved_order))
    });
}

fn load_notebook(app: &AppHandle) -> (Vec<NotebookEntry>, Option<String>) {
    let Ok(data_path) = data_path(app) else {
        return (Vec::new(), Some("无法访问 Deskmon 配置目录".into()));
    };
    if !data_path.exists() {
        return (Vec::new(), None);
    }

    let encrypted = match fs::read_to_string(&data_path)
        .map_err(|err| err.to_string())
        .and_then(|raw| {
            serde_json::from_str::<EncryptedNotebookFile>(&raw).map_err(|err| err.to_string())
        }) {
        Ok(file) => file,
        Err(error) => return (Vec::new(), Some(format!("笔记本数据损坏：{error}"))),
    };

    if encrypted.version != ENCRYPTED_DATA_VERSION {
        return (Vec::new(), Some("笔记本数据版本暂不支持".into()));
    }

    let key = match read_existing_key(app) {
        Ok(key) => key,
        Err(error) => return (Vec::new(), Some(error)),
    };

    match decrypt_notebook(&key, encrypted) {
        Ok(mut notebook) => {
            normalize_notebook_orders(&mut notebook);
            let _ = persist_notebook(app, &notebook);
            (notebook, None)
        }
        Err(error) => (Vec::new(), Some(error)),
    }
}

fn persist_notebook(app: &AppHandle, notebook: &[NotebookEntry]) -> Result<(), String> {
    let key = ensure_key(app)?;
    let encrypted = encrypt_notebook(&key, notebook)?;
    let raw = serde_json::to_vec_pretty(&encrypted).map_err(|err| err.to_string())?;
    let path = data_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, raw).map_err(|err| err.to_string())
}

fn encrypt_notebook(
    key: &[u8; KEY_LEN],
    notebook: &[NotebookEntry],
) -> Result<EncryptedNotebookFile, String> {
    let data = PersistedNotebook {
        notebook: notebook.to_vec(),
    };
    let plaintext = serde_json::to_vec(&data).map_err(|err| err.to_string())?;
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("remember key length is fixed");
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| "笔记本加密失败".to_string())?;
    Ok(EncryptedNotebookFile {
        version: ENCRYPTED_DATA_VERSION,
        nonce: general_purpose::STANDARD.encode(nonce),
        ciphertext: general_purpose::STANDARD.encode(ciphertext),
    })
}

fn decrypt_notebook(
    key: &[u8; KEY_LEN],
    encrypted: EncryptedNotebookFile,
) -> Result<Vec<NotebookEntry>, String> {
    let nonce = match general_purpose::STANDARD.decode(encrypted.nonce) {
        Ok(nonce) if nonce.len() == NONCE_LEN => nonce,
        Ok(_) => return Err("笔记本数据损坏：nonce 长度不正确".into()),
        Err(error) => return Err(format!("笔记本数据损坏：{error}")),
    };
    let ciphertext = match general_purpose::STANDARD.decode(encrypted.ciphertext) {
        Ok(ciphertext) => ciphertext,
        Err(error) => return Err(format!("笔记本数据损坏：{error}")),
    };

    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("remember key length is fixed");
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "笔记本无法解密，请重置后再继续".to_string())?;
    let persisted = serde_json::from_slice::<PersistedNotebook>(&plaintext)
        .map_err(|error| format!("笔记本数据损坏：{error}"))?;
    let mut notebook = persisted.notebook;
    sort_notebook(&mut notebook);
    Ok(notebook)
}

fn normalize_notebook_orders(notebook: &mut [NotebookEntry]) {
    sort_notebook(notebook);
    let len = notebook.len() as u64;
    for (index, entry) in notebook.iter_mut().enumerate() {
        let order = len.saturating_sub(index as u64);
        entry.saved_order = order;
        if entry.pinned_order.is_some() {
            entry.pinned_order = Some(order);
        }
    }
}

fn ensure_key(app: &AppHandle) -> Result<[u8; KEY_LEN], String> {
    match read_existing_key(app) {
        Ok(key) => Ok(key),
        Err(_) => {
            let mut key = [0_u8; KEY_LEN];
            OsRng.fill_bytes(&mut key);
            let path = key_path(app)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::write(path, key).map_err(|err| err.to_string())?;
            Ok(key)
        }
    }
}

fn read_existing_key(app: &AppHandle) -> Result<[u8; KEY_LEN], String> {
    let path = key_path(app)?;
    let bytes = fs::read(path).map_err(|_| "笔记本密钥不存在，请重置后再继续".to_string())?;
    if bytes.len() != KEY_LEN {
        return Err("笔记本密钥损坏，请重置后再继续".into());
    }
    let mut key = [0_u8; KEY_LEN];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn remove_notebook_files(app: &AppHandle) -> Result<(), String> {
    for path in [key_path(app)?, data_path(app)?] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(KEY_FILE))
}

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(DATA_FILE))
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_text_trims_and_truncates() {
        assert_eq!(normalize_text("   \n\t  "), None);
        assert_eq!(
            normalize_text("  hello\nworld  "),
            Some(("hello\nworld".into(), false))
        );

        let long_text = "a".repeat(TEXT_LIMIT + 2);
        let (normalized, truncated) = normalize_text(&long_text).expect("long text is valid");
        assert_eq!(normalized.len(), TEXT_LIMIT);
        assert!(truncated);
    }

    #[test]
    fn recent_caps_and_moves_duplicates_to_front() {
        let mut state = RememberState::default();
        for index in 0..12 {
            state.push_recent(format!("item {index}"), false);
        }

        assert_eq!(state.recent.len(), RECENT_LIMIT);
        assert_eq!(
            state.recent.first().map(|entry| entry.text.as_str()),
            Some("item 11")
        );
        assert_eq!(
            state.recent.last().map(|entry| entry.text.as_str()),
            Some("item 2")
        );

        state.push_recent("item 5".into(), false);

        assert_eq!(state.recent.len(), RECENT_LIMIT);
        assert_eq!(
            state.recent.first().map(|entry| entry.text.as_str()),
            Some("item 5")
        );
        assert_eq!(
            state
                .recent
                .iter()
                .filter(|entry| entry.text == "item 5")
                .count(),
            1,
        );
    }

    #[test]
    fn notebook_sort_puts_pinned_first_then_newest() {
        let mut notebook = vec![
            NotebookEntry {
                id: "old".into(),
                text: "old".into(),
                saved_order: 10,
                pinned_order: None,
                truncated: false,
            },
            NotebookEntry {
                id: "fresh".into(),
                text: "fresh".into(),
                saved_order: 40,
                pinned_order: None,
                truncated: false,
            },
            NotebookEntry {
                id: "pinned-old".into(),
                text: "pinned-old".into(),
                saved_order: 20,
                pinned_order: Some(60),
                truncated: false,
            },
            NotebookEntry {
                id: "pinned-new".into(),
                text: "pinned-new".into(),
                saved_order: 30,
                pinned_order: Some(80),
                truncated: false,
            },
        ];

        sort_notebook(&mut notebook);

        let ids = notebook
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["pinned-new", "pinned-old", "fresh", "old"]);
    }

    #[test]
    fn encrypted_notebook_does_not_store_plaintext_and_roundtrips() {
        let key = [7_u8; KEY_LEN];
        let notebook = vec![NotebookEntry {
            id: "secret-id".into(),
            text: "very secret text".into(),
            saved_order: 123,
            pinned_order: Some(456),
            truncated: false,
        }];

        let encrypted = encrypt_notebook(&key, &notebook).expect("encrypts notebook");
        let raw = serde_json::to_string(&encrypted).expect("serializes encrypted notebook");

        assert!(!raw.contains("very secret text"));
        assert!(!raw.contains("secret-id"));

        let restored = decrypt_notebook(&key, encrypted).expect("decrypts notebook");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].text, "very secret text");
        assert_eq!(restored[0].pinned_order, Some(456));
    }

    #[test]
    fn notebook_entry_accepts_legacy_time_fields() {
        let raw = r#"{
          "id": "legacy",
          "text": "from old data",
          "savedAtMs": 12345,
          "pinnedAtMs": 23456,
          "truncated": false
        }"#;

        let entry = serde_json::from_str::<NotebookEntry>(raw).expect("loads legacy fields");

        assert_eq!(entry.saved_order, 12345);
        assert_eq!(entry.pinned_order, Some(23456));
    }

    #[test]
    fn encrypted_notebook_rejects_wrong_key() {
        let key = [1_u8; KEY_LEN];
        let wrong_key = [2_u8; KEY_LEN];
        let notebook = vec![NotebookEntry {
            id: "id".into(),
            text: "text".into(),
            saved_order: 1,
            pinned_order: None,
            truncated: false,
        }];
        let encrypted = encrypt_notebook(&key, &notebook).expect("encrypts notebook");

        let result = decrypt_notebook(&wrong_key, encrypted);

        assert!(result.is_err());
    }
}
