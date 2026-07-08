window.DELIVERY_ROUTE_CONFIG = {
    // Leave empty to use the direct public APIs as before.
    // Set to your backend origin, for example: 'https://api.example.com'
    apiBaseUrl: '',

    // During the migration phase this keeps the app working if the backend is down.
    // For a paid production product, set this to false.
    directFallback: true,

    requestTimeoutMs: 30000
};
