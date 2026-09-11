/** Type surface for the JavaScript Yaci harness used by TypeScript devnet tests. */

export declare const ADMIN_URL: string;
export declare const STORE_URL: string;
export declare const OGMIOS_URL: string;
export declare const KUPO_URL: string;
export declare const TEST_MNEMONIC: string;

export declare function requireDevnet(): Promise<void>;
export declare function getYaciChain(): Promise<any>;
export declare function topupAddress(address: string, ada: number | bigint): Promise<void>;
export declare function resetDevnet(): Promise<void>;
export declare function latestBlock(): Promise<any>;
export declare function makeClient(mnemonic?: string): Promise<any>;

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  what?: string;
}

export declare function waitFor<T>(
  fn: () => T | Promise<T>,
  options?: WaitOptions,
): Promise<Awaited<T>>;

export declare function settleWallet(
  client: any,
  addressObj: any,
  options?: { attempts?: number; intervalMs?: number },
): Promise<void>;

export declare function retryTransient<T>(
  fn: () => T | Promise<T>,
  options?: { attempts?: number; delayMs?: number; label?: string },
): Promise<Awaited<T>>;
