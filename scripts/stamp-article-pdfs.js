/*
 * Gives every article PDF one consistent, correct bibliographic header.
 *
 *   node scripts/stamp-article-pdfs.js                 download + fix into ./stamped-pdfs (local only)
 *   node scripts/stamp-article-pdfs.js --volume 1      limit to one volume
 *   node scripts/stamp-article-pdfs.js --publish       upload fixed copies to S3 and repoint articles
 *
 * The PDFs were exported from Google Docs with hand-typed headers such as
 * "OIJPCR Vol.4, Number 5.2019" (wrong volume/year, "Number" instead of issue, many
 * spellings). On every page this script removes that old header block (or, when a PDF is
 * not structured that way, covers it with a white box) and prints
 *
 *     oijpcr.org                                  OIJPCR, Volume N, Issue I, YYYY
 *
 * using the volume's year and issue. PDF metadata (title, author, subject) is filled in too.
 *
 * Safety:
 *  - The text of every page below the header band is compared before and after; a PDF whose
 *    body text changed is rejected and not written.
 *  - Originals are never modified or deleted. Fixed copies are uploaded under the `stamped/`
 *    key prefix (refusing to overwrite an existing key) and the previous `pdf` URLs are saved
 *    to backups/ so the change can be reversed.
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({path: path.join(__dirname, '..', '.env')})
const {PDFDocument, PDFName, PDFArray, StandardFonts, decodePDFRawStream, rgb} = require('pdf-lib')
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
const {JOURNAL_NAME, resolveIssue, resolveYear} = require('../utils/bibliography')

const API = process.env.STAMP_API || 'https://api.oijpcr.org'
const MEDIA = 'https://media.oijpcr.org'
const OUT_DIR = path.join(__dirname, '..', 'stamped-pdfs')
const KEY_PREFIX = 'stamped'
const SITE = 'oijpcr.org'

// Old headers sit ~44pt below the top edge; body text starts well below this band.
const HEADER_BAND = 60
const HEADER_BASELINE = 44
const SIDE_MARGIN = 36
const MAX_CLIP_HEIGHT = 80
const MAX_HEADER_LINE_SPREAD = 8

const args = process.argv.slice(2)
const publish = args.includes('--publish')
const volumeFilter = args.includes('--volume') ? parseInt(args[args.indexOf('--volume') + 1], 10) : null

const getJson = async (url) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url} -> ${res.status}`)
    return res.json()
}

function keyFromUrl(url) {
    const {hostname, pathname} = new URL(url)
    if (hostname !== 'media.oijpcr.org' && !hostname.endsWith('.amazonaws.com')) return null
    return decodeURIComponent(pathname.slice(1))
}

const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/')

async function scan(bytes) {
    const doc = await pdfjs.getDocument({data: new Uint8Array(bytes), useSystemFonts: true}).promise
    const pages = []
    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n)
        const {height} = page.getViewport({scale: 1})
        const {items} = await page.getTextContent()
        pages.push(items
            .filter((item) => item.str.trim())
            .map((item) => ({
                str: item.str,
                x: item.transform[4],
                top: height - item.transform[5],
                width: item.width,
                height: item.height,
            })))
    }
    await doc.destroy()
    return pages
}

const bodyText = (pageItems) => pageItems
    .filter((item) => item.top > HEADER_BAND)
    .map((item) => item.str.replace(/\s+/g, ''))
    .join('')

function readContent(doc, page) {
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents]
    return streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n')
}

// Google Docs draws the page header as one clipped group at the top of the (flipped) page.
function removeHeaderGroup(content, pageHeight) {
    const flipped = new RegExp(`^1 0 0 -1 0 ${Math.round(pageHeight)}(\\.\\d+)? cm$`, 'm').test(
        content.split('\n').slice(0, 5).join('\n'))
    if (!flipped) return null

    const lines = content.split('\n')
    for (let i = 0; i < lines.length - 2; i++) {
        const rect = /^0 0 [\d.]+ ([\d.]+) re$/.exec(lines[i + 1])
        if (lines[i] !== 'q' || !rect || !/^W\*? n$/.test(lines[i + 2]) || parseFloat(rect[1]) > MAX_CLIP_HEIGHT) continue

        let depth = 0
        let end = i
        for (; end < lines.length; end++) {
            if (lines[end] === 'q') depth++
            else if (lines[end] === 'Q' && --depth === 0) break
        }
        if (end >= lines.length) return null
        return [...lines.slice(0, i), ...lines.slice(end + 1)].join('\n')
    }
    return null
}

async function fixPdf(original, article, info) {
    const before = await scan(original)
    const doc = await PDFDocument.load(original, {updateMetadata: false})
    const pages = doc.getPages()
    const stats = {removed: 0, whitedOut: 0, added: 0}

    // 1. remove old header block where it has the expected structure
    pages.forEach((page, index) => {
        if (!before[index].some((item) => item.top <= HEADER_BAND)) return
        const stripped = removeHeaderGroup(readContent(doc, page), page.getHeight())
        if (stripped === null) return
        page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(Buffer.from(stripped, 'latin1'))))
        stats.removed++
    })

    // 2. anything still in the header band gets covered
    const afterRemoval = await scan(await doc.save())
    pages.forEach((page, index) => {
        const leftover = afterRemoval[index].filter((item) => item.top <= HEADER_BAND)
        // A header is a single line. Several lines means body text reaches into the band.
        const tops = leftover.map((item) => item.top)
        if (tops.length && Math.max(...tops) - Math.min(...tops) > MAX_HEADER_LINE_SPREAD) {
            throw new Error(`page ${index + 1}: text in header band is not a single line, not covering it`)
        }
        leftover.forEach((item) => {
            const pad = 2
            page.drawRectangle({
                x: item.x - pad,
                y: page.getHeight() - item.top - pad - 1,
                width: item.width + pad * 2,
                height: item.height + pad * 2,
                color: rgb(1, 1, 1),
                borderWidth: 0,
            })
            stats.whitedOut++
        })
    })

    // 3. new consistent header
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    const right = `OIJPCR, Volume ${info.volume}, Issue ${info.issue}, ${info.year}`
    const colour = rgb(0.15, 0.15, 0.15)
    const size = 8
    pages.forEach((page) => {
        const y = page.getHeight() - HEADER_BASELINE
        page.drawText(SITE, {x: SIDE_MARGIN, y, size, font, color: colour})
        page.drawText(right, {
            x: page.getWidth() - SIDE_MARGIN - bold.widthOfTextAtSize(right, size),
            y, size, font: bold, color: colour,
        })
        stats.added++
    })

    const label = `Volume ${info.volume}, Issue ${info.issue}, ${info.year}`
    doc.setTitle(article.title)
    doc.setAuthor(article.author)
    doc.setSubject(`${JOURNAL_NAME}, ${label}`)
    doc.setKeywords(String(article.tags || '').split(',').map((t) => t.trim()).filter(Boolean))
    doc.setCreator(JOURNAL_NAME)
    doc.setProducer(`${JOURNAL_NAME} (${SITE})`)

    const fixed = Buffer.from(await doc.save())

    // 4. verify: body text unchanged, header band holds only the new header
    const after = await scan(fixed)
    if (after.length !== before.length) throw new Error('page count changed')
    before.forEach((pageItems, index) => {
        if (bodyText(pageItems) !== bodyText(after[index])) throw new Error(`body text changed on page ${index + 1}`)
        const header = after[index].filter((item) => item.top <= HEADER_BAND)
        // covered-up text is still extractable; only whiteouts may leave extra items
        if (stats.whitedOut === 0) {
            const text = header.map((item) => item.str).join(' ')
            if (text.replace(/\s+/g, '') !== (SITE + right).replace(/\s+/g, '')) {
                throw new Error(`unexpected header on page ${index + 1}: "${text}"`)
            }
        }
    })

    return {fixed, stats}
}

async function main() {
    const volumes = await getJson(`${API}/journals/archive`)
    const manifest = []
    const failures = []
    const totals = {removed: 0, whitedOut: 0}

    for (const volumeDoc of volumes) {
        if (volumeFilter && volumeDoc.volume !== volumeFilter) continue
        const info = {volume: volumeDoc.volume, issue: resolveIssue(volumeDoc), year: resolveYear(volumeDoc)}
        const articles = await getJson(`${API}/journals/all/${volumeDoc.volume}/info`)

        for (const article of articles) {
            const originalKey = article.pdf && keyFromUrl(article.pdf)
            if (!originalKey) {
                failures.push(`${article._id} ${article.title}: no media PDF`)
                continue
            }
            if (originalKey.startsWith(`${KEY_PREFIX}/`)) {
                console.log(`skip (already fixed) ${article.title}`)
                continue
            }

            try {
                const res = await fetch(`${MEDIA}/${encodeKey(originalKey)}`)
                if (!res.ok) throw new Error(`download ${res.status}`)
                const {fixed, stats} = await fixPdf(Buffer.from(await res.arrayBuffer()), article, info)

                const newKey = `${KEY_PREFIX}/vol-${info.volume}-issue-${info.issue}-${info.year}/${path.basename(originalKey)}`
                const localFile = path.join(OUT_DIR, newKey)
                fs.mkdirSync(path.dirname(localFile), {recursive: true})
                fs.writeFileSync(localFile, fixed)

                totals.removed += stats.removed
                totals.whitedOut += stats.whitedOut
                manifest.push({
                    id: article._id,
                    title: article.title,
                    volume: info.volume,
                    oldUrl: article.pdf,
                    newKey,
                    newUrl: `${MEDIA}/${encodeKey(newKey)}`,
                    localFile,
                    headersRemoved: stats.removed,
                    headersCovered: stats.whitedOut,
                })
                const note = stats.whitedOut ? `  (covered ${stats.whitedOut} header items)` : ''
                console.log(`fixed vol ${info.volume}: ${article.title.slice(0, 55)}${note}`)
            } catch (err) {
                failures.push(`vol ${info.volume} ${article._id} ${article.title}: ${err.message}`)
            }
        }
    }

    fs.mkdirSync(OUT_DIR, {recursive: true})
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
    console.log(`\n${manifest.length} PDFs written to ${OUT_DIR}`)
    console.log(`old headers removed from ${totals.removed} pages, covered on ${totals.whitedOut} header items`)
    if (failures.length) {
        console.log(`${failures.length} NOT written:`)
        failures.forEach((f) => console.log('  ' + f))
    }

    if (publish) {
        if (failures.length) throw new Error('Refusing to publish while some PDFs failed. Fix those first.')
        await publishManifest(manifest)
    } else {
        console.log('Local only. Review the files, then re-run with --publish to upload and repoint articles.')
    }
}

async function publishManifest(manifest) {
    if (manifest.length === 0) return
    const mongoose = require('mongoose')
    const Journal = require('../models/journal')
    const {s3, s3bucket} = require('../config/config')

    await mongoose.connect(process.env.MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true})

    const backupDir = path.join(__dirname, '..', 'backups')
    fs.mkdirSync(backupDir, {recursive: true})
    const backupFile = path.join(backupDir, `pdf-urls-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(backupFile, JSON.stringify(manifest.map(({id, oldUrl}) => ({id, oldUrl})), null, 2))
    console.log(`Previous PDF URLs saved: ${backupFile}`)

    try {
        for (const item of manifest) {
            const exists = await s3.headObject({Bucket: s3bucket, Key: item.newKey}).promise().then(() => true, () => false)
            if (exists) throw new Error(`refusing to overwrite existing key ${item.newKey}`)

            await s3.putObject({
                Bucket: s3bucket,
                Key: item.newKey,
                Body: fs.readFileSync(item.localFile),
                ContentType: 'application/pdf',
                ACL: 'public-read',
                CacheControl: 'max-age=604800',
            }).promise()
            await Journal.updateOne({_id: item.id}, {$set: {pdf: item.newUrl}})
            console.log(`published ${item.newKey}`)
        }
    } finally {
        await mongoose.disconnect()
    }
}

main().catch((err) => {
    console.error(err.message)
    process.exitCode = 1
})
