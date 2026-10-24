export function validate({ body, query, params }) {
  return (req, _res, next) => {
    try {
      if (body) req.body = body.parse(req.body)
      if (query) {
        Object.defineProperty(req, 'query', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: query.parse(req.query),
        })
      }
      if (params) req.params = params.parse(req.params)
      next()
    } catch (error) {
      next(error)
    }
  }
}
