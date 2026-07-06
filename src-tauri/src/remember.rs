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
pub const VARIABLE_LIMIT: usize = 50;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableEntry {
    pub id: String,
    pub key: String,
    pub value: String,
    pub note: Option<String>,
    #[serde(default)]
    pub order: u64,
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
pub struct RememberVariablePayload {
    pub id: String,
    pub key: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberSnapshot {
    pub recent: Vec<RememberItemPayload>,
    pub notebook: Vec<RememberItemPayload>,
    pub variables: Vec<RememberVariablePayload>,
    pub error: Option<String>,
    pub recent_limit: usize,
    pub notebook_limit: usize,
    pub variable_limit: usize,
    pub variable_clipboard_cleanup_enabled: bool,
    pub text_limit: usize,
    pub preview_chars: usize,
}

#[derive(Debug, Default)]
pub struct RememberState {
    pub recent: Vec<RecentEntry>,
    pub notebook: Vec<NotebookEntry>,
    pub variables: Vec<VariableEntry>,
    pub variable_clipboard_cleanup_enabled: bool,
    pub load_error: Option<String>,
    pub clipboard_initialized: bool,
    pub last_clipboard_text: Option<String>,
    next_order: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRememberData {
    #[serde(default)]
    notebook: Vec<NotebookEntry>,
    #[serde(default)]
    variables: Vec<VariableEntry>,
    #[serde(default)]
    variable_clipboard_cleanup_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedNotebookFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

pub fn load(app: &AppHandle) -> RememberState {
    let (mut data, load_error) = load_remember_data(app);
    normalize_notebook_orders(&mut data.notebook);
    normalize_variable_orders(&mut data.variables);
    let next_order = data
        .notebook
        .iter()
        .flat_map(|entry| [Some(entry.saved_order), entry.pinned_order])
        .flatten()
        .chain(data.variables.iter().map(|entry| entry.order))
        .max()
        .unwrap_or(0);
    RememberState {
        notebook: data.notebook,
        variables: data.variables,
        variable_clipboard_cleanup_enabled: data.variable_clipboard_cleanup_enabled,
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
        variables: state
            .variables
            .iter()
            .map(|entry| RememberVariablePayload {
                id: entry.id.clone(),
                key: entry.key.clone(),
                note: entry.note.clone(),
            })
            .collect(),
        error: state.load_error.clone(),
        recent_limit: RECENT_LIMIT,
        notebook_limit: NOTEBOOK_LIMIT,
        variable_limit: VARIABLE_LIMIT,
        variable_clipboard_cleanup_enabled: state.variable_clipboard_cleanup_enabled,
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

    pub fn variable_value(&self, id: &str) -> Option<String> {
        self.variables
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.value.clone())
    }

    pub fn variable_key(&self, id: &str) -> Option<String> {
        self.variables
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.key.clone())
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
            return self.persist(app);
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
        self.persist(app)
    }

    pub fn forget_recent(&mut self, id: &str) {
        self.recent.retain(|entry| entry.id != id);
    }

    pub fn clear_recent(&mut self) {
        self.recent.clear();
    }

    pub fn forget_notebook(&mut self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.notebook.retain(|entry| entry.id != id);
        self.persist(app)
    }

    pub fn set_notebook_pinned(
        &mut self,
        app: &AppHandle,
        id: &str,
        pinned: bool,
    ) -> Result<(), String> {
        self.update_notebook_pinned(id, pinned)?;
        self.persist(app)
    }

    fn update_notebook_pinned(&mut self, id: &str, pinned: bool) -> Result<(), String> {
        let Some(index) = self.notebook.iter().position(|entry| entry.id == id) else {
            return Err("没有找到这条记忆".into());
        };

        if pinned {
            let pinned_order = self.next_order();
            self.notebook[index].pinned_order = Some(pinned_order);
        } else {
            if self.notebook[index].pinned_order.is_some() {
                let saved_order = self.next_order();
                self.notebook[index].saved_order = saved_order;
            }
            self.notebook[index].pinned_order = None;
        }

        sort_notebook(&mut self.notebook);
        Ok(())
    }

    pub fn reset_notebook(&mut self, app: &AppHandle) -> Result<(), String> {
        remove_notebook_files(app)?;
        self.notebook.clear();
        self.variables.clear();
        self.variable_clipboard_cleanup_enabled = false;
        self.load_error = None;
        Ok(())
    }

    pub fn create_variable(
        &mut self,
        app: &AppHandle,
        key: String,
        value: String,
        note: Option<String>,
    ) -> Result<String, String> {
        if self.load_error.is_some() {
            return Err("记忆力数据无法解密，请先重置后再继续".into());
        }

        let key = normalize_variable_key(&key)?;
        let value = normalize_variable_value(&value)?;
        let note = normalize_variable_note(note);

        if self
            .variables
            .iter()
            .any(|entry| entry.key.eq_ignore_ascii_case(&key))
        {
            return Err("这个 key 已经存在了".into());
        }
        if self.variables.len() >= VARIABLE_LIMIT {
            return Err("变量已经满了，请先删除不需要的变量".into());
        }

        let id = self.next_id("variable");
        let entry = VariableEntry {
            id: id.clone(),
            key,
            value,
            note,
            order: self.next_order(),
        };
        self.variables.push(entry);
        sort_variables(&mut self.variables);
        self.persist(app)?;
        Ok(id)
    }

    pub fn update_variable(
        &mut self,
        app: &AppHandle,
        id: &str,
        key: String,
        value: String,
        note: Option<String>,
    ) -> Result<(), String> {
        if self.load_error.is_some() {
            return Err("记忆力数据无法解密，请先重置后再继续".into());
        }

        let key = normalize_variable_key(&key)?;
        let value = normalize_variable_value(&value)?;
        let note = normalize_variable_note(note);

        if self
            .variables
            .iter()
            .any(|entry| entry.id != id && entry.key.eq_ignore_ascii_case(&key))
        {
            return Err("这个 key 已经存在了".into());
        }

        let Some(index) = self.variables.iter().position(|entry| entry.id == id) else {
            return Err("没有找到这个变量".into());
        };

        let order = self.next_order();
        self.variables[index].key = key;
        self.variables[index].value = value;
        self.variables[index].note = note;
        self.variables[index].order = order;
        sort_variables(&mut self.variables);
        self.persist(app)
    }

    pub fn delete_variable(&mut self, app: &AppHandle, id: &str) -> Result<(), String> {
        let before = self.variables.len();
        self.variables.retain(|entry| entry.id != id);
        if self.variables.len() == before {
            return Err("没有找到这个变量".into());
        }
        self.persist(app)
    }

    pub fn set_variable_clipboard_cleanup_enabled(
        &mut self,
        app: &AppHandle,
        enabled: bool,
    ) -> Result<(), String> {
        self.variable_clipboard_cleanup_enabled = enabled;
        self.persist(app)
    }

    fn persist(&self, app: &AppHandle) -> Result<(), String> {
        persist_remember_data(
            app,
            &PersistedRememberData {
                notebook: self.notebook.clone(),
                variables: self.variables.clone(),
                variable_clipboard_cleanup_enabled: self.variable_clipboard_cleanup_enabled,
            },
        )
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

fn sort_variables(variables: &mut [VariableEntry]) {
    variables.sort_by(|left, right| {
        right
            .order
            .cmp(&left.order)
            .then_with(|| left.key.cmp(&right.key))
    });
}

fn normalize_variable_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("key 不能为空".into());
    }
    Ok(key.to_string())
}

fn normalize_variable_value(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("value 不能为空".into());
    }
    Ok(value.to_string())
}

fn normalize_variable_note(note: Option<String>) -> Option<String> {
    note.and_then(|note| {
        let note = note.trim();
        if note.is_empty() {
            None
        } else {
            Some(note.to_string())
        }
    })
}

fn load_remember_data(app: &AppHandle) -> (PersistedRememberData, Option<String>) {
    let Ok(data_path) = data_path(app) else {
        return (
            PersistedRememberData::default(),
            Some("无法访问 Deskmon 配置目录".into()),
        );
    };
    if !data_path.exists() {
        return (PersistedRememberData::default(), None);
    }

    let encrypted = match fs::read_to_string(&data_path)
        .map_err(|err| err.to_string())
        .and_then(|raw| {
            serde_json::from_str::<EncryptedNotebookFile>(&raw).map_err(|err| err.to_string())
        }) {
        Ok(file) => file,
        Err(error) => {
            return (
                PersistedRememberData::default(),
                Some(format!("记忆力数据损坏：{error}")),
            )
        }
    };

    if encrypted.version != ENCRYPTED_DATA_VERSION {
        return (
            PersistedRememberData::default(),
            Some("记忆力数据版本暂不支持".into()),
        );
    }

    let key = match read_existing_key(app) {
        Ok(key) => key,
        Err(error) => return (PersistedRememberData::default(), Some(error)),
    };

    match decrypt_remember_data(&key, encrypted) {
        Ok(mut data) => {
            normalize_notebook_orders(&mut data.notebook);
            normalize_variable_orders(&mut data.variables);
            let _ = persist_remember_data(app, &data);
            (data, None)
        }
        Err(error) => (PersistedRememberData::default(), Some(error)),
    }
}

fn persist_remember_data(app: &AppHandle, data: &PersistedRememberData) -> Result<(), String> {
    let key = ensure_key(app)?;
    let encrypted = encrypt_remember_data(&key, data)?;
    let raw = serde_json::to_vec_pretty(&encrypted).map_err(|err| err.to_string())?;
    let path = data_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, raw).map_err(|err| err.to_string())
}

fn encrypt_remember_data(
    key: &[u8; KEY_LEN],
    data: &PersistedRememberData,
) -> Result<EncryptedNotebookFile, String> {
    let plaintext = serde_json::to_vec(&data).map_err(|err| err.to_string())?;
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("remember key length is fixed");
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| "记忆力加密失败".to_string())?;
    Ok(EncryptedNotebookFile {
        version: ENCRYPTED_DATA_VERSION,
        nonce: general_purpose::STANDARD.encode(nonce),
        ciphertext: general_purpose::STANDARD.encode(ciphertext),
    })
}

fn decrypt_remember_data(
    key: &[u8; KEY_LEN],
    encrypted: EncryptedNotebookFile,
) -> Result<PersistedRememberData, String> {
    let nonce = match general_purpose::STANDARD.decode(encrypted.nonce) {
        Ok(nonce) if nonce.len() == NONCE_LEN => nonce,
        Ok(_) => return Err("记忆力数据损坏：nonce 长度不正确".into()),
        Err(error) => return Err(format!("记忆力数据损坏：{error}")),
    };
    let ciphertext = match general_purpose::STANDARD.decode(encrypted.ciphertext) {
        Ok(ciphertext) => ciphertext,
        Err(error) => return Err(format!("记忆力数据损坏：{error}")),
    };

    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("remember key length is fixed");
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "记忆力无法解密，请重置后再继续".to_string())?;
    let mut persisted = decode_remember_plaintext(&plaintext)?;
    sort_notebook(&mut persisted.notebook);
    sort_variables(&mut persisted.variables);
    Ok(persisted)
}

fn decode_remember_plaintext(plaintext: &[u8]) -> Result<PersistedRememberData, String> {
    match serde_json::from_slice::<PersistedRememberData>(plaintext) {
        Ok(data) => Ok(data),
        Err(new_error) => match serde_json::from_slice::<Vec<NotebookEntry>>(plaintext) {
            Ok(notebook) => Ok(PersistedRememberData {
                notebook,
                ..PersistedRememberData::default()
            }),
            Err(_) => Err(format!("记忆力数据损坏：{new_error}")),
        },
    }
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

fn normalize_variable_orders(variables: &mut [VariableEntry]) {
    sort_variables(variables);
    let len = variables.len() as u64;
    for (index, entry) in variables.iter_mut().enumerate() {
        if entry.order == 0 {
            entry.order = len.saturating_sub(index as u64);
        }
    }
    sort_variables(variables);
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
    fn cancelling_pin_moves_entry_to_first_unpinned() {
        let mut state = RememberState {
            notebook: vec![
                NotebookEntry {
                    id: "unpinned-fresh".into(),
                    text: "unpinned-fresh".into(),
                    saved_order: 40,
                    pinned_order: None,
                    truncated: false,
                },
                NotebookEntry {
                    id: "unpinned-old".into(),
                    text: "unpinned-old".into(),
                    saved_order: 10,
                    pinned_order: None,
                    truncated: false,
                },
                NotebookEntry {
                    id: "keep-pinned".into(),
                    text: "keep-pinned".into(),
                    saved_order: 20,
                    pinned_order: Some(60),
                    truncated: false,
                },
                NotebookEntry {
                    id: "cancel-pinned".into(),
                    text: "cancel-pinned".into(),
                    saved_order: 30,
                    pinned_order: Some(80),
                    truncated: false,
                },
            ],
            next_order: 80,
            ..RememberState::default()
        };

        state
            .update_notebook_pinned("cancel-pinned", false)
            .expect("cancels pin");

        let ids = state
            .notebook
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "keep-pinned",
                "cancel-pinned",
                "unpinned-fresh",
                "unpinned-old"
            ]
        );
        assert_eq!(state.notebook[1].pinned_order, None);
    }

    #[test]
    fn encrypted_remember_data_does_not_store_plaintext_and_roundtrips() {
        let key = [7_u8; KEY_LEN];
        let data = PersistedRememberData {
            notebook: vec![NotebookEntry {
                id: "secret-id".into(),
                text: "very secret text".into(),
                saved_order: 123,
                pinned_order: Some(456),
                truncated: false,
            }],
            variables: vec![VariableEntry {
                id: "variable-id".into(),
                key: "api_token".into(),
                value: "secret variable value".into(),
                note: Some("production".into()),
                order: 789,
            }],
            variable_clipboard_cleanup_enabled: true,
        };

        let encrypted = encrypt_remember_data(&key, &data).expect("encrypts remember data");
        let raw = serde_json::to_string(&encrypted).expect("serializes encrypted notebook");

        assert!(!raw.contains("very secret text"));
        assert!(!raw.contains("secret-id"));
        assert!(!raw.contains("secret variable value"));
        assert!(!raw.contains("api_token"));

        let restored = decrypt_remember_data(&key, encrypted).expect("decrypts remember data");
        assert_eq!(restored.notebook.len(), 1);
        assert_eq!(restored.notebook[0].text, "very secret text");
        assert_eq!(restored.notebook[0].pinned_order, Some(456));
        assert_eq!(restored.variables.len(), 1);
        assert_eq!(restored.variables[0].key, "api_token");
        assert_eq!(restored.variables[0].value, "secret variable value");
        assert!(restored.variable_clipboard_cleanup_enabled);
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
    fn encrypted_legacy_notebook_array_roundtrips_into_new_data_shape() {
        let key = [9_u8; KEY_LEN];
        let notebook = vec![NotebookEntry {
            id: "legacy-id".into(),
            text: "legacy text".into(),
            saved_order: 10,
            pinned_order: None,
            truncated: false,
        }];
        let plaintext = serde_json::to_vec(&notebook).expect("serializes legacy notebook");
        let encrypted = encrypt_plaintext_for_test(&key, &plaintext);

        let restored = decrypt_remember_data(&key, encrypted).expect("decrypts legacy notebook");

        assert_eq!(restored.notebook.len(), 1);
        assert_eq!(restored.notebook[0].text, "legacy text");
        assert!(restored.variables.is_empty());
        assert!(!restored.variable_clipboard_cleanup_enabled);
    }

    #[test]
    fn variable_snapshot_does_not_expose_value() {
        let state = RememberState {
            variables: vec![VariableEntry {
                id: "variable-id".into(),
                key: "api_token".into(),
                value: "must never appear".into(),
                note: Some("service key".into()),
                order: 1,
            }],
            ..RememberState::default()
        };

        let raw = serde_json::to_string(&snapshot(&state)).expect("serializes snapshot");

        assert!(raw.contains("api_token"));
        assert!(raw.contains("service key"));
        assert!(!raw.contains("must never appear"));
    }

    #[test]
    fn variable_fields_trim_and_reject_empty_required_values() {
        assert_eq!(normalize_variable_key("  token  "), Ok("token".into()));
        assert_eq!(normalize_variable_value("  secret  "), Ok("secret".into()));
        assert_eq!(
            normalize_variable_note(Some("  production  ".into())),
            Some("production".into())
        );
        assert_eq!(normalize_variable_note(Some("   ".into())), None);
        assert!(normalize_variable_key("   ").is_err());
        assert!(normalize_variable_value("\n\t").is_err());
    }

    #[test]
    fn encrypted_remember_data_rejects_wrong_key() {
        let key = [1_u8; KEY_LEN];
        let wrong_key = [2_u8; KEY_LEN];
        let data = PersistedRememberData {
            notebook: vec![NotebookEntry {
                id: "id".into(),
                text: "text".into(),
                saved_order: 1,
                pinned_order: None,
                truncated: false,
            }],
            ..PersistedRememberData::default()
        };
        let encrypted = encrypt_remember_data(&key, &data).expect("encrypts remember data");

        let result = decrypt_remember_data(&wrong_key, encrypted);

        assert!(result.is_err());
    }

    fn encrypt_plaintext_for_test(key: &[u8; KEY_LEN], plaintext: &[u8]) -> EncryptedNotebookFile {
        let nonce = [3_u8; NONCE_LEN];
        let cipher = ChaCha20Poly1305::new_from_slice(key).expect("remember key length is fixed");
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .expect("encrypts plaintext");
        EncryptedNotebookFile {
            version: ENCRYPTED_DATA_VERSION,
            nonce: general_purpose::STANDARD.encode(nonce),
            ciphertext: general_purpose::STANDARD.encode(ciphertext),
        }
    }
}
