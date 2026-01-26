import * as cp from 'child_process';
import * as util from 'util';
import * as http from 'http';

const exec = util.promisify(cp.exec);

export interface ProcessInfo {
    pid: number;
    extensionPort: number;
    connectPort: number;
    csrfToken: string;
}

export class PortDetector {

    async detect(): Promise<ProcessInfo | null> {
        try {
            console.log('[PortDetector] Starting multi-process port detection (HTTP)...');
            const allProcessInfos = await this.findAllProcessBasicInfo();
            if (allProcessInfos.length === 0) {
                console.log('[PortDetector] No Antigravity-related processes found.');
                return null;
            }

            console.log(`[PortDetector] Found ${allProcessInfos.length} potential processes. Testing each...`);

            for (const info of allProcessInfos) {
                console.log(`[PortDetector] Testing PID ${info.pid} on port ${info.extensionPort}...`);
                const ports = await this.findListeningPorts(info.pid);
                // Also include the extension port from args as a candidate
                if (!ports.includes(info.extensionPort)) {
                    ports.push(info.extensionPort);
                }

                console.log(`[PortDetector] PID ${info.pid} listening candidates: ${ports}`);

                const workingPort = await this.findWorkingPort(ports, info.csrfToken);
                if (workingPort) {
                    console.log(`[PortDetector] SUCCESS: Found working API on PID ${info.pid}, Port ${workingPort}`);
                    return {
                        ...info,
                        connectPort: workingPort
                    };
                }
                console.log(`[PortDetector] PID ${info.pid} did not provide a working API.`);
            }

            console.log('[PortDetector] Exhausted all potential processes. No working API found.');
        } catch (error) {
            console.error('[PortDetector] Fatal detection error:', error);
        }
        return null;
    }

    private async findAllProcessBasicInfo(): Promise<{ pid: number; extensionPort: number; csrfToken: string }[]> {
        // macOS: ps -ww -eo pid,args
        // We look for anything related to antigravity to be safe
        const cmd = `ps -ww -eo pid,args | grep -i "antigravity" | grep -v grep`;
        const results: { pid: number; extensionPort: number; csrfToken: string }[] = [];

        try {
            const { stdout } = await exec(cmd);
            if (!stdout) return [];

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const match = line.trim().match(/^(\d+)\s+(.+)$/);
                if (!match) continue;

                const pid = parseInt(match[1]);
                const args = match[2];

                // Flexible extraction
                const portMatch = args.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = args.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

                if (portMatch && tokenMatch) {
                    results.push({
                        pid,
                        extensionPort: parseInt(portMatch[1]),
                        csrfToken: tokenMatch[1]
                    });
                }
            }
        } catch (e) {
            // grep might return error code 1 if nothing found, which is fine
        }
        return results;
    }


    private async findListeningPorts(pid: number): Promise<number[]> {
        try {
            // lsof to find listening TCP ports for the PID
            const cmd = `lsof -Pan -p ${pid} -i -sTCP:LISTEN`;
            const { stdout } = await exec(cmd);

            const ports: number[] = [];
            const lines = stdout.trim().split('\n');
            // Skip header
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(/:(\d+)\s+\(LISTEN\)/) || line.match(/:(\d+)\s*$/);
                if (match && match[1]) {
                    const p = parseInt(match[1]);
                    if (!ports.includes(p)) ports.push(p);
                }
            }
            return ports;
        } catch (e) {
            // console.warn('lsof failed:', e);
            return [];
        }
    }

    private async findWorkingPort(ports: number[], token: string): Promise<number | null> {
        // Test ports in parallel
        const promises = ports.map(port => this.testPort(port, token).then(success => success ? port : null));
        const results = await Promise.all(promises);
        return results.find(p => p !== null) || null;
    }

    private testPort(port: number, token: string): Promise<boolean> {
        return new Promise((resolve) => {
            const requestBody = JSON.stringify({
                metadata: {
                    ideName: "antigravity",
                    extensionName: "antigravity",
                    ideVersion: "1.0.0",
                    locale: "en"
                }
            });

            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1'
                },
                timeout: 1000 // Give it a second
            };

            const req = http.request(options, (res) => {
                if (res.statusCode === 200) {
                    resolve(true);
                } else {
                    resolve(false);
                }
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(requestBody);
            req.end();
        });
    }
}
