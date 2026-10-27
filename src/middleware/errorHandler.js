/**
 * Global Error Handling Middleware
 */
function errorHandler(err, req, res, next) {
  console.error("Application error:", err.stack || err.message);

  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  res.status(status).json({
    success: false,
    error: {
      message,
      ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {}),
    },
    message,
  });
}

module.exports = errorHandler;
