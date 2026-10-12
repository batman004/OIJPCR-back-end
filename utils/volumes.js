const Journal = require('../models/journal')
const {MIN_ARTICLES_PER_ISSUE} = require('./bibliography')

const withArticleCounts = async (volumes) => {
    // Drafts don't count towards a volume's public article total or its
    // ISSN-completeness badge; see Journal.PUBLIC_ONLY.
    const counts = await Journal.aggregate([
        {$match: Journal.PUBLIC_ONLY},
        {$group: {_id: '$volume', count: {$sum: 1}}},
    ])
    const byVolume = new Map(counts.map(({_id, count}) => [_id, count]))

    return volumes.map((volume) => {
        const articleCount = byVolume.get(volume.volume) || 0
        return {
            ...volume.toJSON(),
            articleCount,
            minArticles: MIN_ARTICLES_PER_ISSUE,
            isComplete: articleCount >= MIN_ARTICLES_PER_ISSUE,
        }
    })
}

module.exports = {withArticleCounts}
