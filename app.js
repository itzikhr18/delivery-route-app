// ============================================
// מסלול משלוחים - Delivery Route Optimizer
// גרסה 3.0 - Bulk Import, Pin Dragging, Smart Splitting
// ============================================

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
    undoTimeout: null,
    lastRemovedAddress: null
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
    
    // Toasts
    undoToast: document.getElementById('undo-toast'),
    undoBtn: document.getElementById('undo-btn'),
    correctionToast: document.getElementById('correction-toast'),
    
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
    
    const confirmHandler = () => {
        elements.confirmModal.classList.remove('active');
        elements.modalConfirm.removeEventListener('click', confirmHandler);
        onConfirm();
    };
    
    elements.modalConfirm.addEventListener('click', confirmHandler);
}

function hideConfirmModal() {
    elements.confirmModal.classList.remove('active');
}

function showDuplicateAlert() {
    elements.duplicateAlert.style.display = 'flex';
    setTimeout(() => {
        elements.duplicateAlert.style.display = 'none';
    }, 3000);
}

function showUndoToast(address, callback) {
    if (state.undoTimeout) {
        clearTimeout(state.undoTimeout);
    }
    
    state.lastRemovedAddress = address;
    elements.undoToast.style.display = 'flex';
    
    state.undoTimeout = setTimeout(() => {
        elements.undoToast.style.display = 'none';
        state.lastRemovedAddress = null;
    }, 5000);
    
    elements.undoBtn.onclick = () => {
        clearTimeout(state.undoTimeout);
        elements.undoToast.style.display = 'none';
        if (callback) callback();
    };
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
        lastViewedIndex: state.lastViewedIndex
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
            state.optimizedRoute = data.optimizedRoute || null;
            state.lastViewedIndex = data.lastViewedIndex || 0;
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
    const history = getHistory();
    const today = new Date().toISOString().split('T')[0];
    
    const existingIndex = history.findIndex(h => h.date === today);
    
    const historyEntry = {
        date: today,
        totalKm: routeData.totalDistance,
        deliveryCount: routeData.addresses.length,
        totalTime: routeData.totalTime,
        startAddress: routeData.startAddress,
        addresses: routeData.addresses.map((addr, index) => ({
            order: index + 1,
            address: addr.address,
            phone: addr.phone,
            notes: addr.notes
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
        console.log(`Using corrected location: ${address}`);
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
            console.log(`Cache hit: ${address}`);
            return cached;
        }
    }
    
    // 3. חפש ב-Nominatim
    const searchAddress = address.includes('ישראל') ? address : `${address}, ישראל`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchAddress)}&format=json&limit=1`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Accept-Language': 'he',
                'User-Agent': 'DeliveryRouteApp/3.0'
            }
        });
        const data = await response.json();
        
        if (data && data.length > 0) {
            const coords = {
                lat: parseFloat(data[0].lat),
                lon: parseFloat(data[0].lon),
                displayName: data[0].display_name
            };
            
            geocodeCache.set(address, coords);
            return coords;
        }
        return null;
    } catch (error) {
        console.error('Geocoding error:', error);
        return null;
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
        
        const geo = await geocodeAddress(addr.address, false);
        fetchedCount++;
        
        if (geo) {
            results.push({ ...addr, coords: geo });
        } else {
            return { error: addr.address, results: null };
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
    
    // אם פחות מ-BATCH_SIZE, חשב רגיל
    if (addressCoords.length <= BATCH_SIZE) {
        return await calculateSingleBatchRoute(startCoords, addressCoords);
    }
    
    // חלק לקבוצות
    console.log(`Splitting ${addressCoords.length} addresses into batches of ${BATCH_SIZE}`);
    
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
        console.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} addresses`);
        
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
            <input type="text" class="form-input address-input" placeholder="כתובת *" value="${address.address || ''}" data-index="${index}" data-field="address">
            <input type="tel" class="form-input phone-input" placeholder="מספר טלפון" value="${address.phone || ''}" data-index="${index}" data-field="phone" dir="ltr">
            <input type="text" class="form-input notes-input" placeholder="הערות" value="${address.notes || ''}" data-index="${index}" data-field="notes">
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
        const isCorrected = address.isCorrected || correctedLocations.get(address.address);
        const card = document.createElement('div');
        card.className = `route-address-card ${address.completed ? 'completed' : ''} ${isCorrected ? 'corrected' : ''}`;
        card.innerHTML = `
            <div class="route-address-header">
                <div class="route-number">${index + 1}</div>
                <div class="route-address-info">
                    <div class="route-address-text">
                        ${isCorrected ? '<span class="corrected-badge">📍 מתוקן</span>' : ''}
                        ${address.address}
                    </div>
                    ${address.notes ? `<div class="route-address-notes">📝 ${address.notes}</div>` : ''}
                </div>
            </div>
            <div class="route-address-actions">
                ${address.phone ? `<a href="tel:${address.phone}" class="btn btn-phone btn-sm">📞 ${address.phone}</a>` : ''}
                <button class="btn btn-waze btn-sm navigate-btn" data-address="${encodeURIComponent(address.address)}">🧭 Waze</button>
                <button class="btn btn-success btn-sm complete-btn" data-index="${index}">✓ בוצע</button>
            </div>
        `;
        elements.routeAddressesContainer.appendChild(card);
    });
    
    document.querySelectorAll('.navigate-btn').forEach(btn => {
        btn.addEventListener('click', handleNavigate);
    });
    
    document.querySelectorAll('.complete-btn').forEach(btn => {
        btn.addEventListener('click', handleCompleteDelivery);
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
        card.innerHTML = `
            <div class="history-day-header">
                <span class="history-date">${formatDate(day.date)}</span>
                <span style="color: var(--primary);">הצג פרטים ←</span>
            </div>
            <div class="history-stats">
                <span>📦 ${day.deliveryCount} משלוחים</span>
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
            <strong>נקודת התחלה:</strong> ${day.startAddress || 'לא צוין'}
        </div>
        <div style="margin-bottom: 12px; font-size: 0.875rem; color: var(--gray-500);">
            סה"כ: ${day.deliveryCount} משלוחים | ${day.totalKm.toFixed(1)} ק"מ | ${Math.round(day.totalTime)} דקות
        </div>
    `;
    
    day.addresses.forEach(addr => {
        content += `
            <div style="padding: 12px; background: var(--white); border-radius: var(--radius-sm); margin-bottom: 8px; border-right: 3px solid var(--primary);">
                <div style="font-weight: 600;">${addr.order}. ${addr.address}</div>
                ${addr.phone ? `<div style="font-size: 0.875rem; color: var(--gray-500); margin-top: 4px;">📞 ${addr.phone}</div>` : ''}
                ${addr.notes ? `<div style="font-size: 0.875rem; color: var(--gray-500); margin-top: 4px;">📝 ${addr.notes}</div>` : ''}
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
            const isCorrected = addr.isCorrected || correctedLocations.get(addr.address);
            const markerColor = isCorrected ? 'var(--warning)' : 'linear-gradient(135deg, var(--primary), var(--secondary))';
            
            const marker = L.marker([addr.coords.lat, addr.coords.lon], {
                draggable: true, // ניתן לגרירה!
                icon: L.divIcon({
                    className: 'custom-marker leaflet-marker-draggable',
                    html: `<div style="background: ${markerColor}; color: ${isCorrected ? 'var(--gray-800)' : 'white'}; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: move;">${index + 1}</div>`,
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                })
            }).addTo(state.map);
            
            marker.bindPopup(`<strong>${index + 1}. ${addr.address}</strong><br><small>גרור לתיקון מיקום</small>`);
            
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
    
    console.log(`Location corrected: ${address} -> ${newLatLng.lat}, ${newLatLng.lng}`);
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
        alert('לא הוזנו כתובות');
        return;
    }
    
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
        }
    });
    
    renderAddresses();
    saveState();
    hideImportModal();
    
    // הודעה למשתמש
    alert(`יובאו ${lines.length} כתובות בהצלחה!`);
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
        alert('נא להזין כתובת התחלה');
        return;
    }
    
    const validAddresses = state.addresses.filter(a => a.address.trim());
    if (validAddresses.length === 0) {
        alert('נא להוסיף לפחות כתובת משלוח אחת');
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
            alert(`לא הצלחנו למצוא את הכתובת: ${state.startAddress}. אנא בדוק את הכתובת ונסה שוב.`);
            showLoading(false);
            return;
        }
        
        // Geocode all addresses
        const geocodeResult = await geocodeAddressesWithDelay(
            validAddresses,
            (current, total, cached) => updateLoadingProgress(current, total, cached)
        );
        
        if (geocodeResult.error) {
            alert(`לא הצלחנו למצוא את הכתובת: ${geocodeResult.error}. אנא בדוק את הכתובת ונסה שוב.`);
            showLoading(false);
            return;
        }
        
        const geocodedAddresses = geocodeResult.results;
        console.log(`Geocoding complete: ${geocodeResult.cachedCount} from cache, ${geocodeResult.fetchedCount} fetched`);
        
        showLoading(true, 'מחשב מסלול אופטימלי...');
        
        // Calculate optimal route with smart splitting
        const coordsForRouting = geocodedAddresses.map(a => a.coords);
        const routeResult = await calculateOptimalRouteWithSplitting(startGeo, coordsForRouting);
        
        if (!routeResult) {
            alert('שגיאה בחישוב המסלול. אנא נסה שוב.');
            showLoading(false);
            return;
        }
        
        // Reorder addresses
        const orderedAddresses = routeResult.orderedIndices.map(i => geocodedAddresses[i]);
        
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
        elements.statDeliveries.textContent = orderedAddresses.length;
        elements.statDistance.textContent = routeResult.distance.toFixed(1);
        elements.statTime.textContent = Math.round(routeResult.duration);
        elements.routeStartText.textContent = state.startAddress;
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
        
    } catch (error) {
        console.error('Error calculating route:', error);
        alert('משהו השתבש. אנא נסה שוב.');
    }
    
    showLoading(false);
}

function handleNavigate(e) {
    const address = decodeURIComponent(e.target.dataset.address);
    const wazeUrl = `waze://?q=${encodeURIComponent(address)}`;
    window.location.href = wazeUrl;
}

function handleCompleteDelivery(e) {
    const index = parseInt(e.target.dataset.index);
    
    showConfirmModal(
        'סיום משלוח',
        'האם סיימת משלוח זה?',
        () => {
            const removedAddress = state.optimizedRoute.addresses[index];
            state.optimizedRoute.addresses.splice(index, 1);
            
            elements.statDeliveries.textContent = state.optimizedRoute.addresses.length;
            
            renderRouteAddresses();
            updateMap();
            saveState();
            
            showUndoToast(removedAddress, () => {
                state.optimizedRoute.addresses.splice(index, 0, removedAddress);
                elements.statDeliveries.textContent = state.optimizedRoute.addresses.length;
                renderRouteAddresses();
                updateMap();
                saveState();
            });
        }
    );
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
        elements.statDeliveries.textContent = state.optimizedRoute.addresses.length;
        elements.statDistance.textContent = state.optimizedRoute.totalDistance.toFixed(1);
        elements.statTime.textContent = Math.round(state.optimizedRoute.totalTime);
        elements.routeStartText.textContent = state.optimizedRoute.startAddress;
        renderRouteAddresses();
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
    
    // Add first address if none exist
    if (state.addresses.length === 0) {
        handleAddAddress();
    }
    
    console.log('מסלול משלוחים v3.0 initialized');
    console.log(`Cache: ${Object.keys(geocodeCache.data).length} addresses`);
    console.log(`Corrections: ${Object.keys(correctedLocations.data).length} locations`);
}

// Start the app
document.addEventListener('DOMContentLoaded', init);

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(registration => console.log('ServiceWorker registered'))
            .catch(err => console.log('ServiceWorker failed:', err));
    });
}
