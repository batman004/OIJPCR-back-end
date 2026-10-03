const Journal = require('../models/journal')
const {MIN_ARTICLES_PER_ISSUE} = require('./bibliography')

const withArticleCounts = async (volumes) => {
    const counts = await Journal.aggregate([{$group: {_id: '$volume', count: {$sum: 1}}}])
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
