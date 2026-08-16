import { Client } from 'discord.js';

const HEARTBEAT_INTERVAL_MS = 15000;
const originalLogin = Client.prototype.login;

function send(message) {
  if (typeof process.send !== 'function') return;
  try {
    process.send({ ...message, ts: Date.now() });
  } catch {
    // 親プロセスが終了中なら無視する。
  }
}

function exitForRecovery(type, error) {
  send({
    type,
    error: error instanceof Error ? error.message : String(error),
    ready: false,
  });

  // 壊れた状態のプロセスを無理に継続せず、親runnerに再起動させる。
  setTimeout(() => process.exit(1), 100).unref();
}

Client.prototype.login = async function supervisedLogin(...args) {
  if (!this.__botWatchInstalled) {
    Object.defineProperty(this, '__botWatchInstalled', {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    const heartbeat = () => {
      let ready = false;
      let wsStatus = null;
      let ping = null;

      try {
        ready = this.isReady();
        wsStatus = this.ws?.status ?? null;
        ping = Number.isFinite(this.ws?.ping) ? this.ws.ping : null;
      } catch {
        // 状態取得に失敗しても次のheartbeatで再試行する。
      }

      send({
        type: 'discord-heartbeat',
        ready,
        wsStatus,
        ping,
      });
    };

    this.on('clientReady', () => {
      send({ type: 'discord-ready', ready: true });
      heartbeat();
    });

    this.on('shardReady', (id) => {
      send({ type: 'discord-shard-ready', shardId: id, ready: this.isReady() });
    });

    this.on('shardResume', (id, replayedEvents) => {
      send({
        type: 'discord-shard-ready',
        shardId: id,
        replayedEvents,
        ready: this.isReady(),
      });
    });

    this.on('shardReconnecting', (id) => {
      send({ type: 'discord-reconnecting', shardId: id, ready: false });
    });

    this.on('shardDisconnect', (event, id) => {
      send({
        type: 'discord-disconnect',
        shardId: id,
        code: event?.code ?? null,
        ready: false,
      });
    });

    this.on('shardError', (error, id) => {
      send({
        type: 'discord-shard-error',
        shardId: id,
        error: error?.message ?? String(error),
        ready: this.isReady(),
      });
    });

    this.on('error', (error) => {
      send({
        type: 'discord-client-error',
        error: error?.message ?? String(error),
        ready: this.isReady(),
      });
    });

    this.on('invalidated', () => {
      exitForRecovery('discord-invalidated', 'Discord session invalidated');
    });

    const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    heartbeat();
  }

  return originalLogin.apply(this, args);
};

process.on('uncaughtExceptionMonitor', (error, origin) => {
  send({
    type: 'process-exception',
    error: error?.message ?? String(error),
    origin,
    ready: false,
  });
});

process.on('unhandledRejection', (reason) => {
  exitForRecovery('process-rejection', reason);
});
