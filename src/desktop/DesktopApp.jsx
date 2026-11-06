import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import CodeMirror from '@uiw/react-codemirror';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { oneDark } from '@codemirror/theme-one-dark';
import Markdown from '../components/Markdown';
import Icon from '../components/Icon';
import { DEFAULT_OLLAMA_URL, getOllamaStatus, waitForOllama, listLocalModels, pullModel, chatWithOllama, searchLibrary, extractModelTags, desktopInvoke, formatBytes } from './ollama';
import { parseAgentPlan, isSafeProjectRelativePath } from './agentProtocol';
import { languageExtension, detectLanguage } from './languages';

const NAV = [
  ['chat', 'Chat', 'message'], ['models', 'Model Hub', 'box'], ['workspace', 'Code Workspace', 'code'],
  ['projects', 'Projects', 'folder'], ['agents', 'AI Agents', 'spark'], ['runtime', 'Runtime', 'activity'], ['settings', 'Settings', 'settings'],
];
const STORAGE_KEY = 'vertex-ai-desktop-v1';
const SYSTEM_PROMPT = "Tu es VERTEX AI, un assistant local utile, rigoureux et professionnel. Réponds en français sauf demande contraire. Tu peux analyser le projet ouvert et proposer des modifications. N'affirme jamais avoir modifié un fichier ou exécuté une commande si cela n'a pas été fait par un outil explicite.";
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
const parseCommand = raw => { const parts = raw.match(/(?:[^\s\"']+|\"[^\"]*\"|'[^']*')+/g) || []; return { program: parts.shift()?.replace(/^['\"]|['\"]$/g, ''), args: parts.map(x => x.replace(/^['\"]|['\"]$/g, '')) }; };

function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } }
function saveState(value) { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); }

export default function DesktopApp() {
  const initial = useMemo(loadState, []);
  const [page, setPage] = useState('chat');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl && initial.baseUrl !== 'http://127.0.0.1:11434' ? initial.baseUrl : DEFAULT_OLLAMA_URL);
  const [status, setStatus] = useState({ online: false, error: '' });
  const [models, setModels] = useState([]);
  const [runningModels, setRunningModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(initial.selectedModel || '');
  const [catalog, setCatalog] = useState([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogSort, setCatalogSort] = useState('relevance');
  const [catalogTab, setCatalogTab] = useState('catalog');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogHasMore, setCatalogHasMore] = useState(true);
  const [pulling, setPulling] = useState({});
  const [conversations, setConversations] = useState(initial.conversations || []);
  const [activeId, setActiveId] = useState(initial.activeId || null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectRoot, setProjectRoot] = useState(initial.projectRoot || '');
  const [files, setFiles] = useState([]);
  const [activeFile, setActiveFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [terminalPid, setTerminalPid] = useState(null);
  const [explorerQuery, setExplorerQuery] = useState('');
  const [openTabs, setOpenTabs] = useState([]);
  const [tabBuffers, setTabBuffers] = useState({});
  const [dirtyTabs, setDirtyTabs] = useState([]);
  const terminalMountRef = useRef(null);
  const terminalInstanceRef = useRef(null);
  const terminalPidRef = useRef(null);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentLog, setAgentLog] = useState([]);
  const [toast, setToast] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const [settingsTab, setSettingsTab] = useState('general');
  const [systemInfo, setSystemInfo] = useState({});
  const [runtimeProgress, setRuntimeProgress] = useState(null);
  const [projectHistory, setProjectHistory] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [modelDetails, setModelDetails] = useState(null);
  const [modelDetailsName, setModelDetailsName] = useState('');
  const [modelTags, setModelTags] = useState([]);
  const [selectedTag, setSelectedTag] = useState({});
  const [tagsByModel, setTagsByModel] = useState({});
  const [agentRunning, setAgentRunning] = useState(false);
  const bottomRef = useRef(null);
  const abortRef = useRef(false);
  const runtimeCheckRef = useRef(0);
  const activeConversation = conversations.find(c => c.id === activeId) || null;

  useEffect(() => { saveState({ baseUrl, selectedModel, activeId, projectRoot }); }, [baseUrl, selectedModel, activeId, projectRoot]);
  useEffect(() => { let alive = true; (async () => { try { const saved = await desktopInvoke('db_load_conversations'); if (alive && saved?.length) setConversations(saved); const projects = await desktopInvoke('db_load_projects'); if (alive) setProjectHistory(projects || []); } catch (e) { console.warn('SQLite indisponible', e); } })(); return () => { alive = false; }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => { conversations.forEach(c => { void desktopInvoke('db_save_conversation', { conversation: c }).catch(() => {}); }); }, 700); return () => window.clearTimeout(timer); }, [conversations]);
  useEffect(() => { if (projectRoot) void desktopInvoke('db_list_snapshots', { root: projectRoot }).then(setSnapshots).catch(() => {}); }, [projectRoot]);
  useEffect(() => { void desktopInvoke('system_hardware_info').then(setSystemInfo).catch(() => {}); }, []);
  useEffect(() => { let unlisten; listen('vertex-runtime-progress', event => setRuntimeProgress(event.payload)).then(fn => { unlisten = fn; }).catch(() => {}); return () => unlisten?.(); }, []);
  useEffect(() => { let offOutput, offExit, offStarted; listen('vertex-terminal-output', event => { const item = event.payload; if (!terminalPidRef.current || item.pid === terminalPidRef.current) { terminalInstanceRef.current?.write(item.text); } }).then(fn => { offOutput = fn; }).catch(() => {}); listen('vertex-terminal-exit', event => { const item = event.payload; if (!terminalPidRef.current || item.pid === terminalPidRef.current) { terminalInstanceRef.current?.writeln(`\r\n[Processus terminé · code ${item.code ?? 'inconnu'}]`); terminalPidRef.current = null; setTerminalPid(null); } }).then(fn => { offExit = fn; }).catch(() => {}); listen('vertex-terminal-started', event => { terminalPidRef.current = event.payload.pid; setTerminalPid(event.payload.pid); }).then(fn => { offStarted = fn; }).catch(() => {}); return () => { offOutput?.(); offExit?.(); offStarted?.(); }; }, []);
  useEffect(() => { let alive = true; (async () => { const first = await getOllamaStatus(baseUrl); if (!first.online && baseUrl.replace(/\/+$/, '') === DEFAULT_OLLAMA_URL) { try { notify('Préparation du moteur IA intégré…'); await desktopInvoke('ollama_start'); await waitForOllama(DEFAULT_OLLAMA_URL, 45000); } catch (e) { notify(`Moteur local indisponible : ${String(e)}`); } } if (alive) await refreshRuntime(); })(); const timer = window.setInterval(() => void refreshRuntime(), 10000); return () => { alive = false; clearInterval(timer); }; }, [baseUrl]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeConversation?.messages?.length, activeConversation?.messages?.at(-1)?.content]);
  useEffect(() => {
    if (page !== 'workspace' || !projectRoot || !terminalMountRef.current) return;
    let disposed = false;
    let pid = null;
    const terminal = new XTerm({ cursorBlink: true, convertEol: true, scrollback: 8000, fontSize: 12, fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', theme: { background: '#080d14', foreground: '#d5e2f0', cursor: '#70b7ff', selectionBackground: '#24466a', black: '#101722', red: '#ef8178', green: '#78d6a8', yellow: '#e6c17a', blue: '#79b8ff', magenta: '#c59bff', cyan: '#75d8df', white: '#d5e2f0' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(terminalMountRef.current); fit.fit();
    terminal.writeln('Vertex AI · terminal intégré'); terminal.writeln(`Projet : ${projectRoot}`);
    terminalInstanceRef.current = terminal;
    const onData = terminal.onData(data => { const activePid = terminalPidRef.current || pid; if (activePid) void desktopInvoke('terminal_write', { pid: activePid, input: data }).catch(error => terminal.writeln(`\r\n[Terminal] ${String(error)}`)); });
    const onResize = () => { try { fit.fit(); } catch {} };
    const onPtyResize = terminal.onResize(({ cols, rows }) => { const activePid = terminalPidRef.current || pid; if (activePid) void desktopInvoke('terminal_resize', { pid: activePid, cols, rows }).catch(() => {}); });
    window.addEventListener('resize', onResize);
    (async () => { try { pid = await desktopInvoke('terminal_start', { root: projectRoot }); if (disposed) { await desktopInvoke('terminal_kill', { pid }).catch(() => {}); if (terminalPidRef.current === pid) terminalPidRef.current = null; return; } terminalPidRef.current = pid; setTerminalPid(pid); void desktopInvoke('terminal_resize', { pid, cols: terminal.cols, rows: terminal.rows }).catch(() => {}); terminal.focus(); } catch (error) { terminal.writeln(`\r\n[Impossible de démarrer PowerShell] ${String(error)}`); } })();
    return () => { disposed = true; window.removeEventListener('resize', onResize); onData.dispose(); onPtyResize.dispose(); if (pid) void desktopInvoke('terminal_kill', { pid }).catch(() => {}); if (terminalPidRef.current === pid) terminalPidRef.current = null; setTerminalPid(null); terminalInstanceRef.current = null; terminal.dispose(); };
  }, [page, projectRoot]);

  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
  const refreshRuntime = useCallback(async () => {
    const requestId = ++runtimeCheckRef.current;
    const next = await getOllamaStatus(baseUrl);
    if (requestId !== runtimeCheckRef.current) return next;
    setStatus(next);
    if (!next.online) { setModels([]); setRunningModels([]); return next; }
    try {
      const [local, running] = await Promise.all([
        listLocalModels(baseUrl),
        desktopInvoke('ollama_running_models', { baseUrl }).catch(() => ({ models: [] })),
      ]);
      if (requestId !== runtimeCheckRef.current) return next;
      setModels(local);
      setRunningModels(running.models || []);
      if (!selectedModel && local[0]) setSelectedModel(local[0].name);
    } catch (error) {
      console.warn('Impossible de synchroniser les modèles locaux', error);
    }
    return next;
  }, [baseUrl, selectedModel]);

  async function startEngine() {
    if (baseUrl.replace(/\/+$/, '') !== DEFAULT_OLLAMA_URL) { notify(`L’adresse configurée est ${baseUrl}. Le moteur intégré Vertex AI utilise ${DEFAULT_OLLAMA_URL}. Remets cette adresse pour démarrer le moteur intégré.`); return false; }
    setRuntimeProgress({ phase: 'prepare', label: 'Démarrage et vérification du moteur…' });
    try {
      const message = await desktopInvoke('ollama_start');
      const ready = await waitForOllama(DEFAULT_OLLAMA_URL, 45000);
      if (!ready.online) throw new Error(ready.error || 'L’API du moteur ne répond pas.');
      await refreshRuntime();
      setRuntimeProgress({ phase: 'started', label: 'Vertex Local Engine démarré et vérifié' });
      notify(message || `Moteur prêt · Ollama ${ready.version}`);
      return true;
    } catch (error) {
      await refreshRuntime();
      notify(`Démarrage impossible : ${String(error)}`);
      return false;
    }
  }

  async function openProject(path, skipDirtyCheck = false) {
    if (!skipDirtyCheck && dirtyTabs.length) {
      const pending = dirtyTabs.map(filePath => ({ path: filePath, content: filePath === activeFile ? fileContent : tabBuffers[filePath] ?? '' }));
      setConfirmAction({ title: 'Enregistrer les fichiers modifiés ?', description: `${pending.length} fichier(s) contiennent des modifications non enregistrées. Enregistrer avant de changer de projet ?`, run: async () => { for (const file of pending) { await desktopInvoke('db_snapshot_file', { root: projectRoot, path: file.path }); await desktopInvoke('write_project_file', { root: projectRoot, path: file.path, content: file.content }); } setDirtyTabs([]); await openProject(path, true); } });
      return;
    }
    try { if (terminalPid) { await desktopInvoke('terminal_kill', { pid: terminalPid }).catch(() => {}); terminalPidRef.current = null; setTerminalPid(null); } const entries = await desktopInvoke('list_project_files', { root: path }); setOpenTabs([]); setTabBuffers({}); setDirtyTabs([]); setExplorerQuery(''); setProjectRoot(path); void desktopInvoke('db_save_project', { path }).then(() => desktopInvoke('db_load_projects')).then(setProjectHistory).catch(() => {}); setFiles(entries); setActiveFile(''); setFileContent(''); setFileDirty(false); setPage('workspace'); notify('Projet ouvert.'); }
    catch (e) { notify(String(e)); }
  }
  async function chooseProject() { const selected = await open({ directory: true, multiple: false, title: 'Ouvrir un dossier de projet' }); if (selected) await openProject(selected); }
  async function refreshFiles() { if (!projectRoot) return; setFiles(await desktopInvoke('list_project_files', { root: projectRoot })); }
  async function selectFile(file, preserveCurrent = true) { if (file.is_dir) return; if (preserveCurrent && activeFile && fileDirty) setTabBuffers(current => ({ ...current, [activeFile]: fileContent })); if (tabBuffers[file.path] !== undefined) { setActiveFile(file.path); setFileContent(tabBuffers[file.path]); setFileDirty(dirtyTabs.includes(file.path)); setOpenTabs(current => current.includes(file.path) ? current : [...current, file.path]); return; } try { const text = await desktopInvoke('read_project_file', { root: projectRoot, path: file.path }); setActiveFile(file.path); setFileContent(text); setFileDirty(false); setOpenTabs(current => current.includes(file.path) ? current : [...current, file.path]); } catch (e) { notify(String(e)); } }
  async function saveFile() { if (!projectRoot || !activeFile) return; try { await desktopInvoke('db_snapshot_file', { root: projectRoot, path: activeFile }); await desktopInvoke('write_project_file', { root: projectRoot, path: activeFile, content: fileContent }); setFileDirty(false); setDirtyTabs(current => current.filter(path => path !== activeFile)); setTabBuffers(current => ({ ...current, [activeFile]: fileContent })); notify('Fichier enregistré.'); await refreshFiles(); } catch (e) { notify(String(e)); } }

  async function createConversation() {
    const conversation = { id: makeId(), title: 'Nouvelle conversation', model: selectedModel, updatedAt: Date.now(), messages: [] };
    setConversations(current => [conversation, ...current]); setActiveId(conversation.id); setPage('chat');
  }
  function updateConversation(id, fn) { setConversations(current => current.map(c => c.id === id ? fn(c) : c)); }
  async function sendMessage(text = draft) {
    const prompt = text.trim(); if (!prompt || busy) return;
    if (!status.online) { notify('Le moteur local ne répond pas. Relance Vertex Local Engine depuis Runtime.'); return; }
    if (!selectedModel || !models.some(m => m.name === selectedModel)) { notify('Télécharge ou sélectionne un modèle local avant de discuter.'); setPage('models'); return; }
    let conversation = activeConversation;
    if (!conversation) { conversation = { id: makeId(), title: prompt.slice(0, 54), model: selectedModel, updatedAt: Date.now(), messages: [] }; setConversations(current => [conversation, ...current]); setActiveId(conversation.id); }
    const userMessage = { id: makeId(), role: 'user', content: prompt, timestamp: Date.now() };
    const assistantId = makeId();
    const history = [...(conversation.messages || []), userMessage];
    updateConversation(conversation.id, c => ({ ...c, title: c.messages?.length ? c.title : prompt.slice(0, 54), model: selectedModel, updatedAt: Date.now(), messages: [...c.messages, userMessage, { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), pending: true }] }));
    setDraft(''); setBusy(true); abortRef.current = false;
    try {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.map(m => ({ role: m.role, content: m.content }))];
      await chatWithOllama({ model: selectedModel, messages, baseUrl, onToken: token => { if (!abortRef.current) updateConversation(conversation.id, c => ({ ...c, messages: c.messages.map(m => m.id === assistantId ? { ...m, content: m.content + token } : m) })); } });
      updateConversation(conversation.id, c => ({ ...c, messages: c.messages.map(m => m.id === assistantId ? { ...m, pending: false } : m) }));
    } catch (e) { updateConversation(conversation.id, c => ({ ...c, messages: c.messages.map(m => m.id === assistantId ? { ...m, content: `Erreur Ollama : ${String(e)}`, pending: false, error: true } : m) })); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (page === 'models' && !catalog.length && !catalogLoading) void searchModels(''); }, [page]);

  async function searchModels(query = catalogQuery, append = false) {
    setCatalogLoading(true);
    try { const nextPage = append ? catalogPage + 1 : 1; const result = await searchLibrary(query, nextPage); setCatalog(current => append ? [...current, ...result.filter(item => !current.some(old => old.name === item.name))] : result); setCatalogPage(nextPage); setCatalogHasMore(result.length >= 15); if (!result.length && !append) notify('Aucun modèle trouvé. Essaie un autre terme.'); }
    catch (e) { notify(`Catalogue indisponible : ${String(e)}`); }
    finally { setCatalogLoading(false); }
  }
  async function downloadModel(model) {
    const liveStatus = await getOllamaStatus(baseUrl);
    setStatus(liveStatus);
    if (!liveStatus.online) {
      setModels([]); setRunningModels([]);
      notify(`Vertex Local Engine est hors ligne. Démarre-le avant le téléchargement. ${liveStatus.error || ''}`);
      return;
    }
    setPulling(p => ({ ...p, [model]: { status: 'Préparation…', percent: 0 } }));
    try { await pullModel(model, baseUrl, progress => { const percent = progress.total ? Math.round(progress.completed / progress.total * 100) : 0; setPulling(p => ({ ...p, [model]: { status: progress.status || 'Téléchargement', percent, detail: progress.total ? `${formatBytes(progress.completed)} / ${formatBytes(progress.total)}` : '' } })); }); await refreshRuntime(); setSelectedModel(model); notify(`${model} téléchargé.`); }
    catch (e) { notify(`Téléchargement interrompu : ${String(e)}`); }
    finally { setPulling(p => { const n = { ...p }; delete n[model]; return n; }); }
  }
  async function removeModel(model) { setConfirmAction({ title: `Supprimer ${model} ?`, description: 'Le modèle et ses données locales seront supprimés du stockage Ollama.', run: async () => { await desktopInvoke('ollama_delete_model', { baseUrl, model }); await refreshRuntime(); if (selectedModel === model) setSelectedModel(''); notify('Modèle supprimé.'); } }); }
  async function loadCatalogTags(model) { try { const html = await desktopInvoke('search_ollama_tags', { model }); const tags = extractModelTags(html, model); setTagsByModel(v=>({...v,[model]:tags})); if (tags.length <= 1) notify('La bibliothèque ne publie pas de variante supplémentaire détectable pour ce modèle.'); } catch(e) { notify(String(e)); } }
  async function inspectModel(model) { try { const detail = await desktopInvoke('ollama_show_model', { baseUrl, model }); setModelDetails(detail); setModelDetailsName(model); const baseModel = model.split(':')[0]; const html = await desktopInvoke('search_ollama_tags', { model: baseModel }).catch(() => ''); setModelTags(extractModelTags(html, baseModel)); } catch (e) { notify(`Détails du modèle : ${String(e)}`); } }
  async function refreshHardware() { try { setSystemInfo(await desktopInvoke('system_hardware_info')); } catch (e) { notify(String(e)); } }
  async function repairLocalRuntime() { setConfirmAction({ title: 'Réparer le moteur Vertex Local ?', description: 'Vertex AI retélécharge et remplace son moteur intégré officiel. Les modèles téléchargés et les conversations ne seront pas supprimés.', run: async () => { const result = await desktopInvoke('ollama_runtime_update'); notify(result || 'Moteur mis à jour.'); await refreshRuntime(); } }); }
  async function undoAgentRun(run) { const ids = run.snapshotIds || []; if (!ids.length) return; setConfirmAction({ title: 'Annuler les modifications de cet agent ?', description: `Restaurer ${ids.length} fichier(s) à leur état précédent.`, run: async () => { for (const id of [...ids].reverse()) await desktopInvoke('db_restore_snapshot', { id }); await refreshFiles(); const next = await desktopInvoke('db_list_snapshots', { root: projectRoot }); setSnapshots(next); updateAgentRun(run.id, { status: 'Modifications annulées', snapshotIds: [] }); notify('Les fichiers ont été restaurés.'); } }); }


  async function runAgent(promptOverride = '') {
    const requestedTask = (promptOverride || agentPrompt).trim();
    if (!projectRoot || !requestedTask) { notify('Ouvre un projet et décris la tâche de ton agent.'); return; }
    if (!status.online || !selectedModel) { notify('Connecte Ollama et sélectionne un modèle local.'); return; }
    const task = requestedTask; setAgentPrompt(''); setPage('agents'); setAgentRunning(true);
    const runId = makeId();
    const entry = { id: runId, task, status: 'Initialisation de l’agent…', log: [], response: '', actions: [], snapshotIds: [] };
    setAgentLog(current => [entry, ...current]);
    try {
      const listing = await desktopInvoke('list_project_files', { root: projectRoot });
      const candidates = listing.filter(f => !f.is_dir && f.size <= 80000 && /\.(md|txt|json|jsonc|js|jsx|ts|tsx|css|scss|html|yml|yaml|java|py|go|php|sql|xml|toml|properties|gradle|sh|bash|ps1|rs|vue|svelte|c|h|cpp|hpp|cs|rb|swift|kt|kts|dart|lua|ex|exs|graphql)$/i.test(f.path)).slice(0, 40);
      const contents = [];
      for (const file of candidates) { try { const content = await desktopInvoke('read_project_file', { root: projectRoot, path: file.path }); contents.push(`\n--- ${file.path} ---\n${content.slice(0, 10000)}`); } catch {} }
      const projectContext = contents.join('\n').slice(0, 120000);
      const system = `Tu es Vertex AI Coding Agent, un agent logiciel local qui travaille par itérations. Réponds UNIQUEMENT en JSON valide : {"summary":"...","actions":[...]}. Actions autorisées : {"type":"read_file","path":"..."}, {"type":"search_files","query":"..."}, {"type":"write_file","path":"...","content":"contenu intégral"}, {"type":"run_command","command":"..."}. Les chemins doivent être relatifs au projet, sans .. ni chemin absolu. Tu peux demander des lectures/recherches qui seront exécutées immédiatement dans le dossier projet. Les écritures et commandes seront seulement proposées, jamais exécutées sans confirmation explicite. Maximum 12 actions par itération. Pour chaque fichier modifié, retourne le contenu intégral. N'invente jamais le résultat d'une commande. Si tu as assez d'informations, propose les changements nécessaires. Réponds en français.`;
      let toolResults = [];
      let staged = [];
      const log = [`Index : ${listing.length} entrées.`, `${contents.length} fichiers lus au démarrage.`, 'Agent multi-itérations activé (8 cycles maximum), avec validation des chemins et aperçu des modifications.'];
      for (let iteration = 1; iteration <= 8; iteration++) {
        updateAgentRun(runId, { status: `Réflexion ${iteration}/8…`, log: [...log, `Itération ${iteration} : analyse du contexte et des retours outils.`] });
        const prompt = `TÂCHE :\n${task}\n\nPROJET : ${projectRoot}\n\nARBORESCENCE :\n${listing.slice(0, 300).map(f => `${f.is_dir ? 'DIR' : 'FILE'} ${f.path}`).join('\n')}\n\nEXTRAIT DU CODE :\n${projectContext}\n\nRÉSULTATS DES OUTILS DES ITÉRATIONS PRÉCÉDENTES :\n${JSON.stringify(toolResults).slice(0, 35000)}\n\nCycle ${iteration}/8. Demande des lectures/recherches si nécessaire, sinon propose les modifications et les commandes de vérification.`;
        let response = '';
        await chatWithOllama({ model: selectedModel, baseUrl, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], options: { temperature: 0.12 }, onToken: token => { response += token; updateAgentRun(runId, { response }); } });
        const plan = parseAgentPlan(response);
        const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, 12) : [];
        let didReadTool = false;
        for (const action of actions) {
          if (action?.type === 'read_file' && typeof action.path === 'string' && isSafeProjectRelativePath(action.path)) {
            const content = await desktopInvoke('read_project_file', { root: projectRoot, path: action.path }); toolResults.push({ tool: 'read_file', path: action.path, content: content.slice(0, 16000) }); didReadTool = true;
          } else if (action?.type === 'search_files' && typeof action.query === 'string') {
            const q = action.query.toLowerCase(); const matches = []; for (const f of listing.filter(x=>!x.is_dir).slice(0,1000)) { if (f.path.toLowerCase().includes(q)) { matches.push({path:f.path,match:'nom de fichier'}); continue; } if (f.size > 80000) continue; try { const text = await desktopInvoke('read_project_file', { root: projectRoot, path: f.path }); const lines = text.split('\n'); const hits = lines.map((line,index)=>({line:index+1,text:line.slice(0,500)})).filter(x=>x.text.toLowerCase().includes(q)).slice(0,5); if (hits.length) matches.push({path:f.path,hits}); } catch {} if(matches.length>=30) break; } toolResults.push({ tool: 'search_files', query: action.query, matches }); didReadTool = true;
          } else if (action?.type === 'write_file' && typeof action.path === 'string' && typeof action.content === 'string' && isSafeProjectRelativePath(action.path)) {
            const before = await desktopInvoke('read_project_file', { root: projectRoot, path: action.path }).catch(() => null);
            staged.push({ ...action, before, isNew: before === null });
          } else if (action?.type === 'run_command' && typeof action.command === 'string' && action.command.length < 500) staged.push(action);
        }
        log.push(`Itération ${iteration} : ${actions.length} action(s), ${toolResults.length} résultat(s) d’outils, ${staged.length} proposition(s) en attente.`);
        if (!didReadTool || iteration === 8) { updateAgentRun(runId, { status: staged.length ? 'Plan prêt à examiner' : 'Analyse terminée', summary: String(plan.summary || 'Analyse terminée.'), actions: staged, log, response }); break; }
      }
      if (!staged.length) notify('Analyse terminée : aucune modification proposée.');
    } catch (e) { updateAgentRun(runId, { status: 'Échec', log: [String(e)] }); notify(`Agent : ${String(e)}`); }
    finally { setAgentRunning(false); }
  }

  function updateAgentRun(id, patch) { setAgentLog(current => current.map(run => run.id === id ? { ...run, ...patch } : run)); }
  async function applyAgentActions(run) {
    const actions = run.actions || [];
    if (!actions.length) return;
    setConfirmAction({ title: `Appliquer ${actions.length} modification(s) ?`, description: actions.map(a => a.type === 'write_file' ? `ÉCRIRE ${a.path}` : `EXÉCUTER ${a.command}`).join('\n') + '\n\nLes fichiers existants portant le même nom seront remplacés. Les commandes autorisées seront lancées dans le dossier du projet.', run: async () => {
      const snapshotIds = []; const verificationErrors = [];
      for (const action of actions) {
        if (action.type === 'write_file') { const snapshotId = await desktopInvoke('db_snapshot_file', { root: projectRoot, path: action.path }); snapshotIds.push(snapshotId); await desktopInvoke('write_project_file', { root: projectRoot, path: action.path, content: action.content }); }
        else if (action.type === 'run_command') { const { program, args } = parseCommand(action.command); const output = await desktopInvoke('run_project_command', { root: projectRoot, program, args }); terminalInstanceRef.current?.writeln(`\r\n$ ${action.command}\r\n${String(output).replace(/\n/g, '\r\n')}\r\n`); if (String(output).startsWith('[ERREUR]')) verificationErrors.push(`${action.command}\n${output}`); }
      }
      await refreshFiles();
      updateAgentRun(run.id, { status: 'Modifications appliquées', actions: [], snapshotIds, log: [...run.log, 'Les modifications ont été écrites sur le disque. Des points de restauration SQLite sont disponibles.'] });
      setSnapshots(await desktopInvoke('db_list_snapshots', { root: projectRoot }));
      notify(`${actions.length} action(s) exécutée(s).`);
      if (verificationErrors.length) { updateAgentRun(run.id, { log: [...run.log, 'Échec de vérification détecté. L’agent relance une analyse avec les sorties d’erreur.'] }); await runAgent(`Corrige les erreurs de vérification suivantes dans le projet, en t’appuyant sur les fichiers et les sorties réelles. Ne répète pas les commandes sans raison.\n\n${verificationErrors.join('\n\n')}`); }
    } });
  }

  async function createWorkspaceFile() {
    if (!projectRoot) return;
    const relative = window.prompt('Chemin du nouveau fichier (ex. src/App.tsx)');
    if (!relative?.trim()) return;
    try { await desktopInvoke('write_project_file', { root: projectRoot, path: relative.trim(), content: '' }); await refreshFiles(); await selectFile({ path: relative.trim(), is_dir: false }); notify('Fichier créé.'); }
    catch (e) { notify(`Création impossible : ${String(e)}`); }
  }
  async function activateTab(path, preserveCurrent = true) {
    const file = files.find(item => item.path === path) || { path, is_dir: false };
    await selectFile(file, preserveCurrent);
  }
  function closeEditorTab(path) {
    if (dirtyTabs.includes(path)) { setConfirmAction({ title: 'Fermer sans enregistrer ?', description: 'Les modifications non enregistrées seront perdues.', run: () => { const next = openTabs.filter(tab => tab !== path); setOpenTabs(next); setDirtyTabs(current => current.filter(item => item !== path)); setTabBuffers(current => { const copy = { ...current }; delete copy[path]; return copy; }); if (next.length) void activateTab(next[next.length - 1], false); else { setActiveFile(''); setFileContent(''); setFileDirty(false); } } }); return; }
    const next = openTabs.filter(tab => tab !== path); setOpenTabs(next); setDirtyTabs(current => current.filter(item => item !== path)); setTabBuffers(current => { const copy = { ...current }; delete copy[path]; return copy; });
    if (activeFile === path) { if (next.length) void activateTab(next[next.length - 1]); else { setActiveFile(''); setFileContent(''); setFileDirty(false); } }
  }
  useEffect(() => { const onKey = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && page === 'workspace') { event.preventDefault(); if (fileDirty) void saveFile(); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [page, fileDirty, activeFile, fileContent, projectRoot]);

  const groupedFiles = useMemo(() => [...files].filter(f => !explorerQuery || f.path.toLowerCase().includes(explorerQuery.toLowerCase())).sort((a,b) => a.path.localeCompare(b.path)), [files, explorerQuery]);
  const visibleCatalog = useMemo(() => [...catalog].sort((a,b) => catalogSort === 'name' ? a.title.localeCompare(b.title) : 0), [catalog, catalogSort]);
  return <div className="desktop-shell">
    <aside className="desktop-sidebar">
      <div className="desktop-brand"><span className="desktop-brand-icon"><Icon name="logo" size={23}/></span><span><b>VERTEX<span> AI</span></b><small>DESKTOP WORKSPACE</small></span><span className="desktop-version">2.9</span></div>
      <button className="desktop-new-chat" onClick={createConversation}><Icon name="plus" size={16}/> Nouvelle conversation <kbd>Ctrl K</kbd></button>
      <div className="desktop-nav-label">ESPACE DE TRAVAIL</div>
      <nav className="desktop-nav">{NAV.map(([id,label,icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon name={icon} size={17}/>{label}{id === 'models' && models.length > 0 && <span className="nav-count">{models.length}</span>}</button>)}</nav>
      <div className="desktop-history-head"><span>RÉCENT</span><button onClick={() => { setConversations([]); void desktopInvoke('db_delete_conversations').catch(() => {}); }} title="Effacer l'historique"><Icon name="trash" size={13}/></button></div>
      <div className="desktop-history">{conversations.slice(0,35).map(c => <button key={c.id} className={activeId === c.id && page === 'chat' ? 'selected' : ''} onClick={() => { setActiveId(c.id); setPage('chat'); }}><Icon name="message" size={13}/><span>{c.title}</span></button>)}{!conversations.length && <p>Vos conversations apparaîtront ici.</p>}</div>
      <div className="desktop-sidebar-bottom"><div className={`runtime-chip ${status.online ? 'is-online' : 'is-offline'}`}><i/>{status.online ? `Vertex Engine ${status.version}` : 'Vertex Engine hors ligne'}</div><button onClick={() => setPage('settings')}><Icon name="settings" size={15}/> Préférences</button><div className="desktop-profile"><span>V</span><div><b>Vertex Studio</b><small>Session locale</small></div><Icon name="shield" size={15}/></div></div>
    </aside>
    <main className="desktop-main">
      <header className="desktop-topbar"><div className="desktop-breadcrumb"><span>Vertex AI</span><Icon name="chevron" size={13}/><b>{NAV.find(n => n[0] === page)?.[1]}</b>{projectRoot && <><Icon name="chevron" size={13}/><span className="breadcrumb-project">{projectRoot.split(/[\\/]/).pop()}</span></>}</div><div className="desktop-top-actions"><span className={`connection-label ${status.online ? 'good' : 'bad'}`}><i/>{status.online ? 'VERTEX ENGINE · ACTIF' : runtimeProgress?.label || 'VERTEX ENGINE · INITIALISATION'}</span><select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} title="Modèle actif"><option value="">Choisir un modèle</option>{models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}</select><button className="desktop-icon-btn" onClick={() => void refreshRuntime()} title="Actualiser"><Icon name="refresh" size={16}/></button></div></header>
      {page === 'chat' && <section className="desktop-chat-page"><div className="desktop-chat-scroll">{!activeConversation?.messages?.length ? <div className="desktop-welcome"><div className="desktop-orb"><Icon name="spark" size={30}/></div><div className="desktop-eyebrow">INTELLIGENCE LOCALE · VERTEX STUDIO</div><h1>Qu'est-ce qu'on <em>construit</em><br/>aujourd'hui ?</h1><p>Discute avec tes modèles locaux, explore tes idées ou démarre un projet avec un agent IA.</p><div className="desktop-prompt-grid">{[['code','Construire un projet','Crée une application React moderne…'],['bug','Déboguer du code','Analyse cette erreur et trouve une correction…'],['file','Comprendre un projet','Explique-moi l’architecture de mon projet…'],['spark','Explorer une idée','Aide-moi à concevoir une nouvelle fonctionnalité…']].map(([icon,title,body]) => <button key={title} onClick={() => setDraft(body)}><Icon name={icon} size={17}/><span><b>{title}</b><small>{body}</small></span><Icon name="arrowUpRight" size={14}/></button>)}</div><div className="desktop-welcome-status">{status.online ? `${models.length} modèle(s) local(aux) disponible(s)` : 'Initialise Vertex Local Engine pour commencer'} · Aucun abonnement IA requis</div></div> : <div className="desktop-messages">{activeConversation.messages.map(m => <article key={m.id} className={`desktop-message ${m.role}`}>{m.role === 'assistant' && <div className="desktop-avatar"><Icon name="logo" size={17}/></div>}<div className="desktop-message-body"><div className="desktop-message-meta"><b>{m.role === 'user' ? 'Vous' : 'VERTEX AI'}</b><time>{new Date(m.timestamp).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</time></div>{m.role === 'assistant' ? <div className="desktop-markdown"><Markdown content={m.content || (m.pending ? 'Réflexion en cours…' : '')}/></div> : <div className="desktop-user-bubble">{m.content}</div>}</div></article>)}<div ref={bottomRef}/></div>}</div><div className="desktop-composer-wrap"><div className="desktop-composer"><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void sendMessage();} }} placeholder="Écris un message à Vertex AI…" rows={2}/><div className="desktop-composer-bottom"><span><Icon name="shield" size={13}/> Traitement local · {selectedModel || 'Aucun modèle sélectionné'}</span><button disabled={busy || !draft.trim()} onClick={() => void sendMessage()}>{busy ? 'Génération…' : 'Envoyer'} <Icon name="arrowUp" size={16}/></button></div></div><small>Les réponses sont générées sur ton ordinateur par Vertex Local Engine. Maj + Entrée pour une nouvelle ligne.</small></div></section>}

      {page === 'models' && <section className="desktop-page"><div className="desktop-page-heading"><div><div className="desktop-eyebrow">OLLAMA LIBRARY</div><h1>Model Hub</h1><p>Explore le catalogue Ollama et installe tes modèles directement sur ton PC.</p></div><button className="desktop-secondary-btn" onClick={() => void searchModels('')}><Icon name="refresh" size={15}/> Actualiser le catalogue</button></div>{!status.online && <div className="runtime-help"><b>Vertex Local Engine hors ligne</b><p>Le catalogue reste consultable, mais le téléchargement nécessite que l’API Ollama réponde sur {baseUrl}.</p><button className="desktop-primary-btn" onClick={() => void startEngine()}>Démarrer et vérifier le moteur</button></div>}<div className="model-tabs"><button className={catalogTab==='catalog'?'active':''} onClick={()=>setCatalogTab('catalog')}>Catalogue</button><button className={catalogTab==='installed'?'active':''} onClick={()=>setCatalogTab('installed')}>Installés <span>{models.length}</span></button></div>{catalogTab==='catalog' && <><div className="desktop-searchbar"><Icon name="search" size={17}/><input value={catalogQuery} onChange={e => setCatalogQuery(e.target.value)} onKeyDown={e => e.key==='Enter' && void searchModels()} placeholder="Rechercher Qwen, Llama, DeepSeek, Gemma…"/><button onClick={() => void searchModels()} disabled={catalogLoading}>{catalogLoading ? 'Recherche…' : 'Rechercher'}</button></div><div className="catalog-toolbar"><span>{catalog.length} modèle(s) chargés · catalogue public Ollama</span><select value={catalogSort} onChange={e=>setCatalogSort(e.target.value)}><option value="relevance">Pertinence</option><option value="name">Nom A → Z</option></select></div>{models.length > 0 && <div className="installed-strip"><b>Installés sur cet appareil</b><div>{models.map(m => <span key={m.name}>{m.name} <small>{formatBytes(m.size)}</small></span>)}</div></div>}<div className="model-grid">{visibleCatalog.map(m => <article className="model-card" key={m.name}><div className="model-card-top"><span className="model-logo"><Icon name="brain" size={20}/></span><span className="model-source">OLLAMA LIBRARY</span></div><h3>{m.title}</h3><p>{m.description || 'Modèle disponible dans la bibliothèque Ollama.'}</p><div className="model-card-foot"><a href={m.url} target="_blank" rel="noreferrer">Détails <Icon name="external" size={12}/></a>{pulling[m.pull] ? <div className="pull-progress"><span>{pulling[m.pull].status} · {pulling[m.pull].percent}%</span><i><b style={{width:`${pulling[m.pull].percent}%`}}/></i></div> : m.cloud ? <span className="installed-label">Cloud uniquement</span> : models.some(x => x.name === m.pull || x.name === m.name || x.name.split(':')[0] === m.name) ? <span className="installed-label">Installé</span> : <span className="model-download-choice"><select aria-label="Variante" value={selectedTag[m.name] || 'latest'} onChange={e=>setSelectedTag(v=>({...v,[m.name]:e.target.value}))}><option value="latest">latest</option>{(tagsByModel[m.name] || []).map(tag=><option key={tag} value={tag}>{tag}</option>)}</select><button className="tag-fetch-btn" onClick={()=>void loadCatalogTags(m.name)} title="Charger les variantes">Tags</button><button disabled={Object.keys(pulling).length > 0} onClick={() => void downloadModel(`${m.name}:${selectedTag[m.name] || 'latest'}`)}><Icon name="download" size={14}/> Télécharger</button></span>}</div></article>)}</div>{catalog.length > 0 && catalogHasMore && <div className="catalog-load-more"><button onClick={() => void searchModels(catalogQuery, true)} disabled={catalogLoading}>{catalogLoading ? 'Chargement…' : 'Afficher plus de modèles'}</button></div>}{!catalog.length && <div className="catalog-empty"><div><Icon name="library" size={28}/></div><h3>Découvre les modèles Ollama</h3><p>Le catalogue est chargé à la demande pour rester léger. Lance une recherche ou actualise pour explorer la bibliothèque en ligne.</p><button onClick={() => void searchModels('') } disabled={catalogLoading}>{catalogLoading ? 'Chargement…' : 'Charger le catalogue'}</button></div>}</>}{catalogTab==='installed' && <div className="installed-model-list">{models.map(m=><article key={m.name}><span className="model-logo"><Icon name="brain" size={18}/></span><div><b>{m.name}</b><small>{m.details?.parameter_size || 'Modèle local'} · {formatBytes(m.size)}</small></div><button onClick={()=>void removeModel(m.name)}><Icon name="trash" size={14}/> Supprimer</button></article>)}{!models.length && <div className="catalog-empty"><Icon name="box" size={28}/><h3>Aucun modèle installé</h3><p>Ouvre le catalogue pour télécharger ton premier modèle.</p><button onClick={()=>setCatalogTab('catalog')}>Explorer le catalogue</button></div>}</div>}</section>}

      {page === 'workspace' && <section className="desktop-workspace-page">
        <div className="workspace-toolbar"><div><b>Code Workspace</b><small>{projectRoot || 'Aucun dossier ouvert'}{activeFile ? `  ·  ${detectLanguage(activeFile).toUpperCase()}` : ''}</small></div><div><button className="desktop-secondary-btn" onClick={() => void chooseProject()}><Icon name="folderOpen" size={15}/> Ouvrir un projet</button>{projectRoot && <><button className="desktop-secondary-btn" onClick={createWorkspaceFile}><Icon name="plus" size={15}/> Nouveau fichier</button><button className="desktop-secondary-btn" onClick={()=>{terminalInstanceRef.current?.focus();if(terminalPidRef.current)void desktopInvoke('terminal_write',{pid:terminalPidRef.current,input:'git status\r'});}} disabled={!terminalPid}><Icon name="gitBranch" size={14}/> Git status</button><button className="desktop-secondary-btn" onClick={()=>{terminalInstanceRef.current?.focus();if(terminalPidRef.current)void desktopInvoke('terminal_write',{pid:terminalPidRef.current,input:'npm run build\r'});}} disabled={!terminalPid}><Icon name="play" size={14}/> Build</button><button className="desktop-secondary-btn" onClick={() => void refreshFiles()}><Icon name="refresh" size={15}/></button></>}{activeFile && <button className="desktop-primary-btn" onClick={() => void saveFile()} disabled={!fileDirty}>Enregistrer <kbd>Ctrl S</kbd></button>}</div></div>
        {!projectRoot ? <div className="workspace-empty"><Icon name="folderOpen" size={35}/><h2>Ouvre un dossier de projet</h2><p>Vertex AI pourra explorer les fichiers, éditer le code et exécuter des commandes dans ce dossier.</p><button className="desktop-primary-btn" onClick={() => void chooseProject()}>Sélectionner un dossier</button></div> : <div className="workspace-layout">
          <aside className="file-explorer"><div className="file-explorer-title"><span>EXPLORATEUR</span><div><button onClick={createWorkspaceFile} title="Nouveau fichier"><Icon name="plus" size={13}/></button><button onClick={() => void refreshFiles()} title="Actualiser"><Icon name="refresh" size={13}/></button></div></div><div className="explorer-search"><Icon name="search" size={12}/><input value={explorerQuery} onChange={e=>setExplorerQuery(e.target.value)} placeholder="Filtrer les fichiers"/></div>{groupedFiles.map(f => <button key={f.path} className={`file-tree-item ${activeFile===f.path?'active':''} ${f.is_dir?'directory':''}`} style={{paddingLeft: `${10 + Math.min(f.path.split('/').length-1,5)*12}px`}} onClick={() => void selectFile(f)}><Icon name={f.is_dir?'folder':'file'} size={14}/><span>{f.name}</span></button>)}</aside>
          <div className="editor-area"><div className="editor-tabs">{openTabs.map(path=><button key={path} className={`editor-tab ${activeFile===path?'active':''}`} onClick={()=>void activateTab(path)}><Icon name="fileCode" size={13}/><span>{path.split('/').pop()}</span>{dirtyTabs.includes(path) && <i/>}<b onClick={e=>{e.stopPropagation();closeEditorTab(path);}}>×</b></button>)}</div>{activeFile ? <><div className="editor-breadcrumb">{activeFile.split('/').join('  /  ')} <span>{detectLanguage(activeFile).toUpperCase()}</span></div><CodeMirror value={fileContent} height="100%" theme={oneDark} extensions={[languageExtension(activeFile)]} onChange={v => {setFileContent(v);setFileDirty(true);setTabBuffers(current=>({...current,[activeFile]:v}));setDirtyTabs(current=>current.includes(activeFile)?current:[...current,activeFile]);}} basicSetup={{lineNumbers:true,foldGutter:true,highlightActiveLine:true,highlightActiveLineGutter:true,autocompletion:true,closeBrackets:true,indentOnInput:true, bracketMatching:true, rectangularSelection:true, searchKeymap:true}}/></> : <div className="editor-placeholder"><Icon name="code" size={32}/><span>Sélectionne un fichier pour commencer à coder</span><small>JavaScript · TypeScript · Python · Java · C/C++ · C# · Go · Rust · PHP · SQL · HTML · CSS · YAML · TOML · Shell</small></div>}
            <div className="terminal-panel"><div className="terminal-head"><div className="terminal-tabs"><b>TERMINAL</b><span>{terminalPid ? `PID ${terminalPid} · EN COURS` : 'POWERSHELL · PROJET'}</span></div><div><button onClick={()=>{terminalInstanceRef.current?.clear();terminalInstanceRef.current?.focus();}} title="Effacer"><Icon name="trash" size={13}/></button>{terminalPid && <button onClick={()=>{void desktopInvoke('terminal_kill',{pid:terminalPid}).then(()=>{terminalPidRef.current=null;setTerminalPid(null);}).catch(e=>notify(String(e)));}} title="Arrêter le processus"><Icon name="square" size={13}/></button>}</div></div><div ref={terminalMountRef} className="xterm-host"/><div className="terminal-footnote">PowerShell / ConPTY · ANSI · Ctrl+C · redimensionnement · ■ pour arrêter</div></div>
          </div></div>}
      </section>}

      {page === 'projects' && <section className="desktop-page"><div className="desktop-page-heading"><div><div className="desktop-eyebrow">LOCAL WORKSPACES</div><h1>Projects</h1><p>Ouvre et gère les dossiers de développement présents sur ton ordinateur.</p></div><button className="desktop-primary-btn" onClick={() => void chooseProject()}><Icon name="plus" size={15}/> Ouvrir un projet</button></div>{projectHistory.length>0 && <><h3 className="section-title">Projets récents</h3>{projectHistory.map(p=><div className="project-card" key={p.path}><div className="project-icon"><Icon name="folderCode" size={22}/></div><div><b>{p.name}</b><small>{p.path}</small></div><button onClick={()=>void openProject(p.path)}>Ouvrir <Icon name="arrowRight" size={14}/></button></div>)}</>}{projectRoot ? <div className="project-card"><div className="project-icon"><Icon name="folderCode" size={24}/></div><div><b>{projectRoot.split(/[\\/]/).pop()}</b><small>{projectRoot}</small><span>{files.length} éléments indexés</span></div><button onClick={() => setPage('workspace')}>Ouvrir <Icon name="arrowRight" size={14}/></button></div> : <div className="catalog-empty"><Icon name="folderOpen" size={30}/><h3>Aucun projet ouvert</h3><p>Choisis un dossier local pour commencer à travailler avec ton agent de développement.</p><button onClick={() => void chooseProject()}>Choisir un dossier</button></div>}</section>}

      {page === 'agents' && <section className="desktop-page"><div className="desktop-page-heading"><div><div className="desktop-eyebrow">LOCAL AGENT RUNTIME</div><h1>AI Agents</h1><p>Confie des tâches à ton modèle local avec accès contrôlé au projet ouvert.</p></div><span className="agent-safety"><Icon name="shieldCheck" size={15}/> Permissions protégées</span></div><div className="agent-intro-card"><div className="agent-icon"><Icon name="bot" size={26}/></div><div><h3>Vertex Coding Agent</h3><p>Analyse les fichiers du projet et prépare des modifications à examiner avant écriture. Les commandes de build se lancent ensuite dans le terminal intégré après confirmation.</p><div className="agent-capabilities"><span>Lecture de fichiers</span><span>Analyse du code</span><span>Modifications de fichiers</span><span>Écriture confirmée</span></div></div></div><div className="agent-task-box"><label>QUE DOIS-JE FAIRE ?</label><textarea value={agentPrompt} onChange={e=>setAgentPrompt(e.target.value)} placeholder="Ex. Analyse mon projet, identifie les bugs et propose un plan de correction…"/><div><span>{projectRoot ? `Projet : ${projectRoot.split(/[\\/]/).pop()}` : 'Aucun projet ouvert'}</span><button onClick={() => void runAgent()} disabled={!projectRoot || !agentPrompt.trim() || !selectedModel || agentRunning}>{agentRunning ? 'Agent en cours…' : 'Lancer l’analyse'} <Icon name="arrowRight" size={15}/></button></div></div><div className="agent-log-list"><h3>Activité récente</h3>{agentLog.map(a=><article key={a.id}><b>{a.task}</b><small>{a.status}</small>{a.summary && <p>{a.summary}</p>}{a.log.map((l,i)=><p key={i}>{l}</p>)}{a.actions?.length>0 && <><div className="agent-proposed-files">{a.actions.map((action,i)=>action.type==='write_file' ? <details key={i}><summary><Icon name="fileCode" size={13}/>{action.path} · {action.isNew ? 'Nouveau fichier' : 'Modification'}</summary><div className="agent-diff-columns"><div><b>AVANT</b><pre>{action.before ?? '— fichier inexistant —'}</pre></div><div><b>APRÈS</b><pre>{action.content}</pre></div></div></details> : <span key={i}><Icon name="terminal" size={13}/>{action.command}</span>)}</div><button className="desktop-primary-btn" onClick={()=>void applyAgentActions(a)}>Examiner et appliquer les modifications <Icon name="check" size={14}/></button></>}{a.snapshotIds?.length>0 && <button className="desktop-secondary-btn" onClick={()=>void undoAgentRun(a)}>Annuler les modifications</button>}</article>)}{!agentLog.length && <p className="muted-copy">Aucune tâche pour le moment.</p>}</div></section>}

      {page === 'runtime' && <section className="desktop-page"><div className="desktop-page-heading"><div><div className="desktop-eyebrow">LOCAL INFERENCE ENGINE</div><h1>Runtime</h1><p>Contrôle le moteur local intégré à Vertex AI et surveille les modèles installés.</p></div><button className="desktop-secondary-btn" onClick={() => void refreshRuntime()}><Icon name="refresh" size={15}/> Actualiser</button></div>{runtimeProgress && !status.online && <div className="runtime-help"><b>{runtimeProgress.label || 'Préparation du moteur local'}</b>{runtimeProgress.phase === 'download' && <><p>{runtimeProgress.total ? `${(runtimeProgress.received/1073741824).toFixed(2)} / ${(runtimeProgress.total/1073741824).toFixed(2)} Go` : 'Téléchargement en cours…'}</p><div style={{height:6,background:'rgba(255,255,255,.1)',borderRadius:99,overflow:'hidden'}}><div style={{height:'100%',width:`${runtimeProgress.percent || 0}%`,background:'linear-gradient(90deg,#f97316,#3b82f6)',transition:'width .2s'}}/></div></>}</div>}<div className={`runtime-hero ${status.online?'online':''}`}><div className="runtime-hero-icon"><Icon name="cpu" size={27}/></div><div><span>VERTEX LOCAL ENGINE · OLLAMA EMBARQUÉ</span><h2>{status.online ? 'Moteur opérationnel' : 'Initialisation du moteur intégré requise'}</h2><p>{status.online ? `Version ${status.version} · ${models.length} modèle(s) installé(s)` : 'Vertex AI prépare automatiquement son moteur local au premier démarrage.'}</p></div><button onClick={() => void startEngine()}><Icon name="play" size={15}/> Démarrer le moteur</button></div><div className="runtime-stats"><div><small>CPU</small><b>{systemInfo.cpuName || 'Détection…'} · {systemInfo.cpuCores || '—'} cœurs</b><small>Charge {Number(systemInfo.cpuUsage || 0).toFixed(1)}%</small></div><div><small>MÉMOIRE RAM</small><b>{systemInfo.ramTotal ? `${(systemInfo.ramUsed/1073741824).toFixed(1)} / ${(systemInfo.ramTotal/1073741824).toFixed(1)} Go` : '—'}</b></div><div><small>GPU DÉTECTÉ</small><b>{systemInfo.gpus?.length ? systemInfo.gpus.join(' · ') : 'Informations non disponibles'}</b></div><div><small>MODÈLES LOCAUX</small><b>{models.length}</b></div><div><small>ENDPOINT</small><b>{baseUrl}</b></div><div><small>STATUT</small><b className={status.online?'text-good':'text-warn'}>{status.online?'Connecté':'Hors ligne'}</b></div></div><div className="runtime-actions"><button className="desktop-secondary-btn" onClick={refreshHardware}>Actualiser le matériel</button><button className="desktop-secondary-btn" onClick={()=>repairLocalRuntime()}>Réparer / mettre à jour le moteur intégré</button></div><h3 className="section-title">Modèles installés</h3>{models.map(m=><div className="runtime-model" key={m.name}><Icon name="brain" size={18}/><div><b>{m.name}</b><small>{m.details?.parameter_size || 'Modèle local'} · {m.details?.quantization_level || 'Quantification inconnue'} · {runningModels.some(r=>r.name===m.name)?'Chargé en mémoire':'Arrêté'}</small></div><span>{formatBytes(m.size)}</span><button onClick={()=>void inspectModel(m.name)} title="Détails et quantification"><Icon name="info" size={14}/></button><button onClick={()=>void removeModel(m.name)} title="Supprimer"><Icon name="trash" size={15}/></button></div>)}{!models.length && <p className="muted-copy">Aucun modèle installé.</p>}{modelDetails && <div className="runtime-help model-details-panel"><b>Détails : {modelDetailsName}</b><p>Variantes disponibles sur Ollama : {modelTags.length ? modelTags.join(' · ') : 'Liste non exposée pour ce modèle.'}</p><p>{modelDetails.details?.parameter_size || 'Paramètres non renseignés'} · {modelDetails.details?.quantization_level || 'Quantification non renseignée'}</p><p>Famille : {modelDetails.details?.family || '—'} · Formats : {(modelDetails.details?.families || []).join(', ') || '—'}</p><p>{(modelDetails.capabilities || []).join(' · ')}</p><details><summary>Afficher le modèle et les variantes</summary><pre>{JSON.stringify({modelfile:modelDetails.modelfile,parameters:modelDetails.parameters,template:modelDetails.template},null,2)}</pre></details></div>}<div className="runtime-help"><b>Moteur autonome Vertex AI</b><p>Le moteur Ollama officiel est fourni avec Vertex AI et s'exécute dans son espace privé. Aucun Ollama externe, terminal ou gestionnaire de paquets n'est nécessaire. Les modèles sont téléchargés séparément à la demande.</p></div></section>}

      {page === 'settings' && <section className="desktop-page"><div className="desktop-page-heading"><div><div className="desktop-eyebrow">PREFERENCES</div><h1>Settings</h1><p>Configure Vertex AI Desktop et ton environnement local.</p></div></div><div className="settings-layout"><aside>{[['general','Général'],['ollama','Moteur local'],['privacy','Confidentialité'],['about','À propos']].map(([id,label])=><button className={settingsTab===id?'active':''} onClick={()=>setSettingsTab(id)} key={id}>{label}</button>)}</aside><div className="settings-content">{settingsTab==='general'&&<><h3>Général</h3><label className="setting-row"><span><b>Langue de l'interface</b><small>Langue de Vertex AI Desktop</small></span><select defaultValue="fr"><option value="fr">Français</option><option value="en">English (bientôt)</option></select></label><label className="setting-row"><span><b>Modèle par défaut</b><small>Utilisé pour les nouvelles conversations</small></span><select value={selectedModel} onChange={e=>setSelectedModel(e.target.value)}><option value="">Aucun</option>{models.map(m=><option key={m.name}>{m.name}</option>)}</select></label></>}{settingsTab==='ollama'&&<><h3>Vertex Local Engine</h3><label className="setting-row"><span><b>Adresse du moteur local</b><small>API privée du runtime embarqué</small></span><input value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11435"/></label><button className="desktop-primary-btn" onClick={()=>void refreshRuntime()}>Tester la connexion</button></>}{settingsTab==='privacy'&&<><h3>Confidentialité et sécurité</h3><div className="privacy-note"><Icon name="shieldCheck" size={20}/><p>Les messages et fichiers restent sur cet ordinateur et sont envoyés au moteur local intégré (Ollama embarqué). Les recherches de modèles utilisent la bibliothèque publique Ollama. Aucune clé fournisseur cloud n'est requise.</p></div><ul><li>Les accès fichiers sont limités au dossier de projet ouvert.</li><li>Les commandes sont exécutées après confirmation.</li><li>Les suppressions de modèles nécessitent une confirmation.</li><li>Les conversations, projets récents et points de restauration sont stockés dans une base SQLite locale.</li></ul></>}{settingsTab==='about'&&<><h3>Vertex AI Desktop</h3><p>Version 2.9.1 · Vertex Studio</p><p>Application Desktop basée sur React/JavaScript, Vite, Rust et Tauri 2.</p><a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama <Icon name="external" size={13}/></a></>}</div></div></section>}
    </main>
    {toast && <div className="desktop-toast"><Icon name="info" size={15}/>{toast}</div>}
    {confirmAction && <div className="desktop-modal-scrim"><div className="desktop-confirm-modal"><div className="confirm-icon"><Icon name="shieldAlert" size={23}/></div><h3>{confirmAction.title}</h3><p>{confirmAction.description}</p><div><button onClick={()=>setConfirmAction(null)}>Annuler</button><button className="danger-confirm" onClick={async()=>{const action=confirmAction;setConfirmAction(null);try{await action.run();}catch(e){notify(String(e));}}}>Confirmer</button></div></div></div>}
  </div>;
}
