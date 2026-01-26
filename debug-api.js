const { execSync } = require('child_process');
const http = require('http');

async function debug() {
    console.log('--- 1. Testing Process Detection ---');
    try {
        const psOutput = execSync('ps -ww -eo pid,args | grep -i "antigravity" | grep -v grep').toString();
        const lines = psOutput.trim().split('\n');
        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) continue;
            const pid = match[1];
            const args = match[2];
            const tokenMatch = args.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            if (tokenMatch) {
                const token = tokenMatch[1];
                console.log(`\nPID ${pid}: Found Token=${token}`);

                // Find all listening ports for this PID
                try {
                    const lsof = execSync(`lsof -Pan -p ${pid} -i -sTCP:LISTEN`).toString();
                    const ports = [...new Set([...lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map(m => m[1]))];
                    console.log(`Listening Ports: ${ports.join(', ')}`);

                    for (const port of ports) {
                        console.log(`\n--- Testing Port ${port} ---`);
                        const paths = [
                            '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                            '/LanguageServerService/GetUserStatus',
                            '/GetUserStatus'
                        ];
                        for (const path of paths) {
                            const res = await testApi(port, token, path);
                            console.log(`Path ${path}: Status ${res.status}`);
                            if (res.status === 200) {
                                console.log('SUCCESS FOUND WORKING PATH/PORT!');
                            }
                        }
                    }
                } catch (e) { console.log('lsof failed for PID', pid); }
            }
        }
    } catch (e) {
        console.error('Diagnostic Script Failed:', e.message);
    }
}

function testApi(port, token, path) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: '1.0.0', locale: 'en' } });
        const options = {
            hostname: '127.0.0.1',
            port: parseInt(port),
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': token,
                'Connect-Protocol-Version': '1'
            }
        };
        const req = http.request(options, (res) => {
            res.on('data', () => { });
            res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', () => resolve({ status: 'ERROR' }));
        req.write(data);
        req.end();
    });
}

debug();
