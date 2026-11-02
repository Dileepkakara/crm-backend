import multer from 'multer'
import { AppError } from '../errors/AppError.js'

const maxFileSize = 15 * 1024 * 1024
const storage = multer.memoryStorage()

function upload(allowedTypes) {
  const parser = multer({
    storage,
    limits: { fileSize: maxFileSize, files: 1, fields: 0 },
    fileFilter(_req, file, callback) {
      if (!allowedTypes.has(file.mimetype)) {
        callback(new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'Upload a supported PDF or image file.'))
        return
      }
      callback(null, true)
    },
  }).single('file')

  return (req, res, next) => parser(req, res, (error) => {
    if (error instanceof AppError) return next(error)
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(413, 'FILE_TOO_LARGE', 'Files must be 15 MB or smaller.'))
    }
    if (error) return next(new AppError(400, 'INVALID_FILE_UPLOAD', 'The file upload request is invalid.'))
    if (!req.file) return next(new AppError(400, 'FILE_REQUIRED', 'Choose a file to upload.'))
    next()
  })
}

export const documentUpload = upload(new Set(['application/pdf']))
export const attachmentUpload = upload(new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]))
