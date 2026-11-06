use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri::path::BaseDirectory;
use std::{collections::HashMap, fs, io::{Read, Write}, net::TcpListener, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex, OnceLock}, thread, time::Duration};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize, PtySystem, SlavePty};
use walkdir::WalkDir;
use rusqlite::{params, Connection};
use sysinfo::System;

#[derive(Serialize)]
struct FileEntry { name: String, path: String, is_dir: bool, size: u64 }

fn safe_path(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root = Path::new(root).canonicalize().map_err(|e| format!("Dossier projet invalide: {e}"))?;
    let rel = Path::new(relative);
    if rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("Chemin relatif invalide".into());
    }
    let candidate = root.join(rel);
    // Resolve the closest existing ancestor as well as existing targets. This
    // blocks writes through a symlink that points outside the selected project.
    let mut ancestor = candidate.as_path();
    while fs::symlink_metadata(ancestor).is_err() {
        ancestor = ancestor.parent().ok_or("Chemin invalide")?;
    }
    let resolved_ancestor = ancestor.canonicalize().map_err(|_| "Lien symbolique ou parent invalide".to_string())?;
    if !resolved_ancestor.starts_with(&root) {
        return Err("Accès refusé hors du dossier projet".into());
    }
    if fs::symlink_metadata(&candidate).is_ok() {
        let resolved = candidate.canonicalize().map_err(|_| "Lien symbolique invalide".to_string())?;
        if !resolved.starts_with(&root) { return Err("Accès refusé hors du dossier projet".into()); }
        Ok(resolved)
    } else {
        Ok(candidate)
    }
}

#[tauri::command]
fn list_project_files(root: String) -> Result<Vec<FileEntry>, String> {
    let root_path = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for item in WalkDir::new(&root_path).max_depth(5).follow_links(false).into_iter().filter_map(Result::ok) {
        if item.path() == root_path { continue; }
        let rel = item.path().strip_prefix(&root_path).unwrap_or(item.path());
        if rel.components().any(|c| matches!(c.as_os_str().to_str(), Some("node_modules" | ".git" | "target" | "dist"))) { continue; }
        let meta = item.metadata().map_err(|e| e.to_string())?;
        entries.push(FileEntry { name: item.file_name().to_string_lossy().to_string(), path: rel.to_string_lossy().replace('\\', "/"), is_dir: meta.is_dir(), size: meta.len() });
        if entries.len() >= 4000 { break; }
    }
    Ok(entries)
}

#[tauri::command]
fn read_project_file(root: String, path: String) -> Result<String, String> {
    let file = safe_path(&root, &path)?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 { return Err("Fichier trop volumineux (limite 2 Mo)".into()); }
    fs::read_to_string(file).map_err(|e| format!("Lecture impossible: {e}"))
}

#[tauri::command]
fn write_project_file(root: String, path: String, content: String) -> Result<(), String> {
    if content.len() > 2_000_000 { return Err("Fichier trop volumineux (limite 2 Mo)".into()); }
    let file = safe_path(&root, &path)?;
    if let Some(parent) = file.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(file, content).map_err(|e| format!("Écriture impossible: {e}"))
}

#[tauri::command]
fn create_project_folder(root: String, path: String) -> Result<(), String> {
    let folder = safe_path(&root, &path)?;
    fs::create_dir_all(folder).map_err(|e| e.to_string())
}

#[tauri::command]
fn run_project_command(root: String, program: String, args: Vec<String>) -> Result<String, String> {
    let allowed = ["git", "npm", "npx", "node", "python", "python3", "py", "java", "javac", "mvn", "gradle", "cargo", "rustc", "go", "dotnet", "where"];
    if !allowed.contains(&program.as_str()) { return Err(format!("Commande non autorisée: {program}")); }
    let root_path = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut command;
    #[cfg(windows)]
    {
        if ["npm", "npx", "mvn", "gradle"].contains(&program.as_str()) {
            for arg in &args {
                if arg.chars().any(|c| matches!(c, '&' | '|' | '<' | '>' | '^' | '%' | '!' | '\n' | '\r')) {
                    return Err("Argument refusé : caractères de contrôle shell détectés".into());
                }
            }
            let wrapper = match program.as_str() { "npm" => "npm.cmd", "npx" => "npx.cmd", "mvn" => "mvn.cmd", _ => "gradle.bat" };
            command = Command::new("cmd.exe");
            command.arg("/C").arg(wrapper).args(&args);
        } else {
            command = Command::new(&program);
            command.args(&args);
        }
    }
    #[cfg(not(windows))]
    {
        command = Command::new(&program);
        command.args(&args);
    }
    let output = command.current_dir(root_path).output().map_err(|e| format!("Impossible de lancer {program}: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if text.len() > 100_000 { text.truncate(100_000); text.push_str("\n… sortie tronquée …"); }
    Ok(format!("{}\n{}", if output.status.success() { "[OK]" } else { "[ERREUR]" }, text))
}

struct TerminalSession {
    child: Arc<Mutex<Box<dyn PtyChild + Send + Sync>>>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}
static TERMINAL_SESSIONS: OnceLock<Mutex<HashMap<u32, TerminalSession>>> = OnceLock::new();
fn terminal_sessions() -> &'static Mutex<HashMap<u32, TerminalSession>> { TERMINAL_SESSIONS.get_or_init(|| Mutex::new(HashMap::new())) }

fn stop_all_terminals() {
    let sessions = terminal_sessions().lock().map(|mut sessions| std::mem::take(&mut *sessions)).unwrap_or_default();
    for (pid, session) in sessions {
        #[cfg(windows)] { let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output(); }
        if let Ok(mut child) = session.child.lock() { let _ = child.kill(); let _ = child.wait(); }
    }
}

#[tauri::command]
fn terminal_start(app: AppHandle, root: String) -> Result<u32, String> {
    let root_path = Path::new(&root).canonicalize().map_err(|e| format!("Dossier de terminal invalide: {e}"))?;
    if !root_path.is_dir() { return Err("Le dossier de travail n'est pas un dossier.".into()); }
    let pty_system = native_pty_system();
    let mut pair = pty_system.openpty(PtySize { rows: 28, cols: 110, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Impossible de créer le terminal système: {e}"))?;
    #[cfg(windows)]
    let mut builder = CommandBuilder::new("powershell.exe");
    #[cfg(not(windows))]
    let mut builder = CommandBuilder::new("/bin/bash");
    #[cfg(windows)] builder.args(["-NoLogo", "-NoProfile"]);
    #[cfg(not(windows))] builder.arg("-i");
    builder.cwd(root_path.as_os_str());
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("TERM_PROGRAM", "VertexAI");
    let child = pair.slave.spawn_command(builder).map_err(|e| format!("Impossible de démarrer le shell: {e}"))?;
    let pid = child.process_id().ok_or("Impossible de récupérer le PID du terminal")?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Lecture du terminal impossible: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("Écriture du terminal impossible: {e}"))?;
    let master = pair.master;
    let child = Arc::new(Mutex::new(child));
    terminal_sessions().lock().map_err(|_| "Registre du terminal indisponible")?.insert(pid, TerminalSession { child: child.clone(), writer, master });

    let output_app = app.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop { match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => { let text = String::from_utf8_lossy(&buffer[..size]).to_string(); let _ = output_app.emit("vertex-terminal-output", serde_json::json!({"pid":pid,"text":text})); }
        }}
    });
    let monitor_app = app.clone();
    let monitor_child = child.clone();
    thread::spawn(move || loop {
        let status = match monitor_child.lock() { Ok(mut child) => child.try_wait(), Err(_) => break };
        match status {
            Ok(Some(status)) => {
                if let Ok(mut sessions) = terminal_sessions().lock() { sessions.remove(&pid); }
                let code = status.exit_code();
                let _ = monitor_app.emit("vertex-terminal-exit", serde_json::json!({"pid":pid,"code":code,"success":code == 0}));
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(350)),
            Err(error) => { let _ = monitor_app.emit("vertex-terminal-output", serde_json::json!({"pid":pid,"text":format!("\\r\\nErreur de surveillance du terminal: {error}\\r\\n")})); break; }
        }
    });
    let _ = app.emit("vertex-terminal-started", serde_json::json!({"pid":pid,"cwd":root}));
    Ok(pid)
}

#[tauri::command]
fn terminal_write(pid: u32, input: String) -> Result<(), String> {
    if input.len() > 32_000 { return Err("Entrée du terminal trop longue.".into()); }
    let mut sessions = terminal_sessions().lock().map_err(|_| "Registre du terminal indisponible")?;
    let session = sessions.get_mut(&pid).ok_or("Session de terminal introuvable ou terminée")?;
    session.writer.write_all(input.as_bytes()).map_err(|e| format!("Écriture dans le terminal impossible: {e}"))?;
    session.writer.flush().map_err(|e| format!("Envoi au terminal impossible: {e}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(pid: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = terminal_sessions().lock().map_err(|_| "Registre du terminal indisponible")?;
    let session = sessions.get(&pid).ok_or("Session de terminal introuvable")?;
    session.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Redimensionnement du terminal impossible: {e}"))
}

#[tauri::command]
fn terminal_kill(pid: u32) -> Result<(), String> {
    let session = terminal_sessions().lock().map_err(|_| "Registre du terminal indisponible")?.remove(&pid).ok_or("Session de terminal introuvable")?;
    #[cfg(windows)] { let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output(); }
    let mut child = session.child.lock().map_err(|_| "Processus du terminal indisponible")?;
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
async fn ollama_health(base_url: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/version", base_url.trim_end_matches('/'));
    reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(4)).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_local_models(base_url: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_delete_model(base_url: String, model: String) -> Result<(), String> {
    let url = format!("{}/api/delete", base_url.trim_end_matches('/'));
    reqwest::Client::new().delete(url).json(&serde_json::json!({"model": model})).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn search_ollama_library(query: String, page: u32) -> Result<String, String> {
    let url = format!("https://ollama.com/search?q={}&p={}", urlencoding::encode(&query), page);
    reqwest::Client::new().get(url).header("User-Agent", "VertexAI-Desktop/2.6").timeout(std::time::Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())
}


#[tauri::command]
async fn ollama_chat(app: AppHandle, base_url: String, model: String, messages: Vec<serde_json::Value>, options: Option<serde_json::Value>) -> Result<(), String> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({"model": model, "messages": messages, "stream": true, "keep_alive": "5m"});
    if let Some(opts) = options { body["options"] = opts; }
    let mut response = reqwest::Client::new().post(url).json(&body).timeout(std::time::Duration::from_secs(3600)).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) {
                if let Some(content) = value.get("message").and_then(|m| m.get("content")).and_then(|v| v.as_str()) {
                    let _ = app.emit("ollama-chat-token", content.to_string());
                }
                if value.get("done").and_then(|v| v.as_bool()) == Some(true) {
                    let _ = app.emit("ollama-chat-done", &value);
                }
                if let Some(error) = value.get("error").and_then(|v| v.as_str()) { return Err(error.to_string()); }
            }
        }
    }
    if !buffer.is_empty() { if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buffer) { if let Some(content) = value.get("message").and_then(|m| m.get("content")).and_then(|v| v.as_str()) { let _ = app.emit("ollama-chat-token", content.to_string()); } } }
    let _ = app.emit("ollama-chat-finished", true);
    Ok(())
}

#[tauri::command]
async fn ollama_pull(app: AppHandle, base_url: String, model: String) -> Result<(), String> {
    let health_url = format!("{}/api/version", base_url.trim_end_matches('/'));
    reqwest::Client::new().get(&health_url).timeout(std::time::Duration::from_secs(5)).send().await
        .map_err(|e| format!("Vertex Local Engine inaccessible sur {base_url}. Démarre le moteur puis réessaie : {e}"))?
        .error_for_status().map_err(|e| format!("L'API Ollama ne répond pas correctement sur {base_url} : {e}"))?;
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let mut response = reqwest::Client::new().post(url).json(&serde_json::json!({"model": model, "stream": true})).timeout(std::time::Duration::from_secs(7200)).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) {
                let _ = app.emit("ollama-pull-progress", value.clone());
                if let Some(error) = value.get("error").and_then(|v| v.as_str()) { return Err(error.to_string()); }
            }
        }
    }
    let _ = app.emit("ollama-pull-complete", model);
    Ok(())
}

const VERTEX_OLLAMA_HOST: &str = "127.0.0.1:11435";
const OLLAMA_WINDOWS_URL: &str = "https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip";
const OLLAMA_WINDOWS_ROCM_URL: &str = "https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64-rocm.zip";
static OLLAMA_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

static TERMINAL_PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
fn child_slot() -> &'static Mutex<Option<Child>> { OLLAMA_CHILD.get_or_init(|| Mutex::new(None)) }

fn stop_embedded_ollama() {
    if let Ok(mut slot) = child_slot().lock() {
        if let Some(mut child) = slot.take() { let _ = child.kill(); let _ = child.wait(); }
    }
}

fn runtime_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("runtime").join("ollama");
    fs::create_dir_all(&dir).map_err(|e| format!("Création du dossier runtime impossible: {e}"))?;
    Ok(dir)
}

fn models_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("Création du dossier modèles impossible: {e}"))?;
    Ok(dir)
}

fn bundled_resource(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().resolve(format!("resources/{name}"), BaseDirectory::Resource).ok()
}

async fn download_runtime_archive(app: &AppHandle, url: &str, target: &Path, label: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let client = reqwest::Client::builder().user_agent("VertexAI-Desktop/2.9.0 (embedded-runtime)").timeout(std::time::Duration::from_secs(3600)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|e| format!("Téléchargement du moteur impossible: {e}"))?.error_for_status().map_err(|e| format!("Téléchargement du moteur refusé: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let temp = target.with_extension("zip.download");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    let mut received = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        let _ = app.emit("vertex-runtime-progress", serde_json::json!({"phase":"download","label":label,"received":received,"total":total,"percent":if total>0 {(received as f64/total as f64*100.0).round() as u32} else {0}}));
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if received < 1_000_000 { let _ = fs::remove_file(&temp); return Err("L'archive du moteur téléchargée semble invalide (taille insuffisante).".into()); }
    let _ = fs::remove_file(target);
    fs::rename(&temp, target).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_runtime_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Archive moteur introuvable: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Archive moteur illisible: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative) = entry.enclosed_name().map(|p| p.to_path_buf()) else { continue; };
        let output = destination.join(relative);
        if entry.is_dir() { fs::create_dir_all(&output).map_err(|e| e.to_string())?; continue; }
        if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let mut out = fs::File::create(&output).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn find_ollama_executable(directory: &Path) -> Option<PathBuf> {
    WalkDir::new(directory).max_depth(5).follow_links(false).into_iter().filter_map(Result::ok)
        .find(|entry| entry.file_type().is_file() && entry.file_name().to_string_lossy().eq_ignore_ascii_case("ollama.exe"))
        .map(|entry| entry.path().to_path_buf())
}

fn amd_gpu_present() -> bool {
    #[cfg(windows)] {
        return Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ';'"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("amd") || String::from_utf8_lossy(&o.stdout).to_lowercase().contains("radeon")).unwrap_or(false);
    }
    #[cfg(not(windows))] { false }
}

async fn provision_embedded_runtime(app: &AppHandle, force_download: bool) -> Result<PathBuf, String> {
    let runtime = runtime_directory(app)?;
    if !force_download { if let Some(exe) = find_ollama_executable(&runtime) { return Ok(exe); } }
    let _ = app.emit("vertex-runtime-progress", serde_json::json!({"phase":"prepare","label":"Préparation du moteur IA local"}));
    if force_download { let _ = fs::remove_dir_all(&runtime); fs::create_dir_all(&runtime).map_err(|e| e.to_string())?; }
    let base_archive = runtime.join("ollama-windows-amd64.zip");
    let mut bundled = false;
    if !force_download {
        if let Some(source) = bundled_resource(app, "ollama-windows-amd64.zip") {
            if source.is_file() { fs::copy(source, &base_archive).map_err(|e| format!("Copie du moteur embarqué impossible: {e}"))?; bundled = true; }
        }
    }
    if !bundled { download_runtime_archive(app, OLLAMA_WINDOWS_URL, &base_archive, "Moteur Ollama x64").await?; }
    let _ = app.emit("vertex-runtime-progress", serde_json::json!({"phase":"extract","label":"Installation du moteur local"}));
    extract_runtime_archive(&base_archive, &runtime)?;
    let _ = fs::remove_file(&base_archive);

    if amd_gpu_present() {
        let rocm_archive = runtime.join("ollama-windows-amd64-rocm.zip");
        let mut rocm_bundled = false;
        if !force_download {
            if let Some(source) = bundled_resource(app, "ollama-windows-amd64-rocm.zip") {
                if source.is_file() { fs::copy(source, &rocm_archive).map_err(|e| e.to_string())?; rocm_bundled = true; }
            }
        }
        if !rocm_bundled { download_runtime_archive(app, OLLAMA_WINDOWS_ROCM_URL, &rocm_archive, "Accélération AMD ROCm").await?; }
        extract_runtime_archive(&rocm_archive, &runtime)?;
        let _ = fs::remove_file(&rocm_archive);
    }
    find_ollama_executable(&runtime).ok_or_else(|| "Le moteur a été extrait, mais ollama.exe est introuvable dans l'archive officielle.".into())
}

async fn embedded_ollama_ready(timeout: Duration) -> bool {
    let client = match reqwest::Client::builder().connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(3)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    let url = format!("http://{}/api/version", VERTEX_OLLAMA_HOST);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Ok(response) = client.get(&url).send().await {
            if let Ok(response) = response.error_for_status() {
                if response.json::<serde_json::Value>().await.is_ok() { return true; }
            }
        }
        if std::time::Instant::now() >= deadline { return false; }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
}

async fn start_embedded_ollama(app: &AppHandle, force_download: bool) -> Result<String, String> {
    #[cfg(not(windows))] { let _ = app; let _ = force_download; return Err("Cette version All-in-One est actuellement prévue pour Windows x64.".into()); }
    #[cfg(windows)] {
        if force_download {
            stop_embedded_ollama();
        } else {
            let child_running = {
                let mut slot = child_slot().lock().map_err(|_| "Registre du moteur local indisponible")?;
                let state = match slot.as_mut() {
                    Some(child) => Some(child.try_wait().map_err(|e| format!("Impossible de vérifier le processus Ollama : {e}"))?),
                    None => None,
                };
                match state {
                    Some(None) => true,
                    Some(Some(_)) => { *slot = None; false },
                    None => false,
                }
            };
            if child_running {
                if embedded_ollama_ready(Duration::from_secs(18)).await {
                    return Ok("Vertex Local Engine est actif et son API répond correctement.".into());
                }
                stop_embedded_ollama();
            }
        }

        let executable = provision_embedded_runtime(app, force_download).await?;
        let listener = match TcpListener::bind(VERTEX_OLLAMA_HOST) {
            Ok(listener) => listener,
            Err(_) => {
                if embedded_ollama_ready(Duration::from_secs(4)).await {
                    return Ok("Un moteur Ollama répond déjà sur le port local configuré. Vertex AI peut l'utiliser.".into());
                }
                return Err("Le port local 11435 est occupé, mais aucun moteur Ollama ne répond dessus. Ferme le processus qui utilise ce port puis réessaie.".into());
            }
        };
        drop(listener);

        let models = models_directory(app)?;
        let mut command = Command::new(&executable);
        command.arg("serve").env("OLLAMA_HOST", VERTEX_OLLAMA_HOST).env("OLLAMA_MODELS", models)
            .env("OLLAMA_KEEP_ALIVE", "5m").env("OLLAMA_ORIGINS", "tauri://localhost,http://tauri.localhost")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let child = command.spawn().map_err(|e| format!("Impossible de démarrer le moteur Vertex Local ({}): {e}", executable.display()))?;
        if let Ok(mut slot) = child_slot().lock() { *slot = Some(child); }

        if !embedded_ollama_ready(Duration::from_secs(45)).await {
            stop_embedded_ollama();
            return Err("Ollama a été lancé, mais son API n'a pas répondu après 45 secondes. Vérifie l'espace disque et les droits du dossier LocalAppData, puis utilise Réparer le moteur.".into());
        }
        let _ = app.emit("vertex-runtime-progress", serde_json::json!({"phase":"started","label":"Vertex Local Engine démarré et vérifié"}));
        Ok("Vertex Local Engine est démarré et son API est prête. Les modèles peuvent être téléchargés.".into())
    }
}

#[tauri::command]
async fn ollama_start(app: AppHandle) -> Result<String, String> { start_embedded_ollama(&app, false).await }

#[tauri::command]
async fn ollama_runtime_update(app: AppHandle) -> Result<String, String> {
    let result = start_embedded_ollama(&app, true).await?;
    Ok(format!("Moteur autonome réinstallé depuis la dernière version officielle. {result}"))
}


fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vertex-ai.sqlite3"))
}
fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, last_opened INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS file_snapshots(id TEXT PRIMARY KEY, project_root TEXT NOT NULL, relative_path TEXT NOT NULL, existed INTEGER NOT NULL, content TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON file_snapshots(project_root, created_at DESC);") .map_err(|e| e.to_string())?;
    Ok(conn)
}
#[tauri::command]
fn db_save_conversation(app: AppHandle, conversation: serde_json::Value) -> Result<(), String> {
    let id = conversation.get("id").and_then(|v| v.as_str()).ok_or("ID de conversation absent")?;
    let title = conversation.get("title").and_then(|v| v.as_str()).unwrap_or("Conversation");
    let model = conversation.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let updated = conversation.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
    open_db(&app)?.execute("INSERT INTO conversations(id,title,model,updated_at,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET title=excluded.title,model=excluded.model,updated_at=excluded.updated_at,payload=excluded.payload", params![id,title,model,updated,conversation.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn db_load_conversations(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_db(&app)?; let mut stmt = conn.prepare("SELECT payload FROM conversations ORDER BY updated_at DESC LIMIT 500").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let mut out = Vec::new(); for row in rows { let raw = row.map_err(|e| e.to_string())?; out.push(serde_json::from_str(&raw).map_err(|e| e.to_string())?); } Ok(out)
}
#[tauri::command]
fn db_delete_conversations(app: AppHandle) -> Result<(), String> { open_db(&app)?.execute("DELETE FROM conversations", []).map_err(|e| e.to_string())?; Ok(()) }
#[tauri::command]
fn db_save_project(app: AppHandle, path: String) -> Result<(), String> {
    let canonical = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    let value = canonical.to_string_lossy().to_string(); let name = canonical.file_name().unwrap_or_default().to_string_lossy().to_string();
    open_db(&app)?.execute("INSERT INTO projects(path,name,last_opened) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET name=excluded.name,last_opened=excluded.last_opened", params![value,name,chrono_millis()]).map_err(|e| e.to_string())?; Ok(())
}
fn chrono_millis() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
#[tauri::command]
fn db_load_projects(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_db(&app)?; let mut stmt=conn.prepare("SELECT path,name,last_opened FROM projects ORDER BY last_opened DESC LIMIT 100").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok(serde_json::json!({"path":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"lastOpened":r.get::<_,i64>(2)?}))).map_err(|e|e.to_string())?;
    let mut out=Vec::new(); for r in rows {out.push(r.map_err(|e|e.to_string())?);} Ok(out)
}
#[tauri::command]
fn db_snapshot_file(app: AppHandle, root: String, path: String) -> Result<String, String> {
    let file = safe_path(&root, &path)?; let existed=file.exists(); let content=if existed {Some(fs::read_to_string(&file).map_err(|e|e.to_string())?)} else {None};
    let id=format!("{}-{}",chrono_millis(),std::process::id());
    let conn=open_db(&app)?; conn.execute("INSERT INTO file_snapshots(id,project_root,relative_path,existed,content,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![id,root,path,existed as i32,content,chrono_millis()]).map_err(|e|e.to_string())?; conn.execute("DELETE FROM file_snapshots WHERE id IN (SELECT id FROM file_snapshots WHERE project_root=?1 ORDER BY created_at DESC LIMIT -1 OFFSET 500)",params![root]).map_err(|e|e.to_string())?; Ok(id)
}
#[tauri::command]
fn db_list_snapshots(app: AppHandle, root: String) -> Result<Vec<serde_json::Value>, String> {
    let conn=open_db(&app)?; let mut stmt=conn.prepare("SELECT id,relative_path,existed,created_at FROM file_snapshots WHERE project_root=?1 ORDER BY created_at DESC LIMIT 200").map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![root],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"path":r.get::<_,String>(1)?,"existed":r.get::<_,i32>(2)?!=0,"createdAt":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?;
    let mut out=Vec::new();for r in rows{out.push(r.map_err(|e|e.to_string())?);}Ok(out)
}
#[tauri::command]
fn db_restore_snapshot(app: AppHandle, id: String) -> Result<(), String> {
    let conn=open_db(&app)?; let (root,path,existed,content):(String,String,i32,Option<String>)=conn.query_row("SELECT project_root,relative_path,existed,content FROM file_snapshots WHERE id=?1",params![id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e|e.to_string())?;
    let file=safe_path(&root,&path)?; if existed!=0 { if let Some(parent)=file.parent(){fs::create_dir_all(parent).map_err(|e|e.to_string())?;} fs::write(file,content.unwrap_or_default()).map_err(|e|e.to_string())?; } else if file.exists(){fs::remove_file(file).map_err(|e|e.to_string())?;} Ok(())
}
#[tauri::command]
fn system_hardware_info() -> Result<serde_json::Value, String> {
    let mut sys=System::new_all(); sys.refresh_all();
    let mut gpu=Vec::<String>::new();
    #[cfg(windows)] { if let Ok(out)=Command::new("powershell").args(["-NoProfile","-Command","Get-CimInstance Win32_VideoController | ForEach-Object { $vram = [math]::Round($_.AdapterRAM / 1GB, 2); \"$($_.Name) | ${vram} GB VRAM\" }"]).output(){ for line in String::from_utf8_lossy(&out.stdout).lines(){let p:Vec<&str>=line.split('|').collect();if !p.is_empty(){gpu.push(line.to_string());}} } }
    #[cfg(target_os="linux")] { if let Ok(out)=Command::new("sh").args(["-lc","(command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) || lspci 2>/dev/null | grep -Ei 'vga|3d'"]).output(){gpu=String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect();} }
    #[cfg(target_os="macos")] { if let Ok(out)=Command::new("system_profiler").arg("SPDisplaysDataType").output(){gpu=String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l|l.contains("Chipset Model")||l.contains("VRAM")||l.contains("Total Number of Cores")).map(str::to_string).collect();} }
    Ok(serde_json::json!({"os":System::long_os_version().unwrap_or_else(||std::env::consts::OS.into()),"host":System::host_name().unwrap_or_default(),"cpuName":sys.cpus().first().map(|c|c.brand().to_string()).unwrap_or_default(),"cpuCores":sys.cpus().len(),"cpuUsage":sys.global_cpu_usage(),"ramTotal":sys.total_memory(),"ramUsed":sys.used_memory(),"gpus":gpu}))
}
#[tauri::command]
async fn search_ollama_tags(model:String)->Result<String,String>{
    if model.contains("..") || model.contains('/') || model.contains('\\'){return Err("Nom de modèle invalide".into());}
    reqwest::Client::new().get(format!("https://ollama.com/library/{}/tags",urlencoding::encode(&model))).header("User-Agent","VertexAI-Desktop/2.9").timeout(std::time::Duration::from_secs(15)).send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.text().await.map_err(|e|e.to_string())
}

#[tauri::command]
async fn ollama_show_model(base_url:String, model:String)->Result<serde_json::Value,String>{
    reqwest::Client::new().post(format!("{}/api/show",base_url.trim_end_matches('/'))).json(&serde_json::json!({"model":model,"verbose":true})).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())
}
#[tauri::command]
async fn ollama_running_models(base_url:String)->Result<serde_json::Value,String>{
    reqwest::Client::new().get(format!("{}/api/ps",base_url.trim_end_matches('/'))).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| { let handle=app.handle().clone(); let _=open_db(&handle); Ok(()) })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![list_project_files, read_project_file, write_project_file, create_project_folder, run_project_command, terminal_start, terminal_write, terminal_resize, terminal_kill, ollama_health, ollama_local_models, ollama_delete_model, search_ollama_library, ollama_chat, ollama_pull, ollama_start, ollama_runtime_update, db_save_conversation, db_load_conversations, db_delete_conversations, db_save_project, db_load_projects, db_snapshot_file, db_list_snapshots, db_restore_snapshot, system_hardware_info, ollama_show_model, ollama_running_models, search_ollama_tags])
        .build(tauri::generate_context!())
        .expect("Erreur au lancement de Vertex AI")
        .run(|_app_handle, event| { if matches!(event, RunEvent::Exit) { stop_all_terminals(); stop_embedded_ollama(); } });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_path_rejects_parent_traversal() {
        let root = std::env::temp_dir().join(format!("vertex-ai-safe-path-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(safe_path(root.to_str().unwrap(), "../outside.txt").is_err());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn safe_path_accepts_project_relative_file() {
        let root = std::env::temp_dir().join(format!("vertex-ai-safe-path-ok-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(safe_path(root.to_str().unwrap(), "src/main.rs").is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
