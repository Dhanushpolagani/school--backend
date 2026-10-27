/**
 * Standard API response envelope helpers
 */
function success(res, data = null, message = null, statusCode = 200, meta = null) {
  const payload = {
    success: true,
  };

  if (message) payload.message = message;
  if (data !== null) payload.data = data;
  if (meta !== null) payload.meta = meta;

  return res.status(statusCode).json(payload);
}

function error(res, message = "Internal Server Error", statusCode = 500, details = null) {
  const payload = {
    success: false,
    error: {
      message,
    },
    message,
  };

  if (details) payload.error.details = details;

  return res.status(statusCode).json(payload);
}

module.exports = {
  success,
  error,
};
