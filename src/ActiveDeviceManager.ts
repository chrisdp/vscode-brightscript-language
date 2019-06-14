import * as backoff from 'backoff';
import { EventEmitter } from 'events';
import * as xmlParser from 'fast-xml-parser';
import * as http from 'http';
import * as NodeCache from 'node-cache';
import { Client as Client, SsdpHeaders } from 'node-ssdp';
import * as url from 'url';
import * as vscode from 'vscode';

const DEFAULT_TIMEOUT = 10000;

export class ActiveDeviceManager extends EventEmitter {

    constructor() {
        super();
        this.isRunning = false;

        let config: any = vscode.workspace.getConfiguration('brightscript') || {};
        this.enabled = (config.deviceDiscovery || {}).enabled;
        this.showInfoMessages = (config.deviceDiscovery || {}).showInfoMessages;
        vscode.workspace.onDidChangeConfiguration((e) => {
            let config: any = vscode.workspace.getConfiguration('brightscript') || {};
            this.enabled = (config.deviceDiscovery || {}).enabled;
            this.showInfoMessages = (config.deviceDiscovery || {}).showInfoMessages;
            this.processEnabledState();
        });

        this.deviceCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
        this.activeDevices = [];

        this.processEnabledState();
    }

    public activeDevices: any[] = [];
    public lastUsedDevice: string;
    private enabled: boolean;
    private showInfoMessages: boolean;
    private deviceCache: NodeCache;
    private exponentialBackoff: any;
    private isRunning: boolean;

    public getActiveDevices() {
        return this.deviceCache.mget(this.deviceCache.keys());
    }

    private processEnabledState() {
        if (this.enabled && !this.isRunning) {
            this.findDevices();
        } else if (!this.enabled && this.isRunning) {
            this.stop();
        }
    }
    private stop() {
        if (this.exponentialBackoff) {
            this.exponentialBackoff.reset();
        }

        this.deviceCache.flushAll();
        this.isRunning = false;
    }

    private findDevices() {
        this.exponentialBackoff = backoff.exponential({
            randomisationFactor: 0,
            initialDelay: 1000,
            maxDelay: 30000
        });

        this.exponentialBackoff.on('ready', (eventNumber, delay) => {
            this.discoverAll(delay).then((ip) => {
                ip = ip;
            });
            this.exponentialBackoff.backoff();
        });

        this.exponentialBackoff.backoff();
        this.isRunning = true;
    }

    /**
     * Discover all Roku devices on the network. This method always waits the full
     * timeout, resolving to a list of all Roku device addresses that responded
     * within `timeout` ms.
     * @param timeout The time to wait in ms before giving up.
     * @return A promise resolving to a list of Roku device addresses.
     */
    private discoverAll( timeout: number = DEFAULT_TIMEOUT ): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const finder = new RokuFinder();
            const devices: string[] = [];

            finder.on('found', (device) => {
                if (devices.indexOf(device) === -1) {
                    if (this.deviceCache.get(device.deviceInfo['device-id']) === undefined) {
                        // New device found
                        vscode.window.showInformationMessage(`Device found: ${device.deviceInfo['default-device-name']}`);
                    }
                    this.deviceCache.set(device.deviceInfo['device-id'], device);
                    devices.push(device);
                }
            });

            finder.on('timeout', () => {
                if (devices.length > 0) {
                    // debug('found Roku devices at %o after %dms', addresses, elapsedTime());
                    resolve(devices);
                } else {
                    reject(new Error(`Could not find any Roku devices after ${timeout / 1000} seconds`));
                }
            });

            finder.start(timeout);
        });
    }
}

class RokuFinder extends EventEmitter {

    constructor() {
        super();

        this.client = new Client();

        this.client.on('response', (headers: SsdpHeaders) => {
            if (!this.running) {
                return;
            }
            let localHeaders = headers;
            const { ST, LOCATION } = headers;
            if (ST && LOCATION && ST.indexOf('roku') !== -1) {
                http.get(`${LOCATION}/query/device-info`, (resp) => {
                    // Get the device info
                    let data = '';
                    let header = localHeaders;
                    let loc = header.LOCATION;

                    resp.on('data', (chunk) => {
                        // A chunk of data has been received.
                        data += chunk;
                    });

                    resp.on('end', () => {
                        // The whole response has been received.
                        let head = header;
                        let info = xmlParser.parse(data);
                        const device = this.parseAddress(LOCATION);
                        device.deviceInfo = info['device-info'];
                        this.emit('found', device);
                    });
                });
            }
        });
    }

    private readonly client: Client;
    private intervalId: NodeJS.Timer | null = null;
    private timeoutId: NodeJS.Timer | null = null;
    private running: boolean = false;

    private parseAddress(location: string): any {
        const parts = url.parse(location);
        parts.path = undefined;
        parts.pathname = undefined;
        return { location: url.format(parts), ip: parts.hostname, deviceInfo: {} };
    }

    public start(timeout: number) {
        this.running = true;

        const search = () => {
            this.client.search('roku:ecp');
        };

        const done = () => {
            this.stop();
            this.emit('timeout');
        };

        search();
        this.intervalId = setInterval(search, 1000);
        this.timeoutId = setTimeout(done, timeout);
    }

    public stop() {
        clearInterval(this.intervalId!);
        clearTimeout(this.timeoutId!);
        this.running = false;
        this.client.stop();
    }
}
