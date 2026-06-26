/**
 * Azure Blob Storage access for the load menus, with no backend involved.
 *
 * The user signs in with Microsoft Entra ID (MSAL, Authorization Code + PKCE) and that identity is
 * used to:
 *   - list blobs/folders in the configured container (for the file-browser UI), and
 *   - mint a short-lived user-delegation SAS URL for a selected blob.
 *
 * The SAS URL is what gets handed to igv.js: igv loads data with HTTP byte-range requests, and a SAS
 * URL is a plain URL it can range-read without attaching Authorization / x-ms-version headers (which
 * it does not do, and which would trigger CORS preflight).  The user's own Azure RBAC gates access;
 * no secrets are stored in the app.
 *
 * Only MSAL is loaded as a library (lazily, as an ES module from the jsDelivr `/+esm` CDN, so the
 * rollup build is untouched — the dynamic import() is preserved as-is in the 'es' output bundle).
 * The storage operations (list, user-delegation key, SAS signing) are done with direct REST calls +
 * DOMParser + Web Crypto, because the @azure/storage-blob browser bundle mis-deserializes the
 * service XML responses.
 */

// Pinned CDN ES-module bundle.
const MSAL_ESM = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.28.1/+esm'

// Delegated permission scope for the Azure Storage data plane.
const STORAGE_SCOPE = 'https://storage.azure.com/user_impersonation'

// Storage service REST API version used for direct calls (also the SAS signed version).
const STORAGE_API_VERSION = '2021-12-02'

let libsPromise            // memoized CDN load
let msalLib                // @azure/msal-browser module namespace
let msalApp                // msalLib.PublicClientApplication

/**
 * True when the Azure picker is configured and should be offered in the menus.
 */
function isConfigured() {
    return typeof igvwebConfig !== 'undefined' && !!igvwebConfig.azure
}

function getConfig() {
    if (!isConfigured()) {
        throw new Error('Azure storage is not configured (set igvwebConfig.azure)')
    }
    const {clientId, tenantId, storageAccount, container} = igvwebConfig.azure
    if (!clientId || !tenantId || !storageAccount || !container) {
        throw new Error('igvwebConfig.azure must define clientId, tenantId, storageAccount, and container')
    }
    return igvwebConfig.azure
}

/**
 * Lazy-load the MSAL ES module.  Memoized; on failure the memo is cleared so a later attempt can
 * retry.
 */
async function ensureLibsLoaded() {
    if (!libsPromise) {
        libsPromise = (async () => {
            msalLib = await import(MSAL_ESM)
            if (!msalLib?.PublicClientApplication) {
                throw new Error('MSAL library (msal-browser) failed to load')
            }
        })().catch(e => {
            libsPromise = undefined
            throw e
        })
    }
    return libsPromise
}

async function getMsalApp() {
    if (msalApp) return msalApp

    await ensureLibsLoaded()
    const {clientId, tenantId} = getConfig()

    msalApp = new msalLib.PublicClientApplication({
        auth: {
            clientId,
            authority: `https://login.microsoftonline.com/${tenantId}`,
            redirectUri: window.location.origin + window.location.pathname
        },
        cache: {cacheLocation: 'sessionStorage'}
    })

    await msalApp.initialize()

    // Adopt an existing account if one is already cached (e.g. from a prior redirect flow).
    const redirectResponse = await msalApp.handleRedirectPromise()
    const account = redirectResponse?.account || msalApp.getActiveAccount() || msalApp.getAllAccounts()[0]
    if (account) {
        msalApp.setActiveAccount(account)
    }

    return msalApp
}

/**
 * Acquire a storage-scoped access token, prompting interactively only when required.  Returns the
 * shape expected by the @azure/core-auth TokenCredential interface.
 */
async function acquireToken() {
    const app = await getMsalApp()
    const request = {scopes: [STORAGE_SCOPE]}

    let account = app.getActiveAccount()
    if (!account) {
        const login = await app.loginPopup(request)
        account = login.account
        app.setActiveAccount(account)
    }

    try {
        const result = await app.acquireTokenSilent({...request, account})
        return {token: result.accessToken, expiresOnTimestamp: result.expiresOn.getTime()}
    } catch (e) {
        if (e instanceof msalLib.InteractionRequiredAuthError) {
            const result = await app.acquireTokenPopup(request)
            app.setActiveAccount(result.account)
            return {token: result.accessToken, expiresOnTimestamp: result.expiresOn.getTime()}
        }
        throw e
    }
}

/**
 * Sign the user in (interactive prompt if needed).  Call this from a user-gesture handler so the
 * popup is not blocked.
 */
async function signIn() {
    await acquireToken()
}

/**
 * List the immediate folders and blobs under `prefix` in the configured container.
 * `prefix` is a blob-name prefix ending in '/' (or '' for the container root).
 * Returns `[{ name, path, isDirectory, size }]`, directories first then files, alphabetically.
 *
 * Implemented as a direct List Blobs REST call (parsed with DOMParser) rather than via the SDK:
 * the SDK's browser ES-module bundle mis-deserializes the list XML.
 */
async function listDirectory(prefix = '') {
    const {storageAccount, container} = getConfig()
    const {token} = await acquireToken()

    const base = `https://${storageAccount}.blob.core.windows.net/${container}` +
        `?restype=container&comp=list&delimiter=%2F`

    const entries = []
    let marker = ''
    do {
        let url = base
        if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`
        if (marker) url += `&marker=${encodeURIComponent(marker)}`

        const response = await fetch(url, {
            headers: {Authorization: `Bearer ${token}`, 'x-ms-version': STORAGE_API_VERSION}
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`Azure list failed (${response.status}): ${text.slice(0, 300)}`)
        }

        const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
        if (doc.querySelector('parsererror')) {
            throw new Error('Failed to parse Azure list response')
        }

        for (const node of doc.getElementsByTagName('BlobPrefix')) {
            const name = node.getElementsByTagName('Name')[0]?.textContent || ''
            entries.push({
                name: name.slice(prefix.length).replace(/\/$/, ''),
                path: name,
                isDirectory: true
            })
        }
        for (const node of doc.getElementsByTagName('Blob')) {
            const name = node.getElementsByTagName('Name')[0]?.textContent || ''
            const sizeText = node.getElementsByTagName('Content-Length')[0]?.textContent
            entries.push({
                name: name.slice(prefix.length),
                path: name,
                isDirectory: false,
                size: sizeText ? parseInt(sizeText, 10) : undefined
            })
        }

        marker = doc.getElementsByTagName('NextMarker')[0]?.textContent || ''
    } while (marker)

    entries.sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1))
    return entries
}

// ISO 8601 UTC with second precision (no milliseconds), as Azure SAS expects.
function toAzureIso(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// HMAC-SHA256(message) keyed with a base64-encoded key, returned base64-encoded.
async function hmacSha256Base64(keyBase64, message) {
    const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

// Request a user-delegation key (REST), parsed with DOMParser.
async function fetchUserDelegationKey(token, startIso, expiryIso) {
    const {storageAccount} = getConfig()
    const url = `https://${storageAccount}.blob.core.windows.net/?restype=service&comp=userdelegationkey`
    const body = `<?xml version="1.0" encoding="utf-8"?>` +
        `<KeyInfo><Start>${startIso}</Start><Expiry>${expiryIso}</Expiry></KeyInfo>`

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'x-ms-version': STORAGE_API_VERSION,
            'Content-Type': 'application/xml'
        },
        body
    })
    if (!response.ok) {
        const text = await response.text()
        throw new Error(`User delegation key request failed (${response.status}): ${text.slice(0, 300)}`)
    }

    const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
    if (doc.querySelector('parsererror')) {
        throw new Error('Failed to parse user delegation key response')
    }
    const get = tag => doc.getElementsByTagName(tag)[0]?.textContent || ''
    return {
        signedOid: get('SignedOid'),
        signedTid: get('SignedTid'),
        signedStart: get('SignedStart'),
        signedExpiry: get('SignedExpiry'),
        signedService: get('SignedService'),
        signedVersion: get('SignedVersion'),
        value: get('Value')
    }
}

/**
 * Mint a short-lived (1 hour) read-only user-delegation SAS URL for `blobName`.
 *
 * Built by hand (REST key fetch + Web Crypto HMAC) rather than via the SDK, whose browser bundle
 * mis-handles the service XML.  The string-to-sign follows the documented user-delegation SAS layout
 * for signed version 2020-12-06+ (which includes the signedEncryptionScope field).
 */
async function getSasUrl(blobName) {
    const {storageAccount, container} = getConfig()
    const {token} = await acquireToken()

    const startIso = toAzureIso(new Date(Date.now() - 5 * 60 * 1000))   // allow for clock skew
    const expiryIso = toAzureIso(new Date(Date.now() + 60 * 60 * 1000))

    const key = await fetchUserDelegationKey(token, startIso, expiryIso)

    const signedPermissions = 'r'
    const signedProtocol = 'https'
    const signedResource = 'b'
    const signedVersion = key.signedVersion || STORAGE_API_VERSION
    const canonicalizedResource = `/blob/${storageAccount}/${container}/${blobName}`

    const stringToSign = [
        signedPermissions,
        startIso,                 // signed start (st)
        expiryIso,                // signed expiry (se)
        canonicalizedResource,
        key.signedOid,            // skoid
        key.signedTid,            // sktid
        key.signedStart,          // skt
        key.signedExpiry,         // ske
        key.signedService,        // sks
        key.signedVersion,        // skv
        '',                       // signedAuthorizedUserObjectId (saoid)
        '',                       // signedUnauthorizedUserObjectId (suoid)
        '',                       // signedCorrelationId (scid)
        '',                       // signedIP (sip)
        signedProtocol,           // spr
        signedVersion,            // sv
        signedResource,           // sr
        '',                       // signedSnapshotTime
        '',                       // signedEncryptionScope (ses)
        '',                       // rscc - Cache-Control
        '',                       // rscd - Content-Disposition
        '',                       // rsce - Content-Encoding
        '',                       // rscl - Content-Language
        ''                        // rsct - Content-Type
    ].join('\n')

    const signature = await hmacSha256Base64(key.value, stringToSign)

    const params = new URLSearchParams()
    params.set('sv', signedVersion)
    params.set('sr', signedResource)
    params.set('st', startIso)
    params.set('se', expiryIso)
    params.set('sp', signedPermissions)
    params.set('spr', signedProtocol)
    params.set('skoid', key.signedOid)
    params.set('sktid', key.signedTid)
    params.set('skt', key.signedStart)
    params.set('ske', key.signedExpiry)
    params.set('sks', key.signedService)
    params.set('skv', key.signedVersion)
    params.set('sig', signature)

    const encodedBlob = blobName.split('/').map(encodeURIComponent).join('/')
    return `https://${storageAccount}.blob.core.windows.net/${container}/${encodedBlob}?${params.toString()}`
}

export {isConfigured, ensureLibsLoaded, signIn, listDirectory, getSasUrl}
