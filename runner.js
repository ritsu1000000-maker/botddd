import http from 'node:http';
import { spawn } from 'node:child_process';

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);
const RESTART_BASE_DELAY_MS = 3000;
const RESTART_MAX_DELAY_MS = 30000;
const STABLE_AFTER_MS = 120000;

let botProcess = null;
let shuttingDown = false;
let restartAttempts = 0;
let restartTimer = null;
let stableTimer = null;
let lastStartAt = null;
let lastExit = null;

function botIsRunning() {
  return Boolean(botProcess && botProcess.exitCode === null && !botProcess.killed);
}

function restartDelay() {
  return Math.min(
    RESTART_BASE_DELAY_MS * Math.max(1, 2 ** Math.min(restartAttempts, 4)),
    RESTART_MAX_DELAY_MS,
  );
}

function startBot() {
  if (shuttingDown || botIsRunning()) return;

  restartAttempts += 1;
  lastStartAt = new Date();
  console.log(`[runner] Discord Bot を起動します (attempt ${restartAttempts})`);

  botProcess = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    if (botIsRunning()) {
      restartAttempts = 0;
      console.log('[runner] Bot は安定稼働中です。再起動カウンターをリセットしました。');
    }
  }, STABLE_AFTER_MS);

  botProcess.on('error', (error) => {
    console.error('[runner] Botプロセスの起動エラー:', error);
  });

  botProcess.on('exit', (code, signal) => {
    clearTimeout(stableTimer);
    lastExit = {
      at: new Date().toISOString(),
      code,
      signal,
    };

    console.error(`[runner] Botが停止しました code=${code} signal=${signal ?? 'none'}`);
    botProcess = null;

    if (shuttingDown) return;

    const delay = restartDelay();
    console.log(`[runner] ${Math.round(delay / 1000)}秒後にBotを再起動します。`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startBot, delay);
  });
}

const server = http.createServer((req, res) => {
  const running = botIsRunning();

  if (req.url === '/health') {
    res.writeHead(running ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: running,
      bot: running ? 'running' : 'restarting',
      uptimeSeconds: Math.floor(process.uptime()),
      lastStartAt: lastStartAt?.toISOString() ?? null,
      lastExit,
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(running ? 'Discord Verify Bot is running.\n' : 'Discord Verify Bot is restarting.\n');
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;

server.on('error', (error) => {
  console.error('[runner] HTTPサーバーエラー:', error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`[runner] Health server: http://${HOST}:${PORT}/health`);
  startBot();
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runner] ${signal} を受信しました。終了処理を行います。`);

  clearTimeout(restartTimer);
  clearTimeout(stableTimer);

  if (botIsRunning()) {
    botProcess.kill('SIGTERM');
  }

  server.close(() => process.exit(0));

  setTimeout(() => {
    if (botIsRunning()) botProcess.kill('SIGKILL');
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[runner] unhandledRejection:', reason);
});
