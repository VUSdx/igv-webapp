/**
 * Bootstrap modal file-browser for Azure Blob Storage.
 *
 * `open({ multiSelect })` signs the user in, lists the configured container, and lets the user
 * navigate folders and select one or more blobs.  It resolves to an array of
 * `{ path: <blobName>, name: <displayName> }` (empty/cancelled → null).  Callers turn the selected
 * blob names into SAS URLs via azureClient.getSasUrl (see fileLoad.js).
 */

import alertSingleton from './alertSingleton.js'
import {signIn, listDirectory} from './azureClient.js'

const MODAL_ID = 'igv-app-azure-browser-modal'

let modalElement
let bsModal
let listContainer
let breadcrumbContainer
let loadButton

let currentPrefix = ''
let multiSelect = true
let selected = new Map()        // blobName -> displayName
let resolveSelection

function build() {
    if (modalElement) return

    const html =
        `<div id="${MODAL_ID}" class="modal fade" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <div class="modal-title">Azure Storage</div>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <nav aria-label="breadcrumb">
                            <ol class="breadcrumb igv-azure-breadcrumb"></ol>
                        </nav>
                        <div class="list-group igv-azure-list" style="max-height: 50vh; overflow-y: auto;"></div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
                        <button type="button" class="btn btn-sm btn-secondary igv-azure-load-btn" disabled>Load</button>
                    </div>
                </div>
            </div>
        </div>`

    modalElement = document.createRange().createContextualFragment(html).firstChild
    document.body.appendChild(modalElement)

    bsModal = new bootstrap.Modal(modalElement)
    listContainer = modalElement.querySelector('.igv-azure-list')
    breadcrumbContainer = modalElement.querySelector('.igv-azure-breadcrumb')
    loadButton = modalElement.querySelector('.igv-azure-load-btn')

    loadButton.addEventListener('click', () => {
        if (!resolveSelection) return
        const result = Array.from(selected.entries()).map(([path, name]) => ({path, name}))
        const resolve = resolveSelection
        resolveSelection = undefined
        bsModal.hide()
        resolve(result)
    })

    // Cancel / close / backdrop dismiss resolves to null (unless Load already resolved).
    modalElement.addEventListener('hidden.bs.modal', () => {
        if (resolveSelection) {
            const resolve = resolveSelection
            resolveSelection = undefined
            resolve(null)
        }
    })
}

function open(opts = {}) {
    build()

    multiSelect = opts.multiSelect !== false
    selected = new Map()
    currentPrefix = ''
    updateLoadButton()
    bsModal.show()

    const promise = new Promise(resolve => {
        resolveSelection = resolve
    })

    ;(async () => {
        try {
            await signIn()
            await navigate('')
        } catch (e) {
            console.error(e)
            alertSingleton.present(e.message || String(e))
            if (resolveSelection) {
                const resolve = resolveSelection
                resolveSelection = undefined
                bsModal.hide()
                resolve(null)
            }
        }
    })()

    return promise
}

async function navigate(prefix) {
    currentPrefix = prefix
    renderBreadcrumb()
    listContainer.replaceChildren(message('Loading…'))
    const entries = await listDirectory(prefix)
    renderEntries(entries)
}

async function navigateSafe(prefix) {
    try {
        await navigate(prefix)
    } catch (e) {
        console.error(e)
        alertSingleton.present(e.message || String(e))
    }
}

function renderEntries(entries) {
    if (entries.length === 0) {
        listContainer.replaceChildren(message('This folder is empty.'))
        return
    }

    const rows = entries.map(entry => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'list-group-item list-group-item-action d-flex align-items-center'

        const icon = document.createElement('span')
        icon.className = 'me-2'
        icon.textContent = entry.isDirectory ? '📁' : '📄'
        row.appendChild(icon)

        const label = document.createElement('span')
        label.textContent = entry.name
        row.appendChild(label)

        if (entry.isDirectory) {
            row.addEventListener('click', () => navigateSafe(entry.path))
        } else {
            if (entry.size != null) {
                const size = document.createElement('span')
                size.className = 'ms-auto small text-muted'
                size.textContent = formatSize(entry.size)
                row.appendChild(size)
            }
            if (selected.has(entry.path)) row.classList.add('active')
            row.addEventListener('click', () => toggleFile(entry, row))
        }

        return row
    })

    listContainer.replaceChildren(...rows)
}

function toggleFile(entry, row) {
    if (selected.has(entry.path)) {
        selected.delete(entry.path)
        row.classList.remove('active')
    } else {
        if (!multiSelect) {
            selected.clear()
            listContainer.querySelectorAll('.list-group-item.active').forEach(el => el.classList.remove('active'))
        }
        selected.set(entry.path, entry.name)
        row.classList.add('active')
    }
    updateLoadButton()
}

function renderBreadcrumb() {
    const parts = currentPrefix.split('/').filter(Boolean)

    const makeCrumb = (text, prefix, active) => {
        const li = document.createElement('li')
        li.className = `breadcrumb-item${active ? ' active' : ''}`
        if (active) {
            li.textContent = text
        } else {
            const anchor = document.createElement('a')
            anchor.href = '#'
            anchor.textContent = text
            anchor.addEventListener('click', e => {
                e.preventDefault()
                navigateSafe(prefix)
            })
            li.appendChild(anchor)
        }
        return li
    }

    const crumbs = [makeCrumb('Home', '', parts.length === 0)]
    let acc = ''
    parts.forEach((part, i) => {
        acc += `${part}/`
        crumbs.push(makeCrumb(part, acc, i === parts.length - 1))
    })

    breadcrumbContainer.replaceChildren(...crumbs)
}

function updateLoadButton() {
    if (!loadButton) return
    const count = selected.size
    loadButton.disabled = count === 0
    loadButton.textContent = count > 1 ? `Load ${count} files` : 'Load'
}

function message(text) {
    const div = document.createElement('div')
    div.className = 'p-3 text-muted'
    div.textContent = text
    return div
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return `${value.toFixed(1)} ${units[i]}`
}

export {open}
