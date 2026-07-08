// ============================================
// מסלול משלוחים - Delivery Route Optimizer
// גרסה 3.7.0 - Backend API foundation
// ============================================

const APP_VERSION = '3.7.0';
const BACKUP_SCHEMA_VERSION = 1;
const DEBUG_MODE = new URLSearchParams(window.location.search).has('debug');
const DEFAULT_APP_CONFIG = {
    apiBaseUrl: '',
    directFallback: true,
    requestTimeoutMs: 30000
};
const APP_CONFIG = {
    ...DEFAULT_APP_CONFIG,
    ...(window.DELIVERY_ROUTE_CONFIG || {})
};

const DELIVERY_STATUSES = {
    pending: {
        label: 'ממתין',
        icon: '⏳',
        cardClass: 'status-pending',
        markerColor: 'linear-gradient(135deg, var(--primary), var(--secondary))',
        markerTextColor: 'white'
    },
    delivered: {
        label: 'נמסר',
        icon: '✓',
        cardClass: 'status-delivered',
        markerColor: 'var(--success)',
        markerTextColor: 'white'
    },
    not_home: {
        label: 'לא בבית',
        icon: '⌂',
        cardClass: 'status-not-home',
        markerColor: 'var(--warning)',
        markerTextColor: 'var(--gray-800)'
    },
    issue: {
        label: 'בעיה',
        icon: '!',
        cardClass: 'status-issue',
        markerColor: 'var(--danger)',
        markerTextColor: 'white'
    }
};

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log(...args);
    }
}

function getApiBaseUrl() {
    return String(APP_CONFIG.apiBaseUrl || '').trim().replace(/\/+$/, '');
}

function isBackendApiEnabled() {
    return getApiBaseUrl().length > 0;
}

function shouldFallbackToDirectApis() {
    return APP_CONFIG.directFallback !== false;
}

function buildApiUrl(path) {
    return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fetchBackendJson(path, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Number(APP_CONFIG.requestTimeoutMs) || 30000);

    try {
        const response = await fetch(buildApiUrl(path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            const message = data && data.error ? data.error : `Backend request failed (${response.status})`;
            const error = new Error(message);
            error.status = response.status;
            error.details = data;
            throw error;
        }

        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function geocodeAddressViaBackend(address) {
    if (!isBackendApiEnabled()) {
        return { handled: false, result: null };
    }

    try {
        const data = await fetchBackendJson('/api/geocode', { address });
        if (!data || !data.coords) {
            return { handled: true, result: null };
        }

        return {
            handled: true,
            result: {
                lat: Number(data.coords.lat),
                lon: Number(data.coords.lon),
                displayName: data.coords.displayName || address,
                provider: data.provider || data.coords.provider || 'backend'
            }
        };
    } catch (error) {
        console.warn('Backend geocoding failed:', error);
        if (shouldFallbackToDirectApis()) {
            return { handled: false, result: null };
        }
        throw error;
    }
}

function normalizeBackendRoute(route) {
    if (!route || !Array.isArray(route.orderedIndices)) {
        return null;
    }

    return {
        distance: Number(route.distance) || 0,
        duration: Number(route.duration) || 0,
        geometry: route.geometry || null,
        orderedIndices: route.orderedIndices.map(index => Number(index)).filter(index => Number.isInteger(index))
    };
}

async function calculateRouteViaBackend(startCoords, addressCoords) {
    if (!isBackendApiEnabled()) {
        return { handled: false, result: null };
    }

    try {
        const data = await fetchBackendJson('/api/optimize-route', {
            startCoords,
            addressCoords
        });
        const route = normalizeBackendRoute(data && (data.route || data));
        return { handled: true, result: route };
    } catch (error) {
        console.warn('Backend route optimization failed:', error);
        if (shouldFallbackToDirectApis()) {
            return { handled: false, result: null };
        }
        throw error;
    }
}

// State Management
const state = {
    startAddress: '',
    addresses: [],
    optimizedRoute: null,
    currentScreen: 'input',
    map: null,
    markers: [],
    routeLine: null,
    lastViewedIndex: 0,
    toastTimeout: null,
    toastHideTimeout: null
};

// ============================================
// Corrected Locations - תיקוני מיקום ידניים
// ============================================
const correctedLocations = {
    data: {},
    
    load() {
        const saved = localStorage.getItem('correctedLocations');
        if (saved) {
            try {
                this.data = JSON.parse(saved);
            } catch (e) {
                this.data = {};
            }
        }
    },
    
    save() {
        localStorage.setItem('correctedLocations', JSON.stringify(this.data));
    },
    
    get(address) {
        const key = this.normalizeAddress(address);
        return this.data[key] || null;
    },
    
    set(address, coords) {
        const key = this.normalizeAddress(address);
        this.data[key] = {
            lat: coords.lat,
            lon: coords.lon,
            correctedAt: Date.now()
        };
        this.save();
    },
    
    normalizeAddress(address) {
        return address.trim().toLowerCase().replace(/\s+/g, ' ');
    }
};

// ============================================
// Geocoding Cache - שמירת כתובות שכבר חיפשנו
// ============================================
const geocodeCache = {
    data: {},
    
    load() {
        const saved = localStorage.getItem('geocodeCache');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
                for (const key in parsed) {
                    if (parsed[key].timestamp < thirtyDaysAgo) {
                        delete parsed[key];
                    }
                }
                this.data = parsed;
                this.save();
            } catch (e) {
                this.data = {};
            }
        }
    },
    
    save() {
        localStorage.setItem('geocodeCache', JSON.stringify(this.data));
    },
    
    get(address) {
        const key = this.normalizeAddress(address);
        if (this.data[key]) {
            return this.data[key].coords;
        }
        return null;
    },
    
    set(address, coords) {
        const key = this.normalizeAddress(address);
        this.data[key] = {
            coords: coords,
            timestamp: Date.now()
        };
        this.save();
    },
    
    normalizeAddress(address) {
        return address.trim().toLowerCase().replace(/\s+/g, ' ');
    }
};

// ============================================
// DOM Elements
// ============================================
const elements = {
    // Screens
    inputScreen: document.getElementById('input-screen'),
    routeScreen: document.getElementById('route-screen'),
    historyScreen: document.getElementById('history-screen'),
    
    // Input elements
    startAddressInput: document.getElementById('start-address'),
    addressesContainer: document.getElementById('addresses-container'),
    addAddressBtn: document.getElementById('add-address-btn'),
    calculateRouteBtn: document.getElementById('calculate-route-btn'),
    clearAllBtn: document.getElementById('clear-all-btn'),
    duplicateAlert: document.getElementById('duplicate-alert'),
    bulkImportBtn: document.getElementById('bulk-import-btn'),
    
    // Route elements
    statDeliveries: document.getElementById('stat-deliveries'),
    statDistance: document.getElementById('stat-distance'),
    statTime: document.getElementById('stat-time'),
    routeStartText: document.getElementById('route-start-text'),
    routeAddressesContainer: document.getElementById('route-addresses-container'),
    printRouteBtn: document.getElementById('print-route-btn'),
    shareRouteBtn: document.getElementById('share-route-btn'),
    exportRouteBtn: document.getElementById('export-route-btn'),
    editRouteBtn: document.getElementById('edit-route-btn'),
    newDayBtn: document.getElementById('new-day-btn'),
    printDate: document.getElementById('print-date'),
    
    // History elements
    historyContainer: document.getElementById('history-container'),
    
    // Modals & Overlays
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text'),
    loadingProgress: document.getElementById('loading-progress'),
    loadingProgressBar: document.getElementById('loading-progress-bar'),
    confirmModal: document.getElementById('confirm-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalText: document.getElementById('modal-text'),
    modalConfirm: document.getElementById('modal-confirm'),
    modalCancel: document.getElementById('modal-cancel'),
    historyModal: document.getElementById('history-modal'),
    historyModalTitle: document.getElementById('history-modal-title'),
    historyModalContent: document.getElementById('history-modal-content'),
    historyModalClose: document.getElementById('history-modal-close'),
    
    // Import Modal
    importModal: document.getElementById('import-modal'),
    importTextarea: document.getElementById('import-textarea'),
    importCount: document.getElementById('import-count'),
    importConfirm: document.getElementById('import-confirm'),
    importCancel: document.getElementById('import-cancel'),
    backupDataBtn: document.getElementById('backup-data-btn'),
    restoreDataBtn: document.getElementById('restore-data-btn'),
    restoreFileInput: document.getElementById('restore-file-input'),
    
    // Toasts
    correctionToast: document.getElementById('correction-toast'),
    appToast: document.getElementById('app-toast'),
    
    // Navigation
    navBtns: document.querySelectorAll('.nav-btn')
};

// ============================================
// Utility Functions
// ============================================

function formatPhoneNumber(phone) {
    if (!phone) return '';
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('972')) {
        cleaned = '0' + cleaned.slice(3);
    }
    if (cleaned.length === 9 && !cleaned.startsWith('0')) {
        cleaned = '0' + cleaned;
    }
    return cleaned;
}

function formatDate(date) {
    const d = new Date(date);
    return d.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]));
}

function getDeliveryStatus(statusKey) {
    return DELIVERY_STATUSES[statusKey] || DELIVERY_STATUSES.pending;
}

function getDeliveryStatusKey(address) {
    if (!address) return 'pending';
    if (address.completed && !address.status) return 'delivered';
    return DELIVERY_STATUSES[address.status] ? address.status : 'pending';
}

function normalizeRouteAddress(address) {
    const status = getDeliveryStatusKey(address);
    return {
        ...address,
        status,
        statusUpdatedAt: address.statusUpdatedAt || null
    };
}

function normalizeRoute(route) {
    if (!route || !Array.isArray(route.addresses)) return route || null;
    return {
        ...route,
        addresses: route.addresses.map(normalizeRouteAddress)
    };
}

function getRouteStatusCounts(route = state.optimizedRoute) {
    const counts = {
        total: 0,
        pending: 0,
        delivered: 0,
        not_home: 0,
        issue: 0
    };

    if (!route || !Array.isArray(route.addresses)) {
        return counts;
    }

    route.addresses.forEach(address => {
        const status = getDeliveryStatusKey(address);
        counts.total++;
        counts[status] = (counts[status] || 0) + 1;
    });

    return counts;
}

function updateRouteStats() {
    const counts = getRouteStatusCounts();
    const remaining = counts.pending + counts.issue;
    elements.statDeliveries.textContent = state.optimizedRoute ? remaining : 0;

    if (state.optimizedRoute) {
        elements.statDistance.textContent = state.optimizedRoute.totalDistance.toFixed(1);
        elements.statTime.textContent = Math.round(state.optimizedRoute.totalTime);
        elements.routeStartText.textContent = state.optimizedRoute.startAddress;
    } else {
        elements.statDistance.textContent = '0';
        elements.statTime.textContent = '0';
        elements.routeStartText.textContent = '';
    }
}

function formatDeliveryLine(address, index) {
    const statusKey = getDeliveryStatusKey(address);
    const status = getDeliveryStatus(statusKey);
    const phone = address.phone ? ` | טלפון: ${address.phone}` : '';
    const notes = address.notes ? ` | הערות: ${address.notes}` : '';
    return `${index + 1}. ${status.icon} ${status.label} - ${address.address}${phone}${notes}`;
}

function buildRouteText(route = state.optimizedRoute) {
    if (!route || !Array.isArray(route.addresses) || route.addresses.length === 0) {
        return '';
    }

    const counts = getRouteStatusCounts(route);
    const lines = [
        `מסלול משלוחים - ${formatDate(route.calculatedAt || new Date())}`,
        `נקודת התחלה: ${route.startAddress}`,
        `סה"כ: ${counts.total} משלוחים | נותרו: ${counts.pending + counts.issue} | נמסרו: ${counts.delivered} | לא בבית: ${counts.not_home}`,
        `מרחק: ${route.totalDistance.toFixed(1)} ק"מ | זמן משוער: ${Math.round(route.totalTime)} דקות`,
        ''
    ];

    route.addresses.forEach((address, index) => {
        lines.push(formatDeliveryLine(address, index));
    });

    return lines.join('\n');
}

function escapeCsvValue(value = '') {
    const text = String(value).replace(/\r?\n/g, ' ');
    return `"${text.replace(/"/g, '""')}"`;
}

function buildRouteCsv(route = state.optimizedRoute) {
    const rows = [
        ['סדר', 'סטטוס', 'כתובת', 'טלפון', 'הערות', 'קו רוחב', 'קו אורך']
    ];

    if (route && Array.isArray(route.addresses)) {
        route.addresses.forEach((address, index) => {
            const status = getDeliveryStatus(getDeliveryStatusKey(address));
            rows.push([
                index + 1,
                status.label,
                address.address || '',
                address.phone || '',
                address.notes || '',
                address.coords ? address.coords.lat : '',
                address.coords ? address.coords.lon : ''
            ]);
        });
    }

    return rows.map(row => row.map(escapeCsvValue).join(',')).join('\n');
}

function downloadTextFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function showLoading(show, text = 'מחשב מסלול אופטימלי...', progress = null) {
    if (show) {
        elements.loadingOverlay.classList.add('active');
        if (elements.loadingText) {
            elements.loadingText.textContent = text;
        }
        if (elements.loadingProgress && elements.loadingProgressBar) {
            if (progress !== null) {
                elements.loadingProgress.style.display = 'block';
                elements.loadingProgressBar.style.width = `${progress}%`;
            } else {
                elements.loadingProgress.style.display = 'none';
            }
        }
    } else {
        elements.loadingOverlay.classList.remove('active');
    }
}

function updateLoadingProgress(current, total, cached = 0) {
    const percent = Math.round((current / total) * 100);
    const text = cached > 0 
        ? `ממיר כתובות... ${current}/${total} (${cached} מהמטמון)`
        : `ממיר כתובות... ${current}/${total}`;
    showLoading(true, text, percent);
}

function showConfirmModal(title, text, onConfirm) {
    elements.modalTitle.textContent = title;
    elements.modalText.textContent = text;
    elements.confirmModal.classList.add('active');

    elements.modalConfirm.onclick = () => {
        elements.confirmModal.classList.remove('active');
        elements.modalConfirm.onclick = null;
        onConfirm();
    };
}

function hideConfirmModal() {
    elements.confirmModal.classList.remove('active');
    elements.modalConfirm.onclick = null;
}

function showDuplicateAlert() {
    elements.duplicateAlert.style.display = 'flex';
    setTimeout(() => {
        elements.duplicateAlert.style.display = 'none';
    }, 3000);
}

function showAppToast(message, type = 'info', duration = 3500) {
    if (!elements.appToast) return;

    if (state.toastTimeout) {
        clearTimeout(state.toastTimeout);
    }
    if (state.toastHideTimeout) {
        clearTimeout(state.toastHideTimeout);
    }

    elements.appToast.textContent = message;
    elements.appToast.className = `app-toast app-toast-${type}`;
    elements.appToast.style.display = 'flex';

    requestAnimationFrame(() => {
        elements.appToast.classList.add('active');
    });

    state.toastTimeout = setTimeout(() => {
        elements.appToast.classList.remove('active');
        state.toastHideTimeout = setTimeout(() => {
            elements.appToast.style.display = 'none';
        }, 250);
    }, duration);
}

function showCorrectionToast() {
    elements.correctionToast.style.display = 'flex';
    setTimeout(() => {
        elements.correctionToast.style.display = 'none';
    }, 3000);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Storage Functions
// ============================================

function saveState() {
    const dataToSave = {
        startAddress: state.startAddress,
        addresses: state.addresses,
        optimizedRoute: state.optimizedRoute,
        lastViewedIndex: state.lastViewedIndex,
        currentScreen: state.currentScreen
    };
    localStorage.setItem('deliveryRouteState', JSON.stringify(dataToSave));
}

function loadState() {
    const saved = localStorage.getItem('deliveryRouteState');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            state.startAddress = data.startAddress || '';
            state.addresses = data.addresses || [];
            state.optimizedRoute = normalizeRoute(data.optimizedRoute);
            state.lastViewedIndex = data.lastViewedIndex || 0;
            state.currentScreen = data.currentScreen || 'input';
        } catch (e) {
            console.error('Error loading state:', e);
        }
    }
}

function getHistory() {
    const history = localStorage.getItem('deliveryRouteHistory');
    if (history) {
        try {
            let data = JSON.parse(history);
            const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
            data = data.filter(entry => new Date(entry.date).getTime() > thirtyDaysAgo);
            localStorage.setItem('deliveryRouteHistory', JSON.stringify(data));
            return data;
        } catch (e) {
            return [];
        }
    }
    return [];
}

function saveToHistory(routeData) {
    if (!routeData || !Array.isArray(routeData.addresses)) return;

    const history = getHistory();
    const today = new Date().toISOString().split('T')[0];
    const counts = getRouteStatusCounts(routeData);
    
    const existingIndex = history.findIndex(h => h.date === today);
    
    const historyEntry = {
        date: today,
        totalKm: routeData.totalDistance,
        deliveryCount: routeData.addresses.length,
        statusCounts: counts,
        totalTime: routeData.totalTime,
        startAddress: routeData.startAddress,
        addresses: routeData.addresses.map((addr, index) => ({
            order: index + 1,
            address: addr.address,
            phone: addr.phone,
            notes: addr.notes,
            status: getDeliveryStatusKey(addr),
            statusUpdatedAt: addr.statusUpdatedAt || null
        }))
    };
    
    if (existingIndex >= 0) {
        history[existingIndex] = historyEntry;
    } else {
        history.unshift(historyEntry);
    }
    
    localStorage.setItem('deliveryRouteHistory', JSON.stringify(history));
}

// ============================================
// Geocoding & Routing Functions
// ============================================

async function geocodeAddress(address, useCache = true) {
    // 1. קודם בדוק תיקונים ידניים (עדיפות עליונה)
    const corrected = correctedLocations.get(address);
    if (corrected) {
        debugLog(`Using corrected location: ${address}`);
        return {
            lat: corrected.lat,
            lon: corrected.lon,
            displayName: address,
            isCorrected: true
        };
    }
    
    // 2. בדוק במטמון
    if (useCache) {
        const cached = geocodeCache.get(address);
        if (cached) {
            debugLog(`Cache hit: ${address}`);
            return cached;
        }
    }

    const backendGeocode = await geocodeAddressViaBackend(address);
    if (backendGeocode.handled) {
        if (backendGeocode.result) {
            geocodeCache.set(address, backendGeocode.result);
        }
        return backendGeocode.result;
    }
    
    // 3. חפש ב-Nominatim
    try {
        // בדוק חיבור אינטרנט
        if (!navigator.onLine) {
            throw new Error('NO_INTERNET');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // timeout 30 שניות

        // viewbox של ישראל לדיוק תוצאות
        const israelViewbox = '34.2,33.4,35.9,29.4';

        const fetchOptions = {
            headers: {
                'Accept-Language': 'he',
                'User-Agent': `DeliveryRouteApp/${APP_VERSION}`
            },
            signal: controller.signal
        };

        const baseParams = 'format=json&limit=5&countrycodes=il';
        const cleanAddress = address.replace(/,?\s*ישראל\s*$/i, '').trim();
        let data = null;

        // ניסיון 1: חיפוש חופשי עם viewbox (ללא הוספת "ישראל" - countrycodes מספיק)
        debugLog(`Geocoding attempt 1 (free search): "${cleanAddress}"`);
        const url1 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanAddress)}&${baseParams}&viewbox=${israelViewbox}&bounded=1`;
        const response1 = await fetch(url1, fetchOptions);
        if (response1.ok) {
            data = await response1.json();
        }

        // ניסיון 2: חיפוש מובנה כעיר/ישוב
        if (!data || data.length === 0) {
            debugLog(`Geocoding attempt 2 (structured city): "${cleanAddress}"`);
            const url2 = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(cleanAddress)}&country=Israel&format=json&limit=5`;
            const response2 = await fetch(url2, fetchOptions);
            if (response2.ok) {
                data = await response2.json();
            }
        }

        // ניסיון 3: חיפוש מובנה כרחוב/מקום
        if (!data || data.length === 0) {
            debugLog(`Geocoding attempt 3 (structured street): "${cleanAddress}"`);
            const url3 = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(cleanAddress)}&country=Israel&format=json&limit=5`;
            const response3 = await fetch(url3, fetchOptions);
            if (response3.ok) {
                data = await response3.json();
            }
        }

        // ניסיון 4: חיפוש חופשי עם ", Israel" באנגלית (Nominatim לפעמים מגיב טוב יותר לאנגלית)
        if (!data || data.length === 0) {
            debugLog(`Geocoding attempt 4 (English country): "${cleanAddress}"`);
            const url4 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanAddress + ', Israel')}&format=json&limit=5`;
            const response4 = await fetch(url4, fetchOptions);
            if (response4.ok) {
                data = await response4.json();
            }
        }

        // ניסיון 5: חיפוש חופשי ללא הגבלות גיאוגרפיות (מרחיב את החיפוש)
        if (!data || data.length === 0) {
            debugLog(`Geocoding attempt 5 (unrestricted): "${cleanAddress}"`);
            const url5 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanAddress)}&format=json&limit=5`;
            const response5 = await fetch(url5, fetchOptions);
            if (response5.ok) {
                const allResults = await response5.json();
                // סנן רק תוצאות באזור ישראל (lat: 29-34, lon: 34-36)
                if (allResults && allResults.length > 0) {
                    data = allResults.filter(r => {
                        const lat = parseFloat(r.lat);
                        const lon = parseFloat(r.lon);
                        return lat >= 29 && lat <= 34 && lon >= 34 && lon <= 36.5;
                    });
                }
            }
        }

        clearTimeout(timeoutId);

        if (data && data.length > 0) {
            // העדף תוצאה מסוג place/city/village/town על פני כביש או בניין
            const preferredTypes = ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'residential'];
            const bestMatch = data.find(r => preferredTypes.some(t => (r.type || '').includes(t) || (r.class || '') === 'place')) || data[0];

            const coords = {
                lat: parseFloat(bestMatch.lat),
                lon: parseFloat(bestMatch.lon),
                displayName: bestMatch.display_name
            };

            geocodeCache.set(address, coords);
            return coords;
        }
        return null;
    } catch (error) {
        console.error('Geocoding error:', error);

        // סמן את סוג השגיאה
        if (error.message === 'NO_INTERNET' || error.name === 'AbortError' || !navigator.onLine) {
            error.isNetworkError = true;
        }

        throw error; // העבר את השגיאה הלאה לטיפול
    }
}

async function geocodeAddressesWithDelay(addresses, onProgress) {
    const results = [];
    let cachedCount = 0;
    let fetchedCount = 0;
    
    for (let i = 0; i < addresses.length; i++) {
        const addr = addresses[i];
        
        // בדוק תיקון ידני
        const corrected = correctedLocations.get(addr.address);
        if (corrected) {
            results.push({
                ...addr,
                coords: { lat: corrected.lat, lon: corrected.lon, displayName: addr.address },
                isCorrected: true
            });
            cachedCount++;
            if (onProgress) onProgress(i + 1, addresses.length, cachedCount);
            continue;
        }
        
        // בדוק במטמון
        const cached = geocodeCache.get(addr.address);
        if (cached) {
            cachedCount++;
            results.push({ ...addr, coords: cached });
            if (onProgress) onProgress(i + 1, addresses.length, cachedCount);
            continue;
        }
        
        // חפש ב-Nominatim עם השהייה
        if (fetchedCount > 0) {
            await delay(1100);
        }
        
        try {
            const geo = await geocodeAddress(addr.address, false);
            fetchedCount++;
            
            if (geo) {
                results.push({ ...addr, coords: geo });
            } else {
                return { error: addr.address, results: null, errorType: 'NOT_FOUND' };
            }
        } catch (error) {
            if (error.isNetworkError || !navigator.onLine) {
                return { error: addr.address, results: null, errorType: 'NETWORK_ERROR' };
            }
            return { error: addr.address, results: null, errorType: 'UNKNOWN_ERROR' };
        }
        
        if (onProgress) onProgress(i + 1, addresses.length, cachedCount);
    }
    
    return { error: null, results, cachedCount, fetchedCount };
}

// ============================================
// Smart Splitting - חלוקה אוטומטית לקבוצות
// ============================================

const BATCH_SIZE = 40; // מקסימום נקודות לכל בקשת OSRM

async function calculateOptimalRouteWithSplitting(startCoords, addressCoords) {
    if (addressCoords.length === 0) return null;

    const backendRoute = await calculateRouteViaBackend(startCoords, addressCoords);
    if (backendRoute.handled) {
        return backendRoute.result;
    }
    
    // אם פחות מ-BATCH_SIZE, חשב רגיל
    if (addressCoords.length <= BATCH_SIZE) {
        return await calculateSingleBatchRoute(startCoords, addressCoords);
    }
    
    // חלק לקבוצות
    debugLog(`Splitting ${addressCoords.length} addresses into batches of ${BATCH_SIZE}`);
    
    const batches = [];
    for (let i = 0; i < addressCoords.length; i += BATCH_SIZE) {
        batches.push(addressCoords.slice(i, i + BATCH_SIZE));
    }
    
    let allOrderedIndices = [];
    let totalDistance = 0;
    let totalDuration = 0;
    let combinedGeometry = { type: 'LineString', coordinates: [] };
    let currentStartCoords = startCoords;
    let globalIndexOffset = 0;
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        debugLog(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} addresses`);
        
        const batchResult = await calculateSingleBatchRoute(currentStartCoords, batch);
        
        if (!batchResult) {
            console.error(`Batch ${batchIndex + 1} failed`);
            return null;
        }
        
        // מיפוי האינדקסים הגלובליים
        const globalIndices = batchResult.orderedIndices.map(i => i + globalIndexOffset);
        allOrderedIndices = allOrderedIndices.concat(globalIndices);
        
        totalDistance += batchResult.distance;
        totalDuration += batchResult.duration;
        
        // חיבור הגיאומטריה
        if (batchResult.geometry && batchResult.geometry.coordinates) {
            combinedGeometry.coordinates = combinedGeometry.coordinates.concat(batchResult.geometry.coordinates);
        }
        
        // הנקודה האחרונה של הקבוצה הנוכחית = נקודת ההתחלה של הבאה
        const lastIndex = batchResult.orderedIndices[batchResult.orderedIndices.length - 1];
        currentStartCoords = batch[lastIndex];
        
        globalIndexOffset += batch.length;
    }
    
    return {
        distance: totalDistance,
        duration: totalDuration,
        geometry: combinedGeometry,
        orderedIndices: allOrderedIndices
    };
}

async function calculateSingleBatchRoute(startCoords, addressCoords) {
    if (addressCoords.length === 0) return null;
    
    const allCoords = [startCoords, ...addressCoords];
    const coordsString = allCoords.map(c => `${c.lon},${c.lat}`).join(';');
    
    const url = `https://router.project-osrm.org/trip/v1/driving/${coordsString}?source=first&roundtrip=false&geometries=geojson&overview=full`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.code === 'Ok' && data.trips && data.trips.length > 0) {
            const trip = data.trips[0];
            const waypoints = data.waypoints;
            
            const orderedIndices = waypoints
                .slice(1)
                .map((wp, originalIndex) => ({
                    originalIndex,
                    tripIndex: wp.waypoint_index
                }))
                .sort((a, b) => a.tripIndex - b.tripIndex)
                .map(item => item.originalIndex);
            
            return {
                distance: trip.distance / 1000,
                duration: trip.duration / 60,
                geometry: trip.geometry,
                orderedIndices
            };
        }
        return null;
    } catch (error) {
        console.error('Routing error:', error);
        return null;
    }
}

// ============================================
// UI Rendering Functions
// ============================================

function renderAddressCard(address, index) {
    const card = document.createElement('div');
    card.className = 'address-card';
    card.innerHTML = `
        <span class="address-number">${index + 1}</span>
        <button class="delete-btn" data-index="${index}">×</button>
        <div class="address-fields">
            <input type="text" class="form-input address-input" placeholder="כתובת *" value="${escapeHtml(address.address || '')}" data-index="${index}" data-field="address">
            <input type="tel" class="form-input phone-input" placeholder="מספר טלפון" value="${escapeHtml(address.phone || '')}" data-index="${index}" data-field="phone" dir="ltr">
            <input type="text" class="form-input notes-input" placeholder="הערות" value="${escapeHtml(address.notes || '')}" data-index="${index}" data-field="notes">
        </div>
    `;
    return card;
}

function renderAddresses() {
    elements.addressesContainer.innerHTML = '';
    
    state.addresses.forEach((address, index) => {
        const card = renderAddressCard(address, index);
        elements.addressesContainer.appendChild(card);
    });
    
    document.querySelectorAll('.address-card input').forEach(input => {
        input.addEventListener('input', handleAddressInput);
        input.addEventListener('blur', handleAddressBlur);
    });
    
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', handleDeleteAddress);
    });
}

function renderRouteAddresses() {
    elements.routeAddressesContainer.innerHTML = '';
    
    if (!state.optimizedRoute || !state.optimizedRoute.addresses) return;
    
    state.optimizedRoute.addresses.forEach((address, index) => {
        const statusKey = getDeliveryStatusKey(address);
        const status = getDeliveryStatus(statusKey);
        const isCorrected = address.isCorrected || correctedLocations.get(address.address);
        const card = document.createElement('div');
        card.className = `route-address-card ${status.cardClass} ${isCorrected ? 'corrected' : ''}`;
        card.innerHTML = `
            <div class="route-address-header">
                <div class="route-number">${index + 1}</div>
                <div class="route-address-info">
                    <div class="route-address-meta">
                        <span class="status-badge ${status.cardClass}">${status.icon} ${status.label}</span>
                        ${isCorrected ? '<span class="corrected-badge">📍 מתוקן</span>' : ''}
                    </div>
                    <div class="route-address-text">
                        ${escapeHtml(address.address)}
                    </div>
                    ${address.notes ? `<div class="route-address-notes">📝 ${escapeHtml(address.notes)}</div>` : ''}
                </div>
            </div>
            <div class="route-address-actions">
                ${address.phone ? `<a href="tel:${escapeHtml(address.phone)}" class="btn btn-phone btn-sm">📞 ${escapeHtml(address.phone)}</a>` : ''}
                <button class="btn btn-waze btn-sm navigate-btn" data-address="${encodeURIComponent(address.address)}" data-index="${index}">🧭 Waze</button>
            </div>
            <div class="status-actions" aria-label="עדכון סטטוס משלוח">
                <button class="status-btn ${statusKey === 'pending' ? 'active' : ''}" data-index="${index}" data-status="pending">⏳ ממתין</button>
                <button class="status-btn ${statusKey === 'delivered' ? 'active' : ''}" data-index="${index}" data-status="delivered">✓ נמסר</button>
                <button class="status-btn ${statusKey === 'not_home' ? 'active' : ''}" data-index="${index}" data-status="not_home">⌂ לא בבית</button>
                <button class="status-btn ${statusKey === 'issue' ? 'active' : ''}" data-index="${index}" data-status="issue">! בעיה</button>
            </div>
        `;
        elements.routeAddressesContainer.appendChild(card);
    });
    
    document.querySelectorAll('.navigate-btn').forEach(btn => {
        btn.addEventListener('click', handleNavigate);
    });
    
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', handleSetDeliveryStatus);
    });
}

function renderHistory() {
    const history = getHistory();
    elements.historyContainer.innerHTML = '';
    
    if (history.length === 0) {
        elements.historyContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <div class="empty-state-title">אין היסטוריה</div>
                <p>ההיסטוריה תשמר כאן אחרי ימי משלוחים</p>
            </div>
        `;
        return;
    }
    
    history.forEach((day) => {
        const card = document.createElement('div');
        card.className = 'history-day-card';
        const counts = day.statusCounts || getRouteStatusCounts({ addresses: day.addresses || [] });
        card.innerHTML = `
            <div class="history-day-header">
                <span class="history-date">${formatDate(day.date)}</span>
                <span style="color: var(--primary);">הצג פרטים ←</span>
            </div>
            <div class="history-stats">
                <span>📦 ${day.deliveryCount} משלוחים</span>
                <span>✓ ${counts.delivered || 0} נמסרו</span>
                <span>🛣️ ${day.totalKm.toFixed(1)} ק"מ</span>
            </div>
        `;
        card.addEventListener('click', () => showHistoryDetail(day));
        elements.historyContainer.appendChild(card);
    });
}

function showHistoryDetail(day) {
    elements.historyModalTitle.textContent = `משלוחים - ${formatDate(day.date)}`;
    
    let content = `
        <div style="margin-bottom: 16px; padding: 12px; background: var(--gray-100); border-radius: var(--radius-md);">
            <strong>נקודת התחלה:</strong> ${escapeHtml(day.startAddress || 'לא צוין')}
        </div>
        <div style="margin-bottom: 12px; font-size: 0.875rem; color: var(--gray-500);">
            סה"כ: ${day.deliveryCount} משלוחים | ${day.totalKm.toFixed(1)} ק"מ | ${Math.round(day.totalTime)} דקות
        </div>
    `;
    
    day.addresses.forEach(addr => {
        const status = getDeliveryStatus(getDeliveryStatusKey(addr));
        content += `
            <div style="padding: 12px; background: var(--white); border-radius: var(--radius-sm); margin-bottom: 8px; border-right: 3px solid var(--primary);">
                <div style="margin-bottom: 6px;"><span class="status-badge ${status.cardClass}">${status.icon} ${status.label}</span></div>
                <div style="font-weight: 600;">${addr.order}. ${escapeHtml(addr.address)}</div>
                ${addr.phone ? `<div style="font-size: 0.875rem; color: var(--gray-500); margin-top: 4px;">📞 ${escapeHtml(addr.phone)}</div>` : ''}
                ${addr.notes ? `<div style="font-size: 0.875rem; color: var(--gray-500); margin-top: 4px;">📝 ${escapeHtml(addr.notes)}</div>` : ''}
            </div>
        `;
    });
    
    elements.historyModalContent.innerHTML = content;
    elements.historyModal.classList.add('active');
}

// ============================================
// Map Functions with Draggable Markers
// ============================================

function initMap() {
    if (state.map) {
        state.map.remove();
    }
    
    state.map = L.map('map').setView([31.7455, 34.9896], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(state.map);
}

function updateMap() {
    if (!state.map || !state.optimizedRoute) return;
    
    // Clear existing markers and route
    state.markers.forEach(marker => marker.remove());
    state.markers = [];
    if (state.routeLine) {
        state.routeLine.remove();
    }
    
    // Add start marker (not draggable)
    if (state.optimizedRoute.startCoords) {
        const startMarker = L.marker([state.optimizedRoute.startCoords.lat, state.optimizedRoute.startCoords.lon], {
            icon: L.divIcon({
                className: 'custom-marker',
                html: `<div style="background: var(--success); color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">🏠</div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            })
        }).addTo(state.map);
        state.markers.push(startMarker);
    }
    
    // Add address markers (draggable!)
    state.optimizedRoute.addresses.forEach((addr, index) => {
        if (addr.coords) {
            const status = getDeliveryStatus(getDeliveryStatusKey(addr));
            const isCorrected = addr.isCorrected || correctedLocations.get(addr.address);
            const markerColor = status.markerColor;
            const markerTextColor = status.markerTextColor;
            const markerBorder = isCorrected ? '2px solid var(--warning)' : 'none';
            
            const marker = L.marker([addr.coords.lat, addr.coords.lon], {
                draggable: true, // ניתן לגרירה!
                icon: L.divIcon({
                    className: 'custom-marker leaflet-marker-draggable',
                    html: `<div style="background: ${markerColor}; color: ${markerTextColor}; border: ${markerBorder}; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: move;">${index + 1}</div>`,
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                })
            }).addTo(state.map);
            
            marker.bindPopup(`<strong>${index + 1}. ${escapeHtml(addr.address)}</strong><br><small>${status.icon} ${status.label} | גרור לתיקון מיקום</small>`);
            
            // Event: סיום גרירה
            marker.on('dragend', function(e) {
                const newLatLng = e.target.getLatLng();
                handleMarkerDragEnd(addr.address, newLatLng, index);
            });
            
            state.markers.push(marker);
        }
    });
    
    // Draw route line
    if (state.optimizedRoute.geometry && state.optimizedRoute.geometry.coordinates) {
        const coords = state.optimizedRoute.geometry.coordinates.map(c => [c[1], c[0]]);
        state.routeLine = L.polyline(coords, {
            color: '#4361ee',
            weight: 4,
            opacity: 0.8
        }).addTo(state.map);
        
        state.map.fitBounds(state.routeLine.getBounds(), { padding: [30, 30] });
    }
}

function handleMarkerDragEnd(address, newLatLng, index) {
    // שמור את התיקון
    correctedLocations.set(address, {
        lat: newLatLng.lat,
        lon: newLatLng.lng
    });
    
    // עדכן את המצב
    if (state.optimizedRoute && state.optimizedRoute.addresses[index]) {
        state.optimizedRoute.addresses[index].coords = {
            lat: newLatLng.lat,
            lon: newLatLng.lng
        };
        state.optimizedRoute.addresses[index].isCorrected = true;
    }
    
    // גם עדכן את הcache
    geocodeCache.set(address, {
        lat: newLatLng.lat,
        lon: newLatLng.lng,
        displayName: address
    });
    
    saveState();
    showCorrectionToast();
    renderRouteAddresses();
    
    debugLog(`Location corrected: ${address} -> ${newLatLng.lat}, ${newLatLng.lng}`);
}

// ============================================
// Bulk Import Functions
// ============================================

function showImportModal() {
    elements.importModal.classList.add('active');
    elements.importTextarea.value = '';
    elements.importCount.textContent = '0 כתובות';
    elements.importTextarea.focus();
}

function hideImportModal() {
    elements.importModal.classList.remove('active');
}

function updateImportCount() {
    const text = elements.importTextarea.value;
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    elements.importCount.textContent = `${lines.length} כתובות`;
}

function handleBulkImport() {
    const text = elements.importTextarea.value;
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    
    if (lines.length === 0) {
        showAppToast('לא הוזנו כתובות', 'warning');
        return;
    }

    let addedCount = 0;

    // הוסף את הכתובות החדשות
    lines.forEach(line => {
        const address = line.trim();
        // בדוק שהכתובת לא כבר קיימת
        const exists = state.addresses.some(a => 
            a.address.trim().toLowerCase() === address.toLowerCase()
        );
        
        if (!exists && address.length > 0) {
            state.addresses.push({
                address: address,
                phone: '',
                notes: ''
            });
            addedCount++;
        }
    });
    
    renderAddresses();
    saveState();
    hideImportModal();
    
    if (addedCount > 0) {
        showAppToast(`יובאו ${addedCount} כתובות בהצלחה`, 'success');
    } else {
        showAppToast('כל הכתובות כבר קיימות ברשימה', 'warning');
    }
}

// ============================================
// Event Handlers
// ============================================

function handleNavigation(e) {
    const screenName = e.target.dataset.screen;
    if (!screenName) return;
    
    elements.navBtns.forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    
    document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
    
    if (screenName === 'input') {
        elements.inputScreen.classList.add('active');
    } else if (screenName === 'route') {
        elements.routeScreen.classList.add('active');
        if (!state.map) {
            setTimeout(initMap, 100);
        }
        setTimeout(updateMap, 150);
    } else if (screenName === 'history') {
        elements.historyScreen.classList.add('active');
        renderHistory();
    }
    
    state.currentScreen = screenName;
}

function handleAddAddress() {
    state.addresses.push({
        address: '',
        phone: '',
        notes: ''
    });
    renderAddresses();
    saveState();
    
    const lastInput = elements.addressesContainer.querySelector('.address-card:last-child .address-input');
    if (lastInput) {
        lastInput.focus();
    }
}

function handleDeleteAddress(e) {
    const index = parseInt(e.target.dataset.index);
    state.addresses.splice(index, 1);
    renderAddresses();
    saveState();
}

function handleAddressInput(e) {
    const index = parseInt(e.target.dataset.index);
    const field = e.target.dataset.field;
    
    if (index >= 0 && field) {
        state.addresses[index][field] = e.target.value;
    }
}

function handleAddressBlur(e) {
    const index = parseInt(e.target.dataset.index);
    const field = e.target.dataset.field;
    
    if (field === 'phone' && state.addresses[index]) {
        const formatted = formatPhoneNumber(state.addresses[index].phone);
        state.addresses[index].phone = formatted;
        e.target.value = formatted;
    }
    
    if (field === 'address' && state.addresses[index]) {
        const currentAddress = state.addresses[index].address.trim().toLowerCase();
        if (currentAddress) {
            const duplicateIndex = state.addresses.findIndex((addr, i) => 
                i !== index && addr.address.trim().toLowerCase() === currentAddress
            );
            if (duplicateIndex >= 0) {
                showDuplicateAlert();
            }
        }
    }
    
    saveState();
}

function handleStartAddressChange() {
    state.startAddress = elements.startAddressInput.value;
    saveState();
}

async function handleCalculateRoute() {
    if (!state.startAddress.trim()) {
        showAppToast('נא להזין כתובת התחלה', 'warning');
        return;
    }
    
    const validAddresses = state.addresses.filter(a => a.address.trim());
    if (validAddresses.length === 0) {
        showAppToast('נא להוסיף לפחות כתובת משלוח אחת', 'warning');
        return;
    }
    
    showLoading(true, 'בודק כתובת התחלה...');
    
    try {
        // Geocode start address
        let startGeo = correctedLocations.get(state.startAddress);
        if (startGeo) {
            startGeo = { lat: startGeo.lat, lon: startGeo.lon };
        } else {
            startGeo = await geocodeAddress(state.startAddress);
        }
        
        if (!startGeo) {
            showAppToast(`לא הצלחנו למצוא את הכתובת: ${state.startAddress}. אנא בדוק את הכתובת ונסה שוב.`, 'error', 5000);
            showLoading(false);
            return;
        }
        
        // Geocode all addresses
        const geocodeResult = await geocodeAddressesWithDelay(
            validAddresses,
            (current, total, cached) => updateLoadingProgress(current, total, cached)
        );
        
        if (geocodeResult.error) {
            let errorMessage;
            switch (geocodeResult.errorType) {
                case 'NETWORK_ERROR':
                    errorMessage = 'אין חיבור לאינטרנט. בדוק את החיבור ונסה שוב.';
                    break;
                case 'NOT_FOUND':
                    errorMessage = `לא הצלחנו למצוא את הכתובת: ${geocodeResult.error}. אנא בדוק את הכתובת ונסה שוב.`;
                    break;
                default:
                    errorMessage = `שגיאה בעיבוד הכתובת: ${geocodeResult.error}. אנא נסה שוב.`;
            }
            showAppToast(errorMessage, 'error', 5000);
            showLoading(false);
            return;
        }
        
        const geocodedAddresses = geocodeResult.results;
        debugLog(`Geocoding complete: ${geocodeResult.cachedCount} from cache, ${geocodeResult.fetchedCount} fetched`);
        
        showLoading(true, 'מחשב מסלול אופטימלי...');
        
        // Calculate optimal route with smart splitting
        const coordsForRouting = geocodedAddresses.map(a => a.coords);
        const routeResult = await calculateOptimalRouteWithSplitting(startGeo, coordsForRouting);
        
        if (!routeResult) {
            showAppToast('שגיאה בחישוב המסלול. אנא נסה שוב.', 'error', 5000);
            showLoading(false);
            return;
        }
        
        // Reorder addresses
        const orderedAddresses = routeResult.orderedIndices.map(i => normalizeRouteAddress({
            ...geocodedAddresses[i],
            status: 'pending',
            statusUpdatedAt: null
        }));
        
        state.optimizedRoute = {
            startAddress: state.startAddress,
            startCoords: startGeo,
            addresses: orderedAddresses,
            totalDistance: routeResult.distance,
            totalTime: routeResult.duration,
            geometry: routeResult.geometry,
            calculatedAt: new Date().toISOString()
        };
        
        saveState();
        saveToHistory(state.optimizedRoute);
        
        // Update UI
        updateRouteStats();
        elements.printDate.textContent = formatDate(new Date());
        
        renderRouteAddresses();
        
        // Switch to route screen
        elements.navBtns.forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-screen="route"]').classList.add('active');
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        elements.routeScreen.classList.add('active');
        
        setTimeout(() => {
            if (!state.map) initMap();
            updateMap();
        }, 100);

        showAppToast(`המסלול חושב עבור ${orderedAddresses.length} משלוחים`, 'success');

    } catch (error) {
        console.error('Error calculating route:', error);
        
        let errorMessage = 'משהו השתבש. אנא נסה שוב.';
        if (!navigator.onLine) {
            errorMessage = 'אין חיבור לאינטרנט. בדוק את החיבור ונסה שוב.';
        } else if (error.message && error.message.includes('Failed to fetch')) {
            errorMessage = 'בעיית תקשורת. בדוק את החיבור לאינטרנט ונסה שוב.';
        }
        showAppToast(errorMessage, 'error', 5000);
    }
    
    showLoading(false);
}

function handleNavigate(e) {
    const address = decodeURIComponent(e.target.dataset.address);
    const index = parseInt(e.target.dataset.index);
    
    // נסה לקבל קואורדינטות אם יש
    let lat, lon;
    if (state.optimizedRoute && state.optimizedRoute.addresses[index] && state.optimizedRoute.addresses[index].coords) {
        lat = state.optimizedRoute.addresses[index].coords.lat;
        lon = state.optimizedRoute.addresses[index].coords.lon;
    }
    
    // URL עם קואורדינטות (יותר מדויק)
    const wazeUrl = lat && lon 
        ? `waze://?ll=${lat},${lon}&navigate=yes`
        : `waze://?q=${encodeURIComponent(address)}&navigate=yes`;
    
    const googleMapsUrl = lat && lon
        ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
        : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
    
    // נסה Waze, אם לא עובד אחרי 1.5 שניות - פתח Google Maps
    const startTime = Date.now();
    window.location.href = wazeUrl;
    
    // בדוק אם Waze נפתח (אם לא, הדף עדיין פה אחרי timeout)
    setTimeout(() => {
        // אם עברו פחות מ-2 שניות והדף עדיין פעיל, כנראה Waze לא מותקן
        if (Date.now() - startTime < 2000 && document.visibilityState === 'visible') {
            window.location.href = googleMapsUrl;
        }
    }, 1500);
}

function setDeliveryStatus(index, statusKey) {
    if (!state.optimizedRoute || !state.optimizedRoute.addresses[index]) return;

    const address = state.optimizedRoute.addresses[index];
    const currentStatus = getDeliveryStatusKey(address);
    const nextStatus = currentStatus === statusKey && statusKey !== 'pending' ? 'pending' : statusKey;
    const status = getDeliveryStatus(nextStatus);

    address.status = nextStatus;
    address.statusUpdatedAt = new Date().toISOString();
    address.completed = nextStatus === 'delivered';

    updateRouteStats();
    renderRouteAddresses();
    updateMap();
    saveState();
    saveToHistory(state.optimizedRoute);

    showAppToast(`${address.address}: ${status.label}`, nextStatus === 'issue' ? 'warning' : 'success');
}

function handleSetDeliveryStatus(e) {
    const index = parseInt(e.currentTarget.dataset.index);
    const status = e.currentTarget.dataset.status;
    setDeliveryStatus(index, status);
}

function handleShareRoute() {
    const text = buildRouteText();

    if (!text) {
        showAppToast('אין מסלול לשיתוף', 'warning');
        return;
    }

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    const opened = window.open(whatsappUrl, '_blank', 'noopener,noreferrer');

    if (!opened) {
        window.location.href = whatsappUrl;
    }
}

function handleExportRoute() {
    if (!state.optimizedRoute || !Array.isArray(state.optimizedRoute.addresses) || state.optimizedRoute.addresses.length === 0) {
        showAppToast('אין מסלול לייצוא', 'warning');
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    downloadTextFile(`delivery-route-${today}.csv`, `\ufeff${buildRouteCsv()}`, 'text/csv;charset=utf-8');
    showAppToast('קובץ המסלול ירד למחשב', 'success');
}

function buildBackupData() {
    return {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
            deliveryRouteState: {
                startAddress: state.startAddress,
                addresses: state.addresses,
                optimizedRoute: normalizeRoute(state.optimizedRoute),
                lastViewedIndex: state.lastViewedIndex,
                currentScreen: state.currentScreen
            },
            deliveryRouteHistory: getHistory(),
            geocodeCache: geocodeCache.data,
            correctedLocations: correctedLocations.data
        }
    };
}

function handleBackupData() {
    const today = new Date().toISOString().split('T')[0];
    const backup = JSON.stringify(buildBackupData(), null, 2);
    downloadTextFile(`delivery-route-backup-${today}.json`, backup, 'application/json;charset=utf-8');
    showAppToast('קובץ גיבוי ירד למחשב', 'success');
}

function applyBackupData(backup) {
    if (!backup || !backup.data || !backup.data.deliveryRouteState) {
        throw new Error('INVALID_BACKUP');
    }

    const backupState = backup.data.deliveryRouteState;

    state.startAddress = backupState.startAddress || '';
    state.addresses = Array.isArray(backupState.addresses) ? backupState.addresses : [];
    state.optimizedRoute = normalizeRoute(backupState.optimizedRoute);
    state.lastViewedIndex = backupState.lastViewedIndex || 0;
    state.currentScreen = backupState.currentScreen || 'input';

    geocodeCache.data = backup.data.geocodeCache || {};
    correctedLocations.data = backup.data.correctedLocations || {};

    localStorage.setItem('deliveryRouteState', JSON.stringify({
        startAddress: state.startAddress,
        addresses: state.addresses,
        optimizedRoute: state.optimizedRoute,
        lastViewedIndex: state.lastViewedIndex,
        currentScreen: state.currentScreen
    }));
    localStorage.setItem('deliveryRouteHistory', JSON.stringify(backup.data.deliveryRouteHistory || []));
    geocodeCache.save();
    correctedLocations.save();

    elements.startAddressInput.value = state.startAddress;
    renderAddresses();
    renderRouteAddresses();
    renderHistory();
    updateRouteStats();

    const screenToShow = state.currentScreen === 'route' && !state.optimizedRoute ? 'input' : state.currentScreen;
    elements.navBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.screen === screenToShow));
    document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));

    if (screenToShow === 'route') {
        elements.routeScreen.classList.add('active');
        setTimeout(() => {
            if (!state.map) initMap();
            updateMap();
        }, 100);
    } else if (screenToShow === 'history') {
        elements.historyScreen.classList.add('active');
        renderHistory();
    } else {
        elements.inputScreen.classList.add('active');
    }

    if (state.map) {
        updateMap();
    }
}

function handleRestoreBackup(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
        try {
            const backup = JSON.parse(reader.result);
            showConfirmModal(
                'שחזור מגיבוי',
                'שחזור הגיבוי יחליף את הנתונים המקומיים באפליקציה. להמשיך?',
                () => {
                    applyBackupData(backup);
                    showAppToast('הגיבוי שוחזר בהצלחה', 'success');
                }
            );
        } catch (error) {
            showAppToast('קובץ הגיבוי לא תקין', 'error');
        } finally {
            elements.restoreFileInput.value = '';
        }
    };

    reader.onerror = () => {
        showAppToast('לא הצלחנו לקרוא את קובץ הגיבוי', 'error');
        elements.restoreFileInput.value = '';
    };

    reader.readAsText(file);
}

function handleClearAll() {
    showConfirmModal(
        'מחיקת כתובות',
        'האם אתה בטוח שברצונך למחוק את כל הכתובות?',
        () => {
            state.addresses = [];
            state.startAddress = '';
            elements.startAddressInput.value = '';
            renderAddresses();
            saveState();
        }
    );
}

function handleNewDay() {
    showConfirmModal(
        'התחלת יום חדש',
        'האם אתה בטוח? פעולה זו תמחק את המסלול הנוכחי.',
        () => {
            state.addresses = [];
            state.startAddress = '';
            state.optimizedRoute = null;
            elements.startAddressInput.value = '';
            renderAddresses();
            updateRouteStats();
            saveState();
            
            elements.navBtns.forEach(btn => btn.classList.remove('active'));
            document.querySelector('[data-screen="input"]').classList.add('active');
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            elements.inputScreen.classList.add('active');
        }
    );
}

function handlePrintRoute() {
    window.print();
}

function handleEditRoute() {
    elements.navBtns.forEach(btn => btn.classList.remove('active'));
    document.querySelector('[data-screen="input"]').classList.add('active');
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    elements.inputScreen.classList.add('active');
}

// ============================================
// Initialize App
// ============================================

function init() {
    // Load data
    correctedLocations.load();
    geocodeCache.load();
    loadState();
    
    // Render initial UI
    elements.startAddressInput.value = state.startAddress;
    renderAddresses();
    
    // If we have an optimized route, render it
    if (state.optimizedRoute && state.optimizedRoute.addresses && state.optimizedRoute.addresses.length > 0) {
        updateRouteStats();
        renderRouteAddresses();
    }
    
    // Restore the correct screen
    if (state.currentScreen && state.currentScreen !== 'input') {
        // Update nav buttons
        elements.navBtns.forEach(btn => btn.classList.remove('active'));
        const activeBtn = document.querySelector(`[data-screen="${state.currentScreen}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        
        // Update screens
        document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
        
        if (state.currentScreen === 'route' && state.optimizedRoute) {
            elements.routeScreen.classList.add('active');
            setTimeout(() => {
                if (!state.map) initMap();
                updateMap();
            }, 100);
        } else if (state.currentScreen === 'history') {
            elements.historyScreen.classList.add('active');
            renderHistory();
        } else {
            elements.inputScreen.classList.add('active');
        }
    }
    
    // Event Listeners
    elements.navBtns.forEach(btn => {
        btn.addEventListener('click', handleNavigation);
    });
    
    elements.startAddressInput.addEventListener('input', handleStartAddressChange);
    elements.addAddressBtn.addEventListener('click', handleAddAddress);
    elements.calculateRouteBtn.addEventListener('click', handleCalculateRoute);
    elements.clearAllBtn.addEventListener('click', handleClearAll);
    elements.printRouteBtn.addEventListener('click', handlePrintRoute);
    elements.shareRouteBtn.addEventListener('click', handleShareRoute);
    elements.exportRouteBtn.addEventListener('click', handleExportRoute);
    elements.editRouteBtn.addEventListener('click', handleEditRoute);
    elements.newDayBtn.addEventListener('click', handleNewDay);
    elements.modalCancel.addEventListener('click', hideConfirmModal);
    elements.historyModalClose.addEventListener('click', () => {
        elements.historyModal.classList.remove('active');
    });
    
    // Import modal events
    elements.bulkImportBtn.addEventListener('click', showImportModal);
    elements.importCancel.addEventListener('click', hideImportModal);
    elements.importConfirm.addEventListener('click', handleBulkImport);
    elements.importTextarea.addEventListener('input', updateImportCount);
    elements.backupDataBtn.addEventListener('click', handleBackupData);
    elements.restoreDataBtn.addEventListener('click', () => elements.restoreFileInput.click());
    elements.restoreFileInput.addEventListener('change', handleRestoreBackup);
    
    // Close modals on overlay click
    elements.confirmModal.addEventListener('click', (e) => {
        if (e.target === elements.confirmModal) hideConfirmModal();
    });
    
    elements.historyModal.addEventListener('click', (e) => {
        if (e.target === elements.historyModal) {
            elements.historyModal.classList.remove('active');
        }
    });
    
    elements.importModal.addEventListener('click', (e) => {
        if (e.target === elements.importModal) hideImportModal();
    });
    
    // Auto-save when app goes to background (user switches apps)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveState();
            debugLog('State saved (app went to background)');
        }
    });
    
    // Also save on page unload/refresh
    window.addEventListener('beforeunload', () => {
        saveState();
    });
    
    // Save periodically (every 30 seconds) as backup
    setInterval(() => {
        saveState();
    }, 30000);
    
    // Add first address if none exist
    if (state.addresses.length === 0) {
        handleAddAddress();
    }
    
    debugLog(`מסלול משלוחים v${APP_VERSION} initialized`);
    debugLog(`Backend API: ${isBackendApiEnabled() ? getApiBaseUrl() : 'disabled'}`);
    debugLog(`Cache: ${Object.keys(geocodeCache.data).length} addresses`);
    debugLog(`Corrections: ${Object.keys(correctedLocations.data).length} locations`);
    debugLog(`Restored screen: ${state.currentScreen}`);
}

// Start the app
document.addEventListener('DOMContentLoaded', init);

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(() => debugLog('ServiceWorker registered'))
            .catch(err => debugLog('ServiceWorker failed:', err));
    });
}
