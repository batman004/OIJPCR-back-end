const mongoose = require('mongoose')
require('dotenv').config()

const sourceImageSchema = new mongoose.Schema({
  url: {type: String, required: true},
  name: {type: String, default: ''},
  contentType: {type: String, default: ''},
}, {_id: false})

const journalSchema = new mongoose.Schema({
    author: {
      type: String,
      required: true,
      default: 'Anonymous',
    },

    authorPhoto: {
      type: String,
    },

    title: {
      type: String,
      required: true,
      default: 'Title NA',
    },

    content: {
      type: String,
      required: true,
      default: 'Content NA',
    },

    slug: {
      type: String,
      required: true,
      default: 'Slug NA',
    },

    volume: {
      type: Number,
      default: 1,
    },

    tags: {
      type: String,
      default: ',',
    },

    pdf: {
        type: String
    },

    cover: {
      type: String,
      default: `${process.env.HOST}editor/images/article_cover_fallback.jpg`,
    },

    // Drafts (e.g. created from an accepted submission) are excluded from every
    // public query but remain fully editable/previewable in the admin area.
    // Existing documents predate this field; code must not assume it is set
    // (see Journal.PUBLIC_ONLY below).
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'published',
    },

    // Images from a submitted manuscript that couldn't be placed in the text
    // automatically (e.g. EMF/WMF). Shown beside the editor so the editor can
    // insert them wherever they belong.
    sourceImages: {
      type: [sourceImageSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
)

journalSchema.index({ tags: 'text' })

const Journal = mongoose.model('Journal', journalSchema)

// A Mongo filter for "not a draft": documents saved before `status` existed
// have no value for it, so excluding 'draft' (rather than requiring
// 'published') includes them without a migration. Spread into any query that
// must not surface drafts - every public journalsController route, the
// per-volume article counts, and the admin metrics dashboard.
Journal.PUBLIC_ONLY = {status: {$ne: 'draft'}}

module.exports = Journal
