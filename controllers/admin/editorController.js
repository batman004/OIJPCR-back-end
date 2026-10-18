const fs = require('fs/promises')
const path = require('path')
const Journal = require('../../models/journal')
const AppError = require('../../utils/appError')
const {deleteCoverImage} = require('./utils')
const {logAction, logError} = require('../../utils/logger')
const {multerImageUpload} = require('../ImageUpload/ArticleCoverImage')
const {multerPDFUpload} = require('../PDFUpload/PDF')
const {generateAndAttachPdf} = require('./articlePdf')

exports.uploadImage = multerImageUpload
exports.uploadPDF = multerPDFUpload

exports.getJournals = async (req, res) => {
    const journals = await Journal.find()
    if (!journals) throw new AppError('Could not load articles', 500)
    logAction('ARTICLE READ list', {count: journals.length})
    res.json(journals)
}

// Admin-only: fetches an article by id regardless of status, unlike the public
// GET /journals/:id, which hides drafts. Used by the edit screen so a draft
// (e.g. one created from an accepted submission) can be opened and previewed
// without ever being reachable through the public site.
exports.getJournalById = async (req, res) => {
    const {id} = req.params
    const journal = await Journal.findById(id)
    if (!journal) throw new AppError(`Found no journal with ID ${id}`, 404)
    res.json(journal)
}

// ! change buffer type
// ! for local testing only
exports.getImageFile = async (req, res) => {
    const {name} = req.params
    // * calculate path of image in ./public/img
    const imagePath = path.dirname(require.main.filename) + '/public/img/' + name
    const imageSource = path.join(imagePath)
    //  * read image
    let data
    try {
        data = await fs.readFile(imageSource)
    } catch (err) {
        throw new AppError('Could not load image', 404)
    }
    // * send image using correct headers
    res.writeHead(200, {'Content-Type': 'image/jpeg'})
    res.end(data)
}

// * return image URL to client, stored in MongoDB.
exports.uploadFile = (req, res) => {
    const aliasLocationURL = `https://${req.file.location.split("https://s3.ap-south-1.amazonaws.com/")[1]}`
    logAction('FILE CREATE', {
        field: req.file.fieldname,
        key: req.file.key,
        url: aliasLocationURL,
    })
    res.send({
        msg: 'File Uploaded Successfully',
        file: {
            url: aliasLocationURL,
        }
    })
}

exports.saveArticle = async (req, res) => {
    const {author, title, content, slug, volume, cover, tags, authorPhoto, pdfFilePath, status} = req.body

    const newArticle = new Journal({
        author, title, content, slug, volume, cover, tags, authorPhoto, pdf: pdfFilePath, status
    })

    const result = await newArticle.save()

    if (!result) {
        logError('ARTICLE CREATE', 'Could not create Article', {title, volume})
        throw new AppError('Could not create Article', 400)
    }

    logAction('ARTICLE CREATE', {id: result._id, title: result.title, volume: result.volume, author: result.author, status: result.status})
    res.status(201).send({status: 'success'})
}

exports.editArticle = async (req, res) => {
    const {id} = req.body
    const {
        author, title, content, slug, volume, cover, tags, authorPhoto, pdfFilePath, status
    } = req.body

    // `status` is only included when the field is present in the request, so an
    // older client that doesn't send it can't accidentally flip a draft live.
    const modifiedArticle = {author, title, content, slug, volume, cover, tags, authorPhoto, pdf: pdfFilePath}
    if (status !== undefined) modifiedArticle.status = status
    // The editor replaces a manuscript image that could not be shown (see
    // SourceImages in the front end), so the list is saved as sent.
    if (Array.isArray(req.body.sourceImages)) modifiedArticle.sourceImages = req.body.sourceImages

    const result = await Journal.findByIdAndUpdate(id, {...modifiedArticle})

    if (!result) {
        logError('ARTICLE UPDATE', 'Article not found', {id, title})
        throw new AppError('Could not update Article', 400)
    }

    logAction('ARTICLE UPDATE', {id, title, volume, author, status})
    res.status(201).send({status: 'success'})
}

exports.deleteArticle = async (req, res) => {
    const {id, articleCover, authorPhoto, pdf} = req.body
    const existing = await Journal.findById(id)
    if (!existing) {
        logError('ARTICLE DELETE', 'Article not found', {id})
        throw new AppError('Could not delete Article', 400)
    }

    await Promise.all([
        deleteCoverImage(articleCover),
        deleteCoverImage(authorPhoto),
        deleteCoverImage(pdf),
    ])

    const result = await Journal.findByIdAndDelete(id)

    if (!result) {
        logError('ARTICLE DELETE', 'Mongo delete failed', {id, title: existing.title})
        throw new AppError('Could not delete Article', 400)
    }

    logAction('ARTICLE DELETE', {id, title: existing.title, volume: existing.volume})
    res.status(201).send({status: 'success'})
}

exports.deleteFile = async (req, res, next) => {
    const {fileName} = req.params
    await deleteCoverImage(fileName, next)
    logAction('FILE DELETE', {fileName})
    res.status(204).send({status: 'success'})
}

// Builds a PDF for this article - laid out like the rest of the archive (see
// utils/manuscript.js) - from its current title/author/content, uploads it,
// and points the article at it. Callable any time, so an editor can
// regenerate after changing the content or assigning a volume.
exports.generatePdf = async (req, res) => {
    const {id} = req.params
    const journal = await Journal.findById(id)
    if (!journal) throw new AppError(`Found no journal with ID ${id}`, 404)

    const url = await generateAndAttachPdf(journal)

    logAction('ARTICLE PDF GENERATE', {id, title: journal.title, volume: journal.volume})
    res.status(200).json({status: 'success', pdf: url})
}
