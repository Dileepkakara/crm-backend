import assert from 'node:assert/strict'
import test from 'node:test'
import { Quotation } from '../src/models/index.js'
import { resourceRouter } from '../src/routes/resourceRoutes.js'
import { assertFileSignature } from '../src/services/documents.js'
import { downloadFromCloudinary, uploadToCloudinary } from '../src/services/cloudinaryStorage.js'
import { safeResource } from '../src/services/resources.js'

test('quotation document upload route is matched before status-action routes', () => {
  const routes = resourceRouter('quotations').stack
    .map((layer) => layer.route?.path)
    .filter(Boolean)

  assert.ok(routes.indexOf('/:id/documents') < routes.indexOf('/:id/:action'))
})

test('document version delete route is registered for authenticated document resources', () => {
  const routes = resourceRouter('quotations').stack
    .map((layer) => layer.route)
    .filter(Boolean)

  assert.ok(routes.some((route) => route.path === '/:id/documents/:version' && route.methods.delete))
})

test('validates PDF extension, media type, and file signature', () => {
  const file = {
    originalname: 'quotation.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nexample\n%%EOF'),
  }
  assert.equal(assertFileSignature(file).resourceType, 'raw')
  assert.throws(() => assertFileSignature({ ...file, originalname: 'quotation.txt' }), { code: 'FILE_TYPE_MISMATCH' })
  assert.throws(() => assertFileSignature({ ...file, buffer: Buffer.from('not a PDF') }), { code: 'INVALID_FILE_CONTENT' })
})

test('reports the exact missing Cloudinary variable names without attempting an upload', async () => {
  const variables = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
  const previous = variables.map((name) => process.env[name])
  variables.forEach((name) => { delete process.env[name] })
  try {
    await assert.rejects(
      uploadToCloudinary({ buffer: Buffer.from('unused'), publicId: 'unused', resourceType: 'raw', format: 'pdf' }),
      (error) => error.code === 'CLOUDINARY_NOT_CONFIGURED'
        && variables.every((name) => error.message.includes(name)),
    )
  } finally {
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
})

test('explains Cloudinary original-file delivery restrictions', async () => {
  const variables = {
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  }
  const originalFetch = globalThis.fetch
  Object.entries(variables).forEach(([name]) => { process.env[name] = 'test-value' })
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: 'Customer is marked as untrusted',
      code: 'show_original_customer_untrusted',
    },
  }), { status: 403, headers: { 'Content-Type': 'application/json' } })

  try {
    await assert.rejects(
      downloadFromCloudinary({
        publicId: 'private/test.pdf',
        resourceType: 'raw',
        format: 'pdf',
        fileSize: 1,
      }),
      (error) => error.statusCode === 503
        && error.code === 'CLOUDINARY_ACCOUNT_UNTRUSTED'
        && error.message.includes('contact Cloudinary support'),
    )
  } finally {
    globalThis.fetch = originalFetch
    Object.entries(variables).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
})

test('client quotation serialization exposes current metadata but never Cloudinary identifiers', async () => {
  const quotation = new Quotation({
    id: 'QT-DOCUMENT-1',
    clientId: 'CL-DOCUMENT-1',
    title: 'Website design',
    issueDate: new Date('2026-10-01'),
    validUntil: new Date('2026-10-31'),
    documentVersions: [{
      documentType: 'quotation',
      parentRecordId: 'QT-DOCUMENT-1',
      documentNumber: 'QT-DOCUMENT-1',
      cloudinaryUrl: 'https://cloudinary.example/private.pdf',
      cloudinaryPublicId: 'crm-private/quotations/QT-DOCUMENT-1/v1',
      resourceType: 'raw',
      format: 'pdf',
      mimeType: 'application/pdf',
      originalFileName: 'quotation.pdf',
      fileSize: 128,
      contentHash: 'a'.repeat(64),
      versionNumber: 1,
      isCurrentVersion: true,
      generatedBy: 'staff-1',
      uploadedAt: new Date('2026-10-01'),
      updatedAt: new Date('2026-10-01'),
    }],
  })
  await quotation.validate()

  assert.equal(quotation.toJSON().documentVersions[0].cloudinaryUrl, undefined)
  assert.equal(quotation.toJSON().documentVersions[0].cloudinaryPublicId, undefined)
  const client = { id: 'client-user-1', role: 'client', clientId: 'CL-DOCUMENT-1' }
  const result = safeResource('quotations', quotation, client)
  assert.equal(result.documentVersions.length, 1)
  assert.equal(result.documentVersions[0].versionNumber, 1)
  assert.equal(result.documentVersions[0].cloudinaryUrl, undefined)
  assert.equal(result.documentVersions[0].cloudinaryPublicId, undefined)

  quotation.documentNeedsRegeneration = true
  assert.deepEqual(safeResource('quotations', quotation, client).documentVersions, [])
})
