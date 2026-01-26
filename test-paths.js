const http = require('http');

async function check() {
    const port = 54958; // Known working port from previous run
    const token = 'cfd8f108-3568-416b-adde-cc688071bb50';

    const paths = [
        '/exa.language_server_pb.LanguageServerService/GetUnleashData',
        '/exa.language_server_pb.LanguageServerService/GetUserStatus'
    ];

    for (const path of paths) {
        const body = JSON.stringify({
            context: { properties: { ide: "antigravity", os: "darwin" } },
            metadata: { ideName: 'antigravity' }
        });
        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': token,
                'Connect-Protocol-Version': '1'
            }
        };
        const status = await new Promise(r => {
            const req = http.request(options, res => r(res.statusCode));
            req.on('error', () => r('ERR'));
            req.write(body);
            req.end();
        });
        console.log(`Path ${path}: ${status}`);
    }
}
check();
