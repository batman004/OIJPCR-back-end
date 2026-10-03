const express = require('express')
const router = express.Router({ mergeParams: true })
const authController = require('../controllers/auth/authController')
const volumeRoute = require('./Admin/volume')
const editorRoute = require('./Admin/editor')
const metricsController = require('../controllers/metricsController')

router.use('/volume', authController.isLoggedIn, volumeRoute)
router.use('/editor', authController.isLoggedIn, editorRoute)

router.get('/me', authController.isLoggedIn, authController.me)
router.get('/metrics', authController.isLoggedIn, metricsController.dashboard)

router.route('/login')
  .post(authController.login)

router.route('/signup')
  .post(authController.signup)

router.route('/logout')
  .get(authController.logout)

router.route('/user')
  .delete(authController.isLoggedIn, authController.deleteUser)

module.exports = router