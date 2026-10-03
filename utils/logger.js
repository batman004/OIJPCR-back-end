const stamp = () => new Date().toISOString()

const formatDetails = (details = {}) =>
    Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
        .join(' ')

const logAction = (action, details = {}) => {
    const extra = formatDetails(details)
    console.log(`[CRUD] ${stamp()} ${action}${extra ? ` ${extra}` : ''}`)
}

const logError = (action, err, details = {}) => {
    const extra = formatDetails({
        ...details,
        error: err && err.message ? err.message : err,
    })
    console.error(`[CRUD] ${stamp()} ${action} FAILED${extra ? ` ${extra}` : ''}`)
}

module.exports = {logAction, logError}
