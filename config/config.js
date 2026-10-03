const aws = require('aws-sdk')

aws.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
})

const s3 = new aws.S3();

module.exports = {
  aws,
  s3,
  s3bucket: process.env.S3_BUCKET_NAME || process.env.S3_BUCKET
}
