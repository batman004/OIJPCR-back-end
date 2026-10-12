const mongoose = require('mongoose')

const storedFileSchema = new mongoose.Schema({
    key: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
}, { _id: false })

const commentSchema = new mongoose.Schema({
    body: { type: String, required: true, maxlength: 2000 },
    author: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } })

const submissionSchema = new mongoose.Schema({
    authorName: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    affiliation: { type: String, trim: true, maxlength: 200, default: '' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    articleType: {
        type: String,
        required: true,
        enum: ['research', 'commentary', 'book-review'],
    },
    brief: { type: String, required: true, maxlength: 1500 },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    manuscript: { type: storedFileSchema, required: true },
    bookPhoto: { type: storedFileSchema },
    status: {
        type: String,
        enum: ['review', 'accepted', 'rejected'],
        default: 'review',
    },
    comments: [commentSchema],
    // Set once "Add as draft article" has created a Journal from this
    // submission, so the admin UI can link straight to it instead of
    // creating a second draft.
    draftArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Journal' },
}, { timestamps: true })

submissionSchema.index({ status: 1, createdAt: -1 })

module.exports = mongoose.model('Submission', submissionSchema)
