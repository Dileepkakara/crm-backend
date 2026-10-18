import Decimal from 'decimal.js'
import { AppError } from '../errors/AppError.js'

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP })

const amount = (value) => new Decimal(value || 0)
const roundMoney = (value) => Number(amount(value).toDecimalPlaces(2).toFixed(2))

export function calculateDocument(input) {
  const items = input.items || input.lineItems || []
  if (!items.length) throw new AppError(400, 'ITEMS_REQUIRED', 'At least one line item is required.')
  const normalizedItems = items.map((item) => {
    const quantity = amount(item.quantity)
    const rate = amount(item.rate)
    if (!quantity.isFinite() || quantity.lte(0) || !rate.isFinite() || rate.lt(0)) {
      throw new AppError(400, 'INVALID_LINE_ITEM', 'Line-item quantity must be positive and rate must be non-negative.')
    }
    const lineAmount = quantity.mul(rate).toDecimalPlaces(2)
    return {
      description: String(item.description).trim(),
      quantity: Number(quantity.toString()),
      rate: roundMoney(rate),
      amount: Number(lineAmount.toFixed(2)),
    }
  })
  const subtotalDecimal = normalizedItems.reduce((sum, item) => sum.plus(item.amount), new Decimal(0))
  const discountDecimal = amount(input.discount)
  if (!discountDecimal.isFinite() || discountDecimal.lt(0)) {
    throw new AppError(400, 'INVALID_DISCOUNT', 'Discount must be a non-negative amount.')
  }
  if (discountDecimal.gt(subtotalDecimal)) {
    throw new AppError(400, 'DISCOUNT_EXCEEDS_SUBTOTAL', 'Discount cannot exceed the subtotal.')
  }
  const taxable = subtotalDecimal.minus(discountDecimal)
  const useGst = Boolean(input.gstEnabled)
  const sgstRate = useGst && input.sgstEnabled ? amount(input.sgstRate) : new Decimal(0)
  const cgstRate = useGst && input.cgstEnabled ? amount(input.cgstRate) : new Decimal(0)
  if (sgstRate.lt(0) || sgstRate.gt(100) || cgstRate.lt(0) || cgstRate.gt(100)) {
    throw new AppError(400, 'INVALID_TAX_RATE', 'Tax rates must be between 0 and 100 percent.')
  }
  const sgstAmount = taxable.mul(sgstRate).div(100).toDecimalPlaces(2)
  const cgstAmount = taxable.mul(cgstRate).div(100).toDecimalPlaces(2)
  const tax = sgstAmount.plus(cgstAmount).toDecimalPlaces(2)
  const total = taxable.plus(tax).toDecimalPlaces(2)
  return {
    items: normalizedItems,
    subtotal: Number(subtotalDecimal.toDecimalPlaces(2).toFixed(2)),
    discount: roundMoney(discountDecimal),
    taxableValue: Number(taxable.toDecimalPlaces(2).toFixed(2)),
    sgstAmount: Number(sgstAmount.toFixed(2)),
    cgstAmount: Number(cgstAmount.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    total: Number(total.toFixed(2)),
    amount: Number(total.toFixed(2)),
  }
}

export const toMoney = roundMoney
