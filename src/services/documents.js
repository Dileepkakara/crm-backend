import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import mongoose from 'mongoose'
import { AppError } from '../errors/AppError.js'
import { logger } from '../config/logger.js'
import { modelsByResource } from '../models/index.js'
import { recordAudit } from './audit.js'
import { getResource } from './resources.js'
import {
  cloudinaryAssetExists,
  deleteFromCloudinary,
  downloadFromCloudinary,
  uploadToCloudinary,
} from './cloudinaryStorage.js'

const resourceTypes = new Set(['quotations', 'invoices', 'agreements'])
const documentTypeByResource = {
  quotations: 'quotation',
  invoices: 'invoice',
  agreements: 'workOrder',
}
const contentTypes = {
  'application/pdf': { resourceType: 'raw', format: 'pdf', extension: '.pdf' },
  'image/jpeg': { resourceType: 'image', format: 'jpg', extensions: ['.jpg', '.jpeg'] },
  'image/png': { resourceType: 'image', format: 'png', extension: '.png' },
  'image/webp': { resourceType: 'image', format: 'webp', extension: '.webp' },
}

export function assertFileSignature(file) {
  const type = contentTypes[file.mimetype]
  const extension = path.extname(file.originalname || '').toLowerCase()
  if (!type || !(type.extensions || [type.extension]).includes(extension)) {
    throw new AppError(400, 'FILE_TYPE_MISMATCH', 'The file extension and media type must match a supported format.')
  }
  const buffer = file.buffer
  const valid = file.mimetype === 'application/pdf'
    ? buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    : file.mimetype === 'image/jpeg'
      ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : file.mimetype === 'image/png'
        ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : buffer.subarray(0, 4).toString('ascii') === 'RIFF'
          && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!valid) throw new AppError(400, 'INVALID_FILE_CONTENT', 'The uploaded file content does not match its declared file type.')
  if (file.mimetype === 'application/pdf' && !buffer.includes(Buffer.from('%%EOF'))) {
    throw new AppError(400, 'INVALID_PDF', 'The uploaded PDF is incomplete or invalid.')
  }
  return type
}

function safeFileName(fileName) {
  const normalized = String(fileName || 'upload').replaceAll('\\', '/')
  const baseName = path.basename(normalized)
  const safeName = Array.from(baseName).filter((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  }).join('')
  return safeName.slice(0, 255) || 'upload'
}

function publicMetadata(item) {
  const value = item.toObject ? item.toObject() : { ...item }
  delete value.cloudinaryUrl
  delete value.cloudinaryPublicId
  return value
}

function currentDocument(record) {
  return record.documentVersions?.find((item) => item.isCurrentVersion)
    || [...(record.documentVersions || [])].sort((a, b) => b.versionNumber - a.versionNumber)[0]
}

function clientCanAccessDocument(resource, record) {
  if (record.status === 'Draft' || record.status === 'Cancelled') return false
  if (resource === 'agreements') return ['Pending approval', 'Accepted'].includes(record.status)
  if (resource === 'quotations' && record.status === 'Revised') return false
  return true
}

async function loadAccessibleRecord(resource, id, user) {
  if (!resourceTypes.has(resource)) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
  await getResource(resource, id, user)
  const record = await modelsByResource[resource].findOne({ id })
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
  if (user.role === 'client' && !clientCanAccessDocument(resource, record)) {
    throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document was not found.')
  }
  return record
}

function recordSummary(resource, record) {
  return {
    parentRecordId: record.id,
    documentNumber: record.number || record.id,
    documentType: documentTypeByResource[resource],
  }
}

async function persistUpload({ resource, id, file, req, attachment }) {
  const { user } = req
  if (!resourceTypes.has(resource)) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
  const initialRecord = await loadAccessibleRecord(resource, id, user)
  const type = assertFileSignature(file)
  if (!attachment && file.mimetype !== 'application/pdf') {
    throw new AppError(400, 'DOCUMENT_MUST_BE_PDF', 'Final documents must be uploaded as PDF files.')
  }

  const contentHash = createHash('sha256').update(file.buffer).digest('hex')
  const field = attachment ? 'attachments' : 'documentVersions'
  const priorAssets = initialRecord[field] || []
  const existing = priorAssets.find((item) => item.contentHash === contentHash)
  let unavailableAssetId
  if (existing) {
    const exists = await cloudinaryAssetExists(existing.cloudinaryPublicId, existing.resourceType)
    if (exists) {
      if (attachment || (existing.isCurrentVersion && !initialRecord.documentNeedsRegeneration)) {
        return publicMetadata(existing)
      }
      const session = await mongoose.startSession()
      let restoredVersion
      try {
        await session.withTransaction(async () => {
          const record = await modelsByResource[resource].findOne({ id }).session(session)
          if (!record || record.clientId !== initialRecord.clientId) {
            throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
          }
          record.documentVersions.forEach((item) => {
            item.isCurrentVersion = item.contentHash === contentHash
          })
          record.documentNeedsRegeneration = false
          await record.save({ session })
          restoredVersion = record.documentVersions.find((item) => item.contentHash === contentHash)
          await recordAudit(req, `${resource}.document_reused`, resource, id, {
            versionNumber: restoredVersion.versionNumber,
            contentHash,
          }, session)
        })
      } finally {
        await session.endSession()
      }
      return publicMetadata(restoredVersion)
    }
    unavailableAssetId = String(existing._id || existing.id)
  }

  const versionNumber = Math.max(0, ...priorAssets.map((item) => Number(item.versionNumber) || 0)) + 1
  const originalFileName = safeFileName(file.originalname)
  const assetPublicId = [
    'crm-private',
    resource,
    String(id).replace(/[^a-zA-Z0-9_-]/g, '_'),
    `${attachment ? 'attachment' : 'document'}-v${versionNumber}-${randomUUID()}-${contentHash}${type.resourceType === 'raw' ? type.extension : ''}`,
  ].join('/')
  const uploaded = await uploadToCloudinary({
    buffer: file.buffer,
    publicId: assetPublicId,
    resourceType: type.resourceType,
    format: type.format,
  })
  const uploadedAt = new Date()
  const metadata = {
    ...recordSummary(resource, initialRecord),
    documentType: attachment ? 'attachment' : documentTypeByResource[resource],
    cloudinaryUrl: uploaded.secure_url,
    cloudinaryPublicId: uploaded.public_id,
    resourceType: uploaded.resource_type,
    format: uploaded.format,
    mimeType: file.mimetype,
    originalFileName,
    fileSize: file.size,
    contentHash,
    versionNumber,
    isCurrentVersion: true,
    generatedBy: user.id,
    uploadedAt,
    updatedAt: uploadedAt,
  }

  const session = await mongoose.startSession()
  let savedAsset
  let duplicateAsset
  try {
    await session.withTransaction(async () => {
      const record = await modelsByResource[resource].findOne({ id }).session(session)
      if (!record || record.clientId !== initialRecord.clientId) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      if (!attachment) {
        duplicateAsset = record.documentVersions.find((item) =>
          item.contentHash === contentHash && String(item._id || item.id) !== unavailableAssetId)
        if (duplicateAsset) return
        record.documentVersions.forEach((item) => { item.isCurrentVersion = false })
        metadata.versionNumber = Math.max(0, ...record.documentVersions.map((item) => Number(item.versionNumber) || 0)) + 1
        metadata.documentNumber = record.number || record.id
        record.documentVersions.push(metadata)
        record.documentNeedsRegeneration = false
      } else {
        metadata.versionNumber = record.attachments.length + 1
        metadata.documentNumber = record.number || record.id
        record.attachments.push(metadata)
      }
      await record.save({ session })
      await recordAudit(req, attachment ? `${resource}.attachment_uploaded` : `${resource}.document_generated`, resource, id, {
        versionNumber: metadata.versionNumber,
        contentHash,
        fileSize: file.size,
        mimeType: file.mimetype,
      }, session)
      savedAsset = attachment ? record.attachments.at(-1) : record.documentVersions.at(-1)
    })
  } catch (error) {
    try {
      await deleteFromCloudinary(uploaded.public_id, uploaded.resource_type)
    } catch (cleanupError) {
      logger.error({ err: cleanupError, resource, recordId: id }, 'Could not clean up an unlinked Cloudinary upload')
    }
    throw error
  } finally {
    await session.endSession()
  }
  if (duplicateAsset) {
    await deleteFromCloudinary(uploaded.public_id, uploaded.resource_type)
    return publicMetadata(duplicateAsset)
  }
  return publicMetadata(savedAsset)
}

export function saveGeneratedDocument(resource, id, file, req) {
  return persistUpload({ resource, id, file, req, attachment: false })
}

export function saveAttachment(resource, id, file, req) {
  return persistUpload({ resource, id, file, req, attachment: true })
}

export async function deleteDocumentVersion(resource, id, versionNumber, req) {
  const initialRecord = await loadAccessibleRecord(resource, id, req.user)
  const selectedVersion = initialRecord.documentVersions?.find((item) =>
    Number(item.versionNumber) === Number(versionNumber))
  const latestVersion = currentDocument(initialRecord)
  if (!selectedVersion) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document version was not found.')
  if (latestVersion && String(latestVersion._id) === String(selectedVersion._id)) {
    throw new AppError(400, 'CURRENT_DOCUMENT_VERSION', 'The current document version cannot be deleted.')
  }

  const session = await mongoose.startSession()
  let deletedVersion
  try {
    await session.withTransaction(async () => {
      const record = await modelsByResource[resource].findOne({ id }).session(session)
      const version = record?.documentVersions?.find((item) =>
        Number(item.versionNumber) === Number(versionNumber))
      const currentVersion = record && currentDocument(record)
      if (!version) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document version was not found.')
      if (currentVersion && String(currentVersion._id) === String(version._id)) {
        throw new AppError(400, 'CURRENT_DOCUMENT_VERSION', 'The current document version cannot be deleted.')
      }
      deletedVersion = {
        _id: version._id,
        versionNumber: version.versionNumber,
        cloudinaryPublicId: version.cloudinaryPublicId,
        resourceType: version.resourceType,
        contentHash: version.contentHash,
      }
      record.documentVersions.pull({ _id: version._id })
      await record.save({ session })
      await recordAudit(req, `${resource}.document_version_deleted`, resource, id, {
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
      }, session)
    })
  } finally {
    await session.endSession()
  }

  try {
    await deleteFromCloudinary(deletedVersion.cloudinaryPublicId, deletedVersion.resourceType)
  } catch (error) {
    logger.error({ err: error, resource, recordId: id, versionNumber: deletedVersion.versionNumber },
      'Document version metadata was deleted but Cloudinary cleanup failed')
    throw error
  }

  return { versionNumber: deletedVersion.versionNumber }
}

export async function retrieveDocument(resource, id, version, user, download) {
  const record = await loadAccessibleRecord(resource, id, user)
  if (version === 'current' && record.documentNeedsRegeneration) {
    throw new AppError(409, 'DOCUMENT_REGENERATION_REQUIRED', 'The document has changed. Generate and upload a new version before viewing it as current.')
  }
  const document = version === 'current'
    ? currentDocument(record)
    : record.documentVersions?.find((item) => Number(item.versionNumber) === Number(version))
  if (!document || (user.role === 'client' && (!document.isCurrentVersion || !clientCanAccessDocument(resource, record)))) {
    throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document was not found.')
  }
  const buffer = await downloadFromCloudinary({
    publicId: document.cloudinaryPublicId,
    resourceType: document.resourceType,
    format: document.format,
    fileSize: document.fileSize,
  })
  return {
    buffer,
    mimeType: document.mimeType,
    originalFileName: document.originalFileName,
    versionNumber: document.versionNumber,
    download,
  }
}

export async function retrieveAttachment(resource, id, attachmentId, user, download) {
  const record = await loadAccessibleRecord(resource, id, user)
  const attachment = record.attachments?.find((item) =>
    String(item._id || item.id) === String(attachmentId))
  if (!attachment) throw new AppError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment was not found.')
  const buffer = await downloadFromCloudinary({
    publicId: attachment.cloudinaryPublicId,
    resourceType: attachment.resourceType,
    format: attachment.format,
    fileSize: attachment.fileSize,
  })
  return {
    buffer,
    mimeType: attachment.mimeType,
    originalFileName: attachment.originalFileName,
    versionNumber: attachment.versionNumber,
    download,
  }
}
