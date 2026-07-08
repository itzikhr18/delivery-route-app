const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnvFile();

const APP_VERSION = '3.7.0';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const ROOT_DIR = __dirname;
const CACHE_DIR = path.join(ROOT_DIR, '.cache');
const GEOCODE_CACHE_FILE = path.join(CACHE_DIR, 'geocode-cache.json');
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '';
const REQUESTED_GEOCODING_PROVIDER = String(process.env.GEOCODING_PROVIDER || (GEOAPIFY_API_KEY ? 'geoapify' : 'nominatim')).toLowerCase();
const REQUESTED_ROUTING_PROVIDER = String(process.env.ROUTING_PROVIDER || (GEOAPIFY_API_KEY ? 'geoapify' : 'osrm')).toLowerCase();
const EFFECTIVE_GEOCODING_PROVIDER = REQUESTED_GEOCODING_PROVIDER === 'geoapify' && GEOAPIFY_API_KEY ? 'geoapify' : 'nominatim';
const EFFECTIVE_ROUTING_PROVIDER = REQUESTED_ROUTING_PROVIDER === 'geoapify' && GEOAPIFY_API_KEY ? 'geoapify' : 'osrm';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);
const ROUTE_STOP_LIMIT = Number(process.env.ROUTE_STOP_LIMIT || 60);
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 90);
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const PUBLIC_API_DELAY_MS = Number(process.env.PUBLIC_API_DELAY_MS || 1100);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const OSRM_BATCH_SIZE = Number(process.env.OSRM_BATCH_SIZE || 40);
const NOMINATIM_USER_AGENT = process.env.NOMINATIM_USER_AGENT || `DeliveryRouteAppBackend/${APP_VERSION}`;

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

const geocodeCache = loadGeocodeCache();
const rateLimitBuckets = new Map();
let lastPublicApiRequestAt = 0;

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) return;

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    });
}

function loadGeocodeCache() {
    try {
        if (!fs.existsSync(GEOCODE_CACHE_FILE)) return {};

        const parsed = JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, 'utf8'));
        const now = Date.now();
        Object.keys(parsed).forEach(key => {
            if (!parsed[key] || now - Number(parsed[key].timestamp || 0) > CACHE_TTL_MS) {
                delete parsed[key];
            }
        });
        return parsed;
    } catch (error) {
        console.warn('Could not load geocode cache:', error.message);
        return {};
    }
}

function saveGeocodeCache() {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(geocodeCache, null, 2));
    } catch (error) {
        console.warn('Could not save geocode cache:', error.message);
    }
}

function normalizeAddress(address) {
    return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCachedGeocode(address) {
    const key = normalizeAddress(address);
    const item = geocodeCache[key];
    if (!item) return null;

    if (Date.now() - Number(item.timestamp || 0) > CACHE_TTL_MS) {
        delete geocodeCache[key];
        saveGeocodeCache();
        return null;
    }

    return {
        ...item.coords,
        cached: true
    };
}

function setCachedGeocode(address, coords) {
    const key = normalizeAddress(address);
    geocodeCache[key] = {
        coords,
        timestamp: Date.now()
    };
    saveGeocodeCache();
}

function isOriginAllowed(origin) {
    if (!origin) return true;
    if (ALLOWED_ORIGINS.includes('*')) return true;
    return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(request) {
    const origin = request.headers.origin;
    const allowOrigin = isOriginAllowed(origin) ? (origin || '*') : 'null';

    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

function sendJson(response, statusCode, data, request) {
    response.writeHead(statusCode, {
        ...corsHeaders(request),
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify(data));
}

function sendError(response, statusCode, error, request, details = undefined) {
    sendJson(response, statusCode, {
        ok: false,
        error,
        details
    }, request);
}

function getRateLimitKey(request) {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
        return String(forwardedFor).split(',')[0].trim();
    }
    return request.socket.remoteAddress || 'unknown';
}

function checkRateLimit(request) {
    const key = getRateLimitKey(request);
    const now = Date.now();
    const minute = 60 * 1000;
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
        rateLimitBuckets.set(key, { count: 1, resetAt: now + minute });
        return { ok: true, remaining: Math.max(0, RATE_LIMIT_PER_MINUTE - 1) };
    }

    if (bucket.count >= RATE_LIMIT_PER_MINUTE) {
        return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    }

    bucket.count += 1;
    return { ok: true, remaining: Math.max(0, RATE_LIMIT_PER_MINUTE - bucket.count) };
}

async function parseJsonBody(request) {
    return await new Promise((resolve, reject) => {
        let body = '';

        request.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body is too large'));
                request.destroy();
            }
        });

        request.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });

        request.on('error', reject);
    });
}

async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.data = data;
            throw error;
        }

        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function throttlePublicApi() {
    const now = Date.now();
    const elapsed = now - lastPublicApiRequestAt;
    if (elapsed < PUBLIC_API_DELAY_MS) {
        await delay(PUBLIC_API_DELAY_MS - elapsed);
    }
    lastPublicApiRequestAt = Date.now();
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidCoord(coord) {
    return coord &&
        Number.isFinite(Number(coord.lat)) &&
        Number.isFinite(Number(coord.lon)) &&
        Number(coord.lat) >= -90 &&
        Number(coord.lat) <= 90 &&
        Number(coord.lon) >= -180 &&
        Number(coord.lon) <= 180;
}

function normalizeCoord(coord) {
    return {
        lat: Number(coord.lat),
        lon: Number(coord.lon),
        displayName: coord.displayName || coord.address || undefined
    };
}

async function geocodeAddress(address) {
    const cleanAddress = String(address || '').trim();
    if (!cleanAddress) {
        const error = new Error('Address is required');
        error.status = 400;
        throw error;
    }

    const cached = getCachedGeocode(cleanAddress);
    if (cached) {
        return { coords: cached, provider: cached.provider || 'cache', cached: true };
    }

    let coords;
    if (EFFECTIVE_GEOCODING_PROVIDER === 'geoapify') {
        coords = await geocodeWithGeoapify(cleanAddress);
    } else {
        coords = await geocodeWithNominatim(cleanAddress);
    }

    if (coords) {
        setCachedGeocode(cleanAddress, coords);
    }

    return { coords, provider: coords ? coords.provider : EFFECTIVE_GEOCODING_PROVIDER, cached: false };
}

async function geocodeWithGeoapify(address) {
    const url = new URL('https://api.geoapify.com/v1/geocode/search');
    url.searchParams.set('text', address);
    url.searchParams.set('filter', 'countrycode:il');
    url.searchParams.set('bias', 'countrycode:il');
    url.searchParams.set('format', 'json');
    url.searchParams.set('lang', 'he');
    url.searchParams.set('limit', '5');
    url.searchParams.set('apiKey', GEOAPIFY_API_KEY);

    const data = await fetchJson(url);
    const results = Array.isArray(data && data.results) ? data.results : [];
    const bestMatch = results[0];

    if (!bestMatch) return null;

    return {
        lat: Number(bestMatch.lat),
        lon: Number(bestMatch.lon),
        displayName: bestMatch.formatted || address,
        provider: 'geoapify'
    };
}

async function geocodeWithNominatim(address) {
    const israelViewbox = '34.2,33.4,35.9,29.4';
    const cleanAddress = address.replace(/,?\s*israel\s*$/i, '').trim();
    const attempts = [
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanAddress)}&format=json&limit=5&countrycodes=il&viewbox=${israelViewbox}&bounded=1`,
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${cleanAddress}, Israel`)}&format=json&limit=5&countrycodes=il`,
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanAddress)}&format=json&limit=5`
    ];

    for (const url of attempts) {
        await throttlePublicApi();
        const data = await fetchJson(url, {
            headers: {
                'Accept-Language': 'he',
                'User-Agent': NOMINATIM_USER_AGENT
            }
        });

        const results = Array.isArray(data) ? data : [];
        const filteredResults = results.filter(result => {
            const lat = Number(result.lat);
            const lon = Number(result.lon);
            return lat >= 29 && lat <= 34 && lon >= 34 && lon <= 36.5;
        });
        const bestMatch = filteredResults[0] || results[0];

        if (bestMatch) {
            return {
                lat: Number(bestMatch.lat),
                lon: Number(bestMatch.lon),
                displayName: bestMatch.display_name || address,
                provider: 'nominatim'
            };
        }
    }

    return null;
}

async function optimizeRoute(startCoords, addressCoords) {
    if (!isValidCoord(startCoords)) {
        const error = new Error('startCoords is invalid');
        error.status = 400;
        throw error;
    }

    if (!Array.isArray(addressCoords) || addressCoords.length === 0) {
        const error = new Error('addressCoords must contain at least one stop');
        error.status = 400;
        throw error;
    }

    if (addressCoords.length > ROUTE_STOP_LIMIT) {
        const error = new Error(`Route stop limit is ${ROUTE_STOP_LIMIT}`);
        error.status = 413;
        throw error;
    }

    const normalizedStart = normalizeCoord(startCoords);
    const normalizedStops = addressCoords.map(normalizeCoord);

    if (normalizedStops.some(coord => !isValidCoord(coord))) {
        const error = new Error('One or more addressCoords are invalid');
        error.status = 400;
        throw error;
    }

    if (EFFECTIVE_ROUTING_PROVIDER === 'geoapify') {
        return await optimizeRouteWithGeoapify(normalizedStart, normalizedStops);
    }

    return await optimizeRouteWithOsrm(normalizedStart, normalizedStops);
}

async function optimizeRouteWithGeoapify(startCoords, addressCoords) {
    const url = new URL('https://api.geoapify.com/v1/routeplanner');
    url.searchParams.set('apiKey', GEOAPIFY_API_KEY);

    const payload = {
        mode: 'drive',
        agents: [
            {
                id: 'driver_1',
                start_location: [startCoords.lon, startCoords.lat]
            }
        ],
        jobs: addressCoords.map((coord, index) => ({
            id: `stop_${index}`,
            location: [coord.lon, coord.lat]
        }))
    };

    const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const feature = Array.isArray(data && data.features) ? data.features[0] : null;
    if (!feature || !feature.properties) {
        throw new Error('Geoapify did not return a route');
    }

    const orderedIndices = extractGeoapifyOrderedIndices(feature.properties, addressCoords.length);
    if (orderedIndices.length !== addressCoords.length) {
        throw new Error('Geoapify route is missing one or more stops');
    }

    return {
        provider: 'geoapify',
        distance: Number(feature.properties.distance || 0) / 1000,
        duration: Number(feature.properties.time || 0) / 60,
        geometry: geometryToLineString(feature.geometry),
        orderedIndices
    };
}

function extractGeoapifyOrderedIndices(properties, stopCount) {
    const ordered = [];

    const pushJobIndex = value => {
        const index = Number(value);
        if (Number.isInteger(index) && index >= 0 && index < stopCount && !ordered.includes(index)) {
            ordered.push(index);
        }
    };

    if (Array.isArray(properties.waypoints)) {
        properties.waypoints.forEach(waypoint => {
            if (Array.isArray(waypoint.actions)) {
                waypoint.actions.forEach(action => {
                    if (action.job_index !== undefined) pushJobIndex(action.job_index);
                    if (action.job_id && /^stop_\d+$/.test(action.job_id)) {
                        pushJobIndex(action.job_id.replace('stop_', ''));
                    }
                });
            }
        });
    }

    if (Array.isArray(properties.actions)) {
        properties.actions.forEach(action => {
            if (action.job_index !== undefined) pushJobIndex(action.job_index);
            if (action.job_id && /^stop_\d+$/.test(action.job_id)) {
                pushJobIndex(action.job_id.replace('stop_', ''));
            }
        });
    }

    return ordered;
}

function geometryToLineString(geometry) {
    if (!geometry) return null;

    if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
        return geometry;
    }

    if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
        return {
            type: 'LineString',
            coordinates: geometry.coordinates.flat()
        };
    }

    return null;
}

async function optimizeRouteWithOsrm(startCoords, addressCoords) {
    if (addressCoords.length <= OSRM_BATCH_SIZE) {
        return await optimizeSingleOsrmBatch(startCoords, addressCoords);
    }

    const batches = [];
    for (let i = 0; i < addressCoords.length; i += OSRM_BATCH_SIZE) {
        batches.push(addressCoords.slice(i, i + OSRM_BATCH_SIZE));
    }

    let allOrderedIndices = [];
    let totalDistance = 0;
    let totalDuration = 0;
    let combinedGeometry = { type: 'LineString', coordinates: [] };
    let currentStartCoords = startCoords;
    let globalIndexOffset = 0;

    for (const batch of batches) {
        const result = await optimizeSingleOsrmBatch(currentStartCoords, batch);
        if (!result) return null;

        allOrderedIndices = allOrderedIndices.concat(result.orderedIndices.map(index => index + globalIndexOffset));
        totalDistance += result.distance;
        totalDuration += result.duration;

        if (result.geometry && Array.isArray(result.geometry.coordinates)) {
            combinedGeometry.coordinates = combinedGeometry.coordinates.concat(result.geometry.coordinates);
        }

        const lastIndex = result.orderedIndices[result.orderedIndices.length - 1];
        currentStartCoords = batch[lastIndex];
        globalIndexOffset += batch.length;
    }

    return {
        provider: 'osrm',
        distance: totalDistance,
        duration: totalDuration,
        geometry: combinedGeometry,
        orderedIndices: allOrderedIndices
    };
}

async function optimizeSingleOsrmBatch(startCoords, addressCoords) {
    const allCoords = [startCoords, ...addressCoords];
    const coordsString = allCoords.map(coord => `${coord.lon},${coord.lat}`).join(';');
    const url = `https://router.project-osrm.org/trip/v1/driving/${coordsString}?source=first&roundtrip=false&geometries=geojson&overview=full`;

    await throttlePublicApi();
    const data = await fetchJson(url);

    if (data.code !== 'Ok' || !data.trips || !data.trips.length) {
        throw new Error('OSRM did not return a route');
    }

    const trip = data.trips[0];
    const waypoints = data.waypoints || [];
    const orderedIndices = waypoints
        .slice(1)
        .map((waypoint, originalIndex) => ({
            originalIndex,
            tripIndex: waypoint.waypoint_index
        }))
        .sort((a, b) => a.tripIndex - b.tripIndex)
        .map(item => item.originalIndex);

    return {
        provider: 'osrm',
        distance: Number(trip.distance || 0) / 1000,
        duration: Number(trip.duration || 0) / 60,
        geometry: trip.geometry || null,
        orderedIndices
    };
}

async function handleApiRequest(request, response, url) {
    if (!isOriginAllowed(request.headers.origin)) {
        sendError(response, 403, 'Origin is not allowed', request);
        return;
    }

    if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, {
            ok: true,
            version: APP_VERSION,
            providers: {
                geocoding: EFFECTIVE_GEOCODING_PROVIDER,
                routing: EFFECTIVE_ROUTING_PROVIDER,
                requestedGeocoding: REQUESTED_GEOCODING_PROVIDER,
                requestedRouting: REQUESTED_ROUTING_PROVIDER,
                geoapifyConfigured: Boolean(GEOAPIFY_API_KEY)
            },
            geocodeCacheSize: Object.keys(geocodeCache).length
        }, request);
        return;
    }

    if (url.pathname === '/api/usage' && request.method === 'GET') {
        sendJson(response, 200, {
            ok: true,
            rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
            routeStopLimit: ROUTE_STOP_LIMIT,
            cacheTtlDays: CACHE_TTL_DAYS,
            directPublicApiDelayMs: PUBLIC_API_DELAY_MS
        }, request);
        return;
    }

    if (request.method !== 'POST') {
        sendError(response, 405, 'Method not allowed', request);
        return;
    }

    const rateLimit = checkRateLimit(request);
    if (!rateLimit.ok) {
        response.setHeader('Retry-After', String(rateLimit.retryAfter || 60));
        sendError(response, 429, 'Rate limit exceeded', request);
        return;
    }

    try {
        const body = await parseJsonBody(request);

        if (url.pathname === '/api/geocode') {
            const result = await geocodeAddress(body.address);
            if (!result.coords) {
                sendError(response, 404, 'Address not found', request);
                return;
            }

            sendJson(response, 200, {
                ok: true,
                provider: result.provider,
                cached: result.cached,
                coords: result.coords
            }, request);
            return;
        }

        if (url.pathname === '/api/optimize-route') {
            const route = await optimizeRoute(body.startCoords, body.addressCoords);
            sendJson(response, 200, {
                ok: true,
                provider: route.provider,
                route
            }, request);
            return;
        }

        sendError(response, 404, 'API endpoint not found', request);
    } catch (error) {
        const statusCode = Number(error.status || 500);
        const safeStatusCode = statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
        console.error(`${request.method} ${url.pathname}:`, error);
        sendError(response, safeStatusCode, error.message || 'Internal server error', request);
    }
}

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

function serveStaticFile(request, response) {
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
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);

    if (url.pathname.startsWith('/api/')) {
        handleApiRequest(request, response, url);
        return;
    }

    serveStaticFile(request, response);
});

server.listen(PORT, HOST, () => {
    console.log(`Delivery route API is running at http://${HOST}:${PORT}`);
    console.log(`Geocoding provider: ${EFFECTIVE_GEOCODING_PROVIDER}`);
    console.log(`Routing provider: ${EFFECTIVE_ROUTING_PROVIDER}`);
});
