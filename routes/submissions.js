const express = require('express')
const rateLimit = require('express-rate-limit')
const submissionController = require('../controllers/submissionController')

const router = express.Router()

const submissionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 8,
    handler: (req, res) => {
        res.status(429).json({
            status: 'fail',
            message: 'Too many submissions from this network. Try again later.',
        })
    },
})

router.post(
    '/',
    submissionLimiter,
    submissionController.uploadManuscript,
    submissionController.createSubmission,
)

module.exports = router
