const AppError = require('../utils/appError')
const Journal = require('../models/journal')
const ArticleMetric = require('../models/articleMetric')
const {CLICK_TARGETS, SHARE_CHANNELS} = ArticleMetric
const {logError} = require('../utils/logger')

const OBJECT_ID = /^[a-f0-9]{24}$/i
const BOT_USER_AGENT = /bot|crawl|spider|slurp|headless|preview|facebookexternalhit|curl|wget|python-requests|monitor/i
const DAY_MS = 24 * 60 * 60 * 1000

const MIN_DAYS = 7
const MAX_DAYS = 365
const DEFAULT_DAYS = 30
const TOP_TAGS = 10
const RECENT_UPLOADS = 5

const utcDay = (date = new Date()) => date.toISOString().slice(0, 10)
const shiftDay = (day, offset) => utcDay(new Date(Date.parse(day) + offset * DAY_MS))

// ---------------------------------------------------------------------------
// Public: record one event. Never fails the caller and never throws, because a
// metrics problem must not affect readers of the site.
//   POST /journals/:id/events?type=view|click|share&target=<target>
// ---------------------------------------------------------------------------
const EVENTS = {
  view: {counter: 'views'},
  click: {counter: 'clicks', field: 'targets', allowed: CLICK_TARGETS},
  share: {counter: 'shares', field: 'channels', allowed: SHARE_CHANNELS},
}

exports.recordEvent = async (req, res) => {
  const {id} = req.params
  const {type, target} = req.query

  const event = Object.prototype.hasOwnProperty.call(EVENTS, type) ? EVENTS[type] : null
  if (!OBJECT_ID.test(id) || !event) throw new AppError('Invalid event', 400)
  if (event.allowed && !event.allowed.includes(target)) throw new AppError('Invalid event target', 400)

  const userAgent = req.get('user-agent') || ''
  if (!userAgent || BOT_USER_AGENT.test(userAgent)) return res.status(204).end()

  try {
    // Only count articles that exist, so stray ids cannot create rows.
    if (!(await Journal.exists({_id: id}))) throw new AppError('Article not found', 404)

    const inc = {[event.counter]: 1}
    if (event.field) inc[`${event.field}.${target}`] = 1

    await ArticleMetric.updateOne(
      {article: id, day: utcDay()},
      {$inc: inc},
      {upsert: true},
    )
  } catch (err) {
    if (err instanceof AppError) throw err
    logError('METRIC RECORD', err, {id, type})
  }

  res.status(204).end()
}

// ---------------------------------------------------------------------------
// Admin: read-only dashboard payload.  GET /admin/metrics?days=30
// ---------------------------------------------------------------------------
const sumWhen = (condition, field) => ({
  $sum: {$cond: [condition, {$ifNull: [field, 0]}, 0]},
})

const inRange = (from, to) => ({
  $and: [{$gte: ['$day', from]}, {$lte: ['$day', to]}],
})

// Sums `$<field>.<key>` for each key under the output name `<prefix>_<key>`.
const sumTree = (field, prefix, keys, condition) =>
  Object.fromEntries(keys.map(key => [
    `${prefix}_${key}`,
    sumWhen(condition, `$${field}.${key}`),
  ]))

const zeroTree = (keys) => Object.fromEntries(keys.map(key => [key, 0]))

const parseDays = (value) => {
  const days = parseInt(value, 10)
  if (isNaN(days)) return DEFAULT_DAYS
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, days))
}

const splitTags = (tags) =>
  String(tags || '').split(',').map(tag => tag.trim()).filter(Boolean)

exports.dashboard = async (req, res) => {
  const days = parseDays(req.query.days)

  const today = utcDay()
  const start = shiftDay(today, -(days - 1))
  const prevStart = shiftDay(start, -days)
  const prevEnd = shiftDay(start, -1)
  const week = shiftDay(today, -6)
  const priorWeek = shiftDay(today, -13)
  const priorWeekEnd = shiftDay(today, -7)

  // `content` is large and not needed here.
  const journals = await Journal
    .find({})
    .select('title author volume tags createdAt pdf')
    .sort({createdAt: -1})
    .lean()

  const ids = journals.map(journal => journal._id)

  const current = inRange(start, today)
  const [perArticle, perDay, first] = await Promise.all([
    ArticleMetric.aggregate([
      {$match: {article: {$in: ids}}},
      {
        $group: {
          _id: '$article',
          views: sumWhen(current, '$views'),
          clicks: sumWhen(current, '$clicks'),
          shares: sumWhen(current, '$shares'),
          prevViews: sumWhen(inRange(prevStart, prevEnd), '$views'),
          prevClicks: sumWhen(inRange(prevStart, prevEnd), '$clicks'),
          prevShares: sumWhen(inRange(prevStart, prevEnd), '$shares'),
          views7: sumWhen(inRange(week, today), '$views'),
          viewsPrev7: sumWhen(inRange(priorWeek, priorWeekEnd), '$views'),
          allViews: {$sum: {$ifNull: ['$views', 0]}},
          ...sumTree('targets', 't', CLICK_TARGETS, current),
          ...sumTree('channels', 'c', SHARE_CHANNELS, current),
        },
      },
    ]),
    ArticleMetric.aggregate([
      {$match: {article: {$in: ids}, day: {$gte: start, $lte: today}}},
      {
        $group: {
          _id: '$day',
          views: {$sum: {$ifNull: ['$views', 0]}},
          clicks: {$sum: {$ifNull: ['$clicks', 0]}},
          shares: {$sum: {$ifNull: ['$shares', 0]}},
        },
      },
    ]),
    ArticleMetric.findOne({}).sort({day: 1}).select('day').lean(),
  ])

  const metricsById = new Map(perArticle.map(row => [String(row._id), row]))

  const totals = {views: 0, clicks: 0, shares: 0}
  const previous = {views: 0, clicks: 0, shares: 0}
  const clickTargets = zeroTree(CLICK_TARGETS)
  const shareChannels = zeroTree(SHARE_CHANNELS)

  const articles = journals.map(journal => {
    const m = metricsById.get(String(journal._id)) || {}
    const row = {
      id: journal._id,
      title: journal.title,
      author: journal.author,
      volume: journal.volume,
      createdAt: journal.createdAt,
      hasPdf: Boolean(journal.pdf),
      views: m.views || 0,
      clicks: m.clicks || 0,
      shares: m.shares || 0,
      allTimeViews: m.allViews || 0,
      views7: m.views7 || 0,
      viewsPrev7: m.viewsPrev7 || 0,
    }

    totals.views += row.views
    totals.clicks += row.clicks
    totals.shares += row.shares
    previous.views += m.prevViews || 0
    previous.clicks += m.prevClicks || 0
    previous.shares += m.prevShares || 0
    CLICK_TARGETS.forEach(key => { clickTargets[key] += m[`t_${key}`] || 0 })
    SHARE_CHANNELS.forEach(key => { shareChannels[key] += m[`c_${key}`] || 0 })

    return row
  })

  const byDay = new Map(perDay.map(row => [row._id, row]))
  const series = []
  for (let i = 0; i < days; i++) {
    const day = shiftDay(start, i)
    const row = byDay.get(day) || {}
    series.push({day, views: row.views || 0, clicks: row.clicks || 0, shares: row.shares || 0})
  }

  const viewsById = new Map(articles.map(article => [String(article.id), article.views]))
  const tagStats = new Map()
  journals.forEach(journal => {
    const views = viewsById.get(String(journal._id)) || 0
    const seen = new Set()
    splitTags(journal.tags).forEach(tag => {
      const key = tag.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      const stat = tagStats.get(key) || {tag, articles: 0, views: 0}
      stat.articles += 1
      stat.views += views
      tagStats.set(key, stat)
    })
  })
  const tags = [...tagStats.values()]
    .sort((a, b) => b.views - a.views || b.articles - a.articles || a.tag.localeCompare(b.tag))
    .slice(0, TOP_TAGS)

  res.status(200).json({
    range: {days, start, end: today},
    trackingSince: first ? first.day : null,
    totals,
    previous,
    clickTargets,
    shareChannels,
    series,
    articles,
    recent: articles.slice(0, RECENT_UPLOADS),
    tags,
    content: {
      articles: journals.length,
      volumes: new Set(journals.map(journal => journal.volume)).size,
      withPdf: articles.filter(article => article.hasPdf).length,
    },
  })
}
