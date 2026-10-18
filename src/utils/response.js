export function success(res, data, status = 200, message, meta) {
  res.status(status).json({
    success: true,
    data,
    ...(message ? { message } : {}),
    ...(meta ? { meta } : {}),
  })
}
