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

// Bucket name doubles as the custom media domain (S3_BUCKET_NAME=media.oijpcr.org),
// so a key at the bucket root is served at this URL - same shape uploadFile()
// derives from multerS3's `location`.
const mediaUrl = (key) => `https://${s3bucket}/${encodeURI(key)}`

const putFile = async (key, body, contentType) => {
  await s3.putObject({
    Bucket: s3bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: 'public-read',
    CacheControl: 'max-age=604800',
  }).promise()
  return mediaUrl(key)
}

module.exports = { isDefaultImage, deleteCoverImage: deleteFile, mediaUrl, putFile }
