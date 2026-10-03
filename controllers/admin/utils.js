const { s3, s3bucket } = require('../../config/config')
const { logAction, logError } = require('../../utils/logger')

const FALLBACK_FILES = new Set([
  'article_cover_fallback.jpg',
  'article_cover_fallback',
  'volume_cover_fallback.jpeg',
  'volume_cover_fallback',
])

function isDefaultImage(imageName) {
  if (!imageName) return true
  return FALLBACK_FILES.has(decodeURI(String(imageName).split('/').pop()))
}

// S3 cleanup must not block deleting the article/volume. The upload IAM user
// may not have s3:DeleteObject; a missing object is also not an error.
const deleteFile = async (fileName) => {
  if (isDefaultImage(fileName)) return

  const keyName = decodeURI(fileName)
  try {
    await s3.deleteObject({
      Bucket: s3bucket,
      Key: keyName,
    }).promise()
    logAction('FILE DELETE', {key: keyName})
  } catch (error) {
    logError('FILE DELETE', error, {key: keyName, code: error.code})
  }
}

module.exports = { isDefaultImage, deleteCoverImage: deleteFile }
