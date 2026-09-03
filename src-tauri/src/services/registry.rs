//! Docker Registry HTTP API v2 客户端。
//!
//! 用于浏览镜像仓库（如 UCloud 私有仓库 / Docker Hub）：
//! - `GET /v2/_catalog`           → 仓库（repositories）列表
//! - `GET /v2/{repo}/tags/list`   → 某个镜像的全部 tag
//!
//! 认证：
//! - 私有仓库通常用 Basic Auth（用户名:密码）。
//! - Docker Hub / 部分云厂商会返回 `401` + `WWW-Authenticate: Bearer realm=...`，
//!   此时走 token 流程（先取 token，再带 Bearer 重试）。
//! 密码由命令层从 Keychain 读取后传入，本模块不直接触碰密钥存储。

use crate::models::RegistryConfig;
use base64::Engine as _;

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("HTTP 请求失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("认证失败: {0}")]
    Auth(String),
    #[error("仓库服务错误: {0}")]
    Server(String),
    #[error("未找到对应镜像仓库配置")]
    NotFound,
}

#[derive(Debug, serde::Deserialize)]
struct CatalogResp {
    #[serde(default)]
    repositories: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct TagsResp {
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct TokenResp {
    #[serde(alias = "access_token")]
    token: Option<String>,
}

pub struct RegistryClient {
    client: reqwest::Client,
    /// 规范化后的 base URL（无尾斜杠），如 `https://registry.example.com`
    url: String,
    username: Option<String>,
    password: Option<String>,
}

impl RegistryClient {
    /// 依据配置创建客户端；password 由命令层从 Keychain 取出后传入。
    pub fn new(cfg: &RegistryConfig, password: Option<String>) -> Self {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("DevDeck/0.1 (Docker Registry API v2)");
        if cfg.insecure {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder.build().unwrap_or_default();
        let url = normalize_url(&cfg.url, cfg.insecure);
        let username = if cfg.username.trim().is_empty() {
            None
        } else {
            Some(cfg.username.trim().to_string())
        };
        let password = password.filter(|p| !p.trim().is_empty());
        Self {
            client,
            url,
            username,
            password,
        }
    }

    fn basic_auth(&self) -> Option<String> {
        let user = self.username.as_ref()?;
        let pass = self.password.as_deref().unwrap_or("");
        let raw = format!("{user}:{pass}");
        Some(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())))
    }

    /// 先探测 `GET /v2/`，返回服务器支持的版本/状态；用于校验连接与凭据。
    pub async fn ping(&self) -> Result<String, RegistryError> {
        let resp = self.authed_get("/v2/").await?;
        let version = resp
            .headers()
            .get("docker-distribution-api-version")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("v2")
            .to_string();
        Ok(version)
    }

    /// 列出所有仓库（repositories）。Docker Registry v2 的 `_catalog`。
    pub async fn catalog(&self) -> Result<Vec<String>, RegistryError> {
        // 一次取足够大分页；需要时可按 `Link` 头续取。
        let mut repos: Vec<String> = Vec::new();
        let mut n = 0usize;
        loop {
            let resp = self.authed_get(&format!("/v2/_catalog?n=1000&last={n}")).await?;
            let page: CatalogResp = resp.json().await?;
            if page.repositories.is_empty() {
                break;
            }
            let page_len = page.repositories.len();
            n += page_len;
            repos.extend(page.repositories);
            // 简化分页：若本次不足 1000，认为已取完
            if page_len < 1000 {
                break;
            }
        }
        repos.sort();
        Ok(repos)
    }

    /// 列出某个仓库的镜像 tag。
    pub async fn tags(&self, repo: &str) -> Result<Vec<String>, RegistryError> {
        let resp = self.authed_get(&format!("/v2/{repo}/tags/list")).await?;
        let body: TagsResp = resp.json().await?;
        let mut tags = body.tags;
        tags.sort();
        Ok(tags)
    }

    /// 带认证的 GET：先带 Basic，若 401 且有 Bearer challenge 则取 token 重试。
    async fn authed_get(&self, path: &str) -> Result<reqwest::Response, RegistryError> {
        let resp = self.raw_get(path, self.basic_auth().as_deref()).await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            let challenge = resp
                .headers()
                .get("www-authenticate")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            if let Some(challenge) = challenge {
                if let Some(token) = self.fetch_token(&challenge).await? {
                    let resp2 = self.raw_get(path, Some(&format!("Bearer {token}"))).await?;
                    if resp2.status().is_success() {
                        return Ok(resp2);
                    }
                    return Err(RegistryError::Auth(format!(
                        "token 认证失败：HTTP {}",
                        resp2.status()
                    )));
                }
            }
            return Err(RegistryError::Auth(
                "认证失败（HTTP 401）：请检查用户名 / 密码".to_string(),
            ));
        }
        if !resp.status().is_success() {
            return Err(RegistryError::Server(format!("HTTP {}", resp.status())));
        }
        Ok(resp)
    }

    async fn raw_get(
        &self,
        path: &str,
        auth: Option<&str>,
    ) -> Result<reqwest::Response, RegistryError> {
        let url = format!("{}{}", self.url, path);
        let mut req = self.client.get(&url);
        if let Some(a) = auth {
            req = req.header("Authorization", a);
        }
        Ok(req.send().await?)
    }

    /// 解析 `WWW-Authenticate: Bearer realm="...",service="...",scope="..."`，
    /// 向 realm 换取 token（优先带 Basic 凭据，匿名亦可）。
    async fn fetch_token(&self, challenge: &str) -> Result<Option<String>, RegistryError> {
        if !challenge.starts_with("Bearer") && !challenge.starts_with("bearer") {
            return Ok(None);
        }
        let params = parse_challenge(challenge);
        let realm = match params.get("realm") {
            Some(r) => r.clone(),
            None => return Ok(None),
        };
        let mut url = reqwest::Url::parse(&realm).map_err(|e| RegistryError::Server(e.to_string()))?;
        if let Some(service) = params.get("service") {
            url.query_pairs_mut().append_pair("service", service);
        }
        if let Some(scope) = params.get("scope") {
            url.query_pairs_mut().append_pair("scope", scope);
        }
        let mut req = self.client.get(url);
        if let Some(a) = self.basic_auth() {
            req = req.header("Authorization", a);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Ok(None);
        }
        let body: TokenResp = resp.json().await?;
        Ok(body.token)
    }
}

/// 解析 `realm="...",service="..."` 形式的 challenge 参数。
fn parse_challenge(challenge: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    // 去掉开头的 "Bearer"/"Basic" 前缀
    let rest = challenge
        .split_once(' ')
        .map(|(_, r)| r)
        .unwrap_or(challenge);
    for part in rest.split(',') {
        if let Some((k, v)) = part.split_once('=') {
            let k = k.trim().trim_matches('"');
            let v = v.trim().trim_matches('"');
            map.insert(k.to_string(), v.to_string());
        }
    }
    map
}

/// 规范化 registry 地址：缺 scheme 时按 insecure 补 http/https，去掉尾斜杠。
pub fn normalize_url(raw: &str, insecure: bool) -> String {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else if insecure {
        format!("http://{raw}")
    } else {
        format!("https://{raw}")
    };
    with_scheme.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_normalization() {
        assert_eq!(normalize_url("registry.ucloud.cn", false), "https://registry.ucloud.cn");
        assert_eq!(normalize_url("127.0.0.1:5000", true), "http://127.0.0.1:5000");
        assert_eq!(normalize_url("https://hub.docker.com/", false), "https://hub.docker.com");
        assert_eq!(normalize_url("http://x:8080", false), "http://x:8080");
    }

    #[test]
    fn challenge_parsing() {
        let m = parse_challenge(
            "Bearer realm=\"https://auth.docker.io/token\",service=\"registry.docker.io\",scope=\"repository:library/alpine:pull\"",
        );
        assert_eq!(m.get("realm").map(String::as_str), Some("https://auth.docker.io/token"));
        assert_eq!(m.get("service").map(String::as_str), Some("registry.docker.io"));
        assert_eq!(m.get("scope").map(String::as_str), Some("repository:library/alpine:pull"));
    }
}
