const express = require('express')
const submissionController = require('../../controllers/submissionController')

const router = express.Router()

router.get('/', submissionController.list)
router.get('/:id/manuscript', submissionController.downloadManuscript)
router.get('/:id/book-photo', submissionController.downloadBookPhoto)
router.patch('/:id', submissionController.updateStatus)
router.post('/:id/comments', submissionController.addComment)
router.post('/:id/draft-article', submissionController.createDraftArticle)

module.exports = router
