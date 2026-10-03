const multer = require('multer')
const multerS3 = require('multer-s3')
const {
  createFileName,
} = require('./utils')
const { s3, s3bucket } = require('../../config/config')
const AppError = require('../../utils/appError')
const { logError } = require('../../utils/logger')

const multerStorage = multerS3({
  s3: s3,
  bucket: s3bucket,
  acl: 'public-read',
  cacheControl: 'max-age=604800000', // cache for 1 week
  contentType: multerS3.AUTO_CONTENT_TYPE,
  metadata: function (req, file, cb) {
    cb(null, {fieldName: file.fieldname});
  },
  key: function (req, file, cb) {
    const filename = createFileName(file.originalname, file.mimetype)
    cb(null, filename)
  },
})

// ** filter -> allow files with mimeType: image/* to pass through
const multerFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image')) {
    cb(null, true)
  } else {
    const type = file.mimetype || 'unknown type'
    logError('FILE CREATE', 'Not an image', { name: file.originalname, type })
    cb(new AppError(
      `"${file.originalname}" is not an image (${type}). Use JPEG, PNG, GIF, or WebP.`,
      400,
    ), false)
  }
}

const multerImageUpload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
}).single('image')

module.exports = { multerImageUpload }