/**
 * 同端口 WebSocket 广播（对齐 AionsHome /ws 意图）。
 * 事件：monitor_log · monitor_alert；路径固定 /ws。
 */
const { WebSocketServer } = require("ws");

/** @type {import('ws').WebSocketServer | null} */
let wss = null;
/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

function clientCount() {
  return clients.size;
}

function isOpen(socket) {
  /* 1 = OPEN（避免硬依赖 ws 常量在测试里） */
  return socket && socket.readyState === 1;
}

/**
 * 挂到已有 http.Server；可重复调用（只建一次）。
 * @param {import('node:http').Server} server
 */
function attachWsHub(server) {
  if (wss) return wss;
  if (!server) {
    const err = new Error("attachWsHub: need http server");
    err.code = "ws_no_server";
    throw err;
  }
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket, req) => {
    clients.add(socket);
    try {
      socket.send(
        JSON.stringify({
          type: "hello",
          ok: true,
          path: "/ws",
          clients: clients.size,
        })
      );
    } catch (_) {}
    socket.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(String(raw || ""));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      /* 客户端心跳 */
      if (msg.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", t: Date.now() }));
        } catch (_) {}
        return;
      }
      /* H3.3：通话 WebRTC 信令转发给其它端（不回声） */
      if (msg.type === "call_signal") {
        const line = JSON.stringify(msg);
        for (const other of clients) {
          if (other === socket || !isOpen(other)) continue;
          try {
            other.send(line);
          } catch (_) {
            clients.delete(other);
          }
        }
      }
    });
    const drop = () => {
      clients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });
  return wss;
}

/**
 * @param {object} payload 须含 type
 * @returns {{ ok: boolean, sent: number }}
 */
function broadcast(payload) {
  if (!payload || typeof payload !== "object" || !payload.type) {
    return { ok: false, sent: 0 };
  }
  const line = JSON.stringify(payload);
  let sent = 0;
  for (const socket of clients) {
    if (!isOpen(socket)) {
      clients.delete(socket);
      continue;
    }
    try {
      socket.send(line);
      sent += 1;
    } catch (_) {
      clients.delete(socket);
    }
  }
  return { ok: true, sent };
}

function broadcastMonitorLog(entry) {
  return broadcast({ type: "monitor_log", data: entry });
}

/**
 * 对齐 AionsHome monitor_alert：看屏幕 / 截屏前提示各端。
 * @param {string} content
 * @param {object} [extra]
 */
function broadcastMonitorAlert(content, extra) {
  const data = Object.assign(
    {
      content: String(content || "即将查看屏幕").trim().slice(0, 120) || "即将查看屏幕",
      ts: Date.now(),
    },
    extra && typeof extra === "object" ? extra : {}
  );
  if (data.seconds != null) {
    data.seconds = Math.max(0, Math.min(30, Math.floor(Number(data.seconds) || 0)));
  }
  return broadcast({ type: "monitor_alert", data });
}

function selfCheck() {
  console.assert(typeof attachWsHub === "function");
  console.assert(clientCount() === 0);
  const r = broadcast({ type: "monitor_log", data: { monitoringlog: "self" } });
  console.assert(r.ok === true && r.sent === 0);
  const a = broadcastMonitorAlert("自检提示", { kind: "selfcheck", seconds: 5 });
  console.assert(a.ok === true && a.sent === 0);
  const bad = broadcast({ nope: 1 });
  console.assert(bad.ok === false);
  console.log("ws-hub self-check ok");
}

if (require.main === module) {
  selfCheck();
  /* 本地冒烟：临时 HTTP + /ws，发一条 monitor_log 应能收到 */
  const http = require("node:http");
  const WebSocket = require("ws");
  const srv = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  attachWsHub(srv);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    const client = new WebSocket("ws://127.0.0.1:" + port + "/ws");
    let gotLog = false;
    let gotAlert = false;
    client.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "monitor_log" && msg.data && msg.data.monitoringlog === "smoke") {
          gotLog = true;
        }
        if (msg.type === "monitor_alert" && msg.data && msg.data.kind === "smoke") {
          gotAlert = true;
        }
      } catch (_) {}
    });
    client.on("open", () => {
      setTimeout(() => {
        broadcastMonitorLog({ monitoringlog: "smoke", kind: "selfcheck" });
        broadcastMonitorAlert("smoke alert", { kind: "smoke", seconds: 5 });
        setTimeout(() => {
          client.close();
          srv.close();
          if (!gotLog || !gotAlert) {
            console.error("ws smoke failed", { gotLog, gotAlert });
            process.exit(1);
          }
          console.log("ws-hub smoke ok on port", port);
        }, 80);
      }, 40);
    });
    client.on("error", (e) => {
      console.error(e);
      process.exit(1);
    });
  });
}

module.exports = {
  attachWsHub,
  broadcast,
  broadcastMonitorLog,
  broadcastMonitorAlert,
  clientCount,
  selfCheck,
};
