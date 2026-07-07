const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

function resolveRequestPath(requestUrl) {
    const url = new URL(requestUrl, `http://${HOST}:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/') {
        pathname = '/index.html';
    }

    const filePath = path.normalize(path.join(ROOT_DIR, pathname));
    const relativePath = path.relative(ROOT_DIR, filePath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    return filePath;
}

const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end('Method Not Allowed');
        return;
    }

    const filePath = resolveRequestPath(request.url);

    if (!filePath) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        response.writeHead(200, {
            'Cache-Control': 'no-cache',
            'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream'
        });

        if (request.method === 'HEAD') {
            response.end();
            return;
        }

        response.end(data);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`Delivery route app is running at http://${HOST}:${PORT}`);
});
