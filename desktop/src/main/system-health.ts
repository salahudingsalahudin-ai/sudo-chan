import os from 'node:os';

export const HEAVY_SYSTEM_MESSAGE = 'Laptop thoda garam/heavy chal raha hai, koi heavy tab band karni hai?';

export interface MemoryInfo {
  usedBytes: number;
  totalBytes: number;
  percent: number;
  isHeavy: boolean;
}

export function calculateMemoryUsage(freemem: number, totalmem: number, thresholdPercent = 88): MemoryInfo {
  if (totalmem <= 0 || freemem < 0) {
    return { usedBytes: 0, totalBytes: 0, percent: 0, isHeavy: false };
  }
  const clampedFree = Math.min(freemem, totalmem);
  const usedBytes = totalmem - clampedFree;
  const percent = Math.round((usedBytes / totalmem) * 1000) / 10; // e.g. 88.5
  return {
    usedBytes,
    totalBytes: totalmem,
    percent,
    isHeavy: percent > thresholdPercent,
  };
}

export interface SystemHealthOptions {
  checkIntervalMs?: number;
  thresholdPercent?: number;
  alertCooldownMs?: number;
  onHeavyLoad?: (message: string, usagePercent: number) => void;
  onNormalLoad?: (usagePercent: number) => void;
  getMemory?: () => { freemem: number; totalmem: number };
}

export class SystemHealthMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private lastAlertTime = 0;
  private currentHeavy = false;
  private lastPercent = 0;
  private readonly checkIntervalMs: number;
  private readonly thresholdPercent: number;
  private readonly alertCooldownMs: number;
  private readonly onHeavyLoad?: (message: string, usagePercent: number) => void;
  private readonly onNormalLoad?: (usagePercent: number) => void;
  private readonly getMemory: () => { freemem: number; totalmem: number };

  constructor(options?: SystemHealthOptions) {
    this.checkIntervalMs = options?.checkIntervalMs ?? 10_000;
    this.thresholdPercent = options?.thresholdPercent ?? 88;
    this.alertCooldownMs = options?.alertCooldownMs ?? 5 * 60 * 1000;
    this.onHeavyLoad = options?.onHeavyLoad;
    this.onNormalLoad = options?.onNormalLoad;
    this.getMemory = options?.getMemory ?? (() => ({ freemem: os.freemem(), totalmem: os.totalmem() }));
  }

  getMemoryInfo(): MemoryInfo {
    const { freemem, totalmem } = this.getMemory();
    return calculateMemoryUsage(freemem, totalmem, this.thresholdPercent);
  }

  start(): void {
    this.stop();
    this.check();
    this.timer = setInterval(() => {
      this.check();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  check(): MemoryInfo {
    const { freemem, totalmem } = this.getMemory();
    const info = calculateMemoryUsage(freemem, totalmem, this.thresholdPercent);
    this.lastPercent = info.percent;

    if (info.isHeavy) {
      this.currentHeavy = true;
      const now = Date.now();
      if (now - this.lastAlertTime >= this.alertCooldownMs) {
        this.lastAlertTime = now;
        try {
          this.onHeavyLoad?.(HEAVY_SYSTEM_MESSAGE, info.percent);
        } catch {
          // Callback error safety
        }
      }
    } else {
      if (this.currentHeavy) {
        this.currentHeavy = false;
        try {
          this.onNormalLoad?.(info.percent);
        } catch {
          // Callback error safety
        }
      }
    }

    return info;
  }

  isHeavy(): boolean {
    return this.currentHeavy;
  }

  getLastPercent(): number {
    return this.lastPercent;
  }
}
