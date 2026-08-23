//! macOS Keychain credential store — generic passwords.
//! Service name: com.devdeck.app · Account: user@host:port
//! DB only ever stores the account ref, never the secret.

use security_framework::os::macos::keychain::SecKeychain;
use thiserror::Error;

const SERVICE: &str = "com.devdeck.app";

#[derive(Error, Debug)]
pub enum KeychainError {
    #[error("keychain error: {0}")]
    Keychain(#[from] security_framework::base::Error),
    #[error("item not found: {0}")]
    NotFound(String),
    #[error("conversion error: {0}")]
    Conversion(#[from] std::string::FromUtf8Error),
}

fn keychain() -> SecKeychain {
    SecKeychain::default().unwrap()
}

/// Store a password (creates or updates the item).
pub fn store_password(account: &str, password: &str) -> Result<(), KeychainError> {
    let keychain = keychain();
    keychain.set_generic_password(SERVICE, account, password.as_bytes())?;
    Ok(())
}

/// Load a password.
pub fn load_password(account: &str) -> Result<String, KeychainError> {
    let keychain = keychain();
    let (pw, _item) = keychain.find_generic_password(SERVICE, account)?;
    Ok(String::from_utf8(pw.as_ref().to_vec())?)
}

/// Delete a password.
pub fn delete_password(account: &str) -> Result<(), KeychainError> {
    let keychain = keychain();
    let (_pw, item) = keychain
        .find_generic_password(SERVICE, account)
        .map_err(|_| KeychainError::NotFound(account.to_string()))?;
    item.delete();
    Ok(())
}

/// Build the keychain account ref for a host: `user@host:port`
pub fn account_for(user: &str, host: &str, port: u16) -> String {
    format!("{user}@{host}:{port}")
}

pub fn private_key_account(user: &str, host: &str, port: u16) -> String {
    format!("{}:private-key", account_for(user, host, port))
}

pub fn store_private_key(account: &str, private_key_pem: &str) -> Result<(), KeychainError> {
    store_password(&private_key_account_ref(account), private_key_pem)
}

pub fn load_private_key(account: &str) -> Result<String, KeychainError> {
    load_password(&private_key_account_ref(account))
}

fn private_key_account_ref(account: &str) -> String {
    format!("{account}:private-key")
}
