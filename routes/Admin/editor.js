const express = require('express')
const router = express.Router()
const editorController = require('../../controllers/admin/editorController')

router.route('/')
    .get(editorController.getJournals)
    .post(editorController.saveArticle)
    .patch(editorController.editArticle)
    .delete(editorController.deleteArticle)

router
    .delete('/file/:fileName', editorController.deleteFile)
    .delete('/:id/:articleCover/:authorPhoto', editorController.deleteArticle)

router
    .post('/upload/image', editorController.uploadImage, editorController.uploadFile)
    .post('/upload/pdf', editorController.uploadPDF, editorController.uploadFile)

router
    .get('/images/:name', editorController.getImageFile)

// Registered last so they never shadow the literal routes above (e.g. a
// request for /upload/pdf must still hit the upload handler, not this one).
router
    .get('/:id', editorController.getJournalById)
    .post('/:id/pdf', editorController.generatePdf)

module.exports = router