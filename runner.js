import http from 'node:http';
import { spawn } from 'node:child_process';

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);

const RESTART_BASE_DELAY_MS = 3000;
const RESTART_MAX_DELAY_MS = 60000;
const READY_TIMEOUT_MS = 90000;
const HEARTBEAT_TIMEOUT_MS = 60000;
const RECONNECT_GRACE_MS = 90000;
const STABLE_AFTER_MS = 120000;
const WATCHDOG_INTERVAL_MS = 10000;
const FORCE_KILL_AFTER_MS = 10000;

let botProcess = null;
let shuttingDown = false;
let restartAttempts = 0;
let restartTimer = null;
let stableTimer = null;
let readyTimer = null;
let forceKillTimer = null;
let watchdogTimer = null;
let restartInProgress = false;

let botReady = false;
let lastStartAt = null;
let lastReadyAt = null;
let lastHeartbeatAt = null;
let notReadySince = null;
let lastPing = null;
let lastWsStatus = null;
let lastExit = null;
let lastWatchdogReason = null;

function now() {
  return Date.now();
}

function botIsRunning() {
  return Boolean(botProcess && botProcess.exitCode === null && !botProcess.killed);
}

function heartbeatFresh() {
  return Boolean(lastHeartbeatAt && now() - lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS);
}

function botIsHealthy() {
  return botIsRunning() && botReady && heartbeatFresh();
}

function restartDelay() {
  const exponent = Math.max(0, Math.min(restartAttempts - 1, 5));
  return Math.min(RESTART_BASE_DELAY_MS * (2 ** exponent), RESTART_MAX_DELAY_MS);
}

function clearBotTimers() {
  clearTimeout(stableTimer);
  clearTimeout(readyTimer);
  clearTimeout(forceKillTimer);
  stableTimer = null;
  readyTimer = null;
  forceKillTimer = null;
}

function resetRuntimeState() {
  botReady = false;
  lastHeartbeatAt = null;
  notReadySince = null;
  lastPing = null;
  lastWsStatus = null;
}

function scheduleStart(delay = 0) {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(startBot, delay);
}

function stopBot(reason = 'restart') {
  if (!botProcess || !botIsRunning()) {
    restartInProgress = false;
    scheduleStart(restartDelay());
    return;
  }

  if (restartInProgress) return;
  restartInProgress = true;
  lastWatchdogReason = reason;
  console.error(`[runner] Botを再起動します: ${reason}`);

  try {
    botProcess.kill('SIGTERM');
  } catch (error) {
    console.error('[runner] SIGTERM送信に失敗:', error);
  }

  clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => {
    if (!botIsRunning()) return;
    console.error('[runner] Botが終了しないためSIGKILLします。');
    try {
      botProcess.kill('SIGKILL');
    } catch (error) {
      console.error('[runner] SIGKILL送信に失敗:', error);
    }
  }, FORCE_KILL_AFTER_MS);
  forceKillTimer.unref();
}

function handleChildMessage(message) {
  if (!message || typeof message !== 'object') return;

  const type = message.type;
  const messageTime = Number(message.ts) || now();

  if (type === 'discord-heartbeat') {
    lastHeartbeatAt = messageTime;
    lastPing = message.ping ?? null;
    lastWsStatus = message.wsStatus ?? null;

    if (message.ready) {
      if (!botReady) {
        console.log('[runner] Discord接続のREADYを確認しました。');
      }
      botReady = true;
      lastReadyAt = new Date(messageTime);
      notReadySince = null;
    } else {
      botReady = false;
      notReadySince ??= messageTime;
    }
    return;
  }

  if (type === 'discord-ready' || type === 'discord-shard-ready') {
    botReady = true;
    lastHeartbeatAt = messageTime;
    lastReadyAt = new Date(messageTime);
    notReadySince = null;
    console.log(`[runner] Discord接続イベント: ${type}`);
    return;
  }

  if (type === 'discord-reconnecting' || type === 'discord-disconnect') {
    botReady = false;
    notReadySince ??= messageTime;
    console.warn(`[runner] Discord再接続待ち: ${type}`);
    return;
  }

  if (type === 'discord-shard-error' || type === 'discord-client-error') {
    console.error(`[runner] Discordエラー: ${message.error ?? type}`);
    return;
  }

  if (type === 'process-exception' || type === 'process-rejection') {
    console.error(`[runner] Bot内部例外: ${message.error ?? type}`);
  }
}

function startBot() {
  if (shuttingDown || botIsRunning()) return;

  restartInProgress = false;
  restartAttempts += 1;
  lastStartAt = new Date();
  resetRuntimeState();

  console.log(`[runner] Discord Botを起動します (attempt ${restartAttempts})`);

  botProcess = spawn(
    process.execPath,
    ['--import', './bot-watch.js', 'index.js'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    },
  );

  botProcess.stdout?.setEncoding('utf8');
  botProcess.stderr?.setEncoding('utf8');

  botProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  botProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  botProcess.on('message', handleChildMessage);

  clearBotTimers();

  readyTimer = setTimeout(() => {
    if (botIsRunning() && !botReady) {
      stopBot(`起動後${Math.round(READY_TIMEOUT_MS / 1000)}秒以内にDiscord READYになりませんでした`);
    }
  }, READY_TIMEOUT_MS);
  readyTimer.unref();

  stableTimer = setTimeout(() => {
    if (botIsHealthy()) {
      restartAttempts = 0;
      console.log('[runner] Botは安定稼働中です。再起動カウンターをリセットしました。');
    }
  }, STABLE_AFTER_MS);
  stableTimer.unref();

  botProcess.on('error', (error) => {
    console.error('[runner] Botプロセスの起動エラー:', error);
  });

  botProcess.on('exit', (code, signal) => {
    clearBotTimers();

    lastExit = {
      at: new Date().toISOString(),
      code,
      signal,
      reason: lastWatchdogReason,
    };

    console.error(`[runner] Botが停止しました code=${code} signal=${signal ?? 'none'}`);
    botProcess = null;
    restartInProgress = false;
    resetRuntimeState();

    if (shuttingDown) return;

    const delay = restartDelay();
    console.log(`[runner] ${Math.round(delay / 1000)}秒後にBotを自動再起動します。`);
    scheduleStart(delay);
  });
}

function runWatchdog() {
  if (shuttingDown) return;

  if (!botIsRunning()) {
    if (!restartTimer) scheduleStart(restartDelay());
    return;
  }

  const startedAt = lastStartAt?.getTime() ?? now();
  const runningFor = now() - startedAt;

  if (!lastHeartbeatAt && runningFor > READY_TIMEOUT_MS) {
    stopBot('heartbeatを一度も受信できませんでした');
    return;
  }

  if (lastHeartbeatAt && now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
    stopBot(`heartbeatが${Math.round(HEARTBEAT_TIMEOUT_MS / 1000)}秒以上停止しました`);
    return;
  }

  if (!botReady && notReadySince && now() - notReadySince > RECONNECT_GRACE_MS) {
    stopBot(`Discord再接続が${Math.round(RECONNECT_GRACE_MS / 1000)}秒以上完了しませんでした`);
  }
}

const server = http.createServer((req, res) => {
  const healthy = botIsHealthy();
  const heartbeatAgeMs = lastHeartbeatAt ? now() - lastHeartbeatAt : null;

  if (req.url === '/health') {
    res.writeHead(healthy ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      ok: healthy,
      processRunning: botIsRunning(),
      discordReady: botReady,
      heartbeatFresh: heartbeatFresh(),
      heartbeatAgeMs,
      discordPingMs: lastPing,
      wsStatus: lastWsStatus,
      supervisorUptimeSeconds: Math.floor(process.uptime()),
      lastStartAt: lastStartAt?.toISOString() ?? null,
      lastReadyAt: lastReadyAt?.toISOString() ?? null,
      lastExit,
      lastWatchdogReason,
    }));
    return;
  }

  if (req.url === '/live') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true, supervisor: 'running' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(healthy
    ? 'Discord Verify Bot is online and connected.\n'
    : 'Discord Verify Bot supervisor is recovering the bot.\n');
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;

server.on('error', (error) => {
  console.error('[runner] HTTPサーバーエラー:', error);
  setTimeout(() => process.exit(1), 500).unref();
});

server.listen(PORT, HOST, () => {
  console.log(`[runner] Health server: http://${HOST}:${PORT}/health`);
  startBot();

  watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runner] ${signal}を受信しました。終了処理を行います。`);

  clearTimeout(restartTimer);
  clearBotTimers();
  clearInterval(watchdogTimer);

  if (botIsRunning()) {
    try {
      botProcess.kill('SIGTERM');
    } catch {}
  }

  server.close(() => process.exit(0));

  setTimeout(() => {
    if (botIsRunning()) {
      try {
        botProcess.kill('SIGKILL');
      } catch {}
    }
    process.exit(0);
  }, FORCE_KILL_AFTER_MS).unref();
}

function fatalSupervisorError(label, error) {
  console.error(`[runner] ${label}:`, error);
  setTimeout(() => process.exit(1), 500).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => fatalSupervisorError('uncaughtException', error));
process.on('unhandledRejection', (reason) => fatalSupervisorError('unhandledRejection', reason));
