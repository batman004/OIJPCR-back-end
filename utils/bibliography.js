const JOURNAL_NAME = 'Online Indian Journal of Peace and Conflict Resolution'
const FIRST_VOLUME_YEAR = 2016
const DEFAULT_ISSUE = 1
// Annual journal: ISSN requires 10 articles to make a complete issue.
const MIN_ARTICLES_PER_ISSUE = 10

const YEAR_PATTERN = /\b(19|20)\d{2}\b/

const resolveYear = ({volume, year, date}) => {
    const explicit = parseInt(year, 10)
    if (!isNaN(explicit)) return explicit

    const fromDate = YEAR_PATTERN.exec(date || '')
    if (fromDate) return parseInt(fromDate[0], 10)

    return FIRST_VOLUME_YEAR + (parseInt(volume, 10) - 1)
}

const resolveIssue = ({issue}) => {
    const explicit = parseInt(issue, 10)
    return isNaN(explicit) || explicit < 1 ? DEFAULT_ISSUE : explicit
}

module.exports = {
    JOURNAL_NAME,
    FIRST_VOLUME_YEAR,
    DEFAULT_ISSUE,
    MIN_ARTICLES_PER_ISSUE,
    resolveYear,
    resolveIssue,
}
