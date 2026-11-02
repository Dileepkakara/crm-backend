import { v2 as cloudinary } from 'cloudinary'
import { getEnv } from '../config/env.js'
import { AppError } from '../errors/AppError.js'

const cloudinaryVariables = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
const untrustedCustomerCode = 'show_original_customer_untrusted'

function isUntrustedCustomerError(error) {
  return error?.code === untrustedCustomerCode || error?.error?.code === untrustedCustomerCode
}

function untrustedCustomerAppError() {
  return new AppError(
    503,
    'CLOUDINARY_ACCOUNT_UNTRUSTED',
    'Cloudinary has restricted original file delivery for this account. Verify the account or contact Cloudinary support.',
  )
}

function configureCloudinary() {
  const env = getEnv()
  const missing = cloudinaryVariables.filter((name) => !env[name])
  if (missing.length) {
    throw new AppError(503, 'CLOUDINARY_NOT_CONFIGURED', `Cloudinary storage is not configured. Missing environment variables: ${missing.join(', ')}.`)
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  })
}

export async function uploadToCloudinary({ buffer, publicId, resourceType, format }) {
  configureCloudinary()
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      public_id: publicId,
      resource_type: resourceType,
      type: 'authenticated',
      overwrite: false,
      unique_filename: false,
      use_filename: false,
      ...(format ? { format } : {}),
    }, (error, result) => {
      if (error) {
        if (isUntrustedCustomerError(error)) {
          const failure = untrustedCustomerAppError()
          failure.cause = error
          return reject(failure)
        }
        const failure = new AppError(502, 'CLOUDINARY_UPLOAD_FAILED', 'Cloudinary could not store this file.')
        failure.cause = error
        return reject(failure)
      }
      const uploadedFormat = result?.format || format
      if (!result?.secure_url || !result.public_id || !uploadedFormat || !result.resource_type) {
        return reject(new AppError(502, 'CLOUDINARY_INVALID_RESPONSE', 'Cloudinary returned incomplete file metadata.'))
      }
      resolve({ ...result, format: uploadedFormat })
    })
    stream.end(buffer)
  })
}

export async function deleteFromCloudinary(publicId, resourceType) {
  configureCloudinary()
  let result
  try {
    result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: 'authenticated',
      invalidate: true,
    })
  } catch (error) {
    const failure = new AppError(502, 'CLOUDINARY_DELETE_FAILED', 'Cloudinary could not remove the stored file.')
    failure.cause = error
    throw failure
  }
  if (!['ok', 'not found'].includes(result?.result)) {
    throw new AppError(502, 'CLOUDINARY_DELETE_FAILED', 'Cloudinary could not remove the stored file.')
  }
}

export async function cloudinaryAssetExists(publicId, resourceType) {
  configureCloudinary()
  try {
    await cloudinary.api.resource(publicId, {
      resource_type: resourceType,
      type: 'authenticated',
    })
    return true
  } catch (error) {
    if (error.http_code === 404 || error.error?.http_code === 404) return false
    const failure = new AppError(502, 'CLOUDINARY_LOOKUP_FAILED', 'Cloudinary could not verify the stored file.')
    failure.cause = error
    throw failure
  }
}

export async function downloadFromCloudinary({ publicId, resourceType, format, fileSize }) {
  configureCloudinary()
  const url = cloudinary.utils.private_download_url(publicId, format, {
    resource_type: resourceType,
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 120,
  })
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (response.status === 404) {
    throw new AppError(404, 'STORED_FILE_MISSING', 'The saved file is no longer available in Cloudinary. Generate or upload a new version to restore access.')
  }
  if (!response.ok) {
    const body = await response.text()
    let payload
    try {
      payload = JSON.parse(body)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    if (isUntrustedCustomerError(payload?.error)) {
      throw untrustedCustomerAppError()
    }
    throw new AppError(502, 'CLOUDINARY_DELIVERY_FAILED', 'Cloudinary could not deliver this file.')
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (!data.length || data.length > Math.max(fileSize, 1) + 1024) {
    throw new AppError(502, 'CLOUDINARY_INVALID_RESPONSE', 'Cloudinary returned an invalid file size.')
  }
  return data
}
