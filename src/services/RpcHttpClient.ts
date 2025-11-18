import { RpcClient, PendingRequest } from '../types/rpc';
import axios, { AxiosInstance } from 'axios';

export class RpcHttpClient implements RpcClient {
  private url: string;
  private idCounter = 1;
  private connected = false;
  private axiosInstance: AxiosInstance;
  private healthCheckTimer?: NodeJS.Timeout;
  private healthCheckInterval = 5000; // 5 seconds
  private onOpenCallback?: () => void;
  private onCloseCallback?: (code: number, reason: string) => void;
  private onErrorCallback?: (err: any) => void;

  constructor(url: string) {
    this.url = url;
    this.axiosInstance = axios.create({
      baseURL: url,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  isConnected() {
    return this.connected;
  }

  connect(onOpen?: () => void, onClose?: (code: number, reason: string) => void, onError?: (err: any) => void) {
    console.log(`[RpcHttpClient] Connecting to ${this.url}`);
    this.onOpenCallback = onOpen;
    this.onCloseCallback = onClose;
    this.onErrorCallback = onError;
    
    // Try to connect immediately
    this.performHealthCheck();
  }

  private async performHealthCheck() {
    try {
      console.log(`[RpcHttpClient] Health check for ${this.url}...`);
      // Try a simple RPC call to check connectivity
      await this.call<string>('eth_blockNumber', [], 5000);
      
      if (!this.connected) {
        console.log(`[RpcHttpClient] ✓ Health check passed, connected to ${this.url}`);
        this.connected = true;
        this.onOpenCallback?.();
      }
      
      // Schedule next health check
      this.scheduleHealthCheck();
    } catch (error) {
      console.error(`[RpcHttpClient] ✗ Health check failed for ${this.url}:`, error instanceof Error ? error.message : String(error));
      if (this.connected) {
        this.connected = false;
        const message = error instanceof Error ? error.message : String(error);
        this.onCloseCallback?.(0, message);
      }
      this.onErrorCallback?.(error);
      
      // Continue health checks to detect reconnection
      this.scheduleHealthCheck();
    }
  }

  private scheduleHealthCheck() {
    this.clearHealthCheck();
    this.healthCheckTimer = setTimeout(() => this.performHealthCheck(), this.healthCheckInterval);
  }

  private clearHealthCheck() {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  disconnect() {
    this.connected = false;
    this.clearHealthCheck();
  }

  cleanupOldRequests() {
    // HTTP requests don't accumulate like WebSocket requests
    // This is a no-op for HTTP client
  }

  async call<T = any>(method: string, params: any[] = [], timeoutMs: number = 15000): Promise<T> {
    const id = this.idCounter++;
    const payload = { jsonrpc: '2.0', id, method, params };
    
    console.log(`[RpcHttpClient] → Request #${id}: ${method}`, params.length > 0 ? params : '');
    
    try {
      const t0 = Date.now();
      const response = await this.axiosInstance.post('', payload, {
        timeout: timeoutMs,
      });
      const elapsed = Date.now() - t0;
      
      if (response.data.error) {
        console.error(`[RpcHttpClient] ✗ Response #${id}: RPC error (${elapsed}ms)`, response.data.error);
        throw new Error(response.data.error.message || 'RPC error');
      }
      
      const resultPreview = typeof response.data.result === 'string' 
        ? response.data.result 
        : JSON.stringify(response.data.result).substring(0, 100);
      console.log(`[RpcHttpClient] ← Response #${id}: ${resultPreview} (${elapsed}ms)`);
      
      return response.data.result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          console.error(`[RpcHttpClient] ✗ Request #${id} timeout: ${method} (${timeoutMs}ms)`);
          throw new Error(`RPC request timeout for method: ${method} (${timeoutMs}ms)`);
        }
        if (error.response) {
          console.error(`[RpcHttpClient] ✗ Request #${id} HTTP error:`, error.response.status, error.response.statusText);
          throw new Error(`RPC error: ${error.response.status} ${error.response.statusText}`);
        }
        if (error.request) {
          console.error(`[RpcHttpClient] ✗ Request #${id} network error:`, error.message);
          throw new Error(`Network error: ${error.message}`);
        }
      }
      console.error(`[RpcHttpClient] ✗ Request #${id} unexpected error:`, error);
      throw error;
    }
  }
}

