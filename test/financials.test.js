import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateDocument } from '../src/services/financials.js'
import { AppError } from '../src/errors/AppError.js'

test('calculates decimal line items, discount, GST, and rounded total', () => {
  const result = calculateDocument({
    items: [{ description: 'Design', quantity: 3, rate: 0.1 }],
    discount: 0.01,
    gstEnabled: true,
    sgstEnabled: true,
    cgstEnabled: true,
    sgstRate: 9,
    cgstRate: 9,
  })
  assert.deepEqual(result, {
    items: [{ description: 'Design', quantity: 3, rate: 0.1, amount: 0.3 }],
    subtotal: 0.3,
    discount: 0.01,
    taxableValue: 0.29,
    sgstAmount: 0.03,
    cgstAmount: 0.03,
    tax: 0.06,
    total: 0.35,
    amount: 0.35,
  })
})

test('rejects a discount greater than the subtotal', () => {
  assert.throws(
    () => calculateDocument({ items: [{ description: 'Design', quantity: 1, rate: 10 }], discount: 11 }),
    (error) => error instanceof AppError && error.code === 'DISCOUNT_EXCEEDS_SUBTOTAL',
  )
})
