import * as cp from 'child_process';
import * as util from 'util';
import * as https from 'https';

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
            console.log('Starting port detection...');
            const basicInfo = await this.findProcessBasicInfo();
            if (!basicInfo) {
                console.log('Process basic info not found.');
                return null;
            }

            console.log('Found Antigravity process:', basicInfo.pid);
            const ports = await this.findListeningPorts(basicInfo.pid);
            console.log('Listening ports:', ports);

            const workingPort = await this.findWorkingPort(ports, basicInfo.csrfToken);

            if (workingPort) {
                console.log('Found working API port:', workingPort);
                return {
                    ...basicInfo,
                    connectPort: workingPort
                };
            } else {
                console.log('No working API port found.');
            }
        } catch (error) {
            console.error('Failed to detect port:', error);
        }
        return null;
    }

    private async findProcessBasicInfo() {
        // macOS: ps -ww -eo pid,args
        const cmd = `ps -ww -eo pid,args | grep "language_server" | grep -v grep`;
        const { stdout } = await exec(cmd);

        if (!stdout) return null;

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) continue;

            const pid = parseInt(match[1]);
            const args = match[2];

            if (!args.includes('antigravity')) continue;

            const portMatch = args.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = args.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            if (portMatch && tokenMatch) {
                return {
                    pid,
                    extensionPort: parseInt(portMatch[1]),
                    csrfToken: tokenMatch[1]
                };
            }
        }
        return null;
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
            console.warn('lsof failed:', e);
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
            // Use GetUnleashData with payload for testing as per open source reference
            const requestBody = JSON.stringify({
                context: {
                    properties: {
                        devMode: "false",
                        extensionVersion: "0.0.1",
                        hasAnthropicModelAccess: "true",
                        ide: "antigravity",
                        ideVersion: "1.0.0", // Mock version
                        installationId: "test-detection",
                        language: "UNSPECIFIED",
                        os: "darwin",
                        requestedModelId: "MODEL_UNSPECIFIED"
                    }
                }
            });

            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': requestBody.length,
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1'
                },
                rejectUnauthorized: false,
                timeout: 1000 // Give it a second
            };

            const req = https.request(options, (res) => {
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
