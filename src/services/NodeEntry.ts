import { NodeSnapshot } from '../types/node';
import { RpcClient } from '../types/rpc';
import { RpcHttpClient } from './RpcHttpClient';
import { toHexBlock } from '../utils/file';

export class NodeEntry {
  public name: string;
  public host: string;
  public rpcPort: number;
  public rpc: RpcClient;
  private pollTimer?: NodeJS.Timeout;
  private pollIntervalMs = 3000;
  private polling = false;
  public snapshot: NodeSnapshot;
  private connectedSince?: number;
  private lastBlockTimestampSec?: number; // seconds
  private timesWindow: number[] = [];

  constructor(name: string, host: string, rpcPort: number) {
    this.name = name;
    this.host = host;
    this.rpcPort = rpcPort;
    const url = this.resolveHttpUrl(host, rpcPort);
    this.rpc = new RpcHttpClient(url);
    this.snapshot = {
      name,
      host,
      rpcPort,
      connected: false,
      lastDisconnected: Date.now(),
    };
  }

  private resolveHttpUrl(host: string, port: number) {
    try {
      if (/^https?:\/\//i.test(host)) {
        return host;
      }
    } catch {}
    return `http://${host}:${port}`;
  }

  start(onUpdate: (s: NodeSnapshot) => void) {
    console.log(`[${this.name}] Starting node connection to ${this.host}:${this.rpcPort}`);
    const handleOpen = () => {
      console.log(`[${this.name}] ✓ Connected successfully`);
      this.snapshot.connected = true;
      this.snapshot.lastError = undefined;
      this.snapshot.lastUpdated = Date.now();
      this.snapshot.lastDisconnected = undefined;
      this.connectedSince = Date.now();
      this.snapshot.uptimeMs = 0;
      onUpdate(this.snapshot);
      this.schedulePoll(onUpdate);
    };
    const handleClose = (code: number, reason: string) => {
      console.log(`[${this.name}] ✗ Connection closed - code: ${code}, reason: ${reason}`);
      this.snapshot.connected = false;
      this.snapshot.lastError = reason && reason.length > 0 ? `Connection error: ${reason}` : (this.snapshot.lastError || 'Connection closed');
      this.snapshot.lastUpdated = Date.now();
      
      if (!this.snapshot.lastDisconnected) {
        this.snapshot.lastDisconnected = Date.now();
      }
      
      onUpdate(this.snapshot);
      this.clearPoll();
    };
    const handleError = (err: any) => {
      const msg = err?.message || err?.code || err?.name || err;
      console.error(`[${this.name}] ✗ Connection error:`, msg);
      this.snapshot.lastError = String(msg);
      onUpdate(this.snapshot);
    };
    this.rpc.connect(handleOpen, handleClose, handleError);
  }

  stop() {
    this.polling = false;
    this.clearPoll();
    this.rpc.disconnect();
  }

  private clearPoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedulePoll(onUpdate: (s: NodeSnapshot) => void) {
    this.clearPoll();
    this.pollTimer = setTimeout(() => this.poll(onUpdate), this.pollIntervalMs);
  }

  private async poll(onUpdate: (s: NodeSnapshot) => void) {
    // Prevent multiple simultaneous polls
    if (this.polling) {
      console.debug(`[${this.name}] Skipping poll - already polling`);
      this.schedulePoll(onUpdate);
      return;
    }
    
    if (!this.rpc.isConnected()) {
      console.debug(`[${this.name}] Skipping poll - not connected`);
      this.schedulePoll(onUpdate);
      return;
    }

    this.polling = true;
    console.log(`[${this.name}] Starting poll...`);

    try {
      const t0 = Date.now();
      console.log(`[${this.name}] → eth_blockNumber`);
      const blockHex = await this.rpc.call<string>('eth_blockNumber');
      const latencyMs = Date.now() - t0;
      console.log(`[${this.name}] ← eth_blockNumber: ${blockHex} (${latencyMs}ms)`);

      console.log(`[${this.name}] → Fetching node info (5 calls)...`);
      const [peerHex, clientVer, syncing, mining, gasPriceHex] = await Promise.all([
        this.rpc.call<string>('net_peerCount'),
        this.rpc.call<string>('web3_clientVersion'),
        this.rpc.call<false | { startingBlock: string; currentBlock: string; highestBlock: string }>('eth_syncing'),
        this.rpc.call<boolean>('eth_mining').catch(() => false),
        this.rpc.call<string>('eth_gasPrice').catch(() => '0x0'),
      ]);
      console.log(`[${this.name}] ← Received: peers=${peerHex}, client=${clientVer}, syncing=${JSON.stringify(syncing)}, mining=${mining}, gasPrice=${gasPriceHex}`);

      const latestBlock = parseInt(blockHex, 16);
      const peerCount = parseInt(peerHex, 16);
      const gasPrice = parseInt(gasPriceHex, 16);
      const gasGwei = Number.isFinite(gasPrice) ? gasPrice / 1e9 : undefined;

      this.snapshot.latestBlock = Number.isFinite(latestBlock) ? latestBlock : this.snapshot.latestBlock;
      this.snapshot.peerCount = Number.isFinite(peerCount) ? peerCount : this.snapshot.peerCount;
      this.snapshot.clientVersion = clientVer || this.snapshot.clientVersion;
      this.snapshot.syncing = syncing || this.snapshot.syncing;
      this.snapshot.mining = mining;
      this.snapshot.latencyMs = latencyMs;
      this.snapshot.gasPriceGwei = gasGwei;

      if (Number.isFinite(latestBlock)) {
        console.log(`[${this.name}] → eth_getBlockByNumber (block ${latestBlock})`);
        const latestBlockObj = await this.rpc
          .call<any>('eth_getBlockByNumber', [toHexBlock(latestBlock), false])
          .catch((err) => {
            console.error(`[${this.name}] ✗ Failed to fetch block details:`, err?.message || err);
            return undefined;
          });
        if (latestBlockObj) {
          const tsSec = parseInt(latestBlockObj.timestamp, 16);
          const txCount = Array.isArray(latestBlockObj.transactions) ? latestBlockObj.transactions.length : undefined;
          console.log(`[${this.name}] ← Block ${latestBlock}: ${txCount} txs, timestamp=${tsSec}`);
          this.snapshot.blockTxs = txCount;
          const gasUsed = parseInt(latestBlockObj.gasUsed, 16);
          this.snapshot.gasUsed = Number.isFinite(gasUsed) ? gasUsed : this.snapshot.gasUsed;
          const gasLimit = parseInt(latestBlockObj.gasLimit, 16);
          this.snapshot.gasLimit = Number.isFinite(gasLimit) ? gasLimit : this.snapshot.gasLimit;
          if (Number.isFinite(tsSec)) {
            this.snapshot.blockPropagationMs = Date.now() - tsSec * 1000;
            
            if (typeof this.lastBlockTimestampSec === 'number' && tsSec > this.lastBlockTimestampSec) {
              const dt = (tsSec - this.lastBlockTimestampSec) * 1000;
              this.snapshot.blockTimeMs = dt;
              this.timesWindow.push(dt);
              if (this.timesWindow.length > 10) this.timesWindow.shift();
            }
            this.lastBlockTimestampSec = tsSec;
            if (this.timesWindow.length) {
              const sum = this.timesWindow.reduce((a, b) => a + b, 0);
              this.snapshot.blockTimeAvgMs = sum / this.timesWindow.length;
            }
          }
        }
      }

      this.snapshot.connected = true;
      this.snapshot.lastError = undefined;
      this.snapshot.lastUpdated = Date.now();
      console.log(`[${this.name}] ✓ Poll completed successfully`);
    } catch (e: any) {
      console.error(`[${this.name}] ✗ Poll failed:`, e?.message || e);
      this.snapshot.lastError = String(e?.message || e);
      this.snapshot.connected = this.rpc.isConnected();
      this.snapshot.lastUpdated = Date.now();
    } finally {
      this.polling = false;
      onUpdate(this.snapshot);
      this.schedulePoll(onUpdate);
    }
  }
}
