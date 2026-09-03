//! DevDeck MCP Server
//!
//! 独立 stdio MCP Server：让 Claude Code / Cursor 等 AI 通过 MCP 连接 DevDeck
//! 的内置 Docker 引擎（连 / 执行 / 看日志 / 看镜像）。
//!
//! 用法（开发）：
//!   cargo run --bin devdeck-mcp
//!   或设置 DEVDeck_DOCKER_SOCKET 指向其它引擎 socket。
//!
//! 在 Claude Code 中接入：
//!   claude mcp add devdeck -- bash -lc 'DEVDeck_DOCKER_SOCKET=$HOME/.lima/devdeck/sock/docker.sock <devdeck-mcp 可执行路径>'
//! 在 Cursor 中接入：
//!   Settings → MCP → Add：Command = devdeck-mcp 可执行路径
use std::io::{BufRead, Write};
use std::path::Path;

use bollard::container::{ListContainersOptions, LogOutput, LogsOptions, RestartContainerOptions, StartContainerOptions, StopContainerOptions};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::image::ListImagesOptions;
use bollard::network::ListNetworksOptions;
use bollard::volume::ListVolumesOptions;
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde_json::{json, Value};

const SERVER_NAME: &str = "devdeck-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let socket = std::env::var("DEVDeck_DOCKER_SOCKET").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        format!("{home}/.lima/devdeck/sock/docker.sock")
    });
    let docker = if Path::new(&socket).exists() {
        Docker::connect_with_local(&socket, 9600, API_DEFAULT_VERSION)?
    } else {
        Docker::connect_with_local_defaults()?
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = serde_json::from_str(&line)?;
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = msg.get("id").cloned();
        match method {
            "initialize" => {
                respond(
                    &mut stdout,
                    &id,
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
                    }),
                )?;
            }
            "notifications/initialized" | "initialized" | "notifications/cancelled" => {}
            "ping" => respond(&mut stdout, &id, json!({}))?,
            "tools/list" => respond(&mut stdout, &id, json!({ "tools": tools() }))?,
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                let args = msg
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let result = handle_tool(&docker, name, &args).await;
                match result {
                    Ok(text) => respond(
                        &mut stdout,
                        &id,
                        json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                    )?,
                    Err(e) => respond(
                        &mut stdout,
                        &id,
                        json!({ "content": [{ "type": "text", "text": format!("错误: {e}") }], "isError": true }),
                    )?,
                }
            }
            _ => {
                if let Some(id) = id {
                    respond(
                        &mut stdout,
                        &Some(id),
                        json!({ "error": { "code": -32601, "message": "method not found" } }),
                    )?;
                }
            }
        }
        stdout.flush()?;
    }
    Ok(())
}

fn respond(out: &mut std::io::Stdout, id: &Option<Value>, result: Value) -> std::io::Result<()> {
    let payload = match id {
        Some(id) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        None => json!({ "jsonrpc": "2.0", "id": null, "result": result }),
    };
    writeln!(out, "{}", payload)?;
    out.flush()
}

fn tools() -> Value {
    let tools = [
        json!({
            "name": "docker_list_containers",
            "description": "列出本地 Docker 引擎的容器（含已停止），返回 JSON 数组",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "docker_list_images",
            "description": "列出本地 Docker 引擎的镜像",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "docker_start_container",
            "description": "启动一个容器",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "容器名或 ID" } }, "required": ["name"], "additionalProperties": false }
        }),
        json!({
            "name": "docker_stop_container",
            "description": "停止一个容器",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "容器名或 ID" } }, "required": ["name"], "additionalProperties": false }
        }),
        json!({
            "name": "docker_restart_container",
            "description": "重启一个容器",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "容器名或 ID" } }, "required": ["name"], "additionalProperties": false }
        }),
        json!({
            "name": "docker_logs",
            "description": "获取容器日志",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "容器名或 ID" },
                "tail": { "type": "integer", "description": "返回末尾行数，默认 200" }
            }, "required": ["name"], "additionalProperties": false }
        }),
        json!({
            "name": "docker_exec",
            "description": "在容器内执行命令，返回 stdout/stderr",
            "inputSchema": { "type": "object", "properties": {
                "container": { "type": "string", "description": "容器名或 ID" },
                "command": { "type": "string", "description": "要执行的命令，如 'ls -la /app'" }
            }, "required": ["container", "command"], "additionalProperties": false }
        }),
        json!({
            "name": "docker_inspect",
            "description": "查看容器详细信息（JSON）",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "容器名或 ID" } }, "required": ["name"], "additionalProperties": false }
        }),
        json!({
            "name": "docker_list_volumes",
            "description": "列出本地 Docker 引擎的命名卷",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "docker_list_networks",
            "description": "列出本地 Docker 引擎的网络",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
    ];
    Value::Array(tools.to_vec())
}

async fn handle_tool(
    docker: &Docker,
    name: &str,
    args: &Value,
) -> Result<String, Box<dyn std::error::Error>> {
    let arg_str = |k: &str| -> String {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    match name {
        "docker_list_containers" => {
            let list = docker
                .list_containers(Some(ListContainersOptions::<String> {
                    all: true,
                    ..Default::default()
                }))
                .await?;
            Ok(serde_json::to_string_pretty(&list)?)
        }
        "docker_list_images" => {
            let list = docker.list_images(Some(ListImagesOptions::<String>::default())).await?;
            Ok(serde_json::to_string_pretty(&list)?)
        }
        "docker_start_container" => {
            docker
                .start_container(&arg_str("name"), None::<StartContainerOptions<String>>)
                .await?;
            Ok(format!("已启动容器 {}", arg_str("name")))
        }
        "docker_stop_container" => {
            docker
                .stop_container(&arg_str("name"), None::<StopContainerOptions>)
                .await?;
            Ok(format!("已停止容器 {}", arg_str("name")))
        }
        "docker_restart_container" => {
            docker
                .restart_container(&arg_str("name"), None::<RestartContainerOptions>)
                .await?;
            Ok(format!("已重启容器 {}", arg_str("name")))
        }
        "docker_logs" => {
            let tail = args
                .get("tail")
                .and_then(|v| v.as_i64())
                .unwrap_or(200)
                .max(1);
            let opts = LogsOptions::<String> {
                stdout: true,
                stderr: true,
                tail: tail.to_string(),
                ..Default::default()
            };
            let mut stream = docker.logs(&arg_str("name"), Some(opts));
            let mut out = String::new();
            while let Some(chunk) = stream.next().await {
                match chunk? {
                    LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                        out.push_str(&String::from_utf8_lossy(&message));
                    }
                    _ => {}
                }
            }
            Ok(out)
        }
        "docker_exec" => {
            let container = arg_str("container");
            let command = arg_str("command");
            let cmd: Vec<&str> = command.split_whitespace().collect();
            if cmd.is_empty() {
                return Err("command 不能为空".into());
            }
            let exec = docker
                .create_exec(
                    &container,
                    CreateExecOptions {
                        attach_stdout: Some(true),
                        attach_stderr: Some(true),
                        cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
                        ..Default::default()
                    },
                )
                .await?;
            let output = docker.start_exec(&exec.id, None).await?;
            match output {
                StartExecResults::Attached { mut output, .. } => {
                    let mut out = String::new();
                    while let Some(chunk) = output.next().await {
                        match chunk? {
                            LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                                out.push_str(&String::from_utf8_lossy(&message));
                            }
                            _ => {}
                        }
                    }
                    Ok(out)
                }
                StartExecResults::Detached => Ok("命令已在后台执行".to_string()),
            }
        }
        "docker_inspect" => {
            let info = docker.inspect_container(&arg_str("name"), None).await?;
            Ok(serde_json::to_string_pretty(&info)?)
        }
        "docker_list_volumes" => {
            let list = docker.list_volumes(Some(ListVolumesOptions::<String>::default())).await?;
            Ok(serde_json::to_string_pretty(&list)?)
        }
        "docker_list_networks" => {
            let list = docker.list_networks(Some(ListNetworksOptions::<String>::default())).await?;
            Ok(serde_json::to_string_pretty(&list)?)
        }
        _ => Err(format!("未知工具: {name}").into()),
    }
}
