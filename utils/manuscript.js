/*
 * Turns a submitted manuscript into article HTML, and turns an article's
 * HTML content into a PDF styled like the rest of the archive.
 *
 * Manuscripts are submitted as .docx. Text, basic formatting and images are
 * taken from the document via mammoth. Images the browser can display are
 * stored and placed inline in the text. Anything else (EMF/WMF, for example)
 * is stored and handed back separately, so the editor can decide where it
 * goes. A PDF and a legacy .doc are still read for submissions made before
 * the .docx-only rule, on a best-effort basis.
 *
 * PDF generation draws the same header band as scripts/stamp-article-pdfs.js
 * ("oijpcr.org" / "OIJPCR, Volume N, Issue I, YYYY") so a generated PDF reads
 * as one of the set, not a one-off. Body text is plain Times New Roman at a
 * fixed size, and images are embedded at the width of the text block.
 */
const mammoth = require('mammoth')
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
const {PDFDocument, StandardFonts, rgb} = require('pdf-lib')
const {JOURNAL_NAME} = require('./bibliography')

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOC_MIME = 'application/msword'
const PDF_MIME = 'application/pdf'

// Browsers can display these, so they are placed inline in the article text.
const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

const IMAGE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/x-emf': 'emf',
    'image/emf': 'emf',
    'image/x-wmf': 'wmf',
    'image/wmf': 'wmf',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
}
const imageExtension = (contentType) => IMAGE_EXTENSIONS[contentType] || 'bin'

// Stand-in src for an image that mammoth was asked to place but which has no
// place in the text. The tag is removed again once conversion is done.
const PENDING_SRC = 'oijpcr-pending'

// --- manuscript -> article HTML -------------------------------------------

// `saveImage(bytes, contentType)` stores one image and resolves to its public URL.
async function extractManuscriptContent({buffer, mimeType, title, saveImage}) {
    if (mimeType === DOCX_MIME) return extractDocx(buffer, title, saveImage)

    const result = mimeType === PDF_MIME
        ? await extractPdfText(buffer, title)
        : legacyDocPlaceholder()
    return {...result, sourceImages: [], droppedImages: 0}
}

// A manuscript almost always opens with its own title line, which is also the
// submission's `title` field - normalize-compare so the title isn't repeated
// at the top of both the article page and the generated PDF.
const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const looksLikeTitle = (candidate, title) => {
    const a = normalize(candidate)
    const b = normalize(title)
    return Boolean(a) && Boolean(b) && a === b
}

async function extractDocx(buffer, title, saveImage) {
    // Images that could not be placed inline, returned to the editor separately.
    const sourceImages = []
    let droppedImages = 0
    let imageCount = 0

    const convertImage = mammoth.images.imgElement(async (image) => {
        imageCount++
        const name = `Image ${imageCount}`
        const contentType = image.contentType || 'application/octet-stream'

        let url = null
        try {
            url = await saveImage(await image.readAsBuffer(), contentType)
        } catch (err) {
            url = null
        }
        if (!url) {
            droppedImages++
            return {src: PENDING_SRC}
        }
        if (INLINE_IMAGE_TYPES.includes(contentType)) return {src: url}

        sourceImages.push({url, name, contentType})
        return {src: PENDING_SRC}
    })

    try {
        const {value} = await mammoth.convertToHtml({buffer}, {convertImage})
        const html = value
            .replace(new RegExp(`<img\\b[^>]*\\ssrc="${PENDING_SRC}"[^>]*>`, 'g'), '')
            .replace(/<p>\s*<\/p>/g, '')
        if (html.trim()) {
            return {html: dropLeadingTitle(html, title), extracted: true, sourceImages, droppedImages}
        }
    } catch (err) {
        // fall through to the placeholder below
    }
    return {
        html: paragraph('This DOCX could not be read automatically. Open the downloaded manuscript and paste its text in here.'),
        extracted: false,
        sourceImages,
        droppedImages,
    }
}

// Removes a leading <h1-6>/<p> block if its text matches the title.
function dropLeadingTitle(html, title) {
    const match = /^\s*<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/i.exec(html)
    if (!match) return html
    const text = match[2].replace(/<[^>]+>/g, '').trim()
    if (!looksLikeTitle(text, title)) return html
    return html.slice(match[0].length)
}

async function extractPdfText(buffer, title) {
    let doc
    try {
        doc = await pdfjs.getDocument({data: new Uint8Array(buffer), useSystemFonts: true}).promise
    } catch (err) {
        return {
            html: paragraph('This PDF could not be read automatically. Open the downloaded manuscript and paste its text in here.'),
            extracted: false,
        }
    }

    const paragraphs = []
    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n)
        const {items} = await page.getTextContent()

        // Pass 1: pdf.js gives a flat run of text items, several per visual
        // line (one per font/style change). Items on the same baseline join
        // into one line.
        const lines = []
        items.forEach((item) => {
            if (!item.str) return
            const y = item.transform[5]
            const current = lines[lines.length - 1]
            if (current && Math.abs(y - current.y) < item.height * 0.5) {
                current.text += (current.text.endsWith(' ') ? '' : ' ') + item.str
            } else {
                lines.push({y, height: item.height, text: item.str})
            }
        })

        // Pass 2: a wrapped line within a paragraph sits one line-height below
        // the one before it; a new paragraph sits noticeably further down
        // (extra leading, or a blank line in the source). Only the latter
        // starts a new <p> - otherwise every wrapped line would become its
        // own paragraph.
        let text = ''
        let lastY = null
        lines.forEach((line) => {
            const gap = lastY === null ? 0 : lastY - line.y
            if (lastY !== null && gap > line.height * 1.7) {
                if (text.trim()) paragraphs.push(text.trim())
                text = ''
            }
            text += (text ? ' ' : '') + line.text.trim()
            lastY = line.y
        })
        if (text.trim()) paragraphs.push(text.trim())
    }
    await doc.destroy()

    if (paragraphs.length === 0) {
        return {
            html: paragraph('No selectable text was found in this PDF (it may be a scan). Open the downloaded manuscript and paste its text in here.'),
            extracted: false,
        }
    }
    if (looksLikeTitle(paragraphs[0], title)) paragraphs.shift()
    return {html: paragraphs.map(paragraph).join(''), extracted: true}
}

function legacyDocPlaceholder() {
    return {
        html: paragraph('This manuscript was submitted as a .doc file, which cannot be read automatically. Open the downloaded manuscript and paste its text in here.'),
        extracted: false,
    }
}

const paragraph = (text) => `<p>${escapeHtml(text)}</p>`

const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// --- article HTML -> blocks -------------------------------------------------

const decodeAttribute = (value) => String(value)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')

// Good enough to lay out as a PDF; not a general HTML renderer.
function htmlToParagraphs(html) {
    return String(html || '')
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&rsquo;|&lsquo;/g, '’')
        .replace(/&ldquo;|&rdquo;/g, '"')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
}

// Splits article HTML into text paragraphs and images, in document order.
// Each image is {type: 'image', src, label}.
function htmlToBlocks(html) {
    const source = String(html || '')
    const blocks = []
    const pushText = (fragment) => {
        htmlToParagraphs(fragment).forEach((text) => blocks.push({type: 'text', text}))
    }

    let last = 0
    for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
        pushText(source.slice(last, match.index))
        const src = /\ssrc="([^"]*)"/i.exec(match[0])
        const alt = /\salt="([^"]*)"/i.exec(match[0])
        if (src) {
            blocks.push({
                type: 'image',
                src: decodeAttribute(src[1]),
                label: decodeAttribute(alt ? alt[1] : '') || 'image',
            })
        }
        last = match.index + match[0].length
    }
    pushText(source.slice(last))
    return blocks
}

// --- article -> PDF ---------------------------------------------------------

const PAGE = {width: 595.28, height: 841.89} // A4
const MARGIN = {top: 96, bottom: 56, side: 56}
const HEADER_BASELINE = 44
const HEADER_SIDE = 36
const BODY_SIZE = 12
const BODY_LEADING = 17
const PARAGRAPH_GAP = 8
const MAX_IMAGE_HEIGHT = 380

// pdf-lib's standard fonts encode WinAnsi (Windows-1252), which happily
// covers curly quotes, en/em dashes and most currency signs - checking per
// character with the real font (rather than guessing by code point) lets all
// of those through unchanged. The Rupee sign is a common, genuine gap in
// WinAnsi for a journal about India, so it gets a readable stand-in; anything
// else WinAnsi can't encode (non-Latin scripts, emoji, ...) becomes `?`.
const CHAR_FALLBACK = {'₹': 'Rs. '}
const encodable = new Map() // per-font cache; article text repeats characters a lot

function sanitize(text, font) {
    let cache = encodable.get(font)
    if (!cache) encodable.set(font, cache = new Map())

    return Array.from(String(text)).map((ch) => {
        if (CHAR_FALLBACK[ch] !== undefined) return CHAR_FALLBACK[ch]
        if (cache.has(ch)) return cache.get(ch) ? ch : '?'
        let ok = true
        try {
            font.widthOfTextAtSize(ch, 10)
        } catch (err) {
            ok = false
        }
        cache.set(ch, ok)
        return ok ? ch : '?'
    }).join('')
}

function wrapLine(text, font, size, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean)
    const lines = []
    let line = ''
    words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
            lines.push(line)
            line = word
        } else {
            line = candidate
        }
    })
    if (line) lines.push(line)
    return lines.length ? lines : ['']
}

// Only JPEG and PNG can be embedded by pdf-lib. Anything else is shown as a
// placeholder line so the PDF still says an image was there.
async function embedImage(doc, image) {
    if (!image || !image.bytes) return null
    try {
        if (image.contentType === 'image/jpeg') return await doc.embedJpg(image.bytes)
        if (image.contentType === 'image/png') return await doc.embedPng(image.bytes)
    } catch (err) {
        // corrupt or unexpected image data - treated like an unsupported one
    }
    return null
}

// `blocks` is what htmlToBlocks() produces, with each image block's `image`
// set to {bytes, contentType} (or null when it could not be loaded).
async function buildArticlePdf({title, author, affiliation, tags, blocks, volume, issue, year}) {
    const doc = await PDFDocument.create()
    const serif = await doc.embedFont(StandardFonts.TimesRoman)
    const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold)
    const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic)
    const sans = await doc.embedFont(StandardFonts.Helvetica)
    const sansBold = await doc.embedFont(StandardFonts.HelveticaBold)

    const ink = rgb(0.1, 0.1, 0.1)
    const muted = rgb(0.35, 0.35, 0.35)
    const headerColour = rgb(0.15, 0.15, 0.15)
    const contentWidth = PAGE.width - MARGIN.side * 2
    const headerRight = `OIJPCR, Volume ${volume}, Issue ${issue}, ${year}`

    let page = null
    let y = 0
    let pageNumber = 0

    const newPage = () => {
        page = doc.addPage([PAGE.width, PAGE.height])
        pageNumber++
        const headerY = PAGE.height - HEADER_BASELINE
        page.drawText('oijpcr.org', {x: HEADER_SIDE, y: headerY, size: 8, font: sans, color: headerColour})
        page.drawText(headerRight, {
            x: PAGE.width - HEADER_SIDE - sansBold.widthOfTextAtSize(headerRight, 8),
            y: headerY, size: 8, font: sansBold, color: headerColour,
        })
        y = PAGE.height - MARGIN.top
    }

    const ensureSpace = (needed) => {
        if (y - needed < MARGIN.bottom) newPage()
    }

    const drawParagraph = (text, {font, size, leading, color = ink, gapAfter = PARAGRAPH_GAP, centered = false}) => {
        wrapLine(sanitize(text, font), font, size, contentWidth).forEach((line) => {
            ensureSpace(leading)
            const x = centered ? MARGIN.side + (contentWidth - font.widthOfTextAtSize(line, size)) / 2 : MARGIN.side
            page.drawText(line, {x, y: y - leading + 4, size, font, color})
            y -= leading
        })
        y -= gapAfter
    }

    newPage()

    drawParagraph(title || 'Untitled', {font: serifBold, size: 18, leading: 23, gapAfter: 4, centered: true})
    const byline = affiliation ? `By ${author} · ${affiliation}` : `By ${author}`
    drawParagraph(byline, {font: serifItalic, size: 11, leading: 15, color: muted, gapAfter: 20, centered: true})

    for (const block of blocks) {
        if (block.type === 'text') {
            drawParagraph(block.text, {font: serif, size: BODY_SIZE, leading: BODY_LEADING})
            continue
        }

        const picture = await embedImage(doc, block.image)
        if (!picture) {
            drawParagraph(`[Image not included: ${block.label}]`, {
                font: serifItalic, size: 10, leading: 14, color: muted,
            })
            continue
        }

        const scale = Math.min(1, contentWidth / picture.width, MAX_IMAGE_HEIGHT / picture.height)
        const width = picture.width * scale
        const height = picture.height * scale
        ensureSpace(height + PARAGRAPH_GAP)
        page.drawImage(picture, {
            x: MARGIN.side + (contentWidth - width) / 2,
            y: y - height,
            width,
            height,
        })
        y -= height + PARAGRAPH_GAP
    }

    doc.getPages().forEach((p, index) => {
        const label = `${index + 1} / ${pageNumber}`
        p.drawText(label, {
            x: PAGE.width / 2 - sans.widthOfTextAtSize(label, 8) / 2,
            y: 28, size: 8, font: sans, color: muted,
        })
    })

    doc.setTitle(title || 'Untitled')
    doc.setAuthor(author || '')
    doc.setSubject(`${JOURNAL_NAME}, Volume ${volume}, Issue ${issue}, ${year}`)
    doc.setKeywords(String(tags || '').split(',').map((t) => t.trim()).filter(Boolean))
    doc.setCreator(JOURNAL_NAME)
    doc.setProducer(`${JOURNAL_NAME} (oijpcr.org)`)

    return Buffer.from(await doc.save())
}

module.exports = {
    extractManuscriptContent,
    htmlToParagraphs,
    htmlToBlocks,
    buildArticlePdf,
    imageExtension,
}
