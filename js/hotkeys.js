/**
 * Create a throttled zoom handler that accumulates scale factors
 * @param {Object} browser - The IGV browser instance
 * @param {number} delay - Delay in milliseconds before applying accumulated zoom
 * @returns {Function} - Throttled zoom function
 */
function createThrottledZoom(browser, delay = 100) {
    let accumulatedFactor = 1.0
    let timeoutId = null

    return (scaleFactor) => {
        // Accumulate the scale factor (multiply them together)
        accumulatedFactor *= scaleFactor

        // Clear any existing timeout
        if (timeoutId !== null) {
            clearTimeout(timeoutId)
        }

        // Set a new timeout to apply the accumulated zoom
        timeoutId = setTimeout(() => {
            if (accumulatedFactor !== 1.0) {
                browser.zoomWithScaleFactor(accumulatedFactor)
                accumulatedFactor = 1.0
            }
            timeoutId = null
        }, delay)
    }
}

/**
 * Setup scroll wheel zoom functionality with shift key modifier
 * @param {HTMLElement} container - The IGV container element
 * @param {Object} browser - The IGV browser instance
 */
function setupScrollWheelZoom(container, browser) {
    const throttledZoom = createThrottledZoom(browser)

    container.addEventListener('wheel', (event) => {
        // Only zoom if shift key is pressed
        if (event.shiftKey) {
            event.preventDefault()
            event.stopPropagation()

            // Determine zoom direction based on wheel delta
            // Use both deltaY and deltaX (some trackpads generate deltaX instead of deltaY)
            // Use inverse scale factors so zoom in/out are symmetric: 1.1 and 1/1.1 ≈ 0.909
            // Positive delta means zoom out, negative means zoom in
            const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
            const scaleFactor = delta > 0 ? 1.1 : 1/1.1

            throttledZoom(scaleFactor)
        }
    }, { passive: false })
}

/**
 * Setup keyboard shortcuts for zoom in/out
 * Supports: +, =, - keys (with optional Shift modifier)
 * @param {Object} browser - The IGV browser instance
 */
function setupKeyboardZoom(browser) {
    const throttledZoom = createThrottledZoom(browser, 150)

    document.addEventListener('keydown', (event) => {
        const isEditableElement = (element) => (
            !!element &&
            (element.isContentEditable ||
                element.matches?.('input, textarea, select, [contenteditable], [contenteditable="true"], [contenteditable=""]') ||
                !!element.closest?.('input, textarea, select, [contenteditable], [contenteditable="true"], [contenteditable=""]'))
        )

        // Use composedPath to handle retargeted events where target may be a wrapping DIV/host.
        const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
        const isTypingContext = eventPath.some((node) => node instanceof Element && isEditableElement(node))

        const target = event.target instanceof Element ? event.target : null
        const activeElement = document.activeElement instanceof Element ? document.activeElement : null

        if (isTypingContext || isEditableElement(target) || isEditableElement(activeElement)) {
            return
        }

        // Use inverse scale factors so zoom in/out are symmetric: 1.5 and 1/1.5 ≈ 0.667
        // Zoom in: + or = keys (= is on same key as + without shift on US keyboards)
        if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            throttledZoom(1/1.5)
        }
        // Zoom out: - key
        else if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            throttledZoom(1.5)
        }
    })
}

export {setupScrollWheelZoom, setupKeyboardZoom}