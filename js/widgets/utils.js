import {igvxhr} from '../../node_modules/igv-utils/src/index.js'
import {GenericDataSource} from '../../node_modules/data-modal/src/index.js'

/**
 * Factory function for creating a GenericDataSource instance.
 * Centralises construction so call sites do not import or reference
 * the GenericDataSource class directly.   Insures that 'igvxhr' is used for string loading.
 * 'igvxhr' handles Google Auth and gzipped files automatically
 *
 * @param {Object} config - Datasource configuration object
 * @returns {GenericDataSource}
 */
function createDataSource(config) {
    config.igvxhr = igvxhr
    return new GenericDataSource(config)
}

function configureModal(fileLoadWidget, modal, okHandler) {

    const doDismiss = () => {
        fileLoadWidget.dismiss()
        modal.hide()
    }

    const doOK = async () => {

        const result = await okHandler(fileLoadWidget)

        if (true === result) {
            fileLoadWidget.dismiss()
            modal.hide()
        }
    }


    const modalElement = modal._element

    let dismiss

    // upper dismiss - x - button
    dismiss = modalElement.querySelector('.modal-header button')
    dismiss.addEventListener('click', doDismiss)

    // lower dismiss - close - button
    dismiss = modalElement.querySelector('.modal-footer button:nth-child(1)')
    dismiss.addEventListener('click', doDismiss)

    // ok - button
    const ok = modalElement.querySelector('.modal-footer button:nth-child(2)')

    ok.addEventListener('click', doOK)

    modalElement.addEventListener('keypress', event => {
        if ('Enter' === event.key) {
            doOK()
        }
    })
}

export {configureModal, createDataSource}
