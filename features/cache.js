/**
 * Simple in-memory cache with TTL support for API responses.
 * Dramatically reduces redundant API calls when navigating between pages.
 */

const cache = new Map();
const DEFAULT_TTL = 60 * 1000; // 1 minute default TTL

/**
 * Get cached data if still valid
 * @param {string} key - Cache key
 * @returns {any|null} - Cached data or null if expired/missing
 */
export const getCache = (key) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.data;
};

/**
 * Set cache with TTL
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 * @param {number} ttl - Time to live in milliseconds (default: 60s)
 */
export const setCache = (key, data, ttl = DEFAULT_TTL) => {
    cache.set(key, {
        data,
        expiresAt: Date.now() + ttl,
        cachedAt: Date.now()
    });
};

/**
 * Clear specific cache entry
 * @param {string} key - Cache key to clear
 */
export const clearCache = (key) => {
    cache.delete(key);
};

/**
 * Clear all cache entries
 */
export const clearAllCache = () => {
    cache.clear();
};

/**
 * Clear cache entries matching a prefix
 * @param {string} prefix - Key prefix to match
 */
export const clearCacheByPrefix = (prefix) => {
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
};

/**
 * Wrapper for async functions with caching
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Async function to call if cache miss
 * @param {number} ttl - Time to live in milliseconds
 * @returns {Promise<any>} - Cached or fresh data
 */
export const cachedFetch = async (key, fetchFn, ttl = DEFAULT_TTL) => {
    const cached = getCache(key);
    if (cached !== null) {
        console.log(`📦 Cache HIT: ${key}`);
        return cached;
    }
    console.log(`🔄 Cache MISS: ${key}`);
    const data = await fetchFn();
    setCache(key, data, ttl);
    return data;
};

// Cache TTL presets (in milliseconds)
export const TTL = {
    SHORT: 30 * 1000,      // 30 seconds - for frequently changing data
    MEDIUM: 60 * 1000,     // 1 minute - default
    LONG: 5 * 60 * 1000,   // 5 minutes - for stable data like holidays
    VERY_LONG: 15 * 60 * 1000, // 15 minutes - for rarely changing data
};

// Page cache for rendered HTML (instant navigation)
const pageCache = new Map();

/**
 * Cache rendered page HTML for instant re-navigation
 * @param {string} path - Page path
 * @param {string} html - Rendered HTML
 * @param {object} data - Associated data for hydration
 */
export const cachePageState = (path, html, data = null) => {
    pageCache.set(path, {
        html,
        data,
        cachedAt: Date.now()
    });
};

/**
 * Get cached page state
 * @param {string} path - Page path
 * @param {number} maxAge - Maximum age in ms (default: 2 minutes)
 * @returns {object|null} - Cached page state or null
 */
export const getPageState = (path, maxAge = 2 * 60 * 1000) => {
    const entry = pageCache.get(path);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > maxAge) {
        pageCache.delete(path);
        return null;
    }
    return entry;
};

/**
 * Clear page cache for a specific path
 * @param {string} path - Page path to clear
 */
export const clearPageState = (path) => {
    pageCache.delete(path);
};

/**
 * Clear all page cache
 */
export const clearAllPageState = () => {
    pageCache.clear();
};

export default {
    getCache,
    setCache,
    clearCache,
    clearAllCache,
    clearCacheByPrefix,
    cachedFetch,
    TTL,
    cachePageState,
    getPageState,
    clearPageState,
    clearAllPageState
};
