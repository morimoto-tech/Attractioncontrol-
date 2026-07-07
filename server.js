const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, "preshow-state.json");

const STANDBY_URL = "https://res.cloudinary.com/dccdskvu2/video/upload/v1782729443/%E6%9C%AC%E6%96%87%E3%82%92%E8%BF%BD%E5%8A%A0_jf1qym.mp4";
const MAIN_URL = "https://pub-0ed61d4ebc75420aad491fe4a7019ba8.r2.dev/main.mp4";

const SCENES = {
  standby: {
    id: "standby",
    title: "開始前",
    message: "開始前の案内映像をループ再生します。",
    videoUrl: STANDBY_URL,
    videoName: "開始前映像",
    volumeMultiplier: 0.9
  },
  main: {
    id: "main",
    title: "プレショー",
    message: "プレショー本編を再生します。",
    videoUrl: MAIN_URL,
    videoName: "プレショー本編",
    volumeMultiplier: 1.15
  },
  ending: {
    id: "ending",
    title: "終了後",
    message: "30秒待機したあと、自動で開始前に戻ります。",
    videoUrl: "",
    videoName: "",
    volumeMultiplier: 1
  }
};

const clients = new Set();
let returnTimer = null;

const defaultState = () => ({
  currentScene: "standby",
  isPlaying: false,
  endingReturnDelay: 30,
  masterVolume: 100,
  returnAt: null,
  scenes: buildSceneState(),
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
    scenes: buildSceneState(),
    logs: Array.isArray(candidate.logs) && candidate.logs.length ? candidate.logs.slice(0, 40) : fallback.logs
  };

  if (!SCENES[next.currentScene]) {
    next.currentScene = "standby";
  }

  return next;
}

async function saveState(nextState = state) {
  const storableState = {
    currentScene: nextState.currentScene,
    isPlaying: nextState.isPlaying,
    endingReturnDelay: nextState.endingReturnDelay,
    masterVolume: nextState.masterVolume,
    returnAt: nextState.returnAt,
    logs: nextState.logs
  };
  await fsp.writeFile(STATE_PATH, JSON.stringify(storableState, null, 2), "utf8");
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
    state.masterVolume = sanitizeVolume(body.masterVolume, 100);
    addLog(`設定を更新しました。終了後 ${state.endingReturnDelay}秒 / 音量 ${state.masterVolume}%`);
    syncTimerToState();
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

  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
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
      addLog("終了後の待機が終わり、開始前へ戻しました。");
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
    addLog("終了後の待機を再計算し、開始前へ戻しました。");
    return;
  }

  returnTimer = setTimeout(() => {
    activateScene("standby");
    addLog("終了後の待機が終わり、開始前へ戻しました。");
    void persistAndBroadcast();
  }, delay);
}

function loadDemoState() {
  clearReturnTimer();
  state.currentScene = "standby";
  state.isPlaying = false;
  state.endingReturnDelay = 30;
  state.masterVolume = 100;
  state.returnAt = null;
  state.logs = [
    makeLog("デモ状態を読み込みました。"),
    makeLog("開始前はループ、本編は少し大きめ、終了後は30秒待機です。")
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
    returnAt: state.returnAt,
    scenes: buildSceneState(),
    logs: state.logs,
    availableScenes: Object.values(SCENES)
  };
}

function buildSceneState() {
  return Object.fromEntries(
    Object.values(SCENES).map((scene) => [
      scene.id,
      {
        videoUrl: scene.videoUrl,
        audioUrl: "",
        videoName: scene.videoName,
        audioName: "",
        volumeMultiplier: scene.volumeMultiplier
      }
    ])
  );
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
    return 30;
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
