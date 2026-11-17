use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub const RECENT_LIMIT: usize = 10;
pub const CHAIN_LIMIT: usize = 50;
pub const TEXT_LIMIT: usize = 5000;
const PREVIEW_CHARS: usize = 20;
const KEY_FILE: &str = "remember.key";
const DATA_FILE: &str = "remember.json";
const LEGACY_DATA_VERSION: u8 = 1;
const DATA_VERSION: u8 = 2;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: String,
    pub text: String,
    pub preview: String,
    pub truncated: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryChain {
    id: String,
    name: String,
    note: Option<String>,
    values: Vec<String>,
    pinned: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSummary {
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    pub value_count: usize,
    pub pinned: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberSnapshot {
    pub recent: Vec<RecentEntry>,
    pub chains: Vec<ChainSummary>,
    pub error: Option<String>,
    pub recent_limit: usize,
    pub chain_limit: usize,
}

#[derive(Default)]
pub struct RememberState {
    pub recent: Vec<RecentEntry>,
    chains: Vec<MemoryChain>,
    load_error: Option<String>,
    pub clipboard_revision: Option<isize>,
    pub last_clipboard_text: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

pub fn load(app: &AppHandle) -> RememberState {
    match config_dir(app).and_then(|dir| load_chains(&dir)) {
        Ok(chains) => RememberState {
            chains,
            ..RememberState::default()
        },
        Err(error) => RememberState {
            load_error: Some(error),
            ..RememberState::default()
        },
    }
}

pub fn normalize_text(text: &str) -> Option<(String, bool)> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut chars = text.chars();
    let shortened = chars.by_ref().take(TEXT_LIMIT).collect();
    Some((shortened, chars.next().is_some()))
}

pub fn snapshot(state: &RememberState) -> RememberSnapshot {
    RememberSnapshot {
        recent: state.recent.clone(),
        chains: state
            .chains
            .iter()
            .map(|entry| ChainSummary {
                id: entry.id.clone(),
                name: entry.name.clone(),
                note: entry.note.clone(),
                value_count: entry.values.len(),
                pinned: entry.pinned,
            })
            .collect(),
        error: state.load_error.clone(),
        recent_limit: RECENT_LIMIT,
        chain_limit: CHAIN_LIMIT,
    }
}

impl RememberState {
    pub fn push_recent(&mut self, text: String, truncated: bool) {
        self.recent.retain(|entry| entry.text != text);
        let mut chars = text.chars();
        let mut preview: String = chars.by_ref().take(PREVIEW_CHARS).collect();
        if chars.next().is_some() {
            preview.push_str("...");
        }
        self.recent.insert(
            0,
            RecentEntry {
                id: new_id("recent"),
                text,
                preview: preview.replace('\n', " "),
                truncated,
            },
        );
        self.recent.truncate(RECENT_LIMIT);
    }

    pub fn forget_recent(&mut self, id: &str) {
        self.recent.retain(|entry| entry.id != id);
    }

    pub fn chain_name(&self, id: &str) -> Result<&str, String> {
        self.chains
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.name.as_str())
            .ok_or_else(|| "没有找到这条记忆链".into())
    }

    pub fn chain_values(&self, id: &str) -> Result<Vec<String>, String> {
        self.chains
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.values.clone())
            .ok_or_else(|| "没有找到这条记忆链".into())
    }

    pub fn save_chain(
        &mut self,
        app: &AppHandle,
        id: Option<&str>,
        name: String,
        note: Option<String>,
        values: Vec<String>,
    ) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("请填写记忆链名称".into());
        }
        if values.is_empty() || values.iter().any(|value| value.is_empty()) {
            return Err("请填写每一条内容".into());
        }
        if self
            .chains
            .iter()
            .any(|entry| Some(entry.id.as_str()) != id && entry.name.eq_ignore_ascii_case(name))
        {
            return Err("已有同名记忆链".into());
        }

        let mut chains = self.chains.clone();
        let id = match id {
            Some(id) => {
                self.chain_name(id)?;
                id.to_owned()
            }
            None => {
                if chains.len() >= CHAIN_LIMIT {
                    return Err("记忆链已满，请先删除不需要的记忆链".into());
                }
                new_id("chain")
            }
        };
        let pinned = if let Some(index) = chains.iter().position(|chain| chain.id == id) {
            chains.remove(index).pinned
        } else {
            false
        };
        chains.insert(
            0,
            MemoryChain {
                id: id.clone(),
                name: name.to_owned(),
                note: note
                    .map(|note| note.trim().to_owned())
                    .filter(|note| !note.is_empty()),
                values,
                pinned,
            },
        );
        self.commit(app, chains)?;
        Ok(id)
    }

    pub fn set_chain_pinned(
        &mut self,
        app: &AppHandle,
        id: &str,
        pinned: bool,
    ) -> Result<(), String> {
        let mut chains = self.chains.clone();
        let index = chains
            .iter()
            .position(|entry| entry.id == id)
            .ok_or("没有找到这条记忆链")?;
        let mut entry = chains.remove(index);
        entry.pinned = pinned;
        chains.insert(0, entry);
        self.commit(app, chains)
    }

    pub fn delete_chain(&mut self, app: &AppHandle, id: &str) -> Result<(), String> {
        self.chain_name(id)?;
        let mut chains = self.chains.clone();
        chains.retain(|entry| entry.id != id);
        self.commit(app, chains)
    }

    pub fn reset_chains(&mut self, app: &AppHandle) -> Result<(), String> {
        let dir = config_dir(app)?;
        remove_file_if_present(&dir.join(DATA_FILE))?;
        self.chains.clear();
        self.load_error = None;
        remove_file_if_present(&dir.join(KEY_FILE))
    }

    fn commit(&mut self, app: &AppHandle, mut chains: Vec<MemoryChain>) -> Result<(), String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        chains.sort_by_key(|entry| !entry.pinned);
        persist_chains(&config_dir(app)?, &chains)?;
        self.chains = chains;
        Ok(())
    }
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{:016x}", OsRng.next_u64())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|err| err.to_string())
}

fn load_chains(dir: &Path) -> Result<Vec<MemoryChain>, String> {
    let raw = match fs::read(dir.join(DATA_FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let encrypted: EncryptedFile =
        serde_json::from_slice(&raw).map_err(|error| format!("记忆链数据损坏：{error}"))?;
    match encrypted.version {
        LEGACY_DATA_VERSION => {
            // Version 1 contains the removed notebook and variable library.
            persist_chains(dir, &[])?;
            Ok(Vec::new())
        }
        DATA_VERSION => decrypt_chains(&read_key(dir)?, encrypted),
        _ => Err("记忆链数据版本暂不支持".into()),
    }
}

fn persist_chains(dir: &Path, chains: &[MemoryChain]) -> Result<(), String> {
    let key = match read_key(dir) {
        Ok(key) => key,
        Err(_) if !dir.join(KEY_FILE).exists() => {
            let mut key = [0_u8; KEY_LEN];
            OsRng.fill_bytes(&mut key);
            write_private_file(dir, KEY_FILE, &key)?;
            key
        }
        Err(error) => return Err(error),
    };
    let encrypted = encrypt_chains(&key, chains)?;
    let raw = serde_json::to_vec(&encrypted).map_err(|error| error.to_string())?;
    write_private_file(dir, DATA_FILE, &raw)
}

fn read_key(dir: &Path) -> Result<[u8; KEY_LEN], String> {
    let bytes =
        fs::read(dir.join(KEY_FILE)).map_err(|error| format!("无法读取记忆链密钥：{error}"))?;
    bytes.try_into().map_err(|_| "记忆链密钥损坏".into())
}

fn encrypt_chains(key: &[u8; KEY_LEN], chains: &[MemoryChain]) -> Result<EncryptedFile, String> {
    let plaintext = serde_json::to_vec(chains).map_err(|error| error.to_string())?;
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("fixed-length key");
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
        .map_err(|_| "记忆链加密失败")?;
    Ok(EncryptedFile {
        version: DATA_VERSION,
        nonce: general_purpose::STANDARD.encode(nonce),
        ciphertext: general_purpose::STANDARD.encode(ciphertext),
    })
}

fn decrypt_chains(
    key: &[u8; KEY_LEN],
    encrypted: EncryptedFile,
) -> Result<Vec<MemoryChain>, String> {
    let nonce = general_purpose::STANDARD
        .decode(encrypted.nonce)
        .map_err(|error| error.to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("记忆链数据损坏：nonce 长度不正确".into());
    }
    let ciphertext = general_purpose::STANDARD
        .decode(encrypted.ciphertext)
        .map_err(|error| error.to_string())?;
    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("fixed-length key");
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|_| "记忆链无法解密")?;
    serde_json::from_slice(&plaintext).map_err(|error| error.to_string())
}

fn write_private_file(dir: &Path, filename: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let temporary = dir.join(new_id("remember-tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    let result = result.and_then(|_| fs::rename(&temporary, dir.join(filename)));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_text_is_trimmed_and_truncated_without_breaking_unicode() {
        assert_eq!(normalize_text("  \n"), None);
        assert_eq!(
            normalize_text("  hello\nworld  "),
            Some(("hello\nworld".into(), false))
        );
        assert_eq!(
            normalize_text(&"中".repeat(TEXT_LIMIT + 1)),
            Some(("中".repeat(TEXT_LIMIT), true))
        );
    }

    #[test]
    fn chain_encryption_preserves_order_duplicates_and_whitespace() {
        let key = [1; KEY_LEN];
        let chain = MemoryChain {
            id: "test".into(),
            name: "example".into(),
            note: None,
            values: ["  first\n", "second", "  first\n"]
                .map(str::to_owned)
                .to_vec(),
            pinned: true,
        };
        let encrypted = encrypt_chains(&key, std::slice::from_ref(&chain)).unwrap();
        assert!(!serde_json::to_string(&encrypted)
            .unwrap()
            .contains("second"));
        let decoded = decrypt_chains(&key, encrypted).unwrap();
        assert_eq!(decoded[0].values, chain.values);
    }

    #[test]
    fn replacing_version_one_data_is_idempotent() {
        let dir = std::env::temp_dir().join(new_id("deskmon-test"));
        fs::create_dir(&dir).unwrap();
        let legacy = EncryptedFile {
            version: LEGACY_DATA_VERSION,
            nonce: "old".into(),
            ciphertext: "old".into(),
        };
        fs::write(dir.join(DATA_FILE), serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(load_chains(&dir).unwrap().is_empty());
        let saved: EncryptedFile =
            serde_json::from_slice(&fs::read(dir.join(DATA_FILE)).unwrap()).unwrap();
        assert_eq!(saved.version, DATA_VERSION);
        assert!(load_chains(&dir).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
