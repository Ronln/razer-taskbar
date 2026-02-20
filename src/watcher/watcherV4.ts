import { WatchProcess } from './watch_process';
import { AppSettings, getSettings } from '../settings_manager';
import path from 'path';
import fs from 'fs';
import fsa from 'fs/promises';

interface LoggedDeviceInfoV4 {
    serialNumber: string;
    hasBattery: boolean;
    deviceContainerId: string;
    powerStatus: {
        chargingStatus: 'NoCharge_BatteryFull' | 'Charging';
        level: number;
    };
    name: {
        en: string;
        [lang: string]: string;
    };
    productName: {
        en: string;
        [lang: string]: string;
    };
}

export const SynapseV4LogDir = path.resolve(process.env.LOCALAPPDATA, 'Razer', 'RazerAppEngine', 'User Data', 'Logs');

export class WatcherV4 extends WatchProcess {
    private watcher: fs.FSWatcher | null = null;
    private synapseV4LogPath: string | null = null;
    private watcherRetryTimeout: NodeJS.Timeout | null = null;

    start(): void {
        const settings = getSettings();
        try {
            this.stop();

            console.log("init v4 change handler");
            this.findLatestSynapseV4LogFile();
            if (!this.synapseV4LogPath) {
                throw new Error("Cannot start V4 change handler because V4 log path could not be resolved");
            }

            // use fs.watchFile instead of fs.watch for V4 logs. We need polling here to get notified about the changes in time.
            const v4LogFunc = () => this.onLogChangedV4(settings);
            fs.watchFile(this.synapseV4LogPath, { interval: settings.pollingThrottleSeconds * 1000 }, (curr) => {
                console.log(`V4 log change detected ${curr.mtime}`);
                v4LogFunc();
            });
            v4LogFunc();
        } catch (e) {
            console.log(`Error during change handler init: ${e}`);
            this.stop();
            this.watcherRetryTimeout = setTimeout(() => this.start(), settings.pollingThrottleSeconds * 1000);
        }
    }

    stop() {
        if (this.synapseV4LogPath) { fs.unwatchFile(this.synapseV4LogPath); }
        this.watcher?.close();
        this.watcher = null;
        if (this.watcherRetryTimeout) { clearTimeout(this.watcherRetryTimeout); }
        this.watcherRetryTimeout = null;
    }

    private findLatestSynapseV4LogFile(): void {
        this.synapseV4LogPath = null;
        try {
            if (!fs.existsSync(SynapseV4LogDir)) {
                console.warn('[V4] Log directory not found');
                return;
            }

            const candidates = fs.readdirSync(SynapseV4LogDir)
                .filter(name => /^systray_systrayv2\d*\.log$/i.test(name))
                .map(name => {
                    const fullPath = path.resolve(SynapseV4LogDir, name);
                    const stat = fs.statSync(fullPath);
                    return { name, fullPath, mtime: stat.mtime.getTime() };
                });

            if (candidates.length === 0) {
                console.warn('[V4] No log files found');
                return;
            }

            candidates.sort((a, b) => b.mtime - a.mtime);
            this.synapseV4LogPath = candidates[0].fullPath;

            console.log(`[V4] ✅ Selected newest: ${candidates[0].name}`);
        } catch (e) {
            console.error(`[V4] Error selecting log: ${e}`);
        }
    }

    private latestParsedTimeStamp = '';

    private async onLogChangedV4(settings: AppSettings): Promise<void> {
        const start = performance.now();
        const shownDeviceHandle = settings.shownDeviceHandle;

        try {
            const log = await fsa.readFile(this.synapseV4LogPath!, { encoding: 'utf8' });

            // Ловим все возможные форматы с батареей
            const regex = /^\[(?<timestamp>.+?)\].*?(connectingDeviceData|mapDevices|SYNAPSE_DEVICES_SET).*?(?<json>\[[\s\S]*?\])/gm;

            let matches: { timestamp: string; jsonStr: string }[] = [];
            let match;
            while ((match = regex.exec(log)) !== null) {
                matches.push({ timestamp: match.groups!.timestamp, jsonStr: match.groups!.json.trim() });
            }

            if (matches.length === 0) {
                console.warn('[V4] No device data in log');
                return;
            }

            const last = matches[matches.length - 1];

            if (this.latestParsedTimeStamp === last.timestamp) {
                return;
            }

            this.latestParsedTimeStamp = last.timestamp;

            // Парсим как any, чтобы TS не ругался
            let raw: any = JSON.parse(last.jsonStr);

            // Если пришёл объект {devices: [...]}, берём массив
            if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.devices)) {
                raw = raw.devices;
            }

            const devices: LoggedDeviceInfoV4[] = Array.isArray(raw) ? raw : [];

            // Очищаем и обновляем только устройства с батареей
            this.devices.clear();

            devices.filter(d => d.hasBattery === true).forEach(device => {
                const handle = device.serialNumber || device.deviceContainerId || 'UNKNOWN';

                this.devices.set(handle, {
                    name: device.name?.en || device.productName?.en || 'Unknown Device',
                    handle: handle,
                    isConnected: true,
                    batteryPercentage: device.powerStatus?.level ?? 0,
                    isCharging: device.powerStatus?.chargingStatus === 'Charging',
                    isSelected: shownDeviceHandle === handle || shownDeviceHandle === '',
                });
            });

            console.log(`[V4] ✅ Parsed ${this.devices.size} battery device(s) at ${last.timestamp}`);
            console.log(`[V4] Battery levels:`, [...this.devices.values()].map(d => `${d.name} — ${d.batteryPercentage}%`));

            this.trayManager.onDeviceUpdate(this.devices);

        } catch (e: any) {
            console.error(`[V4] Parse error: ${e.message}`);
        }
    }
}
