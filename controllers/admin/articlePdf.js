const Volume = require('../../models/volume')
const AppError = require('../../utils/appError')
const {s3, s3bucket} = require('../../config/config')
const {resolveIssue, resolveYear} = require('../../utils/bibliography')
const {htmlToBlocks, buildArticlePdf} = require('../../utils/manuscript')
const {deleteCoverImage, putFile} = require('./utils')

const IMAGE_TYPES_BY_EXTENSION = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
}

// Only images hosted in our own media bucket are read back for the PDF.
// Anything else is left as a placeholder rather than fetched from an arbitrary URL.
async function loadImage(src) {
    let url
    try {
        url = new URL(src)
    } catch (err) {
        return null
    }
    if (url.hostname !== s3bucket) return null

    const key = decodeURIComponent(url.pathname.slice(1))
    const contentType = IMAGE_TYPES_BY_EXTENSION[key.split('.').pop().toLowerCase()]
    if (!contentType) return null

    try {
        const {Body} = await s3.getObject({Bucket: s3bucket, Key: key}).promise()
        return {bytes: Body, contentType}
    } catch (err) {
        return null
    }
}

// Builds a PDF for `journal` from its current content/metadata, uploads it,
// deletes the PDF it replaces, and saves the new URL onto the document.
// Shared by the explicit "Generate PDF" action (editorController) and by
// creating a draft article from an accepted submission (submissionController).
async function generateAndAttachPdf(journal) {
    const blocks = []
    for (const block of htmlToBlocks(journal.content)) {
        blocks.push(block.type === 'text'
            ? block
            : {type: 'image', label: block.label, image: await loadImage(block.src)})
    }
    if (blocks.length === 0) {
        throw new AppError('Add some content to the article before generating a PDF.', 400)
    }

    // The volume may not be assigned correctly yet (a fresh draft defaults to
    // volume 1) - the header will say so until the editor corrects it and
    // regenerates, same as any other field on a draft.
    const volumeDoc = await Volume.findOne({volume: journal.volume})
    const issue = resolveIssue(volumeDoc || {})
    const year = resolveYear(volumeDoc || {volume: journal.volume})

    const pdfBytes = await buildArticlePdf({
        title: journal.title,
        author: journal.author,
        tags: journal.tags,
        blocks,
        volume: journal.volume,
        issue,
        year,
    })

    const key = `generated_${journal._id}_${Date.now()}.pdf`
    const url = await putFile(key, pdfBytes, 'application/pdf')

    const previousPdf = journal.pdf
    journal.pdf = url
    await journal.save()
    if (previousPdf) await deleteCoverImage(previousPdf.split('/').pop())

    return url
}

module.exports = {generateAndAttachPdf}
