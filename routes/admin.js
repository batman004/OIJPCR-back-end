const express = require('express')
const rateLimit = require('express-rate-limit')
const router = express.Router({ mergeParams: true })
const authController = require('../controllers/auth/authController')
const volumeRoute = require('./Admin/volume')
const editorRoute = require('./Admin/editor')
const submissionRoute = require('./Admin/submissions')
const metricsController = require('../controllers/metricsController')

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => {
        res.status(429).json({
            status: 'fail',
            message: 'Too many attempts from this network. Try again later.',
        })
    },
})

router.use('/volume', authController.isLoggedIn, volumeRoute)
router.use('/editor', authController.isLoggedIn, editorRoute)
router.use('/submissions', authController.isLoggedIn, submissionRoute)

router.get('/me', authController.isLoggedIn, authController.me)
router.get('/metrics', authController.isLoggedIn, metricsController.dashboard)

router.route('/login')
  .post(authLimiter, authController.login)

router.route('/signup')
  .post(authLimiter, authController.signup)

router.route('/logout')
  .get(authController.logout)

router.route('/user')
  .delete(authController.isLoggedIn, authController.deleteUser)

module.exports = router