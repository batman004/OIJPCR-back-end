const crypto = require('crypto')
const path = require('path')
const multer = require('multer')
const mongoose = require('mongoose')
const Submission = require('../models/submission')
const Journal = require('../models/journal')
const AppError = require('../utils/appError')
const { s3, s3bucket } = require('../config/config')
const { logAction, logError } = require('../utils/logger')
const { extractManuscriptContent, imageExtension } = require('../utils/manuscript')
const { generateAndAttachPdf } = require('./admin/articlePdf')
const { putFile } = require('./admin/utils')

const STATUSES = ['review', 'accepted', 'rejected']
const ARTICLE_TYPES = ['research', 'commentary', 'book-review']
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_BRIEF_WORDS = 30

// Manuscripts are accepted as Word documents only. Images and formatting come
// through reliably from .docx, and PDF generation depends on that.
const MANUSCRIPT_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const IMAGE_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
}

const MANUSCRIPT_EXTENSIONS = ['docx']
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif']

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 2 },
    fileFilter: (req, file, cb) => {
        const kind = file.fieldname === 'bookPhoto' ? 'image' : 'manuscript'
        if (fileAllowed(file, kind)) return cb(null, true)
        const message = kind === 'image'
            ? 'Book photo must be a JPEG, PNG, WebP, or GIF.'
            : 'The manuscript must be a Word (.docx) file.'
        cb(new AppError(message, 400))
    },
}).fields([
    { name: 'manuscript', maxCount: 1 },
    { name: 'bookPhoto', maxCount: 1 },
])

exports.uploadManuscript = (req, res, next) => {
    upload(req, res, (err) => {
        if (!err) return next()
        if (err instanceof AppError) return next(err)
        if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new AppError('Each file must be 10 MB or smaller.', 400))
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return next(new AppError('Unexpected file upload.', 400))
        }
        return next(err)
    })
}

exports.createSubmission = async (req, res) => {
    if (String(req.body.fax_number || '').trim()) {
        return res.status(201).json({
            status: 'success',
            message: 'Submission received. The editorial team will review it.',
        })
    }

    const fields = readFields(req.body)
    const manuscriptFile = req.files?.manuscript?.[0]
    const bookPhotoFile = req.files?.bookPhoto?.[0]

    if (!manuscriptFile) throw new AppError('Attach the manuscript as a Word (.docx) file.', 400)
    if (fields.articleType === 'book-review' && !bookPhotoFile) {
        throw new AppError('Attach a photo of the book.', 400)
    }

    const uploadedKeys = []
    try {
        const manuscript = await storeFile(manuscriptFile)
        uploadedKeys.push(manuscript.key)

        let bookPhoto
        if (bookPhotoFile) {
            bookPhoto = await storeFile(bookPhotoFile)
            uploadedKeys.push(bookPhoto.key)
        }

        const submission = await Submission.create({
            ...fields,
            manuscript,
            bookPhoto,
            status: 'review',
        })

        logAction('SUBMISSION CREATE', {
            id: submission._id,
            title: submission.title,
            type: submission.articleType,
        })

        return res.status(201).json({
            status: 'success',
            message: 'Submission received. The editorial team will review it.',
            reference: String(submission._id),
        })
    } catch (err) {
        await Promise.all(uploadedKeys.map(deleteStoredFile))
        throw err
    }
}

exports.list = async (req, res) => {
    const submissions = await Submission.find().sort({ createdAt: -1 })
    const counts = { review: 0, accepted: 0, rejected: 0 }
    submissions.forEach((submission) => {
        counts[submission.status] = (counts[submission.status] || 0) + 1
    })

    res.json({
        status: 'success',
        counts,
        submissions: submissions.map(present),
    })
}

exports.updateStatus = async (req, res) => {
    const status = req.body.status
    if (!STATUSES.includes(status)) {
        throw new AppError('Choose review, accepted, or rejected.', 400)
    }

    const submission = await findSubmission(req.params.id)
    submission.status = status
    await submission.save()

    logAction('SUBMISSION STATUS', { id: submission._id, status })
    res.json({ status: 'success', submission: present(submission) })
}

exports.addComment = async (req, res) => {
    const body = String(req.body.body || '').trim()
    if (!body) throw new AppError('Write a comment before saving it.', 400)
    if (body.length > 2000) throw new AppError('Comments must be 2000 characters or fewer.', 400)

    const submission = await findSubmission(req.params.id)
    submission.comments.push({
        body,
        author: res.locals.user.username,
    })
    await submission.save()

    logAction('SUBMISSION COMMENT', { id: submission._id, author: res.locals.user.username })
    res.status(201).json({ status: 'success', submission: present(submission) })
}

exports.downloadManuscript = (req, res) => sendStoredFile(req, res, 'manuscript', 'attachment')
exports.downloadBookPhoto = (req, res) => sendStoredFile(req, res, 'bookPhoto', 'inline')

// Accepting a submission only changes its status; this is the separate step
// that turns it into an actual (unpublished) article. Content is extracted
// from the manuscript on a best-effort basis - see utils/manuscript.js - and
// a first PDF is generated in the same pass so there is something to preview
// and download right away. The editor is expected to read the draft over,
// correct the volume, and publish it from the normal article editor.
exports.createDraftArticle = async (req, res) => {
    const submission = await findSubmission(req.params.id)

    // Idempotent: a double click (or a retried request) must not create a
    // second draft for the same submission.
    if (submission.draftArticleId) {
        return res.json({
            status: 'success',
            submission: present(submission),
            article: { id: String(submission.draftArticleId) },
        })
    }
    if (submission.status !== 'accepted') {
        throw new AppError('Accept the submission before adding it as a draft article.', 400)
    }

    const { Body } = await fetchStoredObject(submission.manuscript.key, 'manuscript')
    const { html, extracted, sourceImages, droppedImages } = await extractManuscriptContent({
        buffer: Body,
        mimeType: submission.manuscript.mimeType,
        title: submission.title,
        saveImage: saveManuscriptImage,
    })

    const journal = new Journal({
        author: submission.authorName,
        title: submission.title,
        // `slug` is the archive card's short description, not a URL slug (the
        // URL uses slugify(title) instead) - the submission brief fills the
        // same role here.
        slug: submission.brief,
        content: html,
        tags: '',
        status: 'draft',
        sourceImages,
    })
    await journal.save()

    let pdfGenerated = true
    try {
        await generateAndAttachPdf(journal)
    } catch (err) {
        pdfGenerated = false
        logError('SUBMISSION DRAFT ARTICLE PDF', err, { submissionId: submission._id, articleId: journal._id })
    }

    submission.draftArticleId = journal._id
    await submission.save()

    logAction('SUBMISSION DRAFT ARTICLE', {
        submissionId: submission._id,
        articleId: journal._id,
        title: journal.title,
        contentExtracted: extracted,
        pdfGenerated,
        imagesInText: (html.match(/<img\b/gi) || []).length,
        imagesSeparate: sourceImages.length,
        imagesDropped: droppedImages,
    })

    res.status(201).json({
        status: 'success',
        submission: present(submission),
        article: { id: String(journal._id) },
        contentExtracted: extracted,
        pdfGenerated,
        sourceImageCount: sourceImages.length,
        droppedImageCount: droppedImages,
    })
}

function readFields(body = {}) {
    const authorName = cleanText(body.authorName, 120)
    const email = cleanText(body.email, 200).toLowerCase()
    const affiliation = cleanText(body.affiliation, 200)
    const title = cleanText(body.title, 200)
    const articleType = cleanText(body.articleType, 40)
    const brief = cleanText(body.brief, 1500)
    const note = cleanText(body.note, 1000)

    if (authorName.length < 2) throw new AppError('Enter your name.', 400)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address.', 400)
    if (title.length < 3) throw new AppError('Enter the article title.', 400)
    if (!ARTICLE_TYPES.includes(articleType)) throw new AppError('Choose a type of piece.', 400)

    const words = brief.split(/\s+/).filter(Boolean)
    if (!words.length) throw new AppError('Add a short brief.', 400)
    if (words.length > MAX_BRIEF_WORDS) {
        throw new AppError('The brief must be 30 words or fewer.', 400)
    }

    return { authorName, email, affiliation, title, articleType, brief, note }
}

function cleanText(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function fileAllowed(file, kind) {
    const extension = path.extname(file.originalname || '').toLowerCase().replace('.', '')
    if (kind === 'image') {
        return Boolean(IMAGE_TYPES[file.mimetype]) && IMAGE_EXTENSIONS.includes(extension === 'jpeg' ? 'jpeg' : extension)
    }
    const extensionOk = MANUSCRIPT_EXTENSIONS.includes(extension)
    const mimeOk = file.mimetype === MANUSCRIPT_MIME
        || file.mimetype === 'application/octet-stream'
        || !file.mimetype
    return mimeOk && extensionOk
}

async function storeFile(file) {
    if (!s3bucket) throw new AppError('File storage is not configured.', 500)

    const extension = path.extname(file.originalname || '').toLowerCase().replace('.', '') || 'bin'
    const key = `submissions/${crypto.randomBytes(16).toString('hex')}.${extension === 'jpeg' ? 'jpg' : extension}`

    try {
        await s3.putObject({
            Bucket: s3bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype || 'application/octet-stream',
            CacheControl: 'private, no-store',
        }).promise()
    } catch (err) {
        logError('SUBMISSION FILE', err, { name: file.originalname })
        throw new AppError('Could not store the file. Please try again.', 500)
    }

    return {
        key,
        originalName: safeFilename(file.originalname),
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
    }
}

// Images from a manuscript go to the public media bucket (like article images),
// under a random key. They are public once the article is published anyway, and
// a draft's images must be reachable by the editor before that.
function saveManuscriptImage(bytes, contentType) {
    const key = `submission-images/${crypto.randomBytes(16).toString('hex')}.${imageExtension(contentType)}`
    return putFile(key, bytes, contentType)
}

async function deleteStoredFile(key) {
    if (!key || !s3bucket) return
    try {
        await s3.deleteObject({ Bucket: s3bucket, Key: key }).promise()
    } catch (err) {
        logError('SUBMISSION FILE DELETE', err, { key })
    }
}

async function findSubmission(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError('Submission not found.', 404)
    const submission = await Submission.findById(id)
    if (!submission) throw new AppError('Submission not found.', 404)
    return submission
}

async function fetchStoredObject(key, field) {
    try {
        return await s3.getObject({ Bucket: s3bucket, Key: key }).promise()
    } catch (err) {
        logError('SUBMISSION FILE', err, { key, field })
        throw new AppError('Could not read that file.', 500)
    }
}

async function sendStoredFile(req, res, field, disposition) {
    const submission = await findSubmission(req.params.id)
    const file = submission[field]
    if (!file?.key) throw new AppError('That file is not attached.', 404)

    const object = await fetchStoredObject(file.key, field)

    res.set({
        'Content-Type': file.mimeType || object.ContentType || 'application/octet-stream',
        'Content-Length': object.ContentLength || file.size,
        'Content-Disposition': `${disposition}; filename="${safeFilename(file.originalName)}"`,
        'Cache-Control': 'private, no-store',
    })
    res.send(object.Body)
}

function present(submission) {
    const doc = submission.toObject()
    return {
        id: String(doc._id),
        authorName: doc.authorName,
        email: doc.email,
        affiliation: doc.affiliation || '',
        title: doc.title,
        articleType: doc.articleType,
        brief: doc.brief,
        note: doc.note || '',
        status: doc.status,
        draftArticleId: doc.draftArticleId ? String(doc.draftArticleId) : null,
        manuscript: presentFile(doc.manuscript),
        bookPhoto: presentFile(doc.bookPhoto),
        comments: (doc.comments || []).map((comment) => ({
            id: String(comment._id),
            body: comment.body,
            author: comment.author,
            createdAt: comment.createdAt,
        })),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    }
}

function presentFile(file) {
    if (!file?.key) return null
    return {
        originalName: file.originalName,
        size: file.size,
    }
}

function safeFilename(name) {
    const cleaned = String(name || 'file')
        .replace(/[\r\n"]/g, '')
        .replace(/[^\w.\- ()]/g, '_')
        .slice(0, 180)
    return cleaned || 'file'
}
