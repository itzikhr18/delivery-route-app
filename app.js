// ============================================
// מסלול משלוחים - Delivery Route Optimizer
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

// DOM Elements
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
    confirmModal: document.getElementById('confirm-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalText: document.getElementById('modal-text'),
    modalConfirm: document.getElementById('modal-confirm'),
    modalCancel: document.getElementById('modal-cancel'),
    historyModal: document.getElementById('history-modal'),
    historyModalTitle: document.getElementById('history-modal-title'),
    historyModalContent: document.getElementById('history-modal-content'),
    historyModalClose: document.getElementById('history-modal-close'),
    
    // Toast
    undoToast: document.getElementById('undo-toast'),
    undoBtn: document.getElementById('undo-btn'),
    
    // Navigation
    navBtns: document.querySelectorAll('.nav-btn')
};

// ============================================
// Utility Functions
// ============================================

function formatPhoneNumber(phone) {
    if (!phone) return '';
    
    // Remove all non-digit characters
    let cleaned = phone.replace(/\D/g, '');
    
    // Handle Israeli numbers
    if (cleaned.startsWith('972')) {
        cleaned = '0' + cleaned.slice(3);
    }
    
    // Ensure 10 digits with leading 0
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

function showLoading(show) {
    if (show) {
        elements.loadingOverlay.classList.add('active');
    } else {
        elements.loadingOverlay.classList.remove('active');
    }
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
            // Clean up entries older than 30 days
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
    
    // Check if today already exists
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

async function geocodeAddress(address) {
    // Add "Israel" to improve geocoding accuracy for Israeli addresses
    const searchAddress = address.includes('ישראל') ? address : `${address}, ישראל`;
    
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchAddress)}&format=json&limit=1`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Accept-Language': 'he'
            }
        });
        const data = await response.json();
        
        if (data && data.length > 0) {
            return {
                lat: parseFloat(data[0].lat),
                lon: parseFloat(data[0].lon),
                displayName: data[0].display_name
            };
        }
        return null;
    } catch (error) {
        console.error('Geocoding error:', error);
        return null;
    }
}

async function calculateOptimalRoute(startCoords, addressCoords) {
    if (addressCoords.length === 0) return null;
    
    // Build coordinates string for OSRM
    // Format: lon,lat;lon,lat;...
    const allCoords = [startCoords, ...addressCoords];
    const coordsString = allCoords.map(c => `${c.lon},${c.lat}`).join(';');
    
    // Use OSRM trip service for optimal route
    const url = `https://router.project-osrm.org/trip/v1/driving/${coordsString}?source=first&roundtrip=false&geometries=geojson&overview=full`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.code === 'Ok' && data.trips && data.trips.length > 0) {
            const trip = data.trips[0];
            
            // Get the optimal order (waypoint_index tells us the order)
            const waypoints = data.waypoints;
            
            // Create ordered list based on waypoint indices
            // Skip the first one (start address)
            const orderedIndices = waypoints
                .slice(1)
                .map((wp, originalIndex) => ({
                    originalIndex,
                    tripIndex: wp.waypoint_index
                }))
                .sort((a, b) => a.tripIndex - b.tripIndex)
                .map(item => item.originalIndex);
            
            return {
                distance: trip.distance / 1000, // Convert to km
                duration: trip.duration / 60, // Convert to minutes
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
    
    // Add event listeners to new inputs
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
        const card = document.createElement('div');
        card.className = `route-address-card ${address.completed ? 'completed' : ''}`;
        card.innerHTML = `
            <div class="route-address-header">
                <div class="route-number">${index + 1}</div>
                <div class="route-address-info">
                    <div class="route-address-text">${address.address}</div>
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
    
    // Add event listeners
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
    
    history.forEach((day, index) => {
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
// Map Functions
// ============================================

function initMap() {
    if (state.map) {
        state.map.remove();
    }
    
    // Default center on Beit Shemesh, Israel
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
    
    // Add start marker
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
    
    // Add address markers
    state.optimizedRoute.addresses.forEach((addr, index) => {
        if (addr.coords) {
            const marker = L.marker([addr.coords.lat, addr.coords.lon], {
                icon: L.divIcon({
                    className: 'custom-marker',
                    html: `<div style="background: linear-gradient(135deg, var(--primary), var(--secondary)); color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">${index + 1}</div>`,
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                })
            }).addTo(state.map);
            marker.bindPopup(`<strong>${index + 1}. ${addr.address}</strong>`);
            state.markers.push(marker);
        }
    });
    
    // Draw route line
    if (state.optimizedRoute.geometry) {
        const coords = state.optimizedRoute.geometry.coordinates.map(c => [c[1], c[0]]);
        state.routeLine = L.polyline(coords, {
            color: '#4361ee',
            weight: 4,
            opacity: 0.8
        }).addTo(state.map);
        
        // Fit map to route
        state.map.fitBounds(state.routeLine.getBounds(), { padding: [30, 30] });
    }
}

// ============================================
// Event Handlers
// ============================================

function handleNavigation(e) {
    const screenName = e.target.dataset.screen;
    if (!screenName) return;
    
    // Update nav buttons
    elements.navBtns.forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    
    // Update screens
    document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
    
    if (screenName === 'input') {
        elements.inputScreen.classList.add('active');
    } else if (screenName === 'route') {
        elements.routeScreen.classList.add('active');
        if (!state.map) {
            setTimeout(initMap, 100);
        }
        updateMap();
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
    
    // Focus on the new address input
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
    
    // Format phone number on blur
    if (field === 'phone' && state.addresses[index]) {
        const formatted = formatPhoneNumber(state.addresses[index].phone);
        state.addresses[index].phone = formatted;
        e.target.value = formatted;
    }
    
    // Check for duplicates
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
    // Validate
    if (!state.startAddress.trim()) {
        alert('נא להזין כתובת התחלה');
        return;
    }
    
    const validAddresses = state.addresses.filter(a => a.address.trim());
    if (validAddresses.length === 0) {
        alert('נא להוסיף לפחות כתובת משלוח אחת');
        return;
    }
    
    showLoading(true);
    
    try {
        // Geocode start address
        const startGeo = await geocodeAddress(state.startAddress);
        if (!startGeo) {
            alert(`לא הצלחנו למצוא את הכתובת: ${state.startAddress}. אנא בדוק את הכתובת ונסה שוב.`);
            showLoading(false);
            return;
        }
        
        // Geocode all addresses
        const geocodedAddresses = [];
        for (const addr of validAddresses) {
            const geo = await geocodeAddress(addr.address);
            if (geo) {
                geocodedAddresses.push({
                    ...addr,
                    coords: geo
                });
            } else {
                alert(`לא הצלחנו למצוא את הכתובת: ${addr.address}. אנא בדוק את הכתובת ונסה שוב.`);
                showLoading(false);
                return;
            }
        }
        
        // Calculate optimal route
        const coordsForRouting = geocodedAddresses.map(a => a.coords);
        const routeResult = await calculateOptimalRoute(startGeo, coordsForRouting);
        
        if (!routeResult) {
            alert('שגיאה בחישוב המסלול. אנא נסה שוב.');
            showLoading(false);
            return;
        }
        
        // Reorder addresses according to optimal route
        const orderedAddresses = routeResult.orderedIndices.map(i => geocodedAddresses[i]);
        
        // Save optimized route
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
        
        // Init map if needed
        setTimeout(() => {
            if (!state.map) {
                initMap();
            }
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
    
    // Try Waze first
    const wazeUrl = `waze://?q=${encodeURIComponent(address)}`;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    
    // On iOS, try waze:// scheme, fallback to Google Maps
    window.location.href = wazeUrl;
    
    // Fallback after short delay if Waze doesn't open
    setTimeout(() => {
        // This will only work if Waze didn't open
        // (user will have already navigated away if Waze opened)
    }, 100);
}

function handleCompleteDelivery(e) {
    const index = parseInt(e.target.dataset.index);
    
    showConfirmModal(
        'סיום משלוח',
        'האם סיימת משלוח זה?',
        () => {
            const removedAddress = state.optimizedRoute.addresses[index];
            state.optimizedRoute.addresses.splice(index, 1);
            
            // Update stats
            elements.statDeliveries.textContent = state.optimizedRoute.addresses.length;
            
            renderRouteAddresses();
            updateMap();
            saveState();
            
            // Show undo option
            showUndoToast(removedAddress, () => {
                // Undo - add address back
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
            
            // Switch to input screen
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
    // Switch to input screen
    elements.navBtns.forEach(btn => btn.classList.remove('active'));
    document.querySelector('[data-screen="input"]').classList.add('active');
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    elements.inputScreen.classList.add('active');
}

// ============================================
// Initialize App
// ============================================

function init() {
    // Load saved state
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
    
    // Close modals on overlay click
    elements.confirmModal.addEventListener('click', (e) => {
        if (e.target === elements.confirmModal) {
            hideConfirmModal();
        }
    });
    
    elements.historyModal.addEventListener('click', (e) => {
        if (e.target === elements.historyModal) {
            elements.historyModal.classList.remove('active');
        }
    });
    
    // Add first address if none exist
    if (state.addresses.length === 0) {
        handleAddAddress();
    }
}

// Start the app
document.addEventListener('DOMContentLoaded', init);

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(registration => {
                console.log('ServiceWorker registration successful');
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
    });
}
