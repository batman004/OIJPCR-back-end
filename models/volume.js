const mongoose = require('mongoose')
require('dotenv').config()
const {DEFAULT_ISSUE, resolveIssue, resolveYear} = require('../utils/bibliography')

const volumeSchema = new mongoose.Schema({
    volume: {
      type: Number,
      unique: true,
      required: true,
    },

    about: {
      type: String,
      // required: true,
      default: "Explore this volume"
    },

    cover: {
      type: String,
      default: `${process.env.HOST}editor/images/volume_cover_fallback.jpeg`
    },

    date: {
      type: String,
      default: 'January 2021'
    },

    issue: {
      type: Number,
      min: 1,
      default: DEFAULT_ISSUE,
    },

    year: {
      type: Number,
    },
  },
  {
    timestamps: true,
  },
)

// Volumes saved before `year`/`issue` existed still get correct values in API responses.
volumeSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.issue = resolveIssue(ret)
    ret.year = resolveYear(ret)
    return ret
  },
})

const Volume = mongoose.model('Volume', volumeSchema)

module.exports = Volume
