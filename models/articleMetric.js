const mongoose = require('mongoose')

// One document per article per UTC day, updated with atomic $inc upserts.
// Storage is bounded by (articles x active days) no matter how much traffic
// there is, and the journals collection is never touched.
// No schema defaults on purpose: counters are created by $inc on first use and
// the dashboard treats a missing counter as 0.
const counters = (keys) =>
  Object.fromEntries(keys.map(key => [key, {type: Number}]))

const CLICK_TARGETS = ['card', 'pdf', 'print', 'tag']
const SHARE_CHANNELS = ['twitter', 'linkedin', 'link']

const articleMetricSchema = new mongoose.Schema({
    article: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Journal',
      required: true,
    },

    // UTC calendar day, "YYYY-MM-DD". Strings sort and compare correctly.
    day: {
      type: String,
      required: true,
    },

    views: {type: Number},
    clicks: {type: Number},
    shares: {type: Number},

    targets: counters(CLICK_TARGETS),
    channels: counters(SHARE_CHANNELS),
  },
  {
    versionKey: false,
  },
)

articleMetricSchema.index({article: 1, day: 1}, {unique: true})
articleMetricSchema.index({day: 1})

const ArticleMetric = mongoose.model('ArticleMetric', articleMetricSchema)

module.exports = ArticleMetric
module.exports.CLICK_TARGETS = CLICK_TARGETS
module.exports.SHARE_CHANNELS = SHARE_CHANNELS
