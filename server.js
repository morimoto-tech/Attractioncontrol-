const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, "preshow-state.json");

const SCENES = {
  standby: {
    id: "standby",
    title: "待機中",
    message: "スタート前の案内映像・音声"
  },
  main: {
    id: "main",
    title: "プレショー",
    message: "本編の映像・音声"
  },
  ending: {
    id: "ending",
    title: "終了後",
    message: "終了後に一定時間流す映像・音声"
  }
};

const clients = new Set();
let returnTimer = null;

const defaultState = () => ({
  currentScene: "standby",
  isPlaying: false,
  endingReturnDelay: 15,
  masterVolume: 100,
  bgmVolume: 35,
  returnAt: null,
  bgm: emptyBgmMedia(),
  scenes: {
    standby: emptySceneMedia(),
    main: emptySceneMedia(),
    ending: emptySceneMedia()
  },
  logs: [makeLog("プレショーサーバーを初期化しました。")]
});

let state = defaultState();

void boot();

async function boot() {
  state = await loadState();
  syncTimerToState();

  const server = http.createServer((req, res) => {
    void routeRequest(req, res).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: "server_error" });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Pre-show server running on http://localhost:${PORT}`);
  });
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_PATH, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    const fresh = defaultState();
    await saveState(fresh);
    return fresh;
  }
}

function normalizeState(candidate) {
  const fallback = defaultState();
  const next = {
    ...fallback,
    ...candidate,
    bgm: { ...fallback.bgm, ...(candidate.bgm || {}) },
    scenes: {
      standby: { ...fallback.scenes.standby, ...(candidate.scenes?.standby || {}) },
      main: { ...fallback.scenes.main, ...(candidate.scenes?.main || {}) },
      ending: { ...fallback.scenes.ending, ...(candidate.scenes?.ending || {}) }
    },
    logs: Array.isArray(candidate.logs) && candidate.logs.length ? candidate.logs.slice(0, 40) : fallback.logs
  };

  if (!SCENES[next.currentScene]) {
    next.currentScene = "standby";
  }

  return next;
}

async function saveState(nextState = state) {
  await fsp.writeFile(STATE_PATH, JSON.stringify(nextState, null, 2), "utf8");
}

async function routeRequest(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && reqUrl.pathname === "/") {
    return serveFile(res, path.join(ROOT, "control.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && reqUrl.pathname === "/control.html") {
    return serveFile(res, path.join(ROOT, "control.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && reqUrl.pathname === "/display.html") {
    return serveFile(res, path.join(ROOT, "display.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && reqUrl.pathname === "/settings.html") {
    return serveFile(res, path.join(ROOT, "settings.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/state") {
    return sendJson(res, 200, publicState());
  }

  if (req.method === "GET" && reqUrl.pathname === "/events") {
    return handleEvents(req, res);
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/scene") {
    const body = await readJson(req);
    activateScene(body.sceneId);
    return sendJson(res, 200, publicState());
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/stop") {
    stopPlayback();
    return sendJson(res, 200, publicState());
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/settings") {
    const body = await readJson(req);
    state.endingReturnDelay = sanitizeDelay(body.endingReturnDelay);
    state.masterVolume = sanitizeVolume(body.masterVolume);
    state.bgmVolume = sanitizeVolume(body.bgmVolume, 35);
    addLog(`設定を更新しました。自動復帰 ${state.endingReturnDelay}秒 / 音量 ${state.masterVolume}% / BGM ${state.bgmVolume}%`);
    syncTimerToState();
    await persistAndBroadcast();
    return sendJson(res, 200, publicState());
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/media-urls") {
    const body = await readJson(req);
    if (body.target === "bgm") {
      updateBgmUrls(body);
    } else {
      updateMediaUrls(body);
    }
    await persistAndBroadcast();
    return sendJson(res, 200, publicState());
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/demo") {
    loadDemoState();
    await persistAndBroadcast();
    return sendJson(res, 200, publicState());
  }

  sendJson(res, 404, { error: "not_found" });
}

async function serveFile(res, filePath, contentType) {
  const buffer = await fsp.readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(buffer);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);

  const client = res;
  clients.add(client);

  req.on("close", () => {
    clients.delete(client);
  });
}

function activateScene(sceneId) {
  if (!SCENES[sceneId]) {
    throw new Error(`Unknown scene: ${sceneId}`);
  }

  clearReturnTimer();
  state.currentScene = sceneId;
  state.isPlaying = true;
  state.returnAt = null;
  addLog(`${SCENES[sceneId].title}シーンを再生しました。`);

  if (sceneId === "ending") {
    state.returnAt = Date.now() + state.endingReturnDelay * 1000;
    returnTimer = setTimeout(() => {
      activateScene("standby");
      addLog("終了後のタイマー満了で待機中へ戻しました。");
      void persistAndBroadcast();
    }, state.endingReturnDelay * 1000);
  }

  void persistAndBroadcast();
}

function stopPlayback() {
  clearReturnTimer();
  state.isPlaying = false;
  state.returnAt = null;
  addLog("再生を停止しました。");
  void persistAndBroadcast();
}

function clearReturnTimer() {
  if (returnTimer) {
    clearTimeout(returnTimer);
    returnTimer = null;
  }
}

function syncTimerToState() {
  clearReturnTimer();

  if (state.currentScene !== "ending" || !state.isPlaying || !state.returnAt) {
    state.returnAt = null;
    return;
  }

  const delay = state.returnAt - Date.now();
  if (delay <= 0) {
    state.currentScene = "standby";
    state.isPlaying = true;
    state.returnAt = null;
    addLog("終了後の復帰タイミングを再計算し、待機中へ戻しました。");
    return;
  }

  returnTimer = setTimeout(() => {
    activateScene("standby");
    addLog("終了後のタイマー満了で待機中へ戻しました。");
    void persistAndBroadcast();
  }, delay);
}

function updateMediaUrls(body) {
  const sceneId = String(body.sceneId || "");
  if (!SCENES[sceneId]) {
    throw new Error("invalid_scene");
  }

  const scene = state.scenes[sceneId];
  const nextVideoUrl = sanitizeMediaUrl(body.videoUrl);
  const nextAudioUrl = sanitizeMediaUrl(body.audioUrl);

  scene.videoUrl = nextVideoUrl;
  scene.audioUrl = nextAudioUrl;
  scene.videoName = nextVideoUrl ? extractLabel(nextVideoUrl) : "";
  scene.audioName = nextAudioUrl ? extractLabel(nextAudioUrl) : "";

  addLog(`${SCENES[sceneId].title}のURL設定を更新しました。`);
}

function updateBgmUrls(body) {
  const nextAudioUrl = sanitizeMediaUrl(body.audioUrl);
  state.bgm.audioUrl = nextAudioUrl;
  state.bgm.audioName = nextAudioUrl ? extractLabel(nextAudioUrl) : "";
  addLog("共通BGMのURL設定を更新しました。");
}

function sanitizeMediaUrl(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }

  const parsed = new URL(input);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("invalid_media_url");
  }

  return parsed.toString();
}

function extractLabel(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || parsed.hostname);
  } catch (error) {
    return url;
  }
}

function loadDemoState() {
  clearReturnTimer();
  state.currentScene = "standby";
  state.isPlaying = false;
  state.endingReturnDelay = 12;
  state.masterVolume = 85;
  state.bgmVolume = 35;
  state.returnAt = null;
  state.logs = [
    makeLog("プレショー用のデモ状態を読み込みました。"),
    makeLog("操作ページと表示ページは公開URLで開いてください。")
  ];
}

async function persistAndBroadcast() {
  await saveState();
  broadcastState();
}

function broadcastState() {
  const data = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

function publicState() {
  return {
    currentScene: state.currentScene,
    isPlaying: state.isPlaying,
    endingReturnDelay: state.endingReturnDelay,
    masterVolume: state.masterVolume,
    bgmVolume: state.bgmVolume,
    returnAt: state.returnAt,
    bgm: state.bgm,
    scenes: state.scenes,
    logs: state.logs,
    availableScenes: Object.values(SCENES)
  };
}

function emptyBgmMedia() {
  return {
    audioUrl: "",
    audioName: ""
  };
}

function emptySceneMedia() {
  return {
    videoUrl: "",
    audioUrl: "",
    videoName: "",
    audioName: ""
  };
}

function makeLog(message) {
  return {
    time: new Date().toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }),
    message
  };
}

function addLog(message) {
  state.logs.unshift(makeLog(message));
  state.logs = state.logs.slice(0, 40);
}

function sanitizeDelay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return 15;
  }
  return Math.round(numeric);
}

function sanitizeVolume(value, fallback = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half"
  });
  return request.json();
}
