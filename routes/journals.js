const express = require('express')
const router = express.Router()
const rateLimit = require('express-rate-limit')
const journalController = require('./../controllers/journalsController')
const metricsController = require('./../controllers/metricsController')

// Public write endpoint on the production database: cap it per client.
const eventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.EVENT_RATE_LIMIT, 10) || 300,
  message: 'Too many requests, try again later',
})

router.get('/', journalController.journals)
router.get('/home/:limit', journalController.journalsByLimit)
router.get('/tags/:tag', journalController.journalsByTag)
router.get('/tags', journalController.tags)
router.get('/all/:volume/:full', journalController.journalsByVolume)
router.get('/limit/:volume/:limit', journalController.getLimitedJournalsByVolume)
router.get('/archive', journalController.archive)
router.post('/:id/events', eventLimiter, metricsController.recordEvent)

router
  .route('/:id')
  .get(journalController.getJournal)

router
  .route('/:slug/:id')
  .get(journalController.getJournal)



module.exports = router